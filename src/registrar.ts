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

import { EVENT_WHITELIST, PLUGIN_STATE, validateToolSchema } from './contract.js'
import type {
  BackendInstance,
  Disposer,
  JsonSchema,
  LoaderContext,
  LoaderLogger,
  PluginSnapshot,
  PluginSpec,
  PluginState,
  ToolDefinition,
  ToolTextBlock,
} from './types.js'

/** Calls a tool on the backend that hosts the plugin. */
type InvokeTool = (tool: string, args: unknown) => Promise<unknown>

/** Delivers one host event to the backend that hosts the plugin. */
type DispatchEvent = (event: string, args: unknown[]) => Promise<unknown>

/** Logger method names reachable through the one-way `logger.log` operation. */
const LOG_LEVELS = ['debug', 'info', 'warn', 'error'] as const

/** One accepted `logger.log` level. */
type LogLevel = (typeof LOG_LEVELS)[number]

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
  readonly spec: PluginSpec

  /** Current lifecycle state. The manager updates it as the plugin starts and stops. */
  state: PluginState

  /** Backend instance, attached before startup so teardown can stop it at any moment. */
  instance: BackendInstance | null

  /** Failure detail reported by the last failed operation, if any. */
  error: string | null

  readonly #ctx: LoaderContext
  readonly #logger: LoaderLogger | undefined
  readonly #invokeTool: InvokeTool
  readonly #dispatchEvent: DispatchEvent
  readonly #entries: Disposer[]
  readonly #tools: Map<string, Disposer>
  readonly #subscriptions: Map<string, Disposer>
  #disposed: boolean

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
  constructor(
    spec: PluginSpec,
    ctx: LoaderContext,
    logger: LoaderLogger | undefined,
    invokeTool: InvokeTool,
    dispatchEvent: DispatchEvent,
  ) {
    this.spec = spec
    this.#ctx = ctx
    this.#logger = logger
    this.#invokeTool = invokeTool
    this.#dispatchEvent = dispatchEvent

    this.state = PLUGIN_STATE.DISCOVERED
    this.instance = null
    this.error = null

    this.#entries = []
    this.#tools = new Map()
    this.#subscriptions = new Map()
    this.#disposed = false
  }

  /** Number of registrations still held by the ledger. */
  get registrationCount(): number {
    return this.#entries.length
  }

  /** Record one disposer, or run it now when the ledger is already closed. */
  #track(dispose: Disposer): void {
    if (this.#disposed) {
      safeDispose(dispose)
      return
    }
    this.#entries.push(dispose)
  }

  /**
   * Revoke every registration this plugin owns, newest first.
   *
   * Disposal is idempotent and leaves the registrar in the `disposed` state.
   * Tool names and event subscriptions are forgotten so a stale snapshot cannot
   * report registrations that no longer exist.
   */
  dispose(): void {
    if (this.#disposed) return
    this.#disposed = true
    for (const dispose of this.#entries.splice(0).reverse()) safeDispose(dispose)
    this.#tools.clear()
    this.#subscriptions.clear()
    this.state = PLUGIN_STATE.DISPOSED
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
   * @param op - One of `tools.register`, `events.on`, `logger.log`, `effect.register`.
   * @param payload - Operation arguments.
   * @returns Operation specific acknowledgement sent back to the plugin.
   * @throws {Error} When a registration arrives after unload, the operation is
   *   unknown, or the payload violates the contract.
   */
  async handle(op: string, payload: Record<string, unknown> = {}): Promise<unknown> {
    if (this.#disposed && op !== 'logger.log') {
      throw new Error(`plugin ${this.spec.id} has been unloaded`)
    }
    switch (op) {
      case 'tools.register':
        return this.#registerTool(payload)
      case 'events.on':
        return this.#subscribeEvent(payload)
      case 'logger.log':
        return this.#log(payload)
      case 'effect.register':
        return this.#registerEffect(payload)
      default:
        throw new Error(
          `unsupported operation "${op}" ` +
          '(whitelist: tools.register, events.on, logger.log, effect.register)',
        )
    }
  }

  #registerTool(payload: Record<string, unknown>): { registered: string } {
    const raw = payload.tool
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error('tools.register requires payload.tool')
    }
    const spec = raw as Record<string, unknown>
    const name = spec.name
    if (typeof name === 'string' && this.#tools.has(name)) {
      throw new Error(`tool "${name}" already registered by plugin ${this.spec.id}`)
    }

    const definition = buildToolDefinition(spec, this.spec.id, this.#invokeTool)
    const toolName = definition.name
    // The registration lands on the loader's context, so dsh attributes the tool
    // to the loader rather than to the hosted plugin.
    const dispose = this.#ctx.tools.register(definition)
    this.#tools.set(toolName, dispose)
    this.#track(() => {
      this.#tools.delete(toolName)
      dispose()
    })
    this.#logger?.debug?.(`[${this.spec.id}] registered tool ${toolName}`)
    return { registered: toolName }
  }

  #subscribeEvent(payload: Record<string, unknown>): { subscribed: string } {
    const event = payload.event
    if (typeof event !== 'string') throw new Error('events.on requires payload.event')
    if (!EVENT_WHITELIST.has(event)) {
      throw new Error(
        `event "${event}" is not in the mloader whitelist ` +
        `(${[...EVENT_WHITELIST].join(', ')})`,
      )
    }
    if (this.#subscriptions.has(event)) {
      throw new Error(`plugin ${this.spec.id} already subscribes to "${event}"`)
    }

    // Cordis waterfall listeners receive `next` as the last argument, and the
    // chain stops at a listener that does not call it. The listener must call
    // next() synchronously and return its result, while the plugin dispatch is
    // fire-and-forget: awaiting the plugin here would block the host tool
    // execution chain on a plugin.
    const listener = (...args: unknown[]): unknown => {
      const next = typeof args[args.length - 1] === 'function'
        ? args[args.length - 1] as () => unknown
        : undefined
      // A disposed or disabled plugin still advances the chain, otherwise
      // unloading the plugin would break every tool execution in dsh.
      if (this.#disposed || this.state === PLUGIN_STATE.DISABLED) {
        return next === undefined ? undefined : next()
      }

      const eventArgs = next === undefined ? args : args.slice(0, -1)
      void this.#dispatchEvent(event, eventArgs).catch((error: unknown) => {
        this.#logger?.warn?.(
          `[${this.spec.id}] event "${event}" dispatch failed: ${messageOf(error)}`,
        )
      })

      return next === undefined ? undefined : next()
    }

    const dispose = this.#ctx.on(event, listener)
    this.#subscriptions.set(event, dispose)
    this.#track(() => {
      this.#subscriptions.delete(event)
      if (typeof dispose === 'function') dispose()
    })
    this.#logger?.debug?.(`[${this.spec.id}] subscribed ${event}`)
    return { subscribed: event }
  }

  #log(payload: Record<string, unknown>): { logged: string } {
    if (typeof payload.message !== 'string') throw new Error('logger.log requires payload.message')
    const requested = payload.level
    const level: LogLevel = LOG_LEVELS.includes(requested as LogLevel)
      ? requested as LogLevel
      : 'info'
    const fn = this.#logger?.[level]
    if (typeof fn === 'function') {
      const data = payload.data
      fn.call(
        this.#logger,
        `[${this.spec.id}] ${payload.message}` +
        (data === undefined ? '' : ` ${safeStringify(data)}`),
      )
    }
    return { logged: level }
  }

  #registerEffect(payload: Record<string, unknown>): { registered: string } {
    const label = typeof payload.label === 'string' ? payload.label : `plugin:${this.spec.id}`
    // The effect anchor lives on the loader's context, so the cleanup also runs
    // when the whole loader unloads rather than only when this plugin stops.
    const dispose = this.#ctx.effect(() => () => {
      this.#logger?.debug?.(`[${this.spec.id}] effect ${label} cleaned up`)
    }, `external-effect:${this.spec.id}:${label}`)
    this.#track(() => {
      if (typeof dispose === 'function') dispose()
    })
    return { registered: label }
  }

  /**
   * Build the status snapshot for this plugin.
   *
   * The snapshot is plain data so the status tool, the slash command and the
   * `mloader` service can all read it without touching the ledger. Tool names
   * and event names appear in registration order.
   */
  snapshot(): PluginSnapshot {
    return {
      id: this.spec.id,
      name: this.spec.name,
      version: this.spec.version,
      backend: this.spec.backend,
      state: this.state,
      tools: [...this.#tools.keys()],
      events: [...this.#subscriptions.keys()],
      registrations: this.registrationCount,
      ...(this.error ? { error: this.error } : {}),
    }
  }
}

/** Run one disposer and swallow its failure, including an asynchronous one. */
function safeDispose(dispose: Disposer): void {
  try {
    const result: unknown = dispose()
    if (typeof (result as { then?: unknown } | null)?.then === 'function') {
      void (result as Promise<unknown>).catch(() => {})
    }
  } catch {
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
export function buildToolDefinition(
  spec: unknown,
  pluginId: string,
  invoke: InvokeTool,
): ToolDefinition {
  const record = spec !== null && typeof spec === 'object'
    ? spec as Record<string, unknown>
    : {}
  const where = `plugin "${pluginId}" tool "${String(record.name)}"`

  const name = record.name
  if (typeof name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(name)) {
    throw new Error(`${where}: name must match ^[A-Za-z0-9_-]{1,64}$`)
  }
  const description = record.description
  if (typeof description !== 'string' || description.length === 0) {
    throw new Error(`${where}: description is required`)
  }

  const parameters = (record.parameters ?? {
    type: 'object',
    properties: {},
    additionalProperties: false,
  }) as JsonSchema
  const violations = validateToolSchema(parameters, where)
  if (violations.length > 0) throw new Error(violations.join('; '))

  const outputSchema = (record.output ?? { type: 'object', additionalProperties: true }) as JsonSchema
  const outputViolations = validateToolSchema(outputSchema, `${where} output`)
  if (outputViolations.length > 0) throw new Error(outputViolations.join('; '))

  const timeoutMs = record.timeoutMs
  return {
    name,
    description,
    parameters,
    output: {
      schema: outputSchema,
      render(_args: unknown, value: unknown): ToolTextBlock[] {
        return [{ type: 'text', text: renderValueAsText(value) }]
      },
    },
    ...(typeof timeoutMs === 'number' && Number.isFinite(timeoutMs) && timeoutMs > 0
      ? { timeoutMs }
      : {}),
    async execute(args: unknown): Promise<unknown> {
      return await invoke(name, args)
    },
  }
}

/** Render a tool result as plain text for the model. */
function renderValueAsText(value: unknown): string {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

/** Render a log payload without letting an unserialisable value throw. */
function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}

/** Extract a message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
