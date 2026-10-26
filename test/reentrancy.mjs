/**
 * End-to-end deadlock regression: a real Python plugin process, a real Cordis
 * waterfall and a plugin handler that calls back into the host.
 *
 * The assertions are: the waterfall returns the execution body result, it
 * returns within milliseconds, the plugin really received the event, tool calls
 * work, repeated delivery does not accumulate blocking, and unload leaves no
 * registrations behind.
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok: ${name}`)
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL: ${name}${detail ? `: ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds, so a fixed sleep cannot hide a timing bug. */
async function waitFor(label, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(100)
  }
  throw new Error(`${label} did not become true within ${timeoutMs}ms`)
}

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

/** Guard against a test that hangs, which would hide which side deadlocked. */
function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error(`${label} did not settle within ${ms}ms; possible deadlock`)), ms)
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
  await sleep(200)
  const tools = root.get('tools')

  const roots = [new URL('./deadlock', import.meta.url).pathname]
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots, pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  const loader = () => root.get('mloader')
  await waitFor(
    'py-reentrant mount',
    () => {
      const plugin = loader()?.list().find((entry) => entry.id === 'py-reentrant')
      return plugin !== undefined && plugin.state !== 'loaded' && plugin.state !== 'discovered'
    },
  )
  const plugin = loader().list().find((entry) => entry.id === 'py-reentrant')

  section('1. Fixture is mounted as a real Python subprocess')
  check('py-reentrant applied', plugin?.state === 'applied', JSON.stringify(plugin))
  check(
    'subscribed to tools/execute',
    (plugin?.events ?? []).includes('tools/execute'),
    JSON.stringify(plugin?.events),
  )

  section('2. Real waterfall: execution chain complete and not blocked by the plugin')
  const beats = { count: 0 }
  const heartbeat = setInterval(() => { beats.count += 1 }, 20)

  const startedAt = Date.now()
  let waterfallResult
  let waterfallError = null
  try {
    waterfallResult = await withTimeout(
      root.waterfall({}, 'tools/execute', { name: 'reentrant_ping' }, async () => 'body-result'),
      4000,
      'waterfall(tools/execute)',
    )
  } catch (error) {
    waterfallError = error
  }
  const elapsed = Date.now() - startedAt

  check('waterfall did not deadlock', waterfallError === null, waterfallError?.message)
  check('waterfall returned the body result', waterfallResult === 'body-result', JSON.stringify(waterfallResult))
  check('waterfall returned in milliseconds (<500ms)', elapsed < 500, `${elapsed}ms`)

  section('3. The plugin received the event and answered the host callback')
  await sleep(600)
  const echoes = logger.lines.filter((line) => line.includes('event echo'))
  check('plugin called the host from inside the handler', echoes.length > 0, `lines=${echoes.length}`)
  if (echoes.length > 0) console.log(`     ${echoes[echoes.length - 1]}`)

  section('4. Tool calls work while events are delivered')
  let toolResult = null
  let toolError = null
  try {
    toolResult = await withTimeout(tools.get('reentrant_ping').execute({}), 4000, 'reentrant_ping')
  } catch (error) {
    toolError = error
  }
  check('tool call did not deadlock', toolError === null, toolError?.message)
  check('tool call returned the expected value', toolResult?.ok === true, JSON.stringify(toolResult))

  section('5. Repeated delivery does not accumulate blocking')
  const rounds = []
  for (let index = 0; index < 5; index += 1) {
    const start = Date.now()
    try {
      const out = await withTimeout(
        root.waterfall({}, 'tools/execute', { name: `t${index}` }, async () => `r${index}`),
        3000,
        `waterfall#${index}`,
      )
      rounds.push({ out, elapsed: Date.now() - start })
    } catch (error) {
      rounds.push({ out: { error: error.message }, elapsed: Date.now() - start })
    }
  }
  clearInterval(heartbeat)
  check(
    '5 waterfalls returned the correct results',
    rounds.every((round, index) => round.out === `r${index}`),
    JSON.stringify(rounds.map((round) => round.out)),
  )
  check(
    '5 waterfalls were not blocked',
    rounds.every((round) => round.elapsed < 500),
    rounds.map((round) => `${round.elapsed}ms`).join(','),
  )
  check('the main thread stayed responsive', beats.count >= 10, `beats=${beats.count}`)

  section('6. Unload is clean')
  await loaderFiber.dispose()
  await sleep(800)
  const names = tools.schemas().map((schema) => schema.name)
  check('no residual tools', names.filter((name) => name.startsWith('reentrant_')).length === 0, names.join(','))
  const afterDispose = await root.waterfall({}, 'tools/execute', { name: 'x' }, async () => 'still-works')
  check('waterfall is still complete after unload', afterDispose === 'still-works', JSON.stringify(afterDispose))

  if (failures.length === 0) {
    console.log(`\nAll passed: ${passed} assertions`)
    process.exit(0)
  }
  console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
  for (const failure of failures) console.log(`   - ${failure}`)
  console.log('\nRelated log lines:')
  for (const line of logger.lines.filter((entry) => entry.includes('reentrant') || entry.includes('event echo')).slice(-20)) {
    console.log(`   ${line}`)
  }
  process.exit(1)
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
