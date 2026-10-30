/** Profile-owned configuration editing for the loader's operator interface. */

import { createHash } from 'node:crypto'
import type { LoaderContext } from './types.js'

/** The configuration fields exposed by the operator interface. */
export interface EditableConfig {
  roots: string[]
  profilePlugins: boolean
  autoEnable: boolean
  pythonBin: string
  shellPath: string[]
  enablePyc: boolean
  statusTool: boolean
  command: boolean | string
  seedExamples: boolean
  console: boolean | 'verbose'
  watch: boolean
  wasmEnabled: boolean
}

/** Snapshot used for an optimistic configuration edit. */
export interface ConfigSnapshot {
  config: EditableConfig
  revision: string
}

/** The loader entry needed by the host configuration editor. */
interface EditorEntry {
  options: { id?: string; name?: string; config?: unknown }
}

/** The subset of DSH's configEditor service used by this plugin. */
interface ConfigEditor {
  entries(): EditorEntry[]
  edit(entry: EditorEntry, change: (current: unknown, inherited: unknown) => unknown): Promise<void>
}

/** An edit based on a snapshot that is no longer current. */
export class ConfigConflictError extends Error {
  constructor() {
    super('configuration changed; reload it before saving')
    this.name = 'ConfigConflictError'
  }
}

/** An unavailable configuration editor or inactive loader entry. */
export class ConfigUnavailableError extends Error {
  constructor() {
    super('the profile configuration editor or dsh-mloader entry is unavailable')
    this.name = 'ConfigUnavailableError'
  }
}

/** An invalid configuration edit. */
export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ConfigValidationError'
  }
}

/** Default values of the configuration fields exposed by the operator interface. */
const DEFAULTS: EditableConfig = {
  roots: [], profilePlugins: true, autoEnable: true, pythonBin: 'python3', shellPath: [],
  enablePyc: false, statusTool: true, command: true, seedExamples: true, console: true,
  watch: true, wasmEnabled: false,
}

/** Return true when the value is a non-array record. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

/** Project one loader configuration onto the fields exposed by the UI. */
function project(raw: unknown): EditableConfig {
  const source = isRecord(raw) ? raw : {}
  const wasm = isRecord(source.wasm) ? source.wasm : {}
  const strings = (value: unknown, fallback: string[]): string[] =>
    Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : [...fallback]
  const bool = (key: keyof EditableConfig): boolean =>
    typeof source[key] === 'boolean' ? source[key] as boolean : DEFAULTS[key] as boolean
  return {
    roots: strings(source.roots, DEFAULTS.roots),
    profilePlugins: bool('profilePlugins'), autoEnable: bool('autoEnable'),
    pythonBin: typeof source.pythonBin === 'string' ? source.pythonBin : DEFAULTS.pythonBin,
    shellPath: strings(source.shellPath, DEFAULTS.shellPath),
    enablePyc: bool('enablePyc'), statusTool: bool('statusTool'),
    command: typeof source.command === 'boolean' || typeof source.command === 'string' ? source.command : DEFAULTS.command,
    seedExamples: bool('seedExamples'),
    console: source.console === true || source.console === false || source.console === 'verbose' ? source.console : DEFAULTS.console,
    watch: bool('watch'), wasmEnabled: typeof wasm.enabled === 'boolean' ? wasm.enabled : DEFAULTS.wasmEnabled,
  }
}

/** Compute a revision over the fields a form is allowed to change. */
function revision(config: EditableConfig): string {
  return createHash('sha256').update(JSON.stringify(config)).digest('hex')
}

/** Find the active, uniquely addressed loader entry in the profile. */
function editorEntry(ctx: LoaderContext): { editor: ConfigEditor; entry: EditorEntry } {
  const editor = ctx.get<ConfigEditor>('configEditor')
  if (!editor || typeof editor.entries !== 'function' || typeof editor.edit !== 'function') {
    throw new ConfigUnavailableError()
  }
  const candidates = editor.entries().filter((entry) =>
    entry.options.id === 'dsh-mloader' && entry.options.name === 'dsh-mloader')
  if (candidates.length !== 1) throw new ConfigUnavailableError()
  return { editor, entry: candidates[0] as EditorEntry }
}

/**
 * Read the editable loader configuration from the active profile entry.
 *
 * @param ctx - Loader context with the optional DSH configEditor service.
 * @returns The projected configuration and its revision.
 * @throws {ConfigUnavailableError} When the profile entry is not editable.
 */
export function readLoaderConfig(ctx: LoaderContext): ConfigSnapshot {
  const { entry } = editorEntry(ctx)
  const config = project(entry.options.config)
  return { config, revision: revision(config) }
}

/** Validate one partial configuration object before it reaches the host editor. */
function validateChanges(value: unknown): Partial<EditableConfig> {
  if (!isRecord(value) || Object.keys(value).length === 0) throw new ConfigValidationError('changes must be a non-empty object')
  const changes: Partial<EditableConfig> = {}
  for (const [key, item] of Object.entries(value)) {
    switch (key) {
      case 'roots': case 'shellPath':
        if (!Array.isArray(item) || !item.every((part) => typeof part === 'string' && part.length > 0)) {
          throw new ConfigValidationError(`${key} must be a list of non-empty strings`)
        }
        changes[key] = item
        break
      case 'profilePlugins': case 'autoEnable': case 'enablePyc': case 'statusTool':
      case 'seedExamples': case 'watch': case 'wasmEnabled':
        if (typeof item !== 'boolean') throw new ConfigValidationError(`${key} must be a boolean`)
        changes[key] = item
        break
      case 'pythonBin':
        if (typeof item !== 'string' || item.trim() === '') throw new ConfigValidationError('pythonBin must be a non-empty string')
        changes.pythonBin = item
        break
      case 'command':
        if (typeof item !== 'boolean' && (typeof item !== 'string' || !/^[a-z][a-z0-9_-]*$/u.test(item))) {
          throw new ConfigValidationError('command must be a boolean or a valid command name')
        }
        changes.command = item
        break
      case 'console':
        if (item !== true && item !== false && item !== 'verbose') throw new ConfigValidationError('console must be true, false or verbose')
        changes.console = item
        break
      default: throw new ConfigValidationError(`unknown configuration field: ${key}`)
    }
  }
  return changes
}

/**
 * Save an edit through DSH's profile configuration editor.
 *
 * The host editor serializes writes, validates and reconciles the full config,
 * and restores the previous profile patch if reconciliation fails. Unedited
 * fields remain in the raw configuration.
 *
 * @param ctx - Loader context with the optional DSH configEditor service.
 * @param expectedRevision - Revision of the snapshot being edited.
 * @param input - Partial editable configuration.
 * @throws {ConfigValidationError} When the edit is malformed.
 * @throws {ConfigConflictError} When an editable field changed after the read.
 * @throws {ConfigUnavailableError} When the profile entry is not editable.
 */
export async function writeLoaderConfig(ctx: LoaderContext, expectedRevision: unknown, input: unknown): Promise<void> {
  if (typeof expectedRevision !== 'string' || !/^[a-f0-9]{64}$/u.test(expectedRevision)) {
    throw new ConfigValidationError('revision must be a configuration revision')
  }
  const changes = validateChanges(input)
  const { editor, entry } = editorEntry(ctx)
  await editor.edit(entry, (current) => {
    if (revision(project(current)) !== expectedRevision) throw new ConfigConflictError()
    const next: Record<string, unknown> = isRecord(current) ? { ...current } : {}
    for (const [key, value] of Object.entries(changes)) {
      if (key === 'wasmEnabled') next.wasm = { ...(isRecord(next.wasm) ? next.wasm : {}), enabled: value }
      else next[key] = value
    }
    return next
  })
}
