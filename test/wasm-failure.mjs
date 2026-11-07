/**
 * WebAssembly worker failure convergence.
 *
 * The suite exercises the backend instance directly, so each failure kind can
 * be injected without a manager. A looping call produces the timeout path, and
 * terminating or erroring the worker injects the exit and error paths. The
 * assertions cover the failure reason, the pending calls that fail with it,
 * the single report, the intentional stop that stays silent, and the apply
 * window where the worker can die while registrations are in progress.
 *
 * The loop fixture is required and is not committed. The suite skips cleanly
 * when it is absent; a skip leaves these properties unverified rather than
 * failing.
 */

import { existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { WasmBackendInstance } from '../src/backends/wasm.js'

const WASM_BIN = fileURLToPath(new URL('./fixtures/wasm-loop/loop.wasm', import.meta.url))
if (!existsSync(WASM_BIN)) {
  console.log('skip: wasm-failure needs a compiled wasm binary, which is not committed')
  console.log(`   expected at: ${WASM_BIN}`)
  console.log('   run test/fixtures/wasm-loop/build.sh to build it.')
  process.exit(0)
}

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok: ${name}`)
  } else {
    failures.push(`${name}${detail ? ': ' + detail : ''}`)
    console.log(`  FAIL: ${name}${detail ? ': ' + detail : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds, so a fixed sleep cannot hide a timing bug. */
async function waitFor(label, predicate, timeoutMs = 10000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  throw new Error(`${label} did not become true within ${timeoutMs}ms`)
}

/** Return true when the call rejects with a message matching the pattern. */
async function rejects(action, pattern) {
  try {
    await action()
    return false
  } catch (error) {
    return pattern.test(error.message)
  }
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

const logger = makeLogger()

const spec = {
  id: 'wasm-failure',
  name: 'Wasm Failure',
  version: '1.0.0',
  backend: 'wasm',
  entry: WASM_BIN,
  baseDir: dirname(WASM_BIN),
  manifestPath: join(dirname(WASM_BIN), 'mloader.plugin.json'),
  enabled: true,
  inject: [],
  capabilities: { tools: true, events: true, logger: true, effect: true },
  timeouts: { startupMs: 5000, callMs: 400 },
  env: {},
  declared: {},
}

const registrar = {
  async handle() {
    return {}
  },
}

async function startInstance(onCrash) {
  const instance = new WasmBackendInstance(spec, { logger, onCrash })
  await instance.start()
  return instance
}

async function startApplied(onCrash) {
  const instance = await startInstance(onCrash)
  await instance.apply(registrar)
  return instance
}

async function main() {
  section('1. A call deadline fails the worker and reports it once')
  {
    const crashes = []
    const instance = await startApplied((pluginId, failure) => crashes.push({ pluginId, ...failure }))
    const startedAt = Date.now()
    const outcomes = await Promise.allSettled([
      instance.callTool('wasm_loop_forever', {}),
      instance.callTool('wasm_loop_forever', {}),
    ])
    const elapsed = Date.now() - startedAt
    const message = outcomes[0].status === 'rejected' ? outcomes[0].reason.message : ''

    check('both pending calls reject', outcomes.every((outcome) => outcome.status === 'rejected'))
    check('the rejection names the deadline', /timed out/.test(message), message)
    check('the deadline uses the configured callMs', elapsed < 3000, `${elapsed}ms`)
    await waitFor('the timeout report', () => crashes.length === 1)
    check('the report names the timeout reason', crashes[0]?.reason === 'timeout', JSON.stringify(crashes))
    check('the report carries the detail', /timed out/.test(crashes[0]?.message ?? ''), crashes[0]?.message)
    check('the report carries the plugin id', crashes[0]?.pluginId === 'wasm-failure', crashes[0]?.pluginId)
    await sleep(300)
    check('the exit caused by termination is not reported again', crashes.length === 1, JSON.stringify(crashes))
    check(
      'a call after the failure reports a stopped backend',
      await rejects(() => instance.callTool('wasm_fine', {}), /not running/),
    )
  }

  section('2. A worker exit after apply is reported once')
  {
    const crashes = []
    const instance = await startApplied((pluginId, failure) => crashes.push({ pluginId, ...failure }))
    // The worker handle is private to the type system only. The test uses the
    // runtime field to inject the exit that a real module cannot trigger.
    await instance.worker.terminate()
    await waitFor('the exit report', () => crashes.length === 1)
    check('the exit reason is reported', crashes[0]?.reason === 'exit', JSON.stringify(crashes))
    check('the exit detail carries the code', /code=/.test(crashes[0]?.message ?? ''), crashes[0]?.message)
    await sleep(200)
    check('the exit is reported once', crashes.length === 1, JSON.stringify(crashes))
  }

  section('3. A worker error after apply is reported once')
  {
    const crashes = []
    const instance = await startApplied((pluginId, failure) => crashes.push({ pluginId, ...failure }))
    instance.worker.emit('error', new Error('injected worker error'))
    await waitFor('the error report', () => crashes.length === 1)
    check('the error reason is reported', crashes[0]?.reason === 'error', JSON.stringify(crashes))
    check(
      'the error detail carries the worker message',
      /injected worker error/.test(crashes[0]?.message ?? ''),
      crashes[0]?.message,
    )
    await sleep(200)
    check('the error is reported once', crashes.length === 1, JSON.stringify(crashes))
  }

  section('4. An intentional stop is not reported as a failure')
  {
    const crashes = []
    const instance = await startApplied((pluginId, failure) => crashes.push({ pluginId, ...failure }))
    await instance.stop('test stop')
    await sleep(300)
    check('the stop is silent', crashes.length === 0, JSON.stringify(crashes))
  }

  section('5. A worker that dies during the apply handshake fails the apply')
  {
    const crashes = []
    const instance = await startInstance((pluginId, failure) => crashes.push({ pluginId, ...failure }))
    let terminated = false
    const terminatingRegistrar = {
      async handle() {
        if (!terminated) {
          terminated = true
          await instance.worker.terminate()
          await sleep(100)
        }
        return {}
      },
    }
    let applyError = null
    try {
      await instance.apply(terminatingRegistrar)
    } catch (error) {
      applyError = error
    }
    check(
      'apply fails when the worker dies during registration',
      /exited during apply/.test(applyError?.message ?? ''),
      String(applyError),
    )
    check('the apply window is not reported as a crash', crashes.length === 0, JSON.stringify(crashes))
  }

  if (failures.length === 0) {
    console.log(`\nAll passed: ${passed} assertions`)
    process.exit(0)
  }
  console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
  for (const failure of failures) console.log(`   - ${failure}`)
  console.log('\nRelated log lines:')
  for (const line of logger.lines.slice(-30)) console.log(`   ${line}`)
  process.exit(1)
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
