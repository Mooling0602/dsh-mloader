/**
 * WebAssembly safety: an infinite loop inside a plugin must not block the host
 * main thread.
 *
 * The assertions are: WebAssembly is off by default, an explicit enable mounts
 * the plugin, a looping call times out and terminates the worker while a
 * heartbeat keeps ticking, the Python plugin in the same loader keeps working,
 * and unload leaves no registrations behind.
 *
 * A compiled `.wasm` binary is required. The binaries are not committed, so the
 * suite skips cleanly when the fixture is absent; a skip leaves the property
 * unverified rather than failing.
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

const WASM_BIN = fileURLToPath(new URL('./fixtures/wasm-loop/loop.wasm', import.meta.url))
if (!existsSync(WASM_BIN)) {
  console.log('skip: wasm-safety needs a compiled wasm binary, which is not committed')
  console.log(`   expected at: ${WASM_BIN}`)
  console.log('   compile test/fixtures/wasm-loop with GOOS=wasip1 GOARCH=wasm to run it.')
  process.exit(0)
}

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
async function waitFor(label, predicate, timeoutMs = 15000) {
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

  section('1. WebAssembly is disabled by default')
  const fixtures = new URL('./fixtures', import.meta.url).pathname
  const offFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots: [fixtures], pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await waitFor('fixtures settle with wasm disabled', () => {
    const entries = root.get('mloader')?.list() ?? []
    return entries.length === 3 && entries.every((entry) => entry.state !== 'loaded' && entry.state !== 'discovered')
  })
  const offLoader = root.get('mloader')
  const wasmOff = offLoader.list().find((entry) => entry.id === 'wasm-loop')
  check('wasm is not loaded by default', wasmOff?.state === 'disabled', `state=${wasmOff?.state} error=${wasmOff?.error}`)
  check('wasm_loop_forever is not registered', tools.get('wasm_loop_forever') === undefined)
  await offFiber.dispose()
  await sleep(600)

  section('2. An explicit enable mounts the plugin')
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots: [fixtures], pythonBin: 'python3', wasm: { enabled: true }, profilePlugins: false, seedExamples: false, console: false },
  )
  await waitFor('wasm-loop mount', () => {
    const entries = root.get('mloader')?.list() ?? []
    const record = entries.find((entry) => entry.id === 'wasm-loop')
    return record !== undefined && record.state !== 'loaded' && record.state !== 'discovered'
  })
  const loader = root.get('mloader')
  const wasmRecord = loader.list().find((entry) => entry.id === 'wasm-loop')
  check('wasm-loop applied', wasmRecord?.state === 'applied', JSON.stringify(wasmRecord))
  check('normal wasm tool works', (await tools.get('wasm_fine').execute({}))?.fine === true)

  section('3. An infinite loop does not block the host main thread')
  // The heartbeat stops ticking if the main thread is occupied by plugin code.
  let beats = 0
  const heartbeat = setInterval(() => { beats += 1 }, 50)

  const startedAt = Date.now()
  let loopError = null
  try {
    await tools.get('wasm_loop_forever').execute({})
  } catch (error) {
    loopError = error
  }
  const elapsed = Date.now() - startedAt
  clearInterval(heartbeat)

  check('the looping call returns an error', loopError !== null, String(loopError?.message ?? 'no error'))
  check('the error names the timeout', /timed out/i.test(loopError?.message ?? ''), loopError?.message)
  check(
    'the error names the terminated worker or the infinite loop',
    /infinite loop|worker terminated/i.test(loopError?.message ?? ''),
    loopError?.message,
  )
  check('the timeout uses callMs=1200 (<3s)', elapsed < 3000, `${elapsed}ms`)
  check('the main thread stayed responsive (heartbeat >= 10)', beats >= 10, `beats=${beats}, elapsed=${elapsed}ms`)

  section('4. The host keeps working')
  // The fixtures root also holds a Python plugin; it proves the worker failure
  // does not touch the process backend.
  const pyTool = tools.get('legal_tool')
  check('the Python plugin of the same loader is still registered', pyTool !== undefined)
  if (pyTool) {
    const pyResult = await pyTool.execute({})
    check('the Python tool still runs', pyResult?.ok === true, JSON.stringify(pyResult))
  }
  const stillAlive = await new Promise((resolve) => {
    setTimeout(() => resolve('alive'), 100)
  })
  check('the main thread can still schedule a timer', stillAlive === 'alive')

  section('5. Unload is clean')
  await loaderFiber.dispose()
  await sleep(800)
  const finalNames = tools.schemas().map((schema) => schema.name)
  check('no residual tools', finalNames.filter((name) => name.startsWith('py_') || name.startsWith('wasm_')).length === 0,
    finalNames.join(','))

  if (failures.length === 0) {
    console.log(`\nAll passed: ${passed} assertions`)
    process.exit(0)
  }
  console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
  for (const failure of failures) console.log(`   - ${failure}`)
  console.log('\nRelated log lines:')
  for (const line of logger.lines.slice(-40)) console.log(`   ${line}`)
  process.exit(1)
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
