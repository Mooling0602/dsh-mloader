/**
 * Regression test: an event listener must not block the waterfall chain.
 *
 * The test asserts three properties directly against Cordis' waterfall:
 *   1. The listener advances the chain synchronously, so the tool body result
 *      comes back instead of undefined.
 *   2. Dispatching to the plugin does not hold the chain, so the waterfall stays
 *      in the millisecond range while the plugin handler is deliberately slow.
 *   3. A plugin handler may call the host (logging) without deadlocking.
 */

import { Context } from '@deepseek-ai/cordis'
import { PluginRegistrar } from '../src/registrar.js'
import { EVENT_WHITELIST } from '../src/contract.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(detail ? `${name} [${detail}]` : name)
    console.log(`  FAIL ${name}${detail ? ` [${detail}]` : ''}`)
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
  section('1. Build a registrar subscribed to tools/execute')

  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)

  root.provide('tools', { register: () => () => {} })

  const dispatched = []
  const spec = { id: 'test-reentrant', backend: 'python', inject: [] }
  const registrar = new PluginRegistrar(
    spec,
    root,
    logger,
    async () => ({ ok: true }),
    // Simulate the plugin side: slow on purpose, and call the host (log) while handling.
    async (event, args) => {
      dispatched.push({ event, at: Date.now() })
      logger.info(`[plugin] received event ${event}: ${JSON.stringify(args).slice(0, 60)}`)
      await new Promise((resolve) => setTimeout(resolve, 150))
      return undefined
    },
  )

  await registrar.handle('events.on', { event: 'tools/execute' })
  check('subscription is recorded', registrar.snapshot().events.includes('tools/execute'))

  section('2. The waterfall is not blocked and the chain is intact')
  const t0 = Date.now()
  const result = await root.waterfall(
    {},
    'tools/execute',
    { name: 'demo_tool' },
    async () => 'body-result',
  )
  const elapsed = Date.now() - t0

  check('waterfall returns the body result', result === 'body-result', JSON.stringify(result))
  check('waterfall was not blocked by the plugin (<100ms)', elapsed < 100, `${elapsed}ms`)

  section('3. The plugin receives the event (async delivery works)')
  await new Promise((resolve) => setTimeout(resolve, 300))
  check(
    'plugin received tools/execute',
    dispatched.some((entry) => entry.event === 'tools/execute'),
    JSON.stringify(dispatched),
  )
  const pluginLogs = logger.lines.filter((line) => line.includes('[plugin] received event'))
  check('plugin called the host from inside the handler', pluginLogs.length > 0, `count=${pluginLogs.length}`)

  section('4. Repeated dispatch does not accumulate blocking')
  const timings = []
  for (let i = 0; i < 5; i += 1) {
    const start = Date.now()
    const out = await root.waterfall({}, 'tools/execute', { name: `t${i}` }, async () => `r${i}`)
    timings.push({ elapsed: Date.now() - start, out })
  }
  check(
    '5 waterfalls returned the right results',
    timings.every((entry, index) => entry.out === `r${index}`),
    JSON.stringify(timings.map((entry) => entry.out)),
  )
  check(
    '5 waterfalls were not blocked',
    timings.every((entry) => entry.elapsed < 100),
    timings.map((entry) => `${entry.elapsed}ms`).join(','),
  )

  section('5. Disposal does not break the chain')
  registrar.dispose()
  await new Promise((resolve) => setTimeout(resolve, 50))
  const afterDispose = await root.waterfall({}, 'tools/execute', { name: 'x' }, async () => 'still-works')
  check('waterfall still returns the body result after disposal', afterDispose === 'still-works', JSON.stringify(afterDispose))

  section('6. The whitelist still rejects other events')
  let rejected = false
  try {
    await registrar.handle('events.on', { event: 'agent/assistant-stream' })
  } catch {
    rejected = true
  }
  check('event outside the whitelist is rejected', rejected)
  check('whitelist contains 10 events', EVENT_WHITELIST.size === 10, `actual ${EVENT_WHITELIST.size}`)

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS: ${passed} assertions`)
    process.exit(0)
  } else {
    console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
    for (const failure of failures) console.log(`  - ${failure}`)
    console.log('\nRecent log lines:')
    for (const line of logger.lines.slice(-30)) console.log(`  ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\nTest script crashed:', error)
  process.exit(1)
})
