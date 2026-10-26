/**
 * Both backends in one loader: Python plugins in child processes and a
 * WebAssembly plugin in a worker thread, exercised through a real Cordis context
 * and the real tool runtime.
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

const WASM_BIN = fileURLToPath(new URL('./plugins/wasm-hello/hello.wasm', import.meta.url))
if (!existsSync(WASM_BIN)) {
  console.log('skip: dual-backend needs a compiled wasm binary, which is not committed')
  console.log(`   expected at: ${WASM_BIN}`)
  console.log('   compile test/plugins/wasm-hello with GOOS=wasip1 GOARCH=wasm to run it.')
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

  const roots = [new URL('./plugins', import.meta.url).pathname]
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots, pythonBin: 'python3', wasm: { enabled: true }, profilePlugins: false, seedExamples: false, console: false },
  )
  await waitFor('three plugins reach a settled state', () => {
    const entries = root.get('mloader')?.list() ?? []
    return entries.length === 3 && entries.every((entry) => entry.state !== 'loaded' && entry.state !== 'discovered')
  })

  const loader = root.get('mloader')
  const stateOf = (id) => loader.list().find((entry) => entry.id === id)

  section('1. Three plugins are mounted (2 Python + 1 WebAssembly)')
  check('discovered 3 plugins', loader.list().length === 3, loader.list().map((entry) => `${entry.id}:${entry.state}`).join(','))
  check('py-hello applied', stateOf('py-hello')?.state === 'applied', JSON.stringify(stateOf('py-hello')))
  check('py-decl applied', stateOf('py-decl')?.state === 'applied', JSON.stringify(stateOf('py-decl')))
  check('wasm-hello applied', stateOf('wasm-hello')?.state === 'applied', JSON.stringify(stateOf('wasm-hello')))

  section('2. Each plugin reports the backend from its manifest')
  check('wasm-hello backend=wasm', stateOf('wasm-hello')?.backend === 'wasm')
  check('py-hello backend=python', stateOf('py-hello')?.backend === 'python')

  section('3. Python tools go through the real execute path')
  check('py_greet', (await tools.get('py_greet').execute({ who: 'world' }))?.text === 'Hello, world!')
  check('py_add', (await tools.get('py_add').execute({ a: 19, b: 23 }))?.sum === 42)
  check('py_stats', (await tools.get('py_stats').execute({ values: [1, 2, 3, 4] }))?.mean === 2.5)

  section('4. WebAssembly tools go through the real execute path')
  check('wasm_add', (await tools.get('wasm_add').execute({ a: 19, b: 23 }))?.sum === 42)
  check('wasm_upper', (await tools.get('wasm_upper').execute({ s: 'hello wasm' }))?.upper === 'HELLO WASM')

  section('5. The two backends do not interfere')
  const mixed = await Promise.all([
    tools.get('py_add').execute({ a: 1, b: 2 }),
    tools.get('wasm_add').execute({ a: 3, b: 4 }),
    tools.get('py_stats').execute({ values: [9] }),
  ])
  check('concurrent calls return correct results', mixed[0]?.sum === 3 && mixed[1]?.sum === 7 && mixed[2]?.mean === 9)

  section('6. Unloading the WebAssembly plugin does not affect Python')
  await loader.unload('wasm-hello')
  const namesAfter = tools.schemas().map((schema) => schema.name)
  check('wasm_add revoked', !namesAfter.includes('wasm_add'), namesAfter.join(','))
  check('wasm_upper revoked', !namesAfter.includes('wasm_upper'))
  check('py_greet still registered', namesAfter.includes('py_greet'))
  check('py_add still registered', namesAfter.includes('py_add'))

  section('7. Unloading a Python plugin')
  await loader.unload('py-decl')
  const afterPy = tools.schemas().map((schema) => schema.name)
  check('py_add revoked', !afterPy.includes('py_add'))
  check('py_greet still registered', afterPy.includes('py_greet'))

  section('8. Everything is unloaded')
  await loaderFiber.dispose()
  await sleep(800)
  const final = tools.schemas().map((schema) => schema.name)
  check('no residual tools', final.filter((name) => name.startsWith('py_') || name.startsWith('wasm_')).length === 0,
    final.join(','))

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
