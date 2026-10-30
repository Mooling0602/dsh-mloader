/**
 * Release of the bundled example plugins into the profile.
 *
 * The package ships one reference plugin under seed/. Every start replaces each
 * example in <profile>/mloader/plugins with the packaged copy, so the released
 * code always matches the installed loader. A release failure is a warning,
 * never a startup failure. The id hello-mloader is reserved for the bundled
 * example; discovery accepts it only with the bundled marker.
 *
 * @module seed
 */

import { cp, mkdir, readdir, rm, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import type { Dirent } from 'node:fs'
import type { LoaderLogger } from './types.js'

/** Absolute directory that holds the bundled example plugins. */
export const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed')

/** Outcome of one release attempt, used by the caller to report what happened. */
export interface SeedResult {
  /** Example names released for the first time. */
  installed: string[]
  /** Example names replaced because an earlier copy existed. */
  replaced: string[]
}

/** Return true when a path exists. */
async function exists(path: string): Promise<boolean> {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * Replace the bundled examples in a plugin directory.
 *
 * A target directory is removed and the packaged copy is written in its place
 * on every start. This keeps the reference implementation current and removes
 * edits to it, because the bundled example is maintained by the loader rather
 * than by the operator. A failure on one example is logged as a warning and
 * does not stop the remaining examples, because the seed must never block
 * startup.
 *
 * @param targetDir - Plugin directory to populate, normally
 *   <profile>/mloader/plugins. An empty value releases nothing.
 * @param logger - Receives warnings and the release summary. Optional.
 * @returns Names of the newly released and replaced examples.
 */
export async function installSeedExamples(
  targetDir: string,
  logger?: LoaderLogger,
): Promise<SeedResult> {
  const installed: string[] = []
  const replaced: string[] = []

  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    return { installed, replaced }
  }

  let entries: Dirent[]
  try {
    entries = await readdir(SEED_DIR, { withFileTypes: true })
  } catch (error) {
    logger?.warn?.('bundled seed directory is unreadable: ' + messageOf(error))
    return { installed, replaced }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = join(SEED_DIR, entry.name)
    const target = join(targetDir, entry.name)
    const hadTarget = await exists(target)

    try {
      await mkdir(dirname(target), { recursive: true })
      if (hadTarget) await rm(target, { recursive: true, force: true })
      await cp(source, target, { recursive: true, force: true })
      if (hadTarget) replaced.push(entry.name)
      else installed.push(entry.name)
    } catch (error) {
      logger?.warn?.('example plugin ' + entry.name + ' was not installed: ' + messageOf(error))
    }
  }

  if (installed.length > 0) {
    logger?.info?.(
      'seeded ' + installed.length + ' example plugin(s) into ' + targetDir + ': ' +
      installed.join(', '),
    )
  }
  if (replaced.length > 0) {
    logger?.info?.(
      'refreshed ' + replaced.length + ' example plugin(s) in ' + targetDir + ': ' +
      replaced.join(', '),
    )
  }
  return { installed, replaced }
}

/** Extract a message from an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
