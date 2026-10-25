/**
 * dsh-mloader — 跨进程载荷投影（host 对象 → 纯数据）
 *
 * ── 为什么需要这个文件（2026-10-26 事故，定位花了很久）──────────────────
 *
 * dsh 的 `tools/execute` 是 Cordis 的 **waterfall**，监听器收到的第一个参数是
 * **活的 exec 对象**：
 *
 *     { callId, name, arguments, agent: <Cordis Agent>, signal: <AbortSignal>, … }
 *
 * 其中 `agent` 带着 ctx → fiber → scope → agent 的**环**，`signal` 是带内部槽的
 * 宿主对象。码头当时把这个对象原样 `JSON.stringify` 后写进子进程 stdin，
 * 于是抛 `Converting circular structure to JSON`。
 *
 * 而当时的 `#write` 把这次失败当成"对端已关闭"，置 `stdinBroken = true` ——
 * **之后每一帧都被静默丢弃**。现象因此极具迷惑性：
 *
 *   - 插件的工具**注册成功**（那是 apply 期间发的，早于第一次工具调用）
 *   - `mloader_status` **立刻返回**（它是宿主的 ctx 直接注册的，不过子进程）
 *   - 其余所有插件工具全部卡到 callMs 超时：
 *     `tool.call timed out after 15000ms`
 *   - 子进程活着、CPU/IO 全平、同一插件在 dsh 外单独驱动完全正常
 *
 * 结论写成两条硬规则：
 *
 *   1. 过进程边界的东西必须是**纯数据**。不是"大概能 stringify"，而是显式投影：
 *      环 → "[Circular]"，函数 → 省略，超深/超长 → 截断。
 *   2. 序列化失败只让**这一帧**失败，绝不能改变通道状态（见 backends/python.js）。
 */

/** 投影深度上限：再深就不是插件该看的东西了（agent 树上十几层很容易）。 */
export const MAX_DEPTH = 6
/** 数组最多保留的元素数。 */
export const MAX_ARRAY_LENGTH = 100
/** 对象最多保留的键数（exec.agent 有几十个内部字段）。 */
export const MAX_KEYS = 100
/** 单条字符串最多保留的字符数。 */
export const MAX_STRING_LENGTH = 4000

const TRUNCATED = '[Truncated]'
const MAX_DEPTH_MARK = '[MaxDepth]'
const CIRCULAR = '[Circular]'
const FUNCTION_MARK = '[Function]'
const UNREADABLE = '[Unreadable]'

/**
 * 把一个任意 JS 值投影成可 JSON / 可 structuredClone 的纯数据。
 *
 * @param value - 任意值。
 * @param options - 覆盖默认上限（一般不用）。
 * @returns 纯数据（对象 / 数组 / 原始值）。
 */
export function toTransportable(value, options = {}) {
  const limits = { ...DEFAULTS, ...options }
  return project(value, limits, [], 0)
}

const DEFAULTS = {
  maxDepth: MAX_DEPTH,
  maxArrayLength: MAX_ARRAY_LENGTH,
  maxKeys: MAX_KEYS,
  maxStringLength: MAX_STRING_LENGTH,
}

function project(value, limits, ancestors, depth) {
  if (value === null) return null

  const type = typeof value
  if (type === 'undefined') return null
  if (type === 'boolean') return value
  if (type === 'number') return Number.isFinite(value) ? value : String(value)
  if (type === 'bigint') return `${value}n`
  if (type === 'string') return truncate(value, limits.maxStringLength)
  if (type === 'symbol') return value.toString()
  // 函数不可序列化，也不该被插件调用。标记出来比静默丢弃更利于排查。
  if (type === 'function') return FUNCTION_MARK

  // ── 到这里 value 一定是 object ─────────────────────────────────────────
  if (ancestors.includes(value)) return CIRCULAR
  if (depth >= limits.maxDepth) return MAX_DEPTH_MARK

  // 宿主对象会用 Proxy / 内部槽，任何属性读取都可能抛（revoked proxy、
  // 已销毁的 fiber）。投影本身绝不能因此失败 —— 那正是这个文件存在的理由。
  // 所以整段对象处理包在 try 里，任何意外一律降级成标记值。
  try {
    return projectObject(value, limits, ancestors, depth)
  } catch {
    return UNREADABLE
  }
}

function projectObject(value, limits, ancestors, depth) {
  // 宿主对象：AbortSignal 有内部槽，JSON.stringify 出来的 {} 毫无信息量。
  if (isAbortSignal(value)) {
    return {
      $type: 'AbortSignal',
      aborted: value.aborted === true,
      ...(value.reason === undefined ? {} : { reason: project(value.reason, limits, ancestors, depth + 1) }),
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
    return { $type: 'Map', size: value.size, entries: projectEntries(entries, limits, ancestors, depth) }
  }
  if (value instanceof Set) {
    const values = [...value.values()].slice(0, limits.maxArrayLength)
    return { $type: 'Set', size: value.size, values: projectEntries(values, limits, ancestors, depth) }
  }
  if (ArrayBuffer.isView(value) || value instanceof ArrayBuffer) {
    return { $type: value.constructor?.name ?? 'ArrayBuffer', byteLength: value.byteLength ?? 0 }
  }

  const nextAncestors = [...ancestors, value]

  if (Array.isArray(value)) {
    const out = []
    const limit = Math.min(value.length, limits.maxArrayLength)
    for (let i = 0; i < limit; i++) {
      out.push(projectElement(value, i, limits, nextAncestors, depth))
    }
    if (value.length > limit) out.push(TRUNCATED)
    return out
  }

  // ── 普通对象 / 类实例 ─────────────────────────────────────────────────
  // 只取自有可枚举属性：原型链上的方法和 getter 不该跨进程。
  // Object.keys 在 Proxy 上也可能抛，抛出去由上层降级成 [Unreadable]。
  const keys = Object.keys(value)
  const out = {}
  const limit = Math.min(keys.length, limits.maxKeys)
  for (let i = 0; i < limit; i++) {
    const key = keys[i]
    // 读取本身可能抛（getter 访问已销毁的内部状态），单独兜住。
    let raw
    try {
      raw = value[key]
    } catch {
      out[key] = UNREADABLE
      continue
    }
    out[key] = project(raw, limits, nextAncestors, depth + 1)
  }
  if (keys.length > limit) out[TRUNCATED] = keys.length - limit

  // 类实例（非 Object.prototype）补一个类型名，便于插件区分。
  const ctorName = safeRead(value, 'constructor')?.name
  if (typeof ctorName === 'string' && ctorName !== '' && ctorName !== 'Object') {
    return { $type: ctorName, ...out }
  }
  return out
}

function projectElement(array, index, limits, ancestors, depth) {
  let raw
  try {
    raw = array[index]
  } catch {
    return UNREADABLE
  }
  return project(raw, limits, ancestors, depth + 1)
}

function projectEntries(entries, limits, ancestors, depth) {
  const next = [...ancestors]
  return entries.map((entry) => project(entry, limits, next, depth + 1))
}

function truncate(text, max) {
  return text.length > max ? `${text.slice(0, max)}…(${text.length} chars)` : text
}

function isAbortSignal(value) {
  return typeof value === 'object'
    && value !== null
    && typeof value.aborted === 'boolean'
    && typeof value.addEventListener === 'function'
    && typeof value.removeEventListener === 'function'
}

// ── exec 对象的专用投影 ──────────────────────────────────────────────────

/**
 * dsh 的 `tools/*` 事件里，第一个参数是工具执行对象。
 *
 * 通用投影也能处理它（环会变成 "[Circular]"），但会掉进 agent 树里拉出上百个
 * 内部字段 —— 既慢又吵，还把 dsh 的内部结构暴露给插件。这里只挑对外有意义的字段，
 * 形成 docs/ABI.md §3.1 承诺的稳定形状。
 */
export function projectToolExecution(exec) {
  if (!looksLikeExecution(exec)) return toTransportable(exec)

  const out = { $type: 'ToolExecution' }
  for (const key of ['callId', 'rootCallId', 'name', 'parent', 'token']) {
    const raw = safeRead(exec, key)
    if (raw !== undefined) out[key] = toTransportable(raw)
  }
  const args = safeRead(exec, 'arguments')
  if (args !== undefined) out.arguments = toTransportable(args)

  const agent = safeRead(exec, 'agent')
  if (agent !== null && typeof agent === 'object') {
    const agentOut = {}
    for (const key of ['id', 'name', 'kind', 'label']) {
      const raw = safeRead(agent, key)
      if (raw !== undefined && (typeof raw === 'string' || typeof raw === 'number')) {
        agentOut[key] = raw
      }
    }
    out.agent = agentOut
  }

  const signal = safeRead(exec, 'signal')
  if (signal !== null && typeof signal === 'object' && typeof signal.aborted === 'boolean') {
    out.aborted = signal.aborted === true
  }
  return out
}

function safeRead(target, key) {
  try {
    return target[key]
  } catch {
    return undefined
  }
}

function looksLikeExecution(value) {
  if (value === null || typeof value !== 'object') return false
  const name = safeRead(value, 'name')
  if (typeof name !== 'string') return false
  return safeRead(value, 'arguments') !== undefined || safeRead(value, 'callId') !== undefined
}

/** 命中这些事件时，首参按 exec 投影。 */
const TOOL_EXECUTION_EVENTS = new Set([
  'tools/execute',
  'tools/pre-execute',
  'tools/post-execute',
  'tools/result',
  'tools/change',
])

/**
 * 把 waterfall 监听器收到的参数数组投影成可跨进程的纯数据。
 *
 * @param event - 事件名。
 * @param args - 监听器参数（**不含** `next`）。
 * @returns 纯数据数组。
 */
export function projectEventArgs(event, args) {
  if (!Array.isArray(args)) return []
  const specialized = TOOL_EXECUTION_EVENTS.has(event)
  return args.map((arg, index) =>
    specialized && index === 0 ? projectToolExecution(arg) : toTransportable(arg),
  )
}
