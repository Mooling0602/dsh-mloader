/**
 * ★ 端到端死锁回归测试（真实 Python 子进程 + 真实 Cordis waterfall）
 *
 * 事故背景（2026-10-26）：
 *   py-hello 订阅了 tools/execute，并在事件处理器里调 ctx.logger.debug。
 *   当时 listener 写成 `async (...args) => await dispatchEvent(...)`，而 Cordis 的
 *   waterfall 会 await listener 的返回值，于是宿主阻塞在「等插件事件回包」；
 *   插件同时同步等 logger 的 RPC 回包 → 永久互等 → tools 通道占满 →
 *   dsh 所有工具调用（含 bash）全部超时，只能重启。
 *
 * 本测试用真实的 Python 插件子进程复现该场景：
 *   - 插件订阅 tools/execute，处理器内部回调宿主（ctx.logger）
 *   - 宿主走真实 root.waterfall()（带真实的 next 链）
 * 断言：
 *   1. waterfall 返回 body 的结果（执行链完整，没被吞成 undefined）
 *   2. waterfall 在毫秒级返回（没被插件阻塞）
 *   3. 插件确实收到了事件（异步投递成功，不是静默丢弃）
 *   4. 工具调用正常
 *   5. 连续触发不累积阻塞
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

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

/** 超时保护：测试自己不能挂死，否则看不出是被测代码死锁还是测试写错。 */
function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} 超过 ${ms}ms 未返回 —— 疑似死锁`)), ms)
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

async function main() {
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
  const tools = root.get('tools')

  const roots = [new URL('./deadlock', import.meta.url).pathname]
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots, pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const loader = root.get('mloader')
  const plugin = loader.list().find((p) => p.id === 'py-reentrant')

  section('① 复现夹具已挂载（真实 Python 子进程）')
  check('py-reentrant applied', plugin?.state === 'applied', JSON.stringify(plugin))
  check('订阅了 tools/execute', (plugin?.events ?? []).includes('tools/execute'), JSON.stringify(plugin?.events))

  section('② ★ 真实 waterfall：执行链完整且未被插件阻塞')
  const beats = { count: 0 }
  const heartbeat = setInterval(() => { beats.count += 1 }, 20)

  const t0 = Date.now()
  let waterfallResult
  let waterfallError = null
  try {
    waterfallResult = await withTimeout(
      root.waterfall({}, 'tools/execute', { name: 'reentrant_ping' }, async () => 'body-result'),
      4000,
      'waterfall(tools/execute)',
    )
  } catch (err) {
    waterfallError = err
  }
  const elapsed = Date.now() - t0

  check('未死锁', waterfallError === null, waterfallError?.message)
  check('返回 body 的结果（执行链完整）', waterfallResult === 'body-result', JSON.stringify(waterfallResult))
  check('毫秒级返回，未被插件阻塞（<500ms）', elapsed < 500, `${elapsed}ms`)

  section('③ 插件确实收到事件（异步投递，非静默丢弃）')
  await new Promise((resolve) => setTimeout(resolve, 600))
  const echoes = logger.lines.filter((line) => line.includes('事件回显'))
  check('插件在事件处理器内成功回调宿主', echoes.length > 0, `条数=${echoes.length}`)
  if (echoes.length > 0) console.log(`     ${echoes[echoes.length - 1]}`)

  section('④ 工具调用正常（事件路径没污染 tools 通道）')
  let toolResult = null
  let toolError = null
  try {
    toolResult = await withTimeout(tools.get('reentrant_ping').execute({}), 4000, 'reentrant_ping')
  } catch (err) {
    toolError = err
  }
  check('工具调用未死锁', toolError === null, toolError?.message)
  check('返回值正确', toolResult?.ok === true, JSON.stringify(toolResult))

  section('⑤ 连续触发不累积阻塞')
  const rounds = []
  for (let i = 0; i < 5; i += 1) {
    const start = Date.now()
    try {
      const out = await withTimeout(
        root.waterfall({}, 'tools/execute', { name: `t${i}` }, async () => `r${i}`),
        3000,
        `waterfall#${i}`,
      )
      rounds.push({ out, elapsed: Date.now() - start })
    } catch (err) {
      rounds.push({ out: { error: err.message }, elapsed: Date.now() - start })
    }
  }
  clearInterval(heartbeat)
  check(
    '5 次 waterfall 全部返回正确结果',
    rounds.every((r, i) => r.out === `r${i}`),
    JSON.stringify(rounds.map((r) => r.out)),
  )
  check('5 次都未被阻塞', rounds.every((r) => r.elapsed < 500), rounds.map((r) => `${r.elapsed}ms`).join(','))
  check('主线程全程有空（心跳）', beats.count >= 10, `beats=${beats.count}`)

  section('⑥ 卸载干净')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const names = tools.schemas().map((s) => s.name)
  check('无残留工具', names.filter((n) => n.startsWith('reentrant_')).length === 0, names.join(','))
  const afterDispose = await root.waterfall({}, 'tools/execute', { name: 'x' }, async () => 'still-works')
  check('卸载后 waterfall 仍然完整', afterDispose === 'still-works', JSON.stringify(afterDispose))

  console.log(`\n${'─'.repeat(60)}`)
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`)
    process.exit(0)
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\n--- 相关日志 ---')
    for (const line of logger.lines.filter((l) => l.includes('re-entrant') || l.includes('事件回显')).slice(-20)) {
      console.log(`   ${line}`)
    }
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n❌ 测试脚本崩溃:', error)
  process.exit(1)
})
