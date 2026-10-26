/**
 * Cordis plugin entry for dsh-mloader and the manager of the plugins it hosts.
 *
 * This module is an ordinary Cordis plugin. The plugins it hosts are not Cordis
 * plugins: they create no fiber and no context of their own, and every
 * capability they declare is registered on the loader's context and tracked in
 * that plugin's registrar ledger.
 *
 * Startup is asynchronous. `apply()` registers the status surfaces, seeds the
 * bundled examples, starts plugin boot in the background and returns, so the
 * loader never blocks the harness on a slow external plugin. When its fiber
 * leaves the active state the loader aborts a boot that is still in flight and
 * then tears the hosted plugins down, registrations first and backends second.
 *
 * A hosted plugin can also be switched on and off while the loader runs. The
 * operator surfaces are the `/mloader` command and, when the harness provides a
 * web server, the routes in `http.ts`. A toggle changes this process only: the
 * manifest on disk is never rewritten, so the next start follows the manifest
 * again.
 *
 * @module index
 */
import { discover } from './discovery.js';
import { PluginRegistrar } from './registrar.js';
import { PythonBackendInstance } from './backends/python.js';
import { PLUGIN_STATE, profilePluginsDir, resolveProfileDir, resolveRoots } from './contract.js';
import { WasmBackendInstance } from './backends/wasm.js';
import { createStatusTool } from './tools/status.js';
import { DEFAULT_COMMAND_NAME, registerMloaderCommand } from './commands/mloader.js';
import { registerMloaderHttp, WasmDisabledError } from './http.js';
import { installSeedExamples } from './seed.js';
import { createConsole } from './console.js';
/** Name the harness mounts the loader under. */
export const name = 'dsh-mloader';
/**
 * Services the loader needs before it mounts.
 *
 * Only `tools` is required. The optional `commands` service is probed at
 * runtime, so a harness without it still mounts the loader and its plugins.
 */
export const inject = ['tools'];
/** Settings applied when the plugin config omits a key. */
const DEFAULTS = {
    roots: [],
    profilePlugins: true,
    profileDir: undefined,
    autoEnable: true,
    pythonBin: 'python3',
    statusTool: true,
    command: true,
    seedExamples: true,
    console: true,
    wasm: { enabled: false },
};
/**
 * Owns every external plugin hosted by the loader.
 *
 * The manager creates one registrar per discovered plugin, holds that plugin's
 * backend instance, and drives startup, reload, unload and teardown. The loader
 * owns the lifecycle of its plugins: the harness never sees them.
 *
 * Teardown and unload dispose the registrar ledger before stopping the backend,
 * so a cancelled registration is visible to the harness immediately while a
 * slow process exit does not delay it. A backend that fails to stop is a
 * warning, never a failed unload. A backend crash revokes the registrations of
 * its own plugin only; the loader and the other plugins keep running.
 */
export class PluginManager {
    /** Context of the loader plugin. All host registrations happen on it. */
    ctx;
    /** Loader logger, kept separate from the terminal output channel. */
    logger;
    /** Plugin config plus the resolved roots and output channel. */
    config;
    /** Terminal output channel; the logger never prints. */
    out;
    /** One registrar per plugin id, in discovery order. */
    records = new Map();
    /** True once teardown started; later teardown calls are no-ops. */
    disposed = false;
    /** True once unload or teardown aborted startup; boot stops starting plugins. */
    aborted = false;
    /** Background boot task, so teardown can wait for it to finish creating instances. */
    bootTask;
    /**
     * @param ctx - Context of the loader plugin.
     * @param logger - Loader logger, or undefined when the harness provides none.
     * @param config - Plugin config with the resolved roots and output channel.
     */
    constructor(ctx, logger, config) {
        this.ctx = ctx;
        this.logger = logger;
        this.config = config;
        this.out = config.out ?? createConsole(config);
    }
    /**
     * Discover and start the configured plugins.
     *
     * One failing plugin does not stop the others. Boot stops starting plugins as
     * soon as `aborted` is set by a concurrent teardown. The method resolves
     * after the summary line, so the caller learns when the background startup is
     * complete.
     */
    async boot() {
        const roots = this.config.resolvedRoots ?? resolveRoots(this.config.roots);
        const { specs, errors } = await discover(roots, this.logger);
        for (const error of errors)
            this.logger?.warn?.(`discovery: ${error.message}`);
        this.logger?.info?.(`dsh-mloader: discovered ${specs.length} plugin(s) in ${roots.length} root(s)`);
        this.out.detail(`scanned ${roots.length} root(s), found ${specs.length} plugin(s)`);
        for (const spec of specs) {
            if (this.aborted)
                break;
            const record = this.#createRegistrar(spec);
            this.records.set(spec.id, record);
            if (!spec.enabled) {
                record.state = PLUGIN_STATE.DISABLED;
                this.logger?.info?.(`[${spec.id}] disabled by manifest`);
                this.out.lifecycle(`skipped ${spec.id} (disabled in manifest)`);
                continue;
            }
            if (this.config.autoEnable === false) {
                record.state = PLUGIN_STATE.DISCOVERED;
                continue;
            }
            // The WebAssembly path is opt-in until its failure injection coverage is complete.
            if (spec.backend === 'wasm' && this.config.wasm?.enabled !== true) {
                record.state = PLUGIN_STATE.DISABLED;
                record.error = 'wasm backend disabled (set config.wasm.enabled = true to opt in)';
                this.logger?.warn?.(`[${spec.id}] skipped: ${record.error}`);
                this.out.lifecycle(`skipped ${spec.id} (wasm backend is disabled)`);
                continue;
            }
            try {
                await this.#startSafely(record);
            }
            catch {
                // #startSafely reported the failure and left the record failed; boot continues.
            }
        }
        if (this.aborted) {
            this.out.detail('startup aborted');
            return;
        }
        const applied = [...this.records.values()].filter((record) => record.state === PLUGIN_STATE.APPLIED);
        const failed = [...this.records.values()].filter((record) => record.state === PLUGIN_STATE.FAILED);
        const tail = failed.length > 0 ? `, ${failed.length} failed` : '';
        this.out.lifecycle(`ready: ${applied.length} plugin(s) mounted${tail}`);
        if (applied.length === 0 && this.records.size > 0) {
            this.out.warn('no plugins were mounted');
        }
    }
    /**
     * Create the registrar ledger for one plugin spec.
     *
     * Every start creates a fresh registrar because a disposed ledger is single
     * use. A tool call is refused unless the record is applied, and an event is
     * delivered to the backend instance the record currently owns.
     *
     * @param spec - Normalised plugin specification.
     * @returns A registrar with an empty ledger.
     */
    #createRegistrar(spec) {
        const record = new PluginRegistrar(spec, this.ctx, this.logger, async (tool, args) => {
            if (record.state !== PLUGIN_STATE.APPLIED) {
                throw new Error(`plugin ${spec.id} is not active (state=${record.state})`);
            }
            return await record.instance.callTool(tool, args);
        }, async (event, args) => await record.instance.dispatchEvent(event, args));
        return record;
    }
    /**
     * Start one plugin: create its backend, run the handshake and apply its
     * registrations.
     *
     * The backend instance is attached to the registrar before it is started, so
     * teardown can stop an instance whose start is still in flight and no child
     * process can be orphaned. When startup is aborted during apply, the instance
     * is stopped here and the plugin is left in the loaded state for teardown.
     */
    async #start(record) {
        const spec = record.spec;
        record.state = PLUGIN_STATE.LOADED;
        const instance = spec.backend === 'python'
            ? new PythonBackendInstance(spec, {
                logger: this.logger,
                pythonBin: this.config.pythonBin,
                onCrash: (pluginId, info) => this.#onPythonCrash(record, pluginId, info),
            })
            : new WasmBackendInstance(spec, { logger: this.logger });
        record.instance = instance;
        await instance.start();
        instance.setInboundHandler?.(async (op, payload) => await record.handle(op, payload));
        const result = await instance.apply(record);
        if (this.aborted) {
            try {
                await instance.stop('aborted during apply');
            }
            catch {
                // The process is already gone.
            }
            record.instance = null;
            return undefined;
        }
        record.state = PLUGIN_STATE.APPLIED;
        const tools = result?.tools ?? [];
        const events = result?.events ?? [];
        this.logger?.info?.(`[${spec.id}] ready (${spec.backend}); ` +
            `tools=[${tools.join(',')}] events=[${events.join(',')}]`);
        const toolSuffix = tools.length > 0 ? `, tools: ${tools.join(', ')}` : '';
        this.out.lifecycle(`mounted ${spec.id} (${spec.backend}${toolSuffix})`);
        return result;
    }
    /**
     * Start a record and clean up after a failed start.
     *
     * A failed start can leave a backend running and partial registrations
     * attached, so the ledger is disposed, the backend stopped and the record
     * marked failed before the original error is rethrown. Boot and the runtime
     * toggle share this path, which keeps their cleanup identical.
     *
     * @param record - Plugin to start.
     * @returns The apply result on success.
     * @throws The original startup error, after the cleanup above.
     */
    async #startSafely(record) {
        try {
            return await this.#start(record);
        }
        catch (error) {
            const message = messageOf(error);
            record.error = message;
            record.state = PLUGIN_STATE.FAILED;
            this.logger?.error?.(`[${record.spec.id}] failed: ${message}`);
            this.out.error(`plugin ${record.spec.id} failed: ${message}`);
            record.dispose();
            try {
                await record.instance?.stop('startup failed');
            }
            catch {
                // The process is already gone when start() failed late.
            }
            record.instance = null;
            record.state = PLUGIN_STATE.FAILED;
            throw error;
        }
    }
    /**
     * Handle the unexpected exit of a plugin process.
     *
     * The dead plugin's registrations are revoked and it is marked failed. The
     * loader and the other hosted plugins are not affected, and nothing restarts
     * the crashed plugin on its own. The backend stopped itself when its process
     * exited, so its handle is cleared here too: keeping it would make a later
     * `enable()` believe a backend is still running and silently refuse the retry.
     */
    #onPythonCrash(record, pluginId, info) {
        this.logger?.warn?.(`[${pluginId}] python process died (code=${info.code} signal=${info.signal})`);
        this.out.warn(`plugin ${pluginId} process exited (code=${info.code}, signal=${info.signal}); registrations revoked`);
        record.dispose();
        record.instance = null;
        record.state = PLUGIN_STATE.FAILED;
        record.error = `process exited (code=${info.code}, signal=${info.signal})`;
    }
    /** Return a status snapshot of every tracked plugin, in tracking order. */
    list() {
        return [...this.records.values()].map((record) => record.snapshot());
    }
    /**
     * Stop and start one plugin, keeping its manifest.
     *
     * The old instance is stopped before the new one is created, so a reload never
     * runs two backends for the same plugin id. No unload line is printed because
     * the plugin stays tracked. A failed restart leaves the record failed with the
     * error recorded, after its partial registrations and backend are cleaned up.
     *
     * @param id - Plugin id.
     * @returns The snapshot after the plugin is applied again.
     * @throws {Error} When no plugin with the id is tracked, or when the restart
     *   fails; the failed record stays in the status surfaces.
     */
    async reload(id) {
        const record = this.records.get(id);
        if (!record)
            throw new Error(`unknown plugin "${id}"`);
        const spec = record.spec;
        this.out.lifecycle(`reloading ${id}`);
        await this.#stop(record, 'reload');
        const fresh = this.#createRegistrar(spec);
        this.records.set(id, fresh);
        await this.#startSafely(fresh);
        return fresh.snapshot();
    }
    /**
     * Start a plugin that is currently not running.
     *
     * The record keeps its manifest, so a plugin stopped by `enabled: false` in
     * the manifest, or left discovered by `autoEnable: false`, can be started
     * manually. A start failure leaves the record failed with the error message
     * and rethrows; its partial registrations are revoked and its backend is
     * stopped by then.
     *
     * @param id - Plugin id.
     * @returns The snapshot after the plugin is applied.
     * @throws {Error} When no plugin with the id is tracked, when the plugin uses
     *   a WebAssembly backend that the config has not enabled, or when startup
     *   fails.
     */
    async enable(id) {
        const record = this.records.get(id);
        if (!record)
            throw new Error(`unknown plugin "${id}"`);
        // An applied or starting plugin already owns a backend instance; starting a
        // second backend for the same id would orphan the first one.
        if (record.state === PLUGIN_STATE.APPLIED || record.instance !== null)
            return record.snapshot();
        if (record.spec.backend === 'wasm' && this.config.wasm?.enabled !== true) {
            throw new WasmDisabledError();
        }
        const fresh = this.#createRegistrar(record.spec);
        this.records.set(id, fresh);
        await this.#startSafely(fresh);
        return fresh.snapshot();
    }
    /**
     * Stop a running plugin without forgetting it.
     *
     * The ledger is disposed before the backend is stopped, so the harness stops
     * seeing the plugin's registrations immediately. The record stays tracked in
     * the disabled state and can be enabled again through the same surfaces. A
     * failing backend stop is a warning, not a failed disable.
     *
     * @param id - Plugin id.
     * @returns The snapshot after the change, or the unchanged snapshot when the
     *   plugin was neither applied nor starting.
     * @throws {Error} When no plugin with the id is tracked.
     */
    async disable(id) {
        const record = this.records.get(id);
        if (!record)
            throw new Error(`unknown plugin "${id}"`);
        if (record.state !== PLUGIN_STATE.APPLIED && record.state !== PLUGIN_STATE.LOADED) {
            return record.snapshot();
        }
        await this.#stop(record, 'disable');
        record.state = PLUGIN_STATE.DISABLED;
        record.error = null;
        return record.snapshot();
    }
    /**
     * Switch one plugin on or off.
     *
     * @param id - Plugin id.
     * @param enabled - True starts the plugin, false stops it.
     * @returns The resulting snapshot.
     * @throws {Error} When no plugin with the id is tracked or the transition fails.
     */
    async setEnabled(id, enabled) {
        return enabled ? await this.enable(id) : await this.disable(id);
    }
    /**
     * Unload and forget one plugin.
     *
     * Its registrations are revoked before its backend is stopped. The removed
     * record is gone from the status surfaces afterwards.
     *
     * @param id - Plugin id.
     * @throws {Error} When no plugin with the id is tracked.
     */
    async unload(id) {
        const record = this.records.get(id);
        if (!record)
            throw new Error(`unknown plugin "${id}"`);
        await this.#stop(record, 'unload');
        this.records.delete(id);
        return { id, state: PLUGIN_STATE.DISPOSED };
    }
    /**
     * Stop one plugin: dispose its registrations, then stop its backend.
     *
     * The order matters. Disposing the ledger is immediate for the harness, while
     * stopping the backend can take a moment. A failing stop is reported as a
     * warning and does not fail the caller.
     *
     * @param record - Plugin to stop.
     * @param reason - Why the plugin is stopped. A reload prints no unload line.
     */
    async #stop(record, reason = 'unload') {
        record.dispose();
        try {
            await record.instance?.stop('loader unload');
        }
        catch (error) {
            const message = messageOf(error);
            this.logger?.warn?.(`[${record.spec.id}] backend stop failed: ${message}`);
            this.out.warn(`plugin ${record.spec.id} backend did not stop cleanly: ${message}`);
        }
        record.instance = null;
        if (reason !== 'reload') {
            this.out.lifecycle(`unloaded ${record.spec.id}`);
        }
    }
    /**
     * Stop the whole manager when the loader plugin is disposed.
     *
     * Teardown aborts an in-flight boot first and waits for it to stop creating
     * instances, then stops every record still tracked, including one created by
     * the boot task after teardown started. Safe to call more than once.
     */
    async teardown() {
        if (this.disposed)
            return;
        this.disposed = true;
        this.aborted = true;
        this.logger?.info?.('dsh-mloader: unloading all external plugins');
        const count = this.records.size;
        if (count > 0)
            this.out.lifecycle('unloading plugins');
        this.abortStartup();
        if (this.bootTask !== undefined) {
            try {
                await this.bootTask;
            }
            catch {
                // boot() handles its own failures. Teardown only waits for it to finish.
            }
        }
        for (const record of this.records.values()) {
            await this.#stop(record, 'teardown');
        }
        this.records.clear();
        if (count > 0)
            this.out.lifecycle('unloaded');
    }
    /**
     * Abort a startup that is still in flight.
     *
     * Stopping every in-flight instance makes the awaited handshake fail fast, so
     * the background boot finishes quickly and teardown is not held for the
     * startup timeout of a slow plugin.
     */
    abortStartup() {
        this.aborted = true;
        for (const record of this.records.values()) {
            try {
                record.instance?.stop('loader aborting');
            }
            catch {
                // Stopping during an abort may fail because the instance is already gone.
            }
        }
    }
}
/**
 * Mount the loader plugin.
 *
 * The loader resolves its plugin roots and seeds the bundled examples before it
 * discovers plugins, then starts boot in the background and returns without
 * waiting for it. It installs two cleanup effects before boot starts: one aborts
 * an in-flight startup as soon as the fiber leaves the active state, the other
 * runs the full teardown. This ordering is what keeps unloading fast when a
 * hosted plugin is stuck in its own startup.
 *
 * @param ctx - Cordis context of the loader plugin.
 * @param config - Plugin config; omitted keys come from the defaults.
 */
export async function apply(ctx, config = {}) {
    const settings = { ...DEFAULTS, ...config };
    const injected = typeof ctx.get === 'function' ? ctx.get('logger') : undefined;
    const logger = injected ?? ctx.logger?.('mloader') ?? ctx.logger;
    const out = createConsole(settings);
    const baseUrl = typeof ctx.baseUrl === 'string' ? ctx.baseUrl : undefined;
    const wantProfileDir = settings.profilePlugins !== false;
    const roots = resolveRoots(settings.roots, {
        includeProfileDir: wantProfileDir,
        profileDir: settings.profileDir,
        baseUrl,
    });
    const detectedProfile = resolveProfileDir(settings.profileDir, baseUrl);
    if (wantProfileDir && detectedProfile === undefined) {
        logger?.warn?.('dsh-mloader: profile directory not detected (DSH_PROFILE_DIR and DSH_HOME/DSH_PROFILE are ' +
            'unavailable); skipped <profile>/mloader/plugins. Set config.roots explicitly when plugins ' +
            'are installed in the profile.');
        out.warn('profile directory not detected; <profile>/mloader/plugins was skipped');
    }
    if (roots.length === 0) {
        logger?.warn?.('dsh-mloader: no roots configured; set config.roots to a plugin directory');
        out.warn('no plugin roots configured');
        return;
    }
    logger?.debug?.(`dsh-mloader: plugin roots = ${roots.join(', ')}`);
    out.detail(`plugin roots: ${roots.join(', ')}`);
    // Seeding runs before discovery so examples released on this start are mounted in the same run.
    const pluginDir = profilePluginsDir(settings.profileDir, baseUrl);
    if (settings.seedExamples !== false && pluginDir !== undefined) {
        const seeded = await installSeedExamples(pluginDir, logger);
        if (seeded?.installed?.length) {
            out.lifecycle(`seeded: ${seeded.installed.join(', ')}`);
        }
    }
    const manager = new PluginManager(ctx, logger, { ...settings, resolvedRoots: roots, out });
    // Cordis does not export its fiber state enum, so active is the literal 2.
    const FIBER_ACTIVE = 2;
    const onStatus = (fiber, oldState) => {
        if (oldState !== FIBER_ACTIVE || fiber?.state === FIBER_ACTIVE)
            return;
        if (manager.disposed)
            return;
        logger?.debug?.('dsh-mloader: unload detected, aborting startup');
        manager.abortStartup();
    };
    ctx.on('internal/status', onStatus);
    ctx.effect(() => () => ctx.off?.('internal/status', onStatus), 'dsh-mloader:status-watch');
    ctx.effect(() => {
        return async () => {
            manager.abortStartup();
            await manager.teardown();
        };
    }, 'dsh-mloader:teardown');
    // Return without awaiting boot: Cordis waits for apply() before running the disposal effects,
    // so awaiting a slow plugin here would delay unloading for the whole startup timeout.
    const bootTask = manager.boot().catch((error) => {
        logger?.error?.(`dsh-mloader: boot failed: ${messageOf(error)}`);
    });
    manager.bootTask = bootTask;
    if (settings.statusTool !== false) {
        const disposeStatusTool = ctx.tools.register(createStatusTool(() => manager.list()));
        ctx.effect(() => () => disposeStatusTool(), 'dsh-mloader:status-tool');
    }
    registerMloaderHttp(ctx, manager, logger);
    if (settings.command !== false) {
        const commandName = typeof settings.command === 'string'
            ? settings.command
            : DEFAULT_COMMAND_NAME;
        const target = {
            list: () => manager.list(),
            enable: (id) => manager.enable(id),
            disable: (id) => manager.disable(id),
            reload: (id) => manager.reload(id),
        };
        const disposeCommand = registerMloaderCommand(ctx, target, logger, commandName);
        if (disposeCommand) {
            ctx.effect(() => () => disposeCommand(), 'dsh-mloader:command');
        }
    }
    if (typeof ctx.provide === 'function') {
        ctx.provide('mloader', {
            list: () => manager.list(),
            enable: (id) => manager.enable(id),
            disable: (id) => manager.disable(id),
            setEnabled: (id, enabled) => manager.setEnabled(id, enabled),
            reload: (id) => manager.reload(id),
            unload: (id) => manager.unload(id),
        });
    }
}
/** Return the message of a thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
