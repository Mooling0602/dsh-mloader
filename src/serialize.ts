/**
 * Projection of host values into plain data that can cross a runtime boundary.
 *
 * A Python subprocess and a WASM worker thread both receive values produced by
 * the harness, such as the live tool execution object. Those values can contain
 * cycles, host objects with internal slots, functions and getters that throw.
 * Projection is total: it returns primitives, arrays and plain objects for any
 * input, and it never throws. Callers may then serialise the result.
 *
 * @module serialize
 */

/** Maximum object nesting depth kept by the projection. */
export const MAX_DEPTH = 6

/** Maximum number of array elements kept by the projection. */
export const MAX_ARRAY_LENGTH = 100

/** Maximum number of own keys kept when projecting an object. */
export const MAX_KEYS = 100

/** Maximum number of characters kept in one string. */
export const MAX_STRING_LENGTH = 4000

/** Limits that control how much of a value the projection keeps. */
export interface ProjectionLimits {
  maxDepth: number
  maxArrayLength: number
  maxKeys: number
  maxStringLength: number
}

const DEFAULTS: ProjectionLimits = {
  maxDepth: MAX_DEPTH,
  maxArrayLength: MAX_ARRAY_LENGTH,
  maxKeys: MAX_KEYS,
  maxStringLength: MAX_STRING_LENGTH,
}

const TRUNCATED = '[Truncated]'
const MAX_DEPTH_MARK = '[MaxDepth]'
const CIRCULAR = '[Circular]'
const FUNCTION_MARK = '[Function]'
const UNREADABLE = '[Unreadable]'

/**
 * Project any JavaScript value into primitives, arrays and plain objects.
 *
 * Functions become a marker string, cycles become a marker string, unreadable
 * properties become a marker string, and values past the limits are truncated.
 * The result never contains a host object, so it can be serialised with JSON or
 * cloned with `structuredClone`.
 *
 * @param value - Value to project.
 * @param options - Limit overrides.
 * @returns Plain data for the given value.
 */
export function toTransportable(value: unknown, options: Partial<ProjectionLimits> = {}): unknown {
  const limits = { ...DEFAULTS, ...options }
  return project(value, limits, [], 0)
}

function project(
  value: unknown,
  limits: ProjectionLimits,
  ancestors: object[],
  depth: number,
): unknown {
  if (value === null) return null
  if (typeof value === 'undefined') return null
  if (typeof value === 'boolean') return value
  if (typeof value === 'number') return Number.isFinite(value) ? value : String(value)
  if (typeof value === 'bigint') return `${value}n`
  if (typeof value === 'string') return truncate(value, limits.maxStringLength)
  if (typeof value === 'symbol') return value.toString()
  if (typeof value === 'function') return FUNCTION_MARK

  const object = value as object
  if (ancestors.includes(object)) return CIRCULAR
  if (depth >= limits.maxDepth) return MAX_DEPTH_MARK

  try {
    return projectObject(object, limits, ancestors, depth)
  } catch {
    return UNREADABLE
  }
}

function projectObject(
  value: object,
  limits: ProjectionLimits,
  ancestors: object[],
  depth: number,
): unknown {
  if (isAbortSignal(value)) {
    const signal = value as { aborted: boolean; reason?: unknown }
    return {
      $type: 'AbortSignal',
      aborted: signal.aborted === true,
      ...(signal.reason === undefined
        ? {}
        : { reason: project(signal.reason, limits, ancestors, depth + 1) }),
    }
  }
  if (value instanceof Error) {
    return {
      $type: value.name || 'Error',
      message: truncate(String(value.message ?? ''), limits.maxStringLength),
    }
  }
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString()
  if (value instanceof RegExp) return String(value)
  if (value instanceof Map) {
    const entries = [...value.entries()].slice(0, limits.maxArrayLength)
    return {
      $type: 'Map',
      size: value.size,
      entries: projectEntries(entries, limits, ancestors, depth),
    }
  }
  if (value instanceof Set) {
    const values = [...value.values()].slice(0, limits.maxArrayLength)
    return {
      $type: 'Set',
      size: value.size,
      values: projectEntries(values, limits, ancestors, depth),
    }
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    const byteLength = 'byteLength' in value && typeof value.byteLength === 'number'
      ? value.byteLength
      : 0
    return {
      $type: value.constructor?.name ?? 'ArrayBuffer',
      byteLength,
    }
  }

  const nextAncestors = [...ancestors, value]

  if (Array.isArray(value)) {
    const out: unknown[] = []
    const limit = Math.min(value.length, limits.maxArrayLength)
    for (let i = 0; i < limit; i++) {
      out.push(projectElement(value, i, limits, nextAncestors, depth))
    }
    if (value.length > limit) out.push(TRUNCATED)
    return out
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record)
  const out: Record<string, unknown> = {}
  const limit = Math.min(keys.length, limits.maxKeys)
  for (let i = 0; i < limit; i++) {
    const key = keys[i] as string
    let raw: unknown
    try {
      raw = record[key]
    } catch {
      out[key] = UNREADABLE
      continue
    }
    out[key] = project(raw, limits, nextAncestors, depth + 1)
  }
  if (keys.length > limit) out[TRUNCATED] = keys.length - limit

  const ctor = safeRead(value, 'constructor') as { name?: unknown } | undefined
  const ctorName = ctor !== null && typeof ctor === 'object' && typeof ctor.name === 'string'
    ? ctor.name
    : undefined
  if (ctorName !== undefined && ctorName !== '' && ctorName !== 'Object') {
    return { $type: ctorName, ...out }
  }
  return out
}

function projectElement(
  array: unknown[],
  index: number,
  limits: ProjectionLimits,
  ancestors: object[],
  depth: number,
): unknown {
  let raw: unknown
  try {
    raw = array[index]
  } catch {
    return UNREADABLE
  }
  return project(raw, limits, ancestors, depth + 1)
}

function projectEntries(
  entries: unknown[],
  limits: ProjectionLimits,
  ancestors: object[],
  depth: number,
): unknown[] {
  const next = [...ancestors]
  return entries.map((entry) => project(entry, limits, next, depth + 1))
}

function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text
}

function isAbortSignal(value: object): boolean {
  const candidate = value as Record<string, unknown>
  return typeof candidate.aborted === 'boolean'
    && typeof candidate.addEventListener === 'function'
    && typeof candidate.removeEventListener === 'function'
}

/**
 * Project a tool execution object into the stable shape plugins receive.
 *
 * The generic projection would keep the whole agent tree reachable from the
 * execution object. This projection keeps only the fields the plugin contract
 * promises: call identity, tool name, arguments, a few agent identity fields and
 * the abort flag.
 *
 * @param exec - Candidate tool execution object.
 * @returns Plain data with `$type: 'ToolExecution'`, or the generic projection
 *   when the value does not look like an execution object.
 */
export function projectToolExecution(exec: unknown): unknown {
  if (!looksLikeExecution(exec)) return toTransportable(exec)

  const out: Record<string, unknown> = { $type: 'ToolExecution' }
  for (const key of ['callId', 'rootCallId', 'name', 'parent', 'token']) {
    const raw = safeRead(exec, key)
    if (raw !== undefined) out[key] = toTransportable(raw)
  }
  const args = safeRead(exec, 'arguments')
  if (args !== undefined) out.arguments = toTransportable(args)

  const agent = safeRead(exec, 'agent')
  if (isRecord(agent)) {
    const agentOut: Record<string, string | number> = {}
    for (const key of ['id', 'name', 'kind', 'label']) {
      const raw = safeRead(agent, key)
      if (typeof raw === 'string' || typeof raw === 'number') agentOut[key] = raw
    }
    out.agent = agentOut
  }

  const signal = safeRead(exec, 'signal')
  if (isRecord(signal) && typeof signal.aborted === 'boolean') {
    out.aborted = signal.aborted === true
  }
  return out
}

function safeRead(target: unknown, key: string): unknown {
  if (target === null || typeof target !== 'object') return undefined
  try {
    return (target as Record<string, unknown>)[key]
  } catch {
    return undefined
  }
}

function looksLikeExecution(value: unknown): value is Record<string, unknown> {
  if (!isRecord(value)) return false
  if (typeof safeRead(value, 'name') !== 'string') return false
  return safeRead(value, 'arguments') !== undefined || safeRead(value, 'callId') !== undefined
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Events whose first argument is a tool execution object. */
const TOOL_EXECUTION_EVENTS = new Set([
  'tools/execute',
  'tools/pre-execute',
  'tools/post-execute',
  'tools/result',
  'tools/change',
])

/**
 * Project the arguments of a host event into plain data.
 *
 * For tool execution events the first argument is projected with
 * {@link projectToolExecution}; every other argument uses the generic
 * projection.
 *
 * @param event - Event name.
 * @param args - Listener arguments without the waterfall `next` function.
 * @returns Plain data list with the same length as the input.
 */
export function projectEventArgs(event: string, args: unknown[]): unknown[] {
  if (!Array.isArray(args)) return []
  const specialized = TOOL_EXECUTION_EVENTS.has(event)
  return args.map((arg, index) =>
    specialized && index === 0 ? projectToolExecution(arg) : toTransportable(arg),
  )
}
