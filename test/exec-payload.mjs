/**
 * ★ 回归测试：dsh 的 exec 对象能安全跨进程（2026-10-26 事故）
 *
 * 事故现象（非常迷惑人）：
 *   - 插件的工具**注册成功**（`mloader_status` 能看到它们）
 *   - `mloader_status` **立刻返回**（它是宿主直接注册的，不过子进程）
 *   - 但插件的每个工具都卡到 callMs 超时：`tool.call timed out after 15000ms`
 *   - 子进程活着、CPU/IO 全平（`/proc/<pid>/io` 的 rchar/wchar 一动不动）
 *   - 同一个插件在 dsh 外单独驱动时完全正常
 *
 * 根因：
 *   `tools/execute` 是 Cordis 的 waterfall，监听器收到的首参是**活的 exec 对象**：
 *     { callId, name, arguments, agent: <Agent>, signal: <AbortSignal>, … }
 *   `agent` 带着 ctx → fiber → scope 的环。宿主把它原样 `JSON.stringify` 写进
 *   子进程 stdin，抛 `Converting circular structure to JSON`。
 *
 *   真正的杀手是：当时 `#write` 把「序列化失败」和「对端已关闭」共用一个 catch，
 *   于是序列化失败也置 `stdinBroken = true` —— **之后每一帧都被静默丢弃**。
 *   第一次工具调用触发的 `tools/execute` 事件毒死了整条通道，
 *   此后所有 `tool.call` 都发不出去，只能等满 callMs。
 *
 * 本测试断言四件事：
 *   ① 带环 + AbortSignal 的载荷能安全跨进程（不抛错、不毒通道）
 *   ② ★ 事件之后，工具调用仍然正常（这是事故的直接症状）
 *   ③ 插件收到的载荷是投影后的纯数据（不是原样的宿主对象）
 *   ④ 单帧序列化失败不会永久关闭通道（隔离性）
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import {
  MAX_DEPTH,
  projectEventArgs,
  projectToolExecution,
  toTransportable,
} from '../src/serialize.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

function makeLogger() {
  const lines = []
  const push = (level) => (message) => lines.push(`${level}: ${message}`)
  const logger = (..._args) => logger
  logger.debug = push('debug')
  logger.info = push('info')
  logger.warn = push('warn')
  logger.error = push('error')
  logger.lines = lines
  return logger
}

function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未返回 —— 通道疑似被毒死`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * 造一个**结构和 dsh 真实 exec 一样危险**的对象：
 *   - agent 有环（agent.self → agent）
 *   - signal 是真正的宿主 AbortSignal（有内部槽，不能 stringify）
 *   - 含函数、含 undefined、含超深嵌套
 */
function makeHostileExec() {
  const controller = new AbortController()
  const agent = { id: 'agent-1', name: 'main', kind: 'root' }
  agent.self = agent
  agent.ctx = { fiber: { scope: { agent } } } // 又一条环
  return {
    callId: 'call-1',
    name: 'exec_ping',
    arguments: { marker: 'first' },
    agent,
    signal: controller.signal,
    fn: () => 'not serializable',
    nested: { deep: { deeper: { deepest: { evenDeeper: { tooDeep: { way: { too: { far: 1 } } } } } } } },
  }
}

async function main() {
  // ── ① 纯单元：投影函数本身 ────────────────────────────────────────────
  section('① 投影函数：环 / AbortSignal / 函数 / 深度')

  const hostile = makeHostileExec()
  let projected
  let serializeError = null
  try {
    projected = toTransportable(hostile)
  } catch (error) {
    serializeError = error
  }
  check('投影不抛错', serializeError === null, serializeError?.message)

  let jsonText = null
  try {
    jsonText = JSON.stringify(projected)
  } catch (error) {
    serializeError = error
  }
  check('★ 投影结果可 JSON.stringify（修复前这里抛 Converting circular）', jsonText !== null, serializeError?.message)
  check('投影结果可被 structuredClone（worker 通道要求）', (() => {
    try {
      structuredClone(projected)
      return true
    } catch {
      return false
    }
  })())

  const plainJson = (() => {
    try {
      JSON.stringify(hostile)
      return true
    } catch {
      return false
    }
  })()
  check('对照：原始对象确实不可序列化（夹具有效）', plainJson === false)

  const agentProjection = projected.agent
  check('环被标记为 [Circular]', agentProjection?.self === '[Circular]', JSON.stringify(agentProjection))
  check('AbortSignal 被投影成 $type', projected.signal?.$type === 'AbortSignal', JSON.stringify(projected.signal))
  check('AbortSignal 带上 aborted 状态', projected.signal?.aborted === false, JSON.stringify(projected.signal))
  check('函数被标记而非丢弃', projected.fn === '[Function]', JSON.stringify(projected.fn))
  check('超深嵌套被截断', JSON.stringify(projected.nested).includes('MaxDepth'), JSON.stringify(projected.nested))

  // 敌意宿主对象：投影本身绝不能抛，否则「投影」这道防线就是空的
  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  const hostileHostObjects = {
    'revoked proxy': revoked,
    '抛错的 getter': { get boom() { throw new Error('nope') } },
    'ownKeys 抛错的 proxy': new Proxy({}, { ownKeys() { throw new Error('keys') } }),
    'NaN / Infinity': { a: NaN, b: Infinity },
    'Symbol 键': { [Symbol('s')]: 1, a: 2 },
  }
  for (const [label, value] of Object.entries(hostileHostObjects)) {
    let ok = true
    let snapshot
    try {
      snapshot = JSON.stringify(toTransportable(value))
    } catch (error) {
      ok = false
      snapshot = error.message
    }
    check(`敌意对象不炸投影：${label}`, ok, snapshot?.slice(0, 120))
  }

  // exec 专用投影：不把整棵 agent 树塞给插件
  const execProjection = projectToolExecution(hostile)
  check('exec 投影保留 name', execProjection.name === 'exec_ping', JSON.stringify(execProjection))
  check('exec 投影保留 arguments', execProjection.arguments?.marker === 'first', JSON.stringify(execProjection))
  check('exec 投影带上 $type', execProjection.$type === 'ToolExecution', JSON.stringify(execProjection))
  check(
    'exec 投影不暴露整棵 agent 树（只有少数白名单字段）',
    Object.keys(execProjection.agent ?? {}).length <= 4,
    JSON.stringify(execProjection.agent),
  )
  check('exec 投影不含可用 signal 对象', execProjection.signal === undefined, JSON.stringify(execProjection.signal))
  check('exec 投影可 JSON.stringify', (() => {
    try {
      JSON.stringify(execProjection)
      return true
    } catch {
      return false
    }
  })())
  check(`exec 投影远小于通用投影（深度上限 ${MAX_DEPTH}）`, JSON.stringify(execProjection).length < 2000,
    `${JSON.stringify(execProjection).length} chars`)

  const projectedArgs = projectEventArgs('tools/execute', [hostile, 'tail'])
  check('projectEventArgs 处理首参为 exec', projectedArgs[0]?.$type === 'ToolExecution', JSON.stringify(projectedArgs[0]))
  check('projectEventArgs 保留后续参数', projectedArgs[1] === 'tail', JSON.stringify(projectedArgs[1]))
  check('projectEventArgs 结果可序列化', (() => {
    try {
      JSON.stringify(projectedArgs)
      return true
    } catch {
      return false
    }
  })())

  // ── ② 端到端：真实 Python 子进程 + 真实 waterfall ─────────────────────
  section('② 真实 Python 子进程：脏载荷之后工具仍然可用（★ 事故症状）')

  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', {
    section: () => () => {},
    context: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    suppressRuntimeContext: () => () => {},
    refreshContext: (assembly) => assembly,
    assemble: async () => ({ sections: [] }),
  })
  root.plugin(ToolRuntime, {})
  await new Promise((resolve) => setTimeout(resolve, 200))

  const roots = [new URL('./exec-payload', import.meta.url).pathname]
  root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots, pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const loader = root.get('mloader')
  const record = loader?.list().find((p) => p.id === 'py-exec-observer')
  check('夹具插件 applied', record?.state === 'applied', JSON.stringify(record))
  check('订阅了 tools/execute', (record?.events ?? []).includes('tools/execute'), JSON.stringify(record?.events))

  // 先证明通道是好的
  const tools = root.get('tools')
  const pingDef = tools.get('exec_ping')
  check('exec_ping 已注册', pingDef !== undefined)
  check('exec_describe 已注册', tools.get('exec_describe') !== undefined)

  const before = await withTimeout(pingDef.execute({ marker: 'before' }), 8000, 'exec_ping(before)')
  check('事件触发前工具可用', before?.marker === 'before', JSON.stringify(before)?.slice(0, 300))

  // ★ 关键一步：用真实的 hostile exec 触发 waterfall。
  // 修复前，这一行会让标准化失败 → stdinBroken → 后续所有 tool.call 静默丢弃。
  const hostileExec = makeHostileExec()
  let dispatchError = null
  let chainResult
  try {
    chainResult = await withTimeout(
      root.waterfall({}, 'tools/execute', hostileExec, async () => 'body-result'),
      8000,
      'waterfall(tools/execute, hostile exec)',
    )
  } catch (error) {
    dispatchError = error
  }
  check('★ 带环 exec 的 waterfall 不抛错（修复前抛 Converting circular）', dispatchError === null, dispatchError?.message)
  check('执行链完整（返回 body 的结果）', chainResult === 'body-result', JSON.stringify(chainResult))

  // 给异步投递一点时间落地
  await new Promise((resolve) => setTimeout(resolve, 500))

  // ★★★ 这就是事故的直接症状：事件之后工具必须还能用。
  let after
  let afterError = null
  const t0 = Date.now()
  try {
    after = await withTimeout(pingDef.execute({ marker: 'after' }), 8000, 'exec_ping(after)')
  } catch (error) {
    afterError = error
  }
  const elapsed = Date.now() - t0

  check(
    '★★ 脏载荷之后工具调用仍然成功（修复前：15s 超时）',
    afterError === null,
    afterError?.message,
  )
  check('★★ 工具返回内容正确', after?.marker === 'after', JSON.stringify(after)?.slice(0, 300))
  check('★★ 耗时是毫秒级而非等满 callMs', elapsed < 2000, `${elapsed}ms`)

  // ── ③ 插件侧收到的载荷形状 ───────────────────────────────────────────
  section('③ 插件收到的载荷是投影后的纯数据')

  let describe
  let describeError = null
  try {
    describe = await withTimeout(tools.get('exec_describe').execute({}), 8000, 'exec_describe')
  } catch (error) {
    describeError = error
  }
  check('exec_describe 调用成功', describeError === null, describeError?.message)

  const received = describe?.received
  check('插件确实收到了事件（不是静默丢弃）', Array.isArray(received) && received.length > 0,
    JSON.stringify(received)?.slice(0, 300))

  const first = Array.isArray(received) ? received[0] : undefined
  check('插件收到的首参带 $type=ToolExecution', first?.$type === 'ToolExecution', JSON.stringify(first)?.slice(0, 300))
  check('插件收到的 name 正确', first?.name === 'exec_ping', JSON.stringify(first?.name))
  check('插件收到的 arguments 正确', first?.arguments?.marker === 'first', JSON.stringify(first?.arguments))
  check(
    '★ 插件没收到活的宿主对象（无环、无函数、无 AbortSignal 实例）',
    isPlainData(first),
    JSON.stringify(first)?.slice(0, 400),
  )

  // ── ④ 通道隔离性 ─────────────────────────────────────────────────────
  section('④ 单帧失败不关闭通道')

  const stillApplied = loader.list().find((p) => p.id === 'py-exec-observer')
  check('夹具仍在 applied 状态（没被副作用搞崩）', stillApplied?.state === 'applied', JSON.stringify(stillApplied))
  check(
    '事件订阅仍然有效（没被卸载）',
    (stillApplied?.events ?? []).includes('tools/execute'),
    JSON.stringify(stillApplied?.events),
  )

  // 再触发一次，确认可重复
  let repeat
  let repeatError = null
  try {
    repeat = await withTimeout(pingDef.execute({ marker: 'repeat' }), 8000, 'exec_ping(repeat)')
  } catch (error) {
    repeatError = error
  }
  check('重复调用仍正常（通道可复用）', repeatError === null && repeat?.marker === 'repeat',
    repeatError?.message ?? JSON.stringify(repeat)?.slice(0, 300))

  // ── 汇总 ─────────────────────────────────────────────────────────────
  console.log('')
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`)
  } else {
    console.log(`❌ ${failures.length} 项失败（共 ${passed + failures.length} 项）：`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

/** 断言一个值里没有环、没有函数、没有 AbortSignal 实例。 */
function isPlainData(value, seen = new Set()) {
  if (value === null || value === undefined) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  if (type === 'function') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (typeof value === 'object') {
    if (typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean') return false
    for (const key of Object.keys(value)) {
      if (!isPlainData(value[key], seen)) return false
    }
  }
  return true
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error('\n测试自身异常：', error)
    process.exit(1)
  },
)
