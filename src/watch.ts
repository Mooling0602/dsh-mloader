/**
 * Live tracking of the plugin roots.
 *
 * The loader scans its roots at boot. Operators also install and remove plugin
 * directories while dsh runs, so every root is watched and a settled change is
 * reported to the caller. The watcher never parses a manifest: it only says that
 * the set of plugin directories may have changed, and the loader decides what
 * that means.
 *
 * Only directory entries are reported. Creating, renaming and removing a
 * directory maps to a `rename` event, while writing inside a file maps to
 * `change`, so editing a manifest or an entry file never triggers a rescan. That
 * is the agreed scope: a file edit still needs an explicit reload.
 *
 * `fs.watch` maps to inotify on Linux, which needs one kernel watch per
 * directory. A root that does not exist yet cannot be watched, and a very large
 * tree can exceed the watch limit. Both cases are reported as warnings, and for
 * a missing root the parent directory is watched instead so that creating the
 * root later is still noticed.
 *
 * The watchers and the settle timer are unreferenced, so watching never keeps
 * the process alive on its own.
 *
 * @module watch
 */

import { existsSync, watch } from 'node:fs'
import { dirname } from 'node:path'
import type { FSWatcher } from 'node:fs'
import type { LoaderLogger } from './types.js'

/** Quiet period, in milliseconds, a change must settle for before the callback runs. */
const SETTLE_MS = 300

/** Path segments whose writes never change which plugins are installed. */
const IGNORED_SEGMENTS = new Set(['__pycache__', '.git', 'node_modules'])

/** File suffixes that never change which plugins are installed. */
const IGNORED_SUFFIXES = ['.pyc', '.pyo']

/** Options accepted by {@link watchPluginRoots}. */
export interface WatchRootsOptions {
  /** Absolute directories to watch, normally the resolved plugin roots. */
  roots: string[]
  /** Receives one warning per path that cannot be watched. */
  logger?: LoaderLogger
  /** Called once per settled change. A throw is logged and ignored. */
  onChange(): void
}

/** Handle for the watchers of one set of plugin roots. */
export interface RootWatchHandle {
  /** Stop watching. Idempotent, and a pending settle timer is discarded. */
  close(): void
}

/**
 * Watch plugin roots and report settled changes.
 *
 * Every root is watched recursively, so a plugin directory added, removed or
 * renamed at any depth below a root is reported. A burst of events, such as the
 * many entries of a directory copy, produces one callback after the quiet
 * period. Events that cannot change which plugins are installed, which means
 * Python bytecode and the metadata directories of version control and package
 * managers, produce no callback at all.
 *
 * @param options - Roots to watch plus the callback for a settled change.
 * @returns A handle whose `close()` stops every watcher and discards the timer.
 */
export function watchPluginRoots(options: WatchRootsOptions): RootWatchHandle {
  const { roots, logger, onChange } = options
  const watchers: FSWatcher[] = []
  let timer: ReturnType<typeof setTimeout> | undefined
  let closed = false

  const closeOne = (watcher: FSWatcher): void => {
    const index = watchers.indexOf(watcher)
    if (index !== -1) watchers.splice(index, 1)
    try {
      watcher.close()
    } catch {
      // The handle is already closed.
    }
  }

  const fire = (): void => {
    timer = undefined
    if (closed) return
    try {
      onChange()
    } catch (error) {
      logger?.warn?.(`dsh-mloader: plugin root change handler failed: ${messageOf(error)}`)
    }
  }

  const schedule = (): void => {
    if (closed) return
    if (timer !== undefined) clearTimeout(timer)
    timer = setTimeout(fire, SETTLE_MS)
    timer.unref()
  }

  for (const root of roots) {
    const target = resolveTarget(root, logger)
    if (target === undefined) continue
    try {
      const watcher = watch(target, { recursive: true }, (eventType, filename) => {
        if (eventType !== 'rename') return
        if (!isDirectoryEntry(filename)) return
        schedule()
      })
      watcher.on('error', (error: unknown) => {
        logger?.warn?.(`dsh-mloader: cannot watch ${target}: ${messageOf(error)}`)
        closeOne(watcher)
      })
      watcher.unref()
      watchers.push(watcher)
    } catch (error) {
      logger?.warn?.(`dsh-mloader: cannot watch ${target}: ${messageOf(error)}`)
    }
  }

  return {
    close(): void {
      if (closed) return
      closed = true
      if (timer !== undefined) {
        clearTimeout(timer)
        timer = undefined
      }
      for (const watcher of [...watchers]) closeOne(watcher)
    },
  }
}

/**
 * Pick the directory to watch for one root.
 *
 * An existing root is watched directly. A root that does not exist yet cannot be
 * watched, so the nearest existing ancestor is watched instead, which reports the
 * creation of the root and everything that arrives inside it afterwards. The file
 * system root is refused, because watching it would mean watching everything.
 *
 * @param root - Resolved plugin root.
 * @param logger - Logger for a root that cannot be watched.
 * @returns The directory to watch, or undefined when there is none.
 */
function resolveTarget(root: string, logger: LoaderLogger | undefined): string | undefined {
  let target = root
  while (!existsSync(target)) {
    const parent = dirname(target)
    if (parent === target) {
      logger?.warn?.(`dsh-mloader: cannot watch plugin root ${root}: the directory does not exist`)
      return undefined
    }
    target = parent
  }
  if (target === dirname(target)) {
    logger?.warn?.(`dsh-mloader: cannot watch plugin root ${root}: no parent directory below the file system root`)
    return undefined
  }
  if (target !== root) {
    logger?.debug?.(`dsh-mloader: plugin root ${root} does not exist yet; watching ${target}`)
  }
  return target
}

/**
 * Decide whether one filesystem event concerns a directory entry.
 *
 * Rename events cover creating, renaming and removing both files and
 * directories, and Node reports a path relative to the watched root. The event
 * name is absent on some platforms, in which case the change is reported because
 * it cannot be classified.
 *
 * @param filename - Event name as Node reported it.
 * @returns True when the caller should rescan.
 */
function isDirectoryEntry(filename: string | Buffer | null): boolean {
  if (filename === null) return true
  const raw = typeof filename === 'string' ? filename : filename.toString()
  if (raw.length === 0) return true
  const segments = raw.split('\\').join('/').split('/')
  for (const segment of segments) {
    if (IGNORED_SEGMENTS.has(segment)) return false
  }
  const name = segments[segments.length - 1] ?? ''
  for (const suffix of IGNORED_SUFFIXES) {
    if (name.endsWith(suffix)) return false
  }
  return true
}

/** Return the message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
