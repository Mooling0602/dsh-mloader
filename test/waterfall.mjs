/**
 * ★ 回归测试：事件监听器不得阻塞 waterfall（工具执行链）。
 *
 * 事故背景（2026-10-26）：
 *   py-hello 订阅了 tools/execute，并在事件处理器里调 ctx.logger.debug。
 *   当时 listener 写成 `async (...) => await dispatchEvent(...)`，而 Cordis 的
 *   waterfall 会 await listener 的返回值，于是宿主阻塞在事件分发上；
 *   插件同时同步等 logger 的 RPC 回包 → 永久互等 → tools 通道被占满 →
 *   dsh 所有工具调用（含 bash）全部超时，只能重启。
 *
 * 本测试直接对 Cordis 的 waterfall 做断言，覆盖三点：
 *   1. 监听器同步把执行链传下去（结果必须是 body 的返回值，不能是 undefined）
 *   2. 插件分发不阻塞主链路（waterfall 耗时必须是毫秒级）
 *   3. 插件事件处理器内回调宿主不会死锁
 */

import { Context } from '@deepseek-ai/cordis'
import { PluginRegistrar } from '../src/registrar.js'
import { EVENT_WHITELIST } from '../src/contract.js'

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

async function main() {
  section('① 构造一个订阅了 tools/execute 的 registrar')

  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)

  // 假的 tools 服务（本测试不关心工具注册，只关心事件）
  root.provide('tools', { register: () => () => {} })

  const dispatched = []
  const spec = { id: 'test-reentrant', backend: 'python', inject: [] }
  const registrar = new PluginRegistrar(
    spec,
    root,
    logger,
    async () => ({ ok: true }),
    // 模拟插件侧事件分发：故意"慢"，并且在处理期间回调宿主（写日志）
    async (event, args) => {
      dispatched.push({ event, at: Date.now() })
      // 模拟插件在事件处理器里调 ctx.logger（回到宿主）
      logger.info(`[plugin] 收到事件 ${event}: ${JSON.stringify(args).slice(0, 60)}`)
      // 模拟插件处理耗时
      await new Promise((resolve) => setTimeout(resolve, 150))
      return undefined
    },
  )

  await registrar.handle('events.on', { event: 'tools/execute' })
  check('订阅成功', registrar.snapshot().events.includes('tools/execute'))

  section('② ★ waterfall 不被阻塞，且执行链完整')
  const t0 = Date.now()
  const result = await root.waterfall(
    {},
    'tools/execute',
    { name: 'demo_tool' },
    // 这是真正的"工具执行体"，必须被执行到
    async () => 'body-result',
  )
  const elapsed = Date.now() - t0

  check('waterfall 返回了 body 的结果（执行链完整）', result === 'body-result', JSON.stringify(result))
  check('waterfall 未被插件阻塞（<100ms）', elapsed < 100, `${elapsed}ms`)

  section('③ 插件确实收到了事件（异步投递成功）')
  // 等插件侧的 150ms 处理完成
  await new Promise((resolve) => setTimeout(resolve, 300))
  check('插件收到 tools/execute', dispatched.some((d) => d.event === 'tools/execute'), JSON.stringify(dispatched))
  const pluginLogs = logger.lines.filter((line) => line.includes('[plugin] 收到事件'))
  check('插件在事件处理器内成功回调宿主（写日志）', pluginLogs.length > 0, `条数=${pluginLogs.length}`)

  section('④ 连续触发不累积阻塞')
  const timings = []
  for (let i = 0; i < 5; i += 1) {
    const start = Date.now()
    const out = await root.waterfall({}, 'tools/execute', { name: `t${i}` }, async () => `r${i}`)
    timings.push({ elapsed: Date.now() - start, out })
  }
  check('5 次 waterfall 全部返回正确结果', timings.every((t, i) => t.out === `r${i}`), JSON.stringify(timings.map((t) => t.out)))
  check('5 次 waterfall 都未被阻塞', timings.every((t) => t.elapsed < 100), timings.map((t) => `${t.elapsed}ms`).join(','))

  section('⑤ 卸载后仍不破坏执行链')
  registrar.dispose()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const afterDispose = await root.waterfall({}, 'tools/execute', { name: 'x' }, async () => 'still-works')
  check('卸载后 waterfall 仍返回正确结果', afterDispose === 'still-works', JSON.stringify(afterDispose))

  section('⑥ 白名单仍然生效')
  let rejected = false
  try {
    await registrar.handle('events.on', { event: 'agent/assistant-stream' })
  } catch {
    rejected = true
  }
  check('越权事件被拒绝', rejected)
  check('白名单含 10 个事件', EVENT_WHITELIST.size === 10, `实际 ${EVENT_WHITELIST.size}`)

  console.log(`\n${'─'.repeat(60)}`)
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`)
    process.exit(0)
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\n--- 日志 ---')
    for (const line of logger.lines.slice(-30)) console.log(`   ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n❌ 测试脚本崩溃:', error)
  process.exit(1)
})
