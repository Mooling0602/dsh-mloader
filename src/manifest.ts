/**
 * Validation of a plugin manifest, shared by every code path that reads one.
 *
 * A manifest is reached in three places: discovery reads the installed
 * directory, and each installer reads an archive before it extracts anything.
 * They must reach the same verdict for the same manifest. A package the
 * packager accepted would otherwise be rejected at install time, and a manifest
 * an archive rejected could be accepted when the same directory is placed by
 * hand.
 *
 * What lives here is the shape rule for the fields all three consume. A caller
 * still owns the values that differ by consumer: discovery resolves the entry
 * path against the plugin directory, and an installer checks that the entry is
 * a member of the archive.
 *
 * A reserved plugin id is not reported here. Only discovery can admit one,
 * through the built-in marker the bundled example carries, and only the caller
 * knows whether that marker is available.
 *
 * @module manifest
 */

import { posix } from 'node:path'

/** Absolute Windows drive prefix, rejected so an entry cannot leave the root. */
const DRIVE_PATTERN = /^[A-Za-z]:/u

/** Plugin id grammar, shared with the manifest schema in docs/ABI-unified.md. */
const PLUGIN_ID_PATTERN = /^[a-z0-9][a-z0-9_-]{0,31}$/u

/** Backends a manifest may name. */
const BACKENDS = new Set<string>(['python', 'wasm'])

/** One problem found while validating a manifest. */
export interface ManifestViolation {
  /** Field the violation belongs to. */
  field: 'id' | 'backend' | 'entry'
  /** Human readable reason, without a file prefix. */
  message: string
}

/**
 * Validate the manifest fields every consumer must agree on.
 *
 * The violations are ordered by field and an empty array means the manifest is
 * valid. The caller prefixes each message with the manifest path, so the reason
 * stays independent of where the manifest was read from.
 *
 * @param parsed - Parsed manifest object.
 * @returns One violation per problem.
 */
export function validateManifestFields(parsed: Record<string, unknown>): ManifestViolation[] {
  const violations: ManifestViolation[] = []

  const id = parsed.id
  if (typeof id !== 'string' || !PLUGIN_ID_PATTERN.test(id)) {
    violations.push({
      field: 'id',
      message: `id must match ^[a-z0-9][a-z0-9_-]{0,31}$, got ${JSON.stringify(id)}`,
    })
  }

  const backend = parsed.backend
  if (typeof backend !== 'string' || !BACKENDS.has(backend)) {
    violations.push({
      field: 'backend',
      message: `backend must be "python" or "wasm", got ${JSON.stringify(backend)}`,
    })
  }

  const entry = parsed.entry
  if (typeof entry !== 'string' || entry.length === 0) {
    violations.push({
      field: 'entry',
      message: 'entry is required and must be a non-empty string',
    })
  } else if (!isRootFileName(entry)) {
    violations.push({
      field: 'entry',
      message: 'entry must name a file at the plugin root',
    })
  }

  return violations
}

/**
 * Return true when a value names a file directly in the plugin directory.
 *
 * The manifest names one file beside itself, never a path. A separator, an
 * absolute path, a drive prefix or a traversal segment would let the entry
 * point outside the plugin directory, so all of them are rejected alike.
 *
 * @param value - Candidate entry value.
 * @returns Whether the value is a plain file name.
 */
export function isRootFileName(value: string): boolean {
  if (value.includes('\\') || value.includes('/')) return false
  if (posix.isAbsolute(value) || DRIVE_PATTERN.test(value)) return false
  if (value === '.' || value === '..') return false
  return posix.normalize(value) === value
}
