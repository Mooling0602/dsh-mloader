/**
 * Structural types for the loader and the runtimes it hosts.
 *
 * The loader lives in two worlds at once: it is an ordinary Cordis plugin, and
 * it is the host of plugins that are not Cordis plugins. This module declares
 * only the host surface the loader relies on and the shapes that cross the
 * plugin boundary. The declarations are structural so the package keeps no
 * dependency on the Cordis packages.
 *
 * @module types
 */

/** Runtime backend that hosts one external plugin. */
export type BackendKind = 'python' | 'wasm'

/** Lifecycle state of one external plugin. */
export type PluginState = 'discovered' | 'loaded' | 'applied' | 'disabled' | 'failed' | 'disposed'

/** Timeouts declared by a plugin manifest, in milliseconds. */
export interface PluginTimeouts {
  startupMs: number
  callMs: number
}

/** Capability switches declared by a plugin manifest. */
export interface PluginCapabilities {
  tools: boolean
  events: boolean
  logger: boolean
  effect: boolean
  commands: boolean
}

/** A plugin manifest after discovery has normalised it. */
export interface PluginSpec {
  id: string
  name: string
  version: string
  backend: BackendKind
  entry: string
  baseDir: string
  manifestPath: string
  enabled: boolean
  inject: string[]
  capabilities: PluginCapabilities
  timeouts: PluginTimeouts
  env: Record<string, string>
  declared: Record<string, unknown>
}

/** Logging surface shared by the Cordis logger and test doubles. */
export interface LoaderLogger {
  (scope?: string): LoaderLogger
  debug?(message: string, ...rest: unknown[]): void
  info?(message: string, ...rest: unknown[]): void
  warn?(message: string, ...rest: unknown[]): void
  error?(message: string, ...rest: unknown[]): void
}

/** A disposer returned by a host registration. */
export type Disposer = () => unknown

/** A JSON Schema node in the subset accepted by the harness tool registry. */
export type JsonSchema = Record<string, unknown>

/** One text block returned by a tool renderer. */
export interface ToolTextBlock {
  type: 'text'
  text: string
}

/** A tool definition as accepted by the harness tool registry. */
export interface ToolDefinition {
  name: string
  description: string
  parameters: JsonSchema
  output: {
    schema: JsonSchema
    render(args: unknown, value: unknown): ToolTextBlock[]
  }
  timeoutMs?: number
  execute(args: unknown): Promise<unknown>
}

/** Slash command service exposed by the optional dsh-commands plugin. */
export interface CommandService {
  register(command: CommandDefinition): Disposer
}

/** One slash command registration. */
export interface CommandDefinition {
  name: string
  description: string
  input?: { hint?: string }
  handler(
    invocation: { rawInput?: string },
  ): CommandResult | Promise<CommandResult>
}

/** Result one command handler returns to the dispatching UI. */
export interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

/** Input hint a command declaration advertises to capable clients. */
export interface CommandInputHint {
  hint: string
}

/**
 * One command node a plugin declares.
 *
 * The node id routes execution back to the plugin and does not change with the
 * candidate names. The names are tried in order against the global command
 * namespace, and the first one that is not taken is registered.
 */
export interface CommandDeclaration {
  id: string
  names: string[]
  description: string
  input?: CommandInputHint
}

/** Structural view of the Cordis context the loader uses. */
export interface LoaderContext {
  baseUrl?: string
  logger?: LoaderLogger
  /** Cordis fiber that owns this plugin context; its state drives startup aborts. */
  fiber?: { state?: number }
  tools: {
    register(definition: ToolDefinition): Disposer
  }
  on(event: string, listener: (...args: any[]) => unknown): Disposer
  off?(event: string, listener: (...args: any[]) => unknown): void
  effect(setup: () => Disposer | void, label?: string): Disposer
  inject?(deps: string[], callback: (scope: LoaderContext) => void): unknown
  get<T = unknown>(name: string): T | undefined
  provide(name: string, value: unknown): void
}

/** Terminal output channel, separate from the in-memory logger. */
export interface ConsoleChannel {
  readonly enabled: boolean
  lifecycle(message: string): void
  detail(message: string): void
  warn(message: string): void
  error(message: string): void
}

/** Settings that select terminal output behaviour. */
export interface ConsoleSettings {
  console?: boolean | 'verbose'
}

/** Per-plugin state exposed by the status tool and the slash command. */
export interface PluginSnapshot {
  id: string
  name: string
  version: string
  backend: BackendKind
  state: PluginState
  tools: string[]
  events: string[]
  commands: string[]
  registrations: number
  error?: string
}

/** The registrar surface a backend calls while a plugin registers capabilities. */
export interface RegistrarHandle {
  handle(op: string, payload?: Record<string, unknown>): Promise<unknown>
}

/** Result of applying a plugin, used for the lifecycle log lines. */
export interface ApplyResult {
  tools?: string[]
  events?: string[]
}

/** One backend instance that hosts exactly one external plugin. */
export interface BackendInstance {
  readonly spec: PluginSpec
  start(): Promise<unknown>
  setInboundHandler?(handler: (op: string, payload: Record<string, unknown>) => Promise<unknown>): void
  apply(registrar: RegistrarHandle): Promise<ApplyResult | undefined>
  callTool(name: string, args: unknown, signal?: unknown): Promise<unknown>
  dispatchEvent(event: string, args: unknown[]): Promise<unknown>
  /** Run one command node and return its command result. */
  callCommand(command: string, input: string): Promise<unknown>
  stop(reason?: string): Promise<void>
}
