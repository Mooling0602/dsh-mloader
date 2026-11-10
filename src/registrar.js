/**
 * Registration ledger for one external plugin.
 *
 * An external plugin is not a Cordis plugin. It sends registration intents over
 * the private protocol, and the registrar turns them into real registrations on
 * the loader's own context. The registrar owns the whole lifecycle of one
 * plugin: every registration is recorded in a ledger and revoked in reverse
 * order when the plugin unloads or crashes, so dsh never sees a registration
 * that outlives its plugin.
 *
 * @module registrar
 */
import { COMMAND_NAME_PATTERN, EVENT_WHITELIST, PLUGIN_STATE, validateToolSchema } from './contract.js';
/** Logger method names reachable through the one-way `logger.log` operation. */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'];
/**
 * Capability switch that governs each registration operation.
 *
 * The manifest `capabilities` object is the plugin's own declaration of what it
 * may use, so it is enforced here, at the one place every registration passes
 * through, rather than at each backend. Reading it at the channel keeps the
 * Python backend and the WebAssembly declaration path under the same rule: a
 * WebAssembly module returns its declarations as the apply result, and the
 * loader feeds them through this method.
 */
const OPERATION_CAPABILITY = {
    'tools.register': 'tools',
    'commands.register': 'commands',
    'events.on': 'events',
    'logger.log': 'logger',
    'effect.register': 'effect',
};
/**
 * A registrar owns one plugin's registrations on the loader's context.
 *
 * The caller constructs one registrar per plugin, hands it to the backend as
 * the inbound request handler, and calls {@link PluginRegistrar.dispose} when
 * the plugin stops. A registrar is single use: once disposed it rejects further
 * requests, and a registration attempt that races with disposal is revoked
 * immediately instead of hanging around.
 */
export class PluginRegistrar {
    /** Specification of the plugin this registrar serves. */
    spec;
    /** Current lifecycle state. The manager updates it as the plugin starts and stops. */
    state;
    /** Backend instance, attached before startup so teardown can stop it at any moment. */
    instance;
    /** Failure detail reported by the last failed operation, if any. */
    error;
    #ctx;
    #logger;
    #commandsService;
    #invokeTool;
    #dispatchEvent;
    #entries;
    #tools;
    #subscriptions;
    #commands;
    #commandNodes;
    #commandNodeIds;
    #disposed;
    /**
     * Create the ledger for one plugin.
     *
     * The registrar owns the registrations it tracks, not the backend instance.
     * Disposal runs every recorded disposer in reverse registration order and
     * tolerates individual failures, because one broken disposer must not leave
     * the rest of the plugin attached to dsh.
     *
     * @param spec - Plugin specification produced by discovery.
     * @param ctx - The loader's own Cordis context, never a plugin-scoped one.
     * @param logger - Loader logger. Diagnostics stay here and never reach the terminal.
     * @param invokeTool - Executes a tool on the backend for this plugin.
     * @param dispatchEvent - Delivers a host event to the backend for this plugin.
     */
    constructor(spec, ctx, logger, invokeTool, dispatchEvent) {
        this.spec = spec;
        this.#ctx = ctx;
        this.#logger = logger;
        this.#invokeTool = invokeTool;
        this.#dispatchEvent = dispatchEvent;
        this.state = PLUGIN_STATE.DISCOVERED;
        this.instance = null;
        this.error = null;
        // The command service is optional in dsh. A plugin that declares commands
        // still starts when the service is absent; its commands are skipped with a
        // warning instead of failing the whole plugin.
        this.#commandsService = typeof ctx.get === 'function'
            ? ctx.get('commands')
            : undefined;
        this.#entries = [];
        this.#tools = new Map();
        this.#subscriptions = new Map();
        this.#commands = new Map();
        this.#commandNodes = new Map();
        this.#commandNodeIds = new Set();
        this.#disposed = false;
    }
    /** Number of registrations still held by the ledger. */
    get registrationCount() {
        return this.#entries.length;
    }
    /** Record one disposer, or run it now when the ledger is already closed. */
    #track(dispose) {
        if (this.#disposed) {
            safeDispose(dispose);
            return;
        }
        this.#entries.push(dispose);
    }
    /**
     * Revoke every registration this plugin owns, newest first.
     *
     * Disposal is idempotent and leaves the registrar in the `disposed` state.
     * Tool names and event subscriptions are forgotten so a stale snapshot cannot
     * report registrations that no longer exist.
     */
    dispose() {
        if (this.#disposed)
            return;
        this.#disposed = true;
        for (const dispose of this.#entries.splice(0).reverse())
            safeDispose(dispose);
        this.#tools.clear();
        this.#subscriptions.clear();
        this.#commands.clear();
        this.#commandNodes.clear();
        this.#commandNodeIds.clear();
        this.state = PLUGIN_STATE.DISPOSED;
    }
    /**
     * Handle one registration request from the plugin.
     *
     * The operation whitelist is enforced here: an unknown operation is rejected
     * by name with the whitelist in the error, so a plugin can see what the loader
     * accepts. A registration that arrives after disposal rejects instead of
     * creating an entry nobody would ever revoke. A `logger.log` notification is
     * still accepted because logging creates no registration and a cleanup has to
     * be able to log while the ledger is already closed.
     *
     * @param op - One of `tools.register`, `commands.register`, `events.on`, `logger.log`, `effect.register`.
     * @param payload - Operation arguments.
     * @returns Operation specific acknowledgement sent back to the plugin.
     * @throws {Error} When a registration arrives after unload, the operation is
     *   unknown, or the payload violates the contract.
     */
    async handle(op, payload = {}) {
        if (this.#disposed && op !== 'logger.log') {
            throw new Error(`plugin ${this.spec.id} has been unloaded`);
        }
        const capability = OPERATION_CAPABILITY[op];
        // The manifest defaults every switch to true, so a specification that
        // carries no capabilities object allows the whole surface.
        if (capability !== undefined && this.spec.capabilities?.[capability] === false) {
            throw new Error(`plugin ${this.spec.id} declares capabilities.${capability} as false, ` +
                `so "${op}" is not available`);
        }
        switch (op) {
            case 'tools.register':
                return this.#registerTool(payload);
            case 'commands.register':
                return this.#registerCommand(payload);
            case 'events.on':
                return this.#subscribeEvent(payload);
            case 'logger.log':
                return this.#log(payload);
            case 'effect.register':
                return this.#registerEffect(payload);
            default:
                throw new Error(`unsupported operation "${op}" ` +
                    '(whitelist: tools.register, commands.register, events.on, logger.log, effect.register)');
        }
    }
    /**
     * Register one command node on the optional dsh commands service.
     *
     * The node carries candidate names in priority order. Each candidate is tried
     * against the global command namespace; the first one that is not taken wins
     * and the rest stay unused, so the same node is never registered twice. When
     * every candidate is already taken the node is skipped: the loader keeps the
     * command that is already there and the plugin stays applied. A declaration
     * that is malformed, or a registration failure that is not a name conflict,
     * still fails the apply handshake.
     *
     * @param payload - Request payload carrying one command node.
     * @returns Whether a candidate was registered, the registered name when it
     *   was, and the reason when it was not.
     * @throws {Error} When the declaration is malformed, the node id is repeated
     *   by the same plugin, or the commands service rejects the registration for
     *   a reason other than a name conflict.
     */
    #registerCommand(payload) {
        const declaration = readCommandDeclaration(payload.command, this.spec.id);
        // Record the declaration before a candidate is chosen, so a node whose
        // every candidate was taken is still rejected when it is declared twice.
        if (this.#commandNodeIds.has(declaration.id)) {
            throw new Error(`plugin ${this.spec.id} already declares command node "${declaration.id}"`);
        }
        this.#commandNodeIds.add(declaration.id);
        const service = this.#commandsService;
        if (service === undefined) {
            this.#logger?.warn?.(`[${this.spec.id}] commands service is unavailable; ` +
                `command node "${declaration.id}" was not registered`);
            return { registered: false, reason: 'commands service is unavailable' };
        }
        for (const name of declaration.names) {
            let dispose;
            try {
                dispose = service.register({
                    name,
                    description: declaration.description,
                    ...(declaration.input === undefined ? {} : { input: { hint: declaration.input.hint } }),
                    handler: async (invocation) => await this.#runCommand(declaration.id, invocation?.rawInput ?? ''),
                });
            }
            catch (error) {
                if (!isCommandConflict(error))
                    throw error;
                this.#logger?.warn?.(`[${this.spec.id}] command "${name}" is already registered; ` +
                    'trying the next candidate name');
                continue;
            }
            this.#commandNodes.set(declaration.id, name);
            this.#commands.set(name, dispose);
            this.#track(() => {
                this.#commands.delete(name);
                dispose();
            });
            this.#logger?.debug?.(`[${this.spec.id}] registered command /${name}`);
            return { registered: true, name };
        }
        this.#logger?.warn?.(`[${this.spec.id}] every candidate name of command node "${declaration.id}" ` +
            `is already registered (${declaration.names.join(', ')}); command not registered`);
        return { registered: false, reason: 'every candidate command name is already registered' };
    }
    /**
     * Run one command node on the backend and normalize its result.
     *
     * A failure is returned as an error result instead of being thrown, because
     * the commands service renders the result and a thrown handler would surface
     * as an unexpected command failure.
     *
     * @param node - Command node id the plugin declared.
     * @param rawInput - Text after the command name, passed verbatim.
     * @returns The normalized command result.
     */
    async #runCommand(node, rawInput) {
        if (this.#disposed || this.state !== PLUGIN_STATE.APPLIED) {
            return {
                kind: 'error',
                text: `plugin ${this.spec.id} is not active (state=${this.state})`,
            };
        }
        try {
            const result = await this.instance.callCommand(node, rawInput);
            return normalizeCommandResult(result, this.spec.id, node);
        }
        catch (error) {
            return { kind: 'error', text: messageOf(error) };
        }
    }
    #registerTool(payload) {
        const raw = payload.tool;
        if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
            throw new Error('tools.register requires payload.tool');
        }
        const spec = raw;
        const name = spec.name;
        if (typeof name === 'string' && this.#tools.has(name)) {
            throw new Error(`tool "${name}" already registered by plugin ${this.spec.id}`);
        }
        const definition = buildToolDefinition(spec, this.spec.id, this.#invokeTool);
        const toolName = definition.name;
        // The registration lands on the loader's context, so dsh attributes the tool
        // to the loader rather than to the hosted plugin.
        const dispose = this.#ctx.tools.register(definition);
        this.#tools.set(toolName, dispose);
        this.#track(() => {
            this.#tools.delete(toolName);
            dispose();
        });
        this.#logger?.debug?.(`[${this.spec.id}] registered tool ${toolName}`);
        return { registered: toolName };
    }
    #subscribeEvent(payload) {
        const event = payload.event;
        if (typeof event !== 'string')
            throw new Error('events.on requires payload.event');
        if (!EVENT_WHITELIST.has(event)) {
            throw new Error(`event "${event}" is not in the mloader whitelist ` +
                `(${[...EVENT_WHITELIST].join(', ')})`);
        }
        if (this.#subscriptions.has(event)) {
            throw new Error(`plugin ${this.spec.id} already subscribes to "${event}"`);
        }
        // Cordis waterfall listeners receive `next` as the last argument, and the
        // chain stops at a listener that does not call it. The listener must call
        // next() synchronously and return its result, while the plugin dispatch is
        // fire-and-forget: awaiting the plugin here would block the host tool
        // execution chain on a plugin.
        const listener = (...args) => {
            const next = typeof args[args.length - 1] === 'function'
                ? args[args.length - 1]
                : undefined;
            // A disposed or disabled plugin still advances the chain, otherwise
            // unloading the plugin would break every tool execution in dsh.
            if (this.#disposed || this.state === PLUGIN_STATE.DISABLED) {
                return next === undefined ? undefined : next();
            }
            const eventArgs = next === undefined ? args : args.slice(0, -1);
            void this.#dispatchEvent(event, eventArgs).catch((error) => {
                this.#logger?.warn?.(`[${this.spec.id}] event "${event}" dispatch failed: ${messageOf(error)}`);
            });
            return next === undefined ? undefined : next();
        };
        const dispose = this.#ctx.on(event, listener);
        this.#subscriptions.set(event, dispose);
        this.#track(() => {
            this.#subscriptions.delete(event);
            if (typeof dispose === 'function')
                dispose();
        });
        this.#logger?.debug?.(`[${this.spec.id}] subscribed ${event}`);
        return { subscribed: event };
    }
    #log(payload) {
        if (typeof payload.message !== 'string')
            throw new Error('logger.log requires payload.message');
        const requested = payload.level;
        const level = LOG_LEVELS.includes(requested)
            ? requested
            : 'info';
        const fn = this.#logger?.[level];
        if (typeof fn === 'function') {
            const data = payload.data;
            fn.call(this.#logger, `[${this.spec.id}] ${payload.message}` +
                (data === undefined ? '' : ` ${safeStringify(data)}`));
        }
        return { logged: level };
    }
    #registerEffect(payload) {
        const label = typeof payload.label === 'string' ? payload.label : `plugin:${this.spec.id}`;
        // The effect anchor lives on the loader's context, so the cleanup also runs
        // when the whole loader unloads rather than only when this plugin stops.
        const dispose = this.#ctx.effect(() => () => {
            this.#logger?.debug?.(`[${this.spec.id}] effect ${label} cleaned up`);
        }, `external-effect:${this.spec.id}:${label}`);
        this.#track(() => {
            if (typeof dispose === 'function')
                dispose();
        });
        return { registered: label };
    }
    /**
     * Build the status snapshot for this plugin.
     *
     * The snapshot is plain data so the status tool, the slash command and the
     * `mloader` service can all read it without touching the ledger. Tool names
     * and event names appear in registration order.
     */
    snapshot() {
        return {
            id: this.spec.id,
            name: this.spec.name,
            version: this.spec.version,
            backend: this.spec.backend,
            state: this.state,
            tools: [...this.#tools.keys()],
            events: [...this.#subscriptions.keys()],
            commands: [...this.#commands.keys()],
            registrations: this.registrationCount,
            ...(this.error ? { error: this.error } : {}),
        };
    }
}
/**
 * Read and validate one command node declaration.
 *
 * The node id defaults to the first candidate name, so a plugin that does not
 * need a stable routing id can omit it. Candidate names are tried in order.
 *
 * @param raw - The `command` member of a `commands.register` payload.
 * @param pluginId - Plugin that declared the node, used in diagnostics.
 * @returns The normalized declaration.
 * @throws {Error} When the declaration is malformed.
 */
function readCommandDeclaration(raw, pluginId) {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
        throw new Error('commands.register requires payload.command');
    }
    const record = raw;
    const names = record.names;
    if (!Array.isArray(names) || names.length === 0 || names.some((name) => typeof name !== 'string')) {
        throw new Error(`plugin ${pluginId} command node requires a non-empty names array`);
    }
    const id = typeof record.id === 'string' && record.id.length > 0
        ? record.id
        : names[0];
    if (id.length > 64) {
        throw new Error(`plugin ${pluginId} command node id "${id}" must be at most 64 characters`);
    }
    const seen = new Set();
    for (const name of names) {
        if (!COMMAND_NAME_PATTERN.test(name)) {
            throw new Error(`plugin ${pluginId} command node "${id}": name "${name}" must match ` +
                String(COMMAND_NAME_PATTERN));
        }
        if (seen.has(name)) {
            throw new Error(`plugin ${pluginId} command node "${id}" repeats candidate name "${name}"`);
        }
        seen.add(name);
    }
    const description = record.description;
    if (typeof description !== 'string' || description.trim().length === 0) {
        throw new Error(`plugin ${pluginId} command node "${id}" requires a non-empty description`);
    }
    let input;
    if (record.input !== undefined) {
        if (record.input === null || typeof record.input !== 'object' || Array.isArray(record.input)) {
            throw new Error(`plugin ${pluginId} command node "${id}" input must be an object`);
        }
        const hint = record.input.hint;
        if (typeof hint !== 'string' || hint.trim().length === 0) {
            throw new Error(`plugin ${pluginId} command node "${id}" input.hint must be a non-empty string`);
        }
        input = { hint };
    }
    return {
        id,
        names: names,
        description,
        ...(input === undefined ? {} : { input }),
    };
}
/** Return true when a registration failure means the command name is taken. */
function isCommandConflict(error) {
    return error instanceof Error && /already registered/i.test(error.message);
}
/**
 * Normalize the value a command node returned.
 *
 * A bare string is accepted as a successful text result, because it is the
 * natural return type of a small command handler. Anything else must be a
 * {@link CommandResult}.
 *
 * @param value - Value the backend returned.
 * @param pluginId - Plugin that ran the command, used in diagnostics.
 * @param node - Command node id, used in diagnostics.
 * @returns The normalized result. An invalid value becomes an error result.
 */
function normalizeCommandResult(value, pluginId, node) {
    if (typeof value === 'string')
        return { kind: 'success', text: value };
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        return { kind: 'error', text: `plugin ${pluginId} command "${node}" returned an invalid result` };
    }
    const record = value;
    if (record.kind === 'success' && typeof record.text === 'string') {
        return { kind: 'success', text: record.text };
    }
    if (record.kind === 'error' && typeof record.text === 'string' && record.text.trim().length > 0) {
        return { kind: 'error', text: record.text };
    }
    return { kind: 'error', text: `plugin ${pluginId} command "${node}" returned an invalid result` };
}
/** Run one disposer and swallow its failure, including an asynchronous one. */
function safeDispose(dispose) {
    try {
        const result = dispose();
        if (typeof result?.then === 'function') {
            void result.catch(() => { });
        }
    }
    catch {
        // A failing disposer must not interrupt the reverse-order unload.
    }
}
/**
 * Rebuild a plugin declared tool specification into a tool definition dsh can
 * register.
 *
 * Functions cannot cross the process or WebAssembly boundary, so the plugin
 * declares only serialisable data and the loader supplies `output.render` here.
 * The schema is validated against the harness subset before registration, which
 * makes a violation name the plugin, the tool and the offending schema path.
 *
 * @param spec - Tool specification received from the plugin.
 * @param pluginId - Plugin that declared the tool, used in diagnostics.
 * @param invoke - Executes the tool on the backend that hosts the plugin.
 * @returns A tool definition owned by the loader's context.
 * @throws {Error} When the name, description or schema violates the contract.
 */
export function buildToolDefinition(spec, pluginId, invoke) {
    const record = spec !== null && typeof spec === 'object'
        ? spec
        : {};
    const where = `plugin "${pluginId}" tool "${String(record.name)}"`;
    const name = record.name;
    if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
        throw new Error(`${where}: name must match ^[A-Za-z0-9_-]{1,64}$`);
    }
    const description = record.description;
    if (typeof description !== 'string' || description.length === 0) {
        throw new Error(`${where}: description is required`);
    }
    const parameters = (record.parameters ?? {
        type: 'object',
        properties: {},
        additionalProperties: false,
    });
    const violations = validateToolSchema(parameters, where);
    if (violations.length > 0)
        throw new Error(violations.join('; '));
    const outputSchema = (record.output ?? { type: 'object', additionalProperties: true });
    const outputViolations = validateToolSchema(outputSchema, `${where} output`);
    if (outputViolations.length > 0)
        throw new Error(outputViolations.join('; '));
    const timeoutMs = record.timeoutMs;
    return {
        name,
        description,
        parameters,
        output: {
            schema: outputSchema,
            render(_args, value) {
                return [{ type: 'text', text: renderValueAsText(value) }];
            },
        },
        ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
            ? { timeoutMs }
            : {}),
        async execute(args) {
            return await invoke(name, args);
        },
    };
}
/** Render a tool result as plain text for the model. */
function renderValueAsText(value) {
    if (value === undefined || value === null)
        return 'null';
    if (typeof value === 'string')
        return value;
    try {
        return JSON.stringify(value, null, 2);
    }
    catch {
        return String(value);
    }
}
/** Render a log payload without letting an unserialisable value throw. */
function safeStringify(value) {
    try {
        return JSON.stringify(value);
    }
    catch {
        return '[unserializable]';
    }
}
/** Extract a message from an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
