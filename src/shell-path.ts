/** Utilities for configuring the executable search path of child processes. */

import { delimiter } from 'node:path'

/**
 * Prepend configured directories to a copy of a child process environment.
 *
 * @param env - Environment to copy without modifying the host process.
 * @param directories - Search directories in precedence order.
 * @returns The copied environment with its executable search path extended.
 */
export function withShellPath(env: NodeJS.ProcessEnv, directories: readonly string[] = []): NodeJS.ProcessEnv {
  const result = { ...env }
  const entries = directories.filter((entry) => typeof entry === 'string' && entry.length > 0)
  if (entries.length === 0) return result
  const pathKey = Object.keys(result).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH'
  const current = result[pathKey]
  result[pathKey] = current ? [...entries, current].join(delimiter) : entries.join(delimiter)
  return result
}
