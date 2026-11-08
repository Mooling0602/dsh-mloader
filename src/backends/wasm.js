/**
 * WebAssembly backend: the host side of one worker thread that runs one
 * WebAssembly plugin.
 *
 * The host process never executes plugin WebAssembly code. V8 cannot interrupt
 * WebAssembly execution and has no fuel metering, so a module with an infinite
 * loop would freeze the main thread permanently, including the deadline timer.
 * The instance therefore runs in a `worker_threads` worker, and the host
 * terminates that worker when a call exceeds its deadline.
 *
 * The ABI is the core WebAssembly ABI specified in `docs/wasm/WasmABI.md`.
 *
 * @module backends/wasm
 */
import { Worker } from 'node:worker_threads';
import { projectEventArgs } from '../serialize.js';
/** Return the message of an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Backend for one WebAssembly plugin, hosted in one worker thread.
 *
 * The instance owns the worker from `start()` until `stop()`. A timeout
 * terminates the worker, because terminating it is the only mechanism that
 * stops a looping instance. After `apply` returned, an unexpected worker exit,
 * a worker error or a timeout fails every pending call and is reported once
 * through `onCrash`, so the loader can revoke the plugin's registrations and
 * mark it failed.
 */
export class WasmBackendInstance {
    /** Specification of the hosted plugin. */
    spec;
    /** Capabilities the manifest declared, carried for the loader's bookkeeping. */
    capabilities;
    logger;
    onCrash;
    worker = null;
    stopped = false;
    applied = false;
    failed = false;
    seq = 0;
    pending = new Map();
    /**
     * Create the instance. The worker is not started until {@link start}.
     *
     * @param spec - Normalised plugin specification from discovery.
     * @param options - Logger and crash callback used for worker failures.
     */
    constructor(spec, options = {}) {
        const { logger, onCrash } = options;
        this.spec = spec;
        this.logger = logger;
        this.onCrash = onCrash;
        this.capabilities = { tools: true, events: true, logger: true, effect: true, commands: true };
    }
    /**
     * The worker thread cannot call the host synchronously, and version 1
     * declares registrations as the apply result, so no inbound channel exists.
     *
     * @param _handler - Ignored.
     */
    setInboundHandler(_handler) {
        // Version 1 has no inbound registration channel for this backend.
    }
    /**
     * Start the worker and wait for its initialization handshake.
     *
     * @returns This instance.
     * @throws {Error} When the worker cannot start or the module fails to
     *   initialize. The worker is terminated before the error is thrown.
     */
    async start() {
        this.worker = await this.#spawnWorker();
        return this;
    }
    /**
     * Create the worker and resolve when it reports ready.
     *
     * @returns The started worker.
     * @throws {Error} When initialization fails, exceeds the startup deadline,
     *   or the worker exits early.
     */
    #spawnWorker() {
        const worker = new Worker(new URL('./wasm-worker.js', import.meta.url), {
            workerData: { entry: this.spec.entry },
            // Caps the worker's JavaScript heap only. WebAssembly linear memory is
            // external memory and is not covered by this limit.
            resourceLimits: { maxOldGenerationSizeMb: 256 },
        });
        const startupMs = this.spec.timeouts.startupMs;
        return new Promise((resolve, reject) => {
            let timer;
            const cleanup = () => {
                if (timer !== undefined)
                    clearTimeout(timer);
                worker.off('message', onMessage);
                worker.off('error', onError);
                worker.off('exit', onExit);
            };
            // The host owns the startup deadline because the worker cannot interrupt
            // its own looping initialization.
            timer = setTimeout(() => {
                cleanup();
                void worker.terminate().catch(() => {
                    // The worker may already be gone when termination races its exit.
                });
                reject(new Error(`[${this.spec.id}] wasm init exceeded ${startupMs}ms; worker terminated`));
            }, startupMs);
            const onMessage = (message) => {
                if (message.type === 'ready') {
                    cleanup();
                    worker.on('message', (reply) => this.#onReply(reply));
                    worker.on('error', (error) => this.#onWorkerError(worker, error));
                    worker.on('exit', (code) => this.#onWorkerExit(worker, code));
                    resolve(worker);
                }
                else if (message.type === 'init-error') {
                    cleanup();
                    reject(new Error(`[${this.spec.id}] wasm init failed: ${message.error ?? 'unknown error'}`));
                }
            };
            const onError = (error) => {
                cleanup();
                reject(new Error(`[${this.spec.id}] wasm worker error: ${error.message}`));
            };
            const onExit = (code) => {
                cleanup();
                reject(new Error(`[${this.spec.id}] wasm worker exited during init (code=${code})`));
            };
            worker.on('message', onMessage);
            worker.on('error', onError);
            worker.on('exit', onExit);
        });
    }
    /**
     * Fail every pending call and terminate the worker after an unexpected
     * failure. The failure is reported to the loader once, and only after the
     * plugin was applied; a startup or apply failure reaches the loader through
     * the rejected promise instead.
     *
     * @param reason - Failure category reported to the loader.
     * @param message - Failure detail without the plugin id prefix.
     */
    #abort(reason, message) {
        if (this.failed || this.stopped)
            return;
        this.failed = true;
        const worker = this.worker;
        // Clear the handle first, so a late reply or exit from the terminated
        // worker is ignored instead of settling a call that already failed.
        this.worker = null;
        const error = new Error(`[${this.spec.id}] ${message}`);
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(error);
            this.pending.delete(id);
        }
        if (worker !== null) {
            void worker.terminate().catch(() => {
                // The worker may already be gone when termination races its exit.
            });
        }
        this.logger?.error?.(`[${this.spec.id}] ${message}`);
        if (this.applied)
            this.onCrash?.(this.spec.id, { reason, message });
    }
    /**
     * Handle an error event from the worker after the plugin was applied.
     *
     * @param worker - Worker that reported the error.
     * @param error - Error the worker reported.
     */
    #onWorkerError(worker, error) {
        if (this.worker !== worker)
            return;
        this.#abort('error', `wasm worker error: ${messageOf(error)}`);
    }
    /**
     * Handle the worker thread exiting after the plugin was applied.
     *
     * @param worker - Worker that exited.
     * @param code - Exit code of the worker thread.
     */
    #onWorkerExit(worker, code) {
        if (this.worker !== worker)
            return;
        this.#abort('exit', `wasm worker exited (code=${code})`);
    }
    /**
     * Handle one reply from the worker.
     *
     * @param reply - Message the worker sent for one host call.
     */
    #onReply(reply) {
        const id = reply.id;
        const entry = typeof id === 'number' ? this.pending.get(id) : undefined;
        if (entry === undefined || typeof id !== 'number')
            return;
        this.pending.delete(id);
        clearTimeout(entry.timer);
        if (reply.ok !== true) {
            entry.reject(new Error(reply.error ?? 'wasm plugin call failed'));
            return;
        }
        if (!reply.text) {
            entry.resolve(undefined);
            return;
        }
        let frame;
        try {
            frame = JSON.parse(reply.text);
        }
        catch (error) {
            entry.reject(new Error(`[${this.spec.id}] wasm returned invalid JSON: ${messageOf(error)}`));
            return;
        }
        if (frame.ok === false) {
            entry.reject(new Error(frame.error?.message ?? 'wasm plugin call failed'));
            return;
        }
        entry.resolve(frame.result);
    }
    /**
     * Send one request to the worker and wait for its reply.
     *
     * The deadline is enforced by the host thread. On expiry every pending call
     * fails, the worker is terminated and the loader is told once, because
     * terminating the worker is the only way to stop a looping instance.
     *
     * @param op - Operation name.
     * @param payload - Operation payload.
     * @param timeoutMs - Deadline for the reply.
     * @returns The result the plugin returned.
     * @throws {Error} When the plugin rejects the call, the worker fails, or the
     *   deadline expires.
     */
    #invoke(op, payload, timeoutMs) {
        const worker = this.worker;
        if (worker === null || this.stopped || this.failed) {
            return Promise.reject(new Error(`plugin ${this.spec.id} is not running`));
        }
        const id = ++this.seq;
        return new Promise((resolve, reject) => {
            let entry;
            const timer = setTimeout(() => {
                // A stop or an earlier failure already settled this call; the timer
                // must not report the plugin twice.
                if (entry === undefined || this.pending.get(id) !== entry)
                    return;
                this.#abort('timeout', `wasm call "${op}" timed out after ${timeoutMs}ms `
                    + '(worker terminated; the plugin may contain an infinite loop)');
            }, timeoutMs);
            entry = { resolve, reject, timer };
            this.pending.set(id, entry);
            try {
                worker.postMessage({ id, op, payload });
            }
            catch (error) {
                if (this.pending.get(id) === entry) {
                    clearTimeout(timer);
                    this.pending.delete(id);
                    reject(new Error(`[${this.spec.id}] postMessage failed: ${messageOf(error)}`));
                }
            }
        });
    }
    /**
     * Deliver the apply request and perform the registrations the plugin
     * declared in its result.
     *
     * @param registrar - Ledger that performs the real registrations.
     * @returns The registered tool names and event names.
     * @throws {Error} When the call fails or times out, or the worker exits while
     *   the registrations are being performed.
     */
    async apply(registrar) {
        const result = await this.#invoke('apply', { inject: this.spec.inject }, this.spec.timeouts.startupMs);
        const tools = Array.isArray(result?.tools) ? result.tools : [];
        for (const toolSpec of tools) {
            await registrar.handle('tools.register', { tool: toolSpec });
        }
        const events = Array.isArray(result?.events) ? result.events : [];
        for (const event of events) {
            await registrar.handle('events.on', { event });
        }
        const commands = Array.isArray(result?.commands) ? result.commands : [];
        for (const command of commands) {
            await registrar.handle('commands.register', { command });
        }
        // The worker can die while the host performs these registrations, and no
        // pending call exists to fail in that window. Reporting the plugin as
        // applied would leave a dead backend behind a registered tool, so the
        // apply handshake reports the exit instead and the loader marks it failed.
        if (this.worker === null || this.stopped) {
            throw new Error(`[${this.spec.id}] wasm worker exited during apply`);
        }
        this.applied = true;
        return {
            tools: tools.map((tool) => tool.name),
            events: events,
        };
    }
    /**
     * Call one tool registered by this plugin.
     *
     * @param name - Tool name as registered by the plugin.
     * @param args - Arguments supplied by the model.
     * @returns The JSON value the plugin returned.
     * @throws {Error} When the call fails or times out.
     */
    async callTool(name, args, _signal) {
        return await this.#invoke('tool.call', { tool: name, args }, this.spec.timeouts.callMs);
    }
    /**
     * Run one command node declared by this plugin.
     *
     * The command node id routes the call; the text after the command name is
     * passed verbatim. The deadline is the manifest call timeout. A timeout on
     * this path follows the same rule as a tool call: the worker is terminated
     * and the plugin becomes failed.
     *
     * @param command - Command node id the plugin declared.
     * @param input - Text after the command name.
     * @returns The command result the plugin returned.
     * @throws {Error} When the command fails or the deadline expires.
     */
    async callCommand(command, input) {
        return await this.#invoke('command.call', { command, input }, this.spec.timeouts.callMs);
    }
    /**
     * Deliver one host event to the plugin.
     *
     * Arguments are projected into plain data before they cross the thread
     * boundary, because `postMessage` uses structured clone and throws on host
     * objects. A failed delivery is logged and resolves to undefined.
     *
     * @param event - Event name from the whitelist.
     * @param args - Listener arguments, without the waterfall `next` function.
     * @returns The plugin handler result, or undefined when delivery failed.
     */
    async dispatchEvent(event, args) {
        try {
            return await this.#invoke('event', { event, args: projectEventArgs(event, args) }, this.spec.timeouts.callMs);
        }
        catch (error) {
            this.logger?.warn?.(`[${this.spec.id}] event ${event} failed: ${messageOf(error)}`);
            return undefined;
        }
    }
    /**
     * Stop the backend: fail pending calls and terminate the worker.
     *
     * Idempotent. The worker handle is cleared first, so a late message from a
     * terminated worker is ignored. A stop requested by the loader is not a
     * failure and is never reported through `onCrash`.
     *
     * @param _reason - Ignored; a worker has no graceful shutdown channel.
     */
    async stop(_reason) {
        this.stopped = true;
        const worker = this.worker;
        this.worker = null;
        for (const [id, entry] of this.pending) {
            clearTimeout(entry.timer);
            entry.reject(new Error(`[${this.spec.id}] plugin stopped`));
            this.pending.delete(id);
        }
        if (worker !== null) {
            try {
                await worker.terminate();
            }
            catch {
                // The worker already exited.
            }
        }
    }
}
/**
 * Factory the loader uses to create and start a WebAssembly backend instance.
 */
export const wasmBackend = {
    /** Backend kind, matching `manifest.backend`. */
    kind: 'wasm',
    /**
     * Create one instance and complete its startup handshake.
     *
     * @param spec - Normalised plugin specification.
     * @param options - Logger used for worker failures.
     * @returns The started instance.
     * @throws {Error} When the worker cannot be started.
     */
    async createInstance(spec, options) {
        const instance = new WasmBackendInstance(spec, options);
        await instance.start();
        return instance;
    },
};
