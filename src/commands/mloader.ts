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

import type { InstallResult, RemoveResult } from '../installer/install.js'
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
  /**
   * Install one or more plugin packages. Absent when the loader cannot resolve
   * the profile plugin directory.
   */
  install?(paths: string[], options: { force: boolean }): Promise<InstallResult[]>
  /**
   * Remove one installed plugin. Absent when the loader cannot resolve the
   * profile plugin directory.
   */
  remove?(id: string, options: { force: boolean }): Promise<RemoveResult>
}

/** Result of one command invocation, as the commands service expects it. */
export interface CommandResult {
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
const RESERVED_WORDS = new Set([
  'status',
  'help',
  'load',
  'unload',
  'reload',
  'install',
  'uninstall',
  'remove',
  'ok',
  'confirm',
])

/** A package batch waiting for the operator's second confirmation. */
interface PendingInstall {
  /** Input text that produced the pending batch, used to detect a re-run. */
  rawInput: string
  /** Package paths that need confirmation. */
  paths: string[]
}

/** One removal waiting for the operator's second confirmation. */
interface PendingRemoval {
  /** Plugin id the operator asked to remove. */
  id: string
}

/** Mutable state of one registered command, kept across invocations. */
interface CommandState {
  /** The batch waiting for confirmation, when one exists. */
  pending?: PendingInstall
  /** The removal waiting for confirmation, when one exists. */
  pendingRemoval?: PendingRemoval
}

/** Return true when a plugin holds a running backend. */
function isLoaded(state: PluginState): boolean {
  return state === 'applied' || state === 'loaded'
}

/** Render one plugin as a detail block. */
function renderDetail(plugin: PluginSnapshot): string {
  const tools = plugin.tools.length > 0 ? plugin.tools.join(', ') : 'none'
  const events = plugin.events.length > 0 ? plugin.events.join(', ') : 'none'
  const commands = plugin.commands?.length ? plugin.commands.join(', ') : 'none'
  const lines = [
    `Plugin ${plugin.id}:`,
    `  Name: ${plugin.name}`,
    `  Version: ${plugin.version}`,
    `  Backend: ${plugin.backend}`,
    `  State: ${plugin.state} (${isLoaded(plugin.state) ? 'loaded' : 'not loaded'})`,
    `  Tools: ${tools}`,
    `  Events: ${events}`,
    `  Commands: ${commands}`,
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
    `Usage: /${commandName} [status | <id> | load <id> | unload <id> | reload <id> | install <file> ... | uninstall <id> | ok | confirm]`,
    '',
    'Forms:',
    '  status            List every external plugin.',
    '  <id>              Show details for one plugin.',
    '  load <id>         Load a plugin that is not loaded.',
    '  unload <id>       Unload a plugin that is loaded, keeping its files.',
    '  reload <id>       Reload a plugin, loading it first when it is not loaded.',
    '  install <file>    Install one or more plugin packages.',
    '  uninstall <id>    Remove an installed plugin, moving its directory to the trash.',
    '  ok, confirm       Confirm the operation waiting for confirmation.',
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

/** Operations that address one plugin. */
export type MloaderAction = 'info' | 'load' | 'unload' | 'reload' | 'uninstall'

/**
 * Run a plugin operation with the same lifecycle and output as the slash command.
 *
 * @param target - Plugin snapshots and lifecycle operations.
 * @param action - The operation to perform.
 * @param id - The exact plugin identifier.
 * @returns The command result, including transition errors.
 */
export async function runMloaderAction(
  target: MloaderCommandTarget,
  action: MloaderAction,
  id: string,
): Promise<CommandResult> {
  switch (action) {
    case 'info': return showDetail(target, id)
    case 'load': return await loadPlugin(target, id)
    case 'unload': return await unloadPlugin(target, id)
    case 'reload': return await reloadPlugin(target, id)
    case 'uninstall': return await executeRemove(target, id, false)
  }
}

/** Split command input into tokens, honouring single and double quotes. */
function tokenize(input: string): string[] {
  const tokens: string[] = []
  let current = ''
  let started = false
  let quote: "'" | '"' | undefined
  for (const character of input) {
    if (quote !== undefined) {
      if (character === quote) {
        quote = undefined
      } else {
        current += character
      }
      continue
    }
    if (character === "'" || character === '"') {
      quote = character
      started = true
      continue
    }
    if (/\s/u.test(character)) {
      if (started) tokens.push(current)
      started = false
      current = ''
      continue
    }
    current += character
    started = true
  }
  if (quote !== undefined) {
    throw new Error(`unterminated ${quote === "'" ? 'single' : 'double'} quote`)
  }
  if (started) tokens.push(current)
  return tokens
}

/** Outcome of one install batch, after automatic reloads. */
interface InstallExecution {
  result: CommandResult
  results: InstallResult[]
}

/** Run one install batch, reload loaded plugins and render the summary. */
async function executeInstall(
  target: MloaderCommandTarget,
  paths: string[],
  force: boolean,
): Promise<InstallExecution> {
  if (typeof target.install !== 'function') {
    return {
      result: {
        kind: 'error',
        text: 'Package installation is unavailable: the profile plugin directory was not detected.',
      },
      results: [],
    }
  }
  let results: InstallResult[]
  try {
    results = await target.install(paths, { force })
  } catch (error) {
    return { result: { kind: 'error', text: messageOf(error) }, results: [] }
  }

  const installed = results.filter((item) => item.status === 'installed' || item.status === 'updated')
  const pending = results.filter((item) => item.status === 'needs-confirmation')
  const failed = results.filter((item) => item.status === 'failed')
  const lines: string[] = []

  if (installed.length > 0) {
    lines.push(`${installed.length} package(s) installed:`)
    for (const item of installed) {
      const id = item.id ?? item.path
      const version = item.version === undefined ? '' : ` ${item.version}`
      lines.push(
        `  ${item.status} ${id}${version} (${item.backend ?? 'unknown'}) at ${item.directory ?? 'unknown directory'}`,
      )
    }
  }
  if (pending.length > 0) {
    lines.push(`${pending.length} package(s) need confirmation:`)
    for (const item of pending) lines.push(`  ${item.path}: ${item.message ?? 'confirmation required'}`)
    lines.push('Run /mloader ok to confirm, or run the same command again.')
  }
  if (failed.length > 0) {
    lines.push(`${failed.length} package(s) failed:`)
    for (const item of failed) lines.push(`  ${item.path}: ${item.message ?? 'installation failed'}`)
  }

  for (const item of installed) {
    if (item.id === undefined) continue
    const known = target.list().find((plugin) => plugin.id === item.id)
    if (known === undefined || !isLoaded(known.state)) continue
    try {
      await target.reload(item.id)
      lines.push(`reloaded ${item.id}.`)
    } catch (error) {
      lines.push(`warning: reload of ${item.id} failed: ${messageOf(error)}`)
    }
  }
  for (const warning of new Set(results.flatMap((item) => item.warnings))) {
    lines.push(`warning: ${warning}`)
  }
  if (lines.length === 0) lines.push('No package was installed.')

  return {
    result: {
      kind: failed.length > 0 || pending.length > 0 ? 'error' : 'success',
      text: lines.join('\n'),
    },
    results,
  }
}

/**
 * Remove one installed plugin, unloading it first when it is loaded.
 *
 * The backend is stopped before the directory moves, because the interpreter of
 * a running Python plugin holds files inside that directory. A plugin that was
 * never loaded needs no unload, and one whose id is not currently discovered can
 * still be removed: a broken installation is exactly the case where the operator
 * needs this command.
 *
 * @param target - Plugin snapshots, lifecycle operations and the installer.
 * @param id - Plugin id to remove.
 * @param force - Remove even when the installation was edited after installation.
 * @returns The command result, including the confirmation request and its reason.
 */
async function executeRemove(
  target: MloaderCommandTarget,
  id: string,
  force: boolean,
): Promise<CommandResult> {
  if (typeof target.remove !== 'function') {
    return {
      kind: 'error',
      text: 'Plugin removal is unavailable: the profile plugin directory was not detected.',
    }
  }
  const known = findPlugin(target, id)
  if (known !== undefined && isLoaded(known.state)) {
    try {
      await target.disable(id)
    } catch (error) {
      return { kind: 'error', text: `cannot unload ${id} before removing it: ${messageOf(error)}` }
    }
  }

  let result: RemoveResult
  try {
    result = await target.remove(id, { force })
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }

  if (result.status === 'needs-confirmation') {
    return {
      kind: 'error',
      text: [
        `Removing ${id} needs confirmation: ${result.message ?? 'the installation changed'}.`,
        `Run /mloader uninstall ${id} --force to remove it anyway.`,
      ].join('\n'),
    }
  }
  if (result.status === 'failed') {
    return { kind: 'error', text: result.message ?? `could not remove ${id}` }
  }
  const changed = result.changed?.length
    ? `${result.changed.length} edited file(s) went to the trash with it.`
    : undefined
  return {
    kind: 'success',
    text: [`Removed ${id} to ${result.trash ?? 'the trash'}.`, ...changed === undefined ? [] : [changed]].join('\n'),
  }
}

/**
 * Dispatch one invocation.
 *
 * The input is the text after the command name. Unknown or malformed input
 * returns the usage text; a bare token that is not a reserved word selects one
 * plugin, so a plugin may not be addressed by a name the parser claims first.
 * An install batch or a removal that needs confirmation is remembered so that
 * `ok`, `confirm` or a re-run of the same input can complete it.
 */
async function dispatch(
  target: MloaderCommandTarget,
  commandName: string,
  rawInput: string,
  state: CommandState,
): Promise<CommandResult> {
  const input = rawInput.trim()
  let tokens: string[]
  try {
    tokens = tokenize(input)
  } catch (error) {
    return { kind: 'error', text: messageOf(error) }
  }

  if (tokens.length === 0) {
    return { kind: 'success', text: format({ plugins: target.list() }) }
  }

  const first = tokens[0] as string
  if (first === 'install') {
    const paths = tokens.slice(1)
    if (paths.length === 0) {
      return { kind: 'error', text: `Usage: /${commandName} install <file> [<file> ...]` }
    }
    if (state.pending !== undefined && state.pending.rawInput === input) {
      const pending = state.pending
      state.pending = undefined
      return (await executeInstall(target, pending.paths, true)).result
    }
    const execution = await executeInstall(target, paths, false)
    const needs = execution.results
      .filter((item) => item.status === 'needs-confirmation')
      .map((item) => item.path)
    state.pending = needs.length > 0 ? { rawInput: input, paths: needs } : undefined
    return execution.result
  }
  if (first === 'uninstall' || first === 'remove') {
    const rest = tokens.slice(1)
    const id = rest.find((token) => token !== '--force')
    if (id === undefined) {
      return { kind: 'error', text: `Usage: /${commandName} uninstall <id> [--force]` }
    }
    const force = rest.includes('--force')
    if (!force && state.pendingRemoval?.id === id) {
      state.pendingRemoval = undefined
      return await executeRemove(target, id, false)
    }
    const result = await executeRemove(target, id, force)
    // A removal that the installer agreed to perform was performed, so a
    // pending entry is cleared either way; only an edit that still needs the
    // operator's consent keeps one.
    state.pendingRemoval = result.kind === 'error' && result.text.includes('needs confirmation')
      ? { id }
      : undefined
    return result
  }
  if (first === 'ok' || first === 'confirm') {
    if (tokens.length !== 1) return { kind: 'error', text: renderUsage(commandName) }
    const removal = state.pendingRemoval
    if (removal !== undefined) {
      state.pendingRemoval = undefined
      return await executeRemove(target, removal.id, true)
    }
    if (state.pending === undefined) return { kind: 'error', text: 'Nothing to confirm.' }
    const pending = state.pending
    state.pending = undefined
    return (await executeInstall(target, pending.paths, true)).result
  }

  if (tokens.length === 1) {
    if (first === 'status') {
      return { kind: 'success', text: format({ plugins: target.list() }) }
    }
    if (first === 'help') {
      return { kind: 'success', text: renderUsage(commandName) }
    }
    if (RESERVED_WORDS.has(first)) {
      return { kind: 'error', text: renderUsage(commandName) }
    }
    return await runMloaderAction(target, 'info', first)
  }
  if (tokens.length === 2) {
    const id = tokens[1] as string
    if (first === 'load' || first === 'unload' || first === 'reload') {
      return await runMloaderAction(target, first, id)
    }
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

  const state: CommandState = {}
  const dispose = commands.register({
    name: commandName,
    description: 'Manage, install and remove the external plugins hosted by dsh-mloader.',
    input: {
      hint: '[status | <id> | load <id> | unload <id> | reload <id> | install <file> ... | uninstall <id> | ok | confirm]',
    },
    async handler(invocation) {
      return await dispatch(target, commandName, invocation?.rawInput ?? '', state)
    },
  })

  logger?.debug?.(`registered slash command /${commandName}`)
  return typeof dispose === 'function' ? dispose : undefined
}
