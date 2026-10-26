/**
 * The `/mloader` command group.
 *
 * A command reaches the operator while a tool reaches the model. The
 * `/mloader` command lets the operator list the external plugins the loader
 * hosts, inspect one of them, and load, unload or reload a plugin at runtime.
 * Loading and unloading go through the target, which owns the actual lifecycle
 * transition; the command only decides which transition to request.
 *
 * The optional dsh `commands` service is probed at runtime rather than declared
 * in `inject`: dsh may run without it, and a missing command service must never
 * prevent the loader from hosting plugins.
 *
 * @module commands/mloader
 */

import { format } from '../tools/status.js'
import type {
  Disposer,
  LoaderContext,
  LoaderLogger,
  PluginSnapshot,
  PluginState,
} from '../types.js'

/** Command name grammar accepted by dsh. */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u

/** Default command name. The command group uses the bare loader name. */
export const DEFAULT_COMMAND_NAME = 'mloader'

/**
 * Lifecycle operations the command group asks the host to perform.
 *
 * The target owns the real transition: it creates or stops the backend, updates
 * the record and returns the snapshot after the change. `enable`, `disable` and
 * `reload` reject when the plugin id is unknown, when a WebAssembly plugin is
 * disabled by configuration, or when the transition fails; the command turns
 * every rejection into an error result rather than letting it escape.
 */
export interface MloaderCommandTarget {
  /** Return the current snapshot of every known plugin. */
  list(): PluginSnapshot[]
  /** Start a plugin that is not loaded and return its new snapshot. */
  enable(id: string): Promise<PluginSnapshot>
  /** Stop a loaded plugin, keeping its record, and return its new snapshot. */
  disable(id: string): Promise<PluginSnapshot>
  /** Restart a loaded plugin, or start it when it is not loaded. */
  reload(id: string): Promise<PluginSnapshot>
}

/** Result of one command invocation, as the commands service expects it. */
interface CommandResult {
  kind: 'success' | 'error'
  text: string
}

/** One command registration accepted by the optional dsh commands service. */
interface MloaderCommandDefinition {
  name: string
  description: string
  input?: { hint?: string }
  handler(invocation: { rawInput?: string }): CommandResult | Promise<CommandResult>
}

/** Minimal view of the optional dsh commands service. */
interface MloaderCommandService {
  register(command: MloaderCommandDefinition): Disposer
}

/** Words that name a command form and therefore never select a plugin by id. */
const RESERVED_WORDS = new Set(['status', 'help', 'load', 'unload', 'reload'])

/** Return true when a plugin holds a running backend. */
function isLoaded(state: PluginState): boolean {
  return state === 'applied' || state === 'loaded'
}

/** Render one plugin as a detail block. */
function renderDetail(plugin: PluginSnapshot): string {
  const tools = plugin.tools.length > 0 ? plugin.tools.join(', ') : 'none'
  const events = plugin.events.length > 0 ? plugin.events.join(', ') : 'none'
  const lines = [
    `Plugin ${plugin.id}:`,
    `  Name: ${plugin.name}`,
    `  Version: ${plugin.version}`,
    `  Backend: ${plugin.backend}`,
    `  State: ${plugin.state} (${isLoaded(plugin.state) ? 'loaded' : 'not loaded'})`,
    `  Tools: ${tools}`,
    `  Events: ${events}`,
    `  Registrations: ${plugin.registrations}`,
  ]
  if (plugin.error) lines.push(`  Error: ${plugin.error}`)
  return lines.join('\n')
}

/** Render a plugin after a successful load. */
function renderLoaded(plugin: PluginSnapshot): string {
  const tools = plugin.tools.length > 0 ? plugin.tools.join(', ') : 'none'
  return `Plugin ${plugin.id} is now ${plugin.state}; tools: ${tools}.`
}

/** Render a plugin after a successful state change. */
function renderState(plugin: PluginSnapshot): string {
  return `Plugin ${plugin.id} is now ${plugin.state}.`
}

/** Render the usage text for every accepted form. */
function renderUsage(commandName: string): string {
  return [
    `Usage: /${commandName} [status | <id> | load <id> | unload <id> | reload <id>]`,
    '',
    'Forms:',
    '  status        List every external plugin.',
    '  <id>          Show details for one plugin.',
    '  load <id>     Load a plugin that is not loaded.',
    '  unload <id>   Unload a plugin that is loaded.',
    '  reload <id>   Reload a plugin, loading it first when it is not loaded.',
  ].join('\n')
}

/** Return the error result for an id that is not in the current snapshot list. */
function unknownPlugin(id: string): CommandResult {
  return { kind: 'error', text: `Unknown plugin "${id}".` }
}

/** Extract a message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/** Find one plugin in the current snapshots. */
function findPlugin(target: MloaderCommandTarget, id: string): PluginSnapshot | undefined {
  return target.list().find((plugin) => plugin.id === id)
}

/** Handle a bare id token by rendering its detail block. */
function showDetail(target: MloaderCommandTarget, id: string): CommandResult {
  const plugin = findPlugin(target, id)
  if (plugin === undefined) return unknownPlugin(id)
  return { kind: 'success', text: renderDetail(plugin) }
}

/** Load a plugin that is not loaded yet. */
async function loadPlugin(target: MloaderCommandTarget, id: string): Promise<CommandResult> {
  const plugin = findPlugin(target, id)
  if (plugin === undefined) return unknownPlugin(id)
  if (isLoaded(plugin.state)) {
    return { kind: 'success', text: `Plugin ${id} is already loaded.` }
  }
  try {
    return { kind: 'success', text: renderLoaded(await target.enable(id)) }
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }
}

/** Unload a plugin that is loaded. */
async function unloadPlugin(target: MloaderCommandTarget, id: string): Promise<CommandResult> {
  const plugin = findPlugin(target, id)
  if (plugin === undefined) return unknownPlugin(id)
  if (!isLoaded(plugin.state)) {
    return { kind: 'success', text: `Plugin ${id} is not loaded; nothing to unload.` }
  }
  try {
    return { kind: 'success', text: renderState(await target.disable(id)) }
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }
}

/** Reload a loaded plugin, or load it when it is not loaded. */
async function reloadPlugin(target: MloaderCommandTarget, id: string): Promise<CommandResult> {
  const plugin = findPlugin(target, id)
  if (plugin === undefined) return unknownPlugin(id)
  try {
    if (isLoaded(plugin.state)) {
      return { kind: 'success', text: renderState(await target.reload(id)) }
    }
    return { kind: 'success', text: renderLoaded(await target.enable(id)) }
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }
}

/**
 * Dispatch one invocation.
 *
 * The input is the text after the command name. Unknown or malformed input
 * returns the usage text; a bare token that is not a reserved word selects one
 * plugin, so a plugin may not be addressed by a name the parser claims first.
 */
async function dispatch(
  target: MloaderCommandTarget,
  commandName: string,
  rawInput: string,
): Promise<CommandResult> {
  const tokens = rawInput.trim().split(/\s+/).filter((token) => token.length > 0)

  if (tokens.length === 0) {
    return { kind: 'success', text: format({ plugins: target.list() }) }
  }
  if (tokens.length === 1) {
    const word = tokens[0] as string
    if (word === 'status') {
      return { kind: 'success', text: format({ plugins: target.list() }) }
    }
    if (word === 'help') {
      return { kind: 'success', text: renderUsage(commandName) }
    }
    if (RESERVED_WORDS.has(word)) {
      return { kind: 'error', text: renderUsage(commandName) }
    }
    return showDetail(target, word)
  }
  if (tokens.length === 2) {
    const word = tokens[0] as string
    const id = tokens[1] as string
    if (word === 'load') return await loadPlugin(target, id)
    if (word === 'unload') return await unloadPlugin(target, id)
    if (word === 'reload') return await reloadPlugin(target, id)
  }
  return { kind: 'error', text: renderUsage(commandName) }
}

/**
 * Register the `/mloader` command group.
 *
 * The command name is validated before the commands service is touched; an
 * invalid name is a warning and no registration. The `commands` service is
 * optional and is looked up at call time, so a missing service skips the
 * command and leaves plugin hosting untouched. The handler never throws: a
 * failed transition is returned as an error result with the thrown message.
 *
 * @param ctx - The loader's own Cordis context.
 * @param target - Lifecycle operations the command may request.
 * @param logger - Loader logger. Optional.
 * @param commandName - Command name without the leading slash.
 * @returns The command disposer, or `undefined` when nothing was registered.
 */
export function registerMloaderCommand(
  ctx: LoaderContext,
  target: MloaderCommandTarget,
  logger?: LoaderLogger,
  commandName = DEFAULT_COMMAND_NAME,
): Disposer | undefined {
  if (!COMMAND_NAME_PATTERN.test(commandName)) {
    logger?.warn?.(
      `invalid command name "${commandName}" ` +
      `(must match ${String(COMMAND_NAME_PATTERN)}); command not registered`,
    )
    return undefined
  }

  const commands = typeof ctx.get === 'function'
    ? ctx.get<MloaderCommandService>('commands')
    : undefined
  if (commands === undefined || commands === null) {
    logger?.debug?.('commands service is unavailable; slash command was not registered')
    return undefined
  }
  if (typeof commands.register !== 'function') {
    logger?.warn?.('commands service has no register method; slash command was not registered')
    return undefined
  }

  const dispose = commands.register({
    name: commandName,
    description: 'Manage the external plugins hosted by dsh-mloader.',
    input: {
      hint: '[status | <id> | load <id> | unload <id> | reload <id>]',
    },
    async handler(invocation) {
      return await dispatch(target, commandName, invocation?.rawInput ?? '')
    },
  })

  logger?.debug?.(`registered slash command /${commandName}`)
  return typeof dispose === 'function' ? dispose : undefined
}
