/**
 * Discovery of external plugins under the configured roots.
 *
 * A root is scanned for `mloader.plugin.json` manifests. A manifest that cannot
 * be read or validated produces one error and is skipped; discovery never
 * rejects because of a single bad plugin.
 *
 * @module discovery
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { isValidPluginId } from './contract.js'
import type {
  BackendKind,
  LoaderLogger,
  PluginCapabilities,
  PluginSpec,
  PluginTimeouts,
} from './types.js'

/** Metadata file name that marks a plugin directory. */
export const MANIFEST_NAME = 'mloader.plugin.json'

/** One plugin manifest that discovery rejected. */
export interface DiscoveryError {
  /** Root directory that could not be read, when the failure is root scoped. */
  root?: string
  /** Manifest path that was rejected, when the failure is manifest scoped. */
  manifest?: string
  /** Human readable reason, safe to log. */
  message: string
}

/** Result of scanning the plugin roots. */
export interface DiscoveryResult {
  specs: PluginSpec[]
  errors: DiscoveryError[]
}

/**
 * Read and normalise one manifest.
 *
 * @param path - Absolute manifest path.
 * @returns The normalised plugin specification.
 * @throws {Error} When the file is not a JSON object, or a required field is
 *   missing or outside its grammar.
 */
async function readManifest(path: string): Promise<PluginSpec> {
  const raw = await readFile(path, 'utf8')
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${messageOf(error)}`)
  }
  if (!isRecord(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  const baseDir = dirname(path)
  const id = parsed.id
  if (!isValidPluginId(id)) {
    throw new Error(`${path}: id ${JSON.stringify(id)} must match ^[a-z0-9][a-z0-9_-]{0,31}$`)
  }
  const backend = parsed.backend
  if (backend !== 'python' && backend !== 'wasm') {
    throw new Error(`${path}: backend must be "python" or "wasm", got ${JSON.stringify(backend)}`)
  }
  if (typeof parsed.entry !== 'string' || parsed.entry.length === 0) {
    throw new Error(`${path}: entry is required and must be a non-empty string`)
  }

  const timeouts = isRecord(parsed.timeouts) ? parsed.timeouts : {}
  const capabilities = isRecord(parsed.capabilities) ? parsed.capabilities : {}
  const rawEnv = isRecord(parsed.env) ? parsed.env : {}
  const env: Record<string, string> = {}
  for (const [key, value] of Object.entries(rawEnv)) {
    env[key] = typeof value === 'string' ? value : String(value)
  }

  return {
    id,
    name: typeof parsed.name === 'string' && parsed.name ? parsed.name : id,
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    backend: backend as BackendKind,
    entry: resolve(baseDir, parsed.entry),
    baseDir,
    manifestPath: path,
    enabled: parsed.enabled !== false,
    inject: Array.isArray(parsed.inject) ? parsed.inject.map(String) : [],
    capabilities: {
      tools: capabilities.tools !== false,
      events: capabilities.events !== false,
      logger: capabilities.logger !== false,
      effect: capabilities.effect !== false,
    } satisfies PluginCapabilities,
    timeouts: {
      startupMs: finiteNumber(timeouts.startupMs, 10_000),
      callMs: finiteNumber(timeouts.callMs, 30_000),
    } satisfies PluginTimeouts,
    env,
    declared: parsed,
  }
}

/**
 * Scan the plugin roots.
 *
 * Each root may itself be a plugin directory or contain plugin directories.
 * A duplicate plugin id is reported on the later manifest and skipped.
 *
 * @param roots - Absolute root directories.
 * @param logger - Optional logger for manifest failures.
 * @returns Discovered plugins sorted by id, plus the rejected manifests.
 */
export async function discover(roots: string[], logger?: LoaderLogger): Promise<DiscoveryResult> {
  const specs: PluginSpec[] = []
  const errors: DiscoveryError[] = []
  const seenIds = new Map<string, string>()

  for (const root of roots) {
    let entries
    try {
      const info = await stat(root)
      entries = info.isDirectory() ? await readdir(root, { withFileTypes: true }) : []
    } catch (error) {
      errors.push({ root, message: `cannot read plugin root: ${messageOf(error)}` })
      continue
    }

    const candidates: string[] = []
    const rootManifest = join(root, MANIFEST_NAME)
    if (await pathExists(rootManifest)) candidates.push(rootManifest)
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(root, entry.name, MANIFEST_NAME)
      if (await pathExists(manifestPath)) candidates.push(manifestPath)
    }

    for (const manifestPath of candidates) {
      try {
        const spec = await readManifest(manifestPath)
        const previous = seenIds.get(spec.id)
        if (previous !== undefined) {
          errors.push({
            manifest: manifestPath,
            message: `duplicate plugin id "${spec.id}" (already at ${previous})`,
          })
          continue
        }
        seenIds.set(spec.id, manifestPath)
        specs.push(spec)
      } catch (error) {
        const message = messageOf(error)
        errors.push({ manifest: manifestPath, message })
        logger?.warn?.(`skip ${manifestPath}: ${message}`)
      }
    }
  }

  specs.sort((left, right) => left.id.localeCompare(right.id))
  return { specs, errors }
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

function finiteNumber(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
