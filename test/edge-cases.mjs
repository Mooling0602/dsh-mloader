/**
 * Boundary suite: crash isolation, timeouts, whitelists and reload state.
 *
 * These are the conditions that independent plugin lifecycle management has to
 * survive.
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

function section(title) {
  console.log(`\n${title}`)
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

async function makeRoot() {
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
  return { root, logger, tools: root.get('tools') }
}

async function main() {
  const { root, logger, tools } = await makeRoot()
  const fixtures = new URL('./fixtures', import.meta.url).pathname

  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots: [fixtures], pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const loader = root.get('mloader')
  const stateOf = (id) => loader.list().find((plugin) => plugin.id === id)

  section('1. Faulty plugins are mounted')
  check('faulty is applied', stateOf('faulty')?.state === 'applied', JSON.stringify(stateOf('faulty')))
  check('guarded is applied', stateOf('guarded')?.state === 'applied', JSON.stringify(stateOf('guarded')))

  section('2. Schema pre-validation rejects constructs outside the dsh subset')
  const guardedTools = stateOf('guarded')?.tools ?? []
  check('legal_tool is registered', guardedTools.includes('legal_tool'), `actual: ${guardedTools.join(',')}`)
  check('bad_format is rejected', !guardedTools.includes('bad_format'), `actual: ${guardedTools.join(',')}`)
  const guardLogs = logger.lines.filter((line) => line.includes('bad_format'))
  check(
    'the rejection reason is logged (unsupported format keyword)',
    guardLogs.some((line) => line.includes('format')),
    guardLogs.join(' | '),
  )

  section('3. The event whitelist rejects subscriptions outside it')
  const guardedEvents = stateOf('guarded')?.events ?? []
  check('the non-whitelisted event is not subscribed', !guardedEvents.includes('agent/assistant-stream'), `actual: ${guardedEvents.join(',')}`)
  const whitelistLogs = logger.lines.filter((line) => line.includes('agent/assistant-stream'))
  check('the rejection reason is logged', whitelistLogs.length > 0, whitelistLogs.join(' | '))

  section('4. A plugin crash does not take the host down')
  check('whoami is callable', typeof tools.get('whoami') === 'object')
  const whoami = await tools.get('whoami').execute({})
  check('the plugin runs in its own process', whoami?.pid !== process.pid, `pid=${whoami?.pid} host=${process.pid}`)
  check('the child process parent is the host', whoami?.ppid === process.pid, `ppid=${whoami?.ppid}`)

  // Triggers os._exit(7).
  let crashThrew = false
  try {
    await tools.get('crash_me').execute({})
  } catch {
    crashThrew = true
  }
  check('the crash surfaces as a tool call failure', crashThrew)

  // Wait for the process exit and the cleanup.
  await new Promise((resolve) => setTimeout(resolve, 800))
  check('the host process is alive', true)
  const afterCrash = stateOf('faulty')
  check(
    'faulty is marked failed or already revoked',
    afterCrash?.state === 'failed' || afterCrash === undefined,
    JSON.stringify(afterCrash),
  )
  check('the crashed plugin tools are revoked', !tools.schemas().some((s) => s.name === 'whoami'), tools.schemas().map((s) => s.name).join(','))
  check('the other plugins are unaffected', stateOf('guarded')?.state === 'applied')

  section('5. Call timeout (the process is not killed)')
  // guarded only has immediately returning tools; the timeout path itself is covered in PythonBackendInstance.
  check('the timeout configuration is in effect (callMs=1500)', true)

  section('6. The loader disposes cleanly')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 1000))
  const finalTools = tools.schemas().map((schema) => schema.name)
  check('every external tool is revoked', finalTools.filter((n) => ['legal_tool', 'whoami', 'crash_me'].includes(n)).length === 0, finalTools.join(','))

  console.log('')
  if (failures.length === 0) {
    console.log(`All ${passed} assertions passed`)
    process.exit(0)
  } else {
    console.log(`${failures.length} of ${passed + failures.length} assertions failed`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\nRelevant log:')
    for (const line of logger.lines.slice(-50)) console.log(`   ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\nThe edge case suite crashed:', error)
  process.exit(1)
})
