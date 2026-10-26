/**
 * Contract constants, schema validation and profile path resolution.
 *
 * Everything exported here belongs to the external plugin contract or to the
 * profile discovery rules the loader depends on. The values are part of the ABI
 * for Python and WASM plugins; changing one is a contract change.
 *
 * @module contract
 */

import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import type { JsonSchema, PluginState } from './types.js'

/** Events an external plugin may subscribe to. */
export const EVENT_WHITELIST = new Set<string>([
  'tools/execute',
  'tools/pre-execute',
  'tools/post-execute',
  'tools/result',
  'tools/change',
  'agent/status',
  'agent/created',
  'agent/disposed',
  'session/created',
  'session/disposed',
])

/** JSON Schema keywords accepted by the harness tool registry. */
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])

/** JSON Schema annotation keywords accepted by the harness tool registry. */
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])

/** JSON Schema types accepted by the harness tool registry. */
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * Validate a tool schema against the subset the harness accepts.
 *
 * The loader validates before registering so a violation names the plugin and
 * the schema path, rather than surfacing later as a harness error without that
 * context.
 *
 * @param schema - Candidate schema node.
 * @param where - Diagnostic prefix, for example `tool "py_greet"`.
 * @returns One message per violation. An empty array means the schema is valid.
 */
export function validateToolSchema(schema: unknown, where: string): string[] {
  const violations: string[] = []
  const seen = new Set<object>()

  const walk = (node: unknown, path: string): void => {
    if (!isRecord(node)) {
      violations.push(`${where}: ${path} must be a schema object`)
      return
    }
    if (seen.has(node)) {
      violations.push(`${where}: ${path} is circular`)
      return
    }
    seen.add(node)

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
      violations.push(
        `${where}: ${path}.${key} is not supported ` +
        '(subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)',
      )
    }

    if (node.type !== undefined && (typeof node.type !== 'string' || !SUPPORTED_TYPES.has(node.type))) {
      violations.push(`${where}: ${path}.type "${String(node.type)}" is not a supported type`)
    }
    if (node.type !== undefined && node.oneOf !== undefined) {
      violations.push(`${where}: ${path} cannot declare both type and oneOf`)
    }

    if (isRecord(node.properties)) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, `${path}.properties.${key}`)
      }
    }
    if (node.items !== undefined) walk(node.items, `${path}.items`)
    if (Array.isArray(node.oneOf)) {
      node.oneOf.forEach((child, index) => walk(child, `${path}.oneOf[${index}]`))
    }

    seen.delete(node)
  }

  walk(schema, 'schema')
  return violations
}

/** Return true when a manifest id satisfies the plugin id grammar. */
export function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)
}

/** Lifecycle states of an external plugin. */
export const PLUGIN_STATE = Object.freeze({
  DISCOVERED: 'discovered',
  LOADED: 'loaded',
  APPLIED: 'applied',
  DISABLED: 'disabled',
  FAILED: 'failed',
  DISPOSED: 'disposed',
} satisfies Record<string, PluginState>)

/** Version of the NDJSON plugin protocol. */
export const PROTOCOL_VERSION = 1

/** Options that control how plugin roots are resolved. */
export interface ResolveRootsOptions {
  /** Append `<profile>/mloader/plugins` when the profile is known. Defaults to true. */
  includeProfileDir?: boolean
  /** Override the detected profile directory. Intended for tests. */
  profileDir?: string
  /** `ctx.baseUrl`, the file URL of the current profile directory. */
  baseUrl?: string
}

/**
 * Resolve the current dsh profile directory.
 *
 * Sources are tried in this order, most reliable first: the explicit override,
 * `ctx.baseUrl` when the directory looks like a profile, `DSH_PROFILE_DIR`,
 * `DSH_HOME` plus `DSH_PROFILE`, and finally a scan of `~/.dsh/profiles` that
 * only succeeds when exactly one candidate looks like a profile. A profile is
 * recognised by having both `package.json` and `cordis.yml`.
 *
 * @param explicit - Explicit profile directory from configuration.
 * @param baseUrl - `ctx.baseUrl`, set by the harness to the profile directory URL.
 * @returns Absolute profile directory, or `undefined` when no source is reliable.
 */
export function resolveProfileDir(explicit?: string, baseUrl?: string): string | undefined {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit

  const fromBase = profileDirFromBaseUrl(baseUrl)
  if (fromBase !== undefined) return fromBase

  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.DSH_HOME
  const name = process.env.DSH_PROFILE
  if (typeof home === 'string' && home.length > 0 && typeof name === 'string' && name.length > 0) {
    return join(home, 'profiles', name)
  }

  return detectProfileDir()
}

/**
 * Derive a profile directory from `ctx.baseUrl`.
 *
 * @param baseUrl - File URL of a candidate directory.
 * @returns Absolute directory when it looks like a profile, otherwise undefined.
 */
function profileDirFromBaseUrl(baseUrl?: string): string | undefined {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined

  let dir: string
  try {
    const url = new URL(baseUrl)
    if (url.protocol !== 'file:') return undefined
    dir = fileURLToPath(url)
  } catch {
    return undefined
  }

  dir = dir.replace(/[/\\]+$/, '')
  return looksLikeProfileDir(dir) ? dir : undefined
}

/**
 * Return true when a directory contains the files an initialised profile has.
 *
 * @param dir - Candidate profile directory.
 */
function looksLikeProfileDir(dir: string): boolean {
  try {
    return statSync(join(dir, 'package.json')).isFile() &&
      statSync(join(dir, 'cordis.yml')).isFile()
  } catch {
    return false
  }
}

/**
 * Find a profile under `~/.dsh/profiles` by directory shape.
 *
 * Exactly one candidate is required. Guessing among several profiles is worse
 * than returning nothing, because a wrong guess reads and installs plugins in
 * the wrong profile.
 */
function detectProfileDir(): string | undefined {
  const home = process.env.HOME ?? homedir()
  const profilesRoot = join(home, '.dsh', 'profiles')
  let entries
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profilesRoot, entry.name))
    .filter((dir) => looksLikeProfileDir(dir))

  return candidates.length === 1 ? candidates[0] : undefined
}

/**
 * Resolve `<profile>/mloader/plugins`.
 *
 * @param profileDir - Explicit profile directory, when one is configured.
 * @param baseUrl - `ctx.baseUrl` used when no explicit directory is given.
 * @returns Absolute plugin directory, or undefined when no profile is known.
 */
export function profilePluginsDir(profileDir?: string, baseUrl?: string): string | undefined {
  const dir = resolveProfileDir(profileDir, baseUrl)
  if (dir === undefined) return undefined
  return join(dir, 'mloader', 'plugins')
}

/**
 * Resolve configured plugin roots to absolute paths.
 *
 * A root starting with `~` is expanded against the home directory. A relative
 * root is resolved against the profile directory, or the current working
 * directory when no profile is known. Unless `includeProfileDir` is false,
 * `<profile>/mloader/plugins` is appended when the profile is known; duplicate
 * entries are removed.
 *
 * @param roots - Raw configuration value of `roots`.
 * @param options - Profile detection overrides and the profile-root switch.
 * @returns Absolute directories, in configuration order.
 */
export function resolveRoots(roots: unknown, options: ResolveRootsOptions = {}): string[] {
  const { includeProfileDir = true, profileDir, baseUrl } = options
  const detectedProfile = resolveProfileDir(profileDir, baseUrl)
  const base = detectedProfile ?? process.cwd()
  const resolved: string[] = []

  const push = (path: string): void => {
    if (!resolved.includes(path)) resolved.push(path)
  }

  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root !== 'string' || root.length === 0) continue
      push(resolve(base, expandHome(root)))
    }
  }

  if (includeProfileDir && detectedProfile !== undefined) {
    push(join(detectedProfile, 'mloader', 'plugins'))
  }

  return resolved
}

/**
 * Expand a leading `~` against the home directory.
 *
 * @param path - Path that may start with `~` or `~/`.
 * @returns The expanded path, or the input when it has no home prefix.
 */
export function expandHome(path: string): string {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}

/** Return true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export type { JsonSchema }
