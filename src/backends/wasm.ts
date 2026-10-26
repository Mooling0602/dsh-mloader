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
 * The ABI is the core WebAssembly ABI specified in `docs/ABI.md` §7.
 *
 * @module backends/wasm
 */

import { Worker } from 'node:worker_threads'
import { projectEventArgs } from '../serialize.js'
import type {
  ApplyResult,
  BackendInstance,
  LoaderLogger,
  PluginCapabilities,
  PluginSpec,
  RegistrarHandle,
} from '../types.js'

/** A message a worker sends to the host. */
interface WorkerMessage {
  type?: 'ready' | 'init-error'
  id?: number
  ok?: boolean
  text?: string
  error?: string
}

/** A host call waiting for its worker reply. */
interface PendingInvocation {
  resolve(value: unknown): void
  reject(error: Error): void
  timer: ReturnType<typeof setTimeout>
}

/** Declarative registration result a WebAssembly plugin returns from apply. */
interface WasmApplyResult {
  tools?: unknown[]
  events?: unknown[]
}

/** The JSON object a WebAssembly plugin returns as a call result. */
interface WasmReplyFrame {
  ok?: boolean
  error?: { message?: string }
  result?: unknown
}

/** Options of a WebAssembly backend instance. */
export interface WasmBackendOptions {
  /** Loader logger. Worker lifecycle failures are reported through it. */
  logger?: LoaderLogger
}

/** Return the message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Backend for one WebAssembly plugin, hosted in one worker thread.
 *
 * The instance owns the worker from `start()` until `stop()`. A timeout
 * terminates the worker, because terminating it is the only mechanism that
 * stops a looping instance; the host then reports the call as failed and stays
 * running.
 */
export class WasmBackendInstance implements BackendInstance {
  /** Specification of the hosted plugin. */
  readonly spec: PluginSpec

  /** Capabilities the manifest declared, carried for the loader's bookkeeping. */
  readonly capabilities: PluginCapabilities

  private readonly logger: LoaderLogger | undefined

  private worker: Worker | null = null
  private stopped = false
  private seq = 0
  private readonly pending = new Map<number, PendingInvocation>()

  /**
   * Create the instance. The worker is not started until {@link start}.
   *
   * @param spec - Normalised plugin specification from discovery.
   * @param options - Logger used for worker failures.
   */
  constructor(spec: PluginSpec, options: WasmBackendOptions = {}) {
    this.spec = spec
    this.logger = options.logger
    this.capabilities = { tools: true, events: true, logger: true, effect: true }
  }

  /**
   * The worker thread cannot call the host synchronously, and version 1
   * declares registrations as the apply result, so no inbound channel exists.
   *
   * @param _handler - Ignored.
   */
  setInboundHandler(_handler: (op: string, payload: Record<string, unknown>) => Promise<unknown>): void {
    // Version 1 has no inbound registration channel for this backend.
  }

  /**
   * Start the worker and wait for its initialization handshake.
   *
   * @returns This instance.
   * @throws {Error} When the worker cannot start or the module fails to
   *   initialize. The worker is terminated before the error is thrown.
   */
  async start(): Promise<this> {
    this.worker = await this.#spawnWorker()
    return this
  }

  /**
   * Create the worker and resolve when it reports ready.
   *
   * @returns The started worker.
   * @throws {Error} When initialization fails or the worker exits early.
   */
  #spawnWorker(): Promise<Worker> {
    const worker = new Worker(new URL('./wasm-worker.js', import.meta.url), {
      workerData: { entry: this.spec.entry },
      // Best effort memory limit, so a plugin cannot exhaust the host heap.
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })

    return new Promise<Worker>((resolve, reject) => {
      const cleanup = (): void => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      const onMessage = (message: WorkerMessage): void => {
        if (message.type === 'ready') {
          cleanup()
          worker.on('message', (reply: WorkerMessage) => this.#onReply(reply))
          worker.on('exit', (code: number) => this.#onWorkerExit(worker, code))
          resolve(worker)
        } else if (message.type === 'init-error') {
          cleanup()
          reject(new Error(`[${this.spec.id}] wasm init failed: ${message.error ?? 'unknown error'}`))
        }
      }
      const onError = (error: Error): void => {
        cleanup()
        reject(new Error(`[${this.spec.id}] wasm worker error: ${error.message}`))
      }
      const onExit = (code: number): void => {
        cleanup()
        reject(new Error(`[${this.spec.id}] wasm worker exited during init (code=${code})`))
      }
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
    })
  }

  /**
   * Handle the worker thread exiting: fail pending calls when it was not
   * replaced or terminated by the host.
   *
   * @param worker - Worker that exited.
   * @param code - Exit code of the worker thread.
   */
  #onWorkerExit(worker: Worker, code: number): void {
    if (this.worker !== worker) return
    this.logger?.warn?.(`[${this.spec.id}] wasm worker exited (code=${code})`)
    this.worker = null
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`[${this.spec.id}] wasm worker exited (code=${code})`))
      this.pending.delete(id)
    }
  }

  /**
   * Handle one reply from the worker.
   *
   * @param reply - Message the worker sent for one host call.
   */
  #onReply(reply: WorkerMessage): void {
    const id = reply.id
    const entry = typeof id === 'number' ? this.pending.get(id) : undefined
    if (entry === undefined || typeof id !== 'number') return
    this.pending.delete(id)
    clearTimeout(entry.timer)

    if (reply.ok !== true) {
      entry.reject(new Error(reply.error ?? 'wasm plugin call failed'))
      return
    }
    if (!reply.text) {
      entry.resolve(undefined)
      return
    }
    let frame: WasmReplyFrame
    try {
      frame = JSON.parse(reply.text) as WasmReplyFrame
    } catch (error: unknown) {
      entry.reject(new Error(`[${this.spec.id}] wasm returned invalid JSON: ${messageOf(error)}`))
      return
    }
    if (frame.ok === false) {
      entry.reject(new Error(frame.error?.message ?? 'wasm plugin call failed'))
      return
    }
    entry.resolve(frame.result)
  }

  /**
   * Send one request to the worker and wait for its reply.
   *
   * The deadline is enforced by the host thread. On expiry the worker is
   * terminated, because that is the only way to stop a looping instance.
   *
   * @param op - Operation name.
   * @param payload - Operation payload.
   * @param timeoutMs - Deadline for the reply.
   * @returns The result the plugin returned.
   * @throws {Error} When the plugin rejects the call, the worker fails, or the
   *   deadline expires.
   */
  #invoke(op: string, payload: unknown, timeoutMs: number): Promise<unknown> {
    const worker = this.worker
    if (worker === null || this.stopped) {
      return Promise.reject(new Error(`plugin ${this.spec.id} is not running`))
    }
    const id = ++this.seq

    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.pending.delete(id)
        this.logger?.error?.(
          `[${this.spec.id}] wasm "${op}" exceeded ${timeoutMs}ms; terminating worker`,
        )
        // The worker handle is cleared before terminating, so a late reply is
        // ignored instead of resolving a call the host already failed.
        this.worker = null
        try {
          await worker.terminate()
        } catch {
          // The worker already exited.
        }
        reject(
          new Error(
            `[${this.spec.id}] wasm call "${op}" timed out after ${timeoutMs}ms `
            + '(worker terminated; the plugin may contain an infinite loop)',
          ),
        )
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ id, op, payload })
      } catch (error: unknown) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`[${this.spec.id}] postMessage failed: ${messageOf(error)}`))
      }
    })
  }

  /**
   * Deliver the apply request and perform the registrations the plugin
   * declared in its result.
   *
   * @param registrar - Ledger that performs the real registrations.
   * @returns The registered tool names and event names.
   * @throws {Error} When the call fails or times out.
   */
  async apply(registrar: RegistrarHandle): Promise<ApplyResult | undefined> {
    const result = await this.#invoke(
      'apply',
      { inject: this.spec.inject },
      this.spec.timeouts.startupMs,
    ) as WasmApplyResult | undefined

    const tools = Array.isArray(result?.tools) ? result.tools : []
    for (const toolSpec of tools) {
      await registrar.handle('tools.register', { tool: toolSpec })
    }

    const events = Array.isArray(result?.events) ? result.events : []
    for (const event of events) {
      await registrar.handle('events.on', { event })
    }

    return {
      tools: tools.map((tool) => (tool as { name?: string }).name) as string[],
      events: events as string[],
    }
  }

  /**
   * Call one tool registered by this plugin.
   *
   * @param name - Tool name as registered by the plugin.
   * @param args - Arguments supplied by the model.
   * @returns The JSON value the plugin returned.
   * @throws {Error} When the call fails or times out.
   */
  async callTool(name: string, args: unknown, _signal?: unknown): Promise<unknown> {
    return await this.#invoke('tool.call', { tool: name, args }, this.spec.timeouts.callMs)
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
  async dispatchEvent(event: string, args: unknown[]): Promise<unknown> {
    try {
      return await this.#invoke(
        'event',
        { event, args: projectEventArgs(event, args) },
        this.spec.timeouts.callMs,
      )
    } catch (error: unknown) {
      this.logger?.warn?.(`[${this.spec.id}] event ${event} failed: ${messageOf(error)}`)
      return undefined
    }
  }

  /**
   * Stop the backend: fail pending calls and terminate the worker.
   *
   * Idempotent. The worker handle is cleared first, so a late message from a
   * terminated worker is ignored.
   *
   * @param _reason - Ignored; a worker has no graceful shutdown channel.
   */
  async stop(_reason?: string): Promise<void> {
    this.stopped = true
    const worker = this.worker
    this.worker = null

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`[${this.spec.id}] plugin stopped`))
      this.pending.delete(id)
    }

    if (worker !== null) {
      try {
        await worker.terminate()
      } catch {
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
  kind: 'wasm' as const,

  /**
   * Create one instance and complete its startup handshake.
   *
   * @param spec - Normalised plugin specification.
   * @param options - Logger used for worker failures.
   * @returns The started instance.
   * @throws {Error} When the worker cannot be started.
   */
  async createInstance(spec: PluginSpec, options: WasmBackendOptions): Promise<WasmBackendInstance> {
    const instance = new WasmBackendInstance(spec, options)
    await instance.start()
    return instance
  },
}
