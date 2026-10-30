/**
 * Loader integration suite.
 *
 * Mounts the loader on a real Cordis context with the real dsh tools service
 * and drives the whole chain: discovery, Python child process, registration
 * translation, real tool calls through the tools service and clean unload.
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

/** Greeting the Python hello fixture returns for the `who` argument. */
const PY_GREETING = 'Hello, world!'

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

/** Collect log lines so assertions can inspect them. */
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

  // Provide the logger and the real tools service on the root context, as dsh does.
  root.provide('logger', logger)
  // ToolRuntime is the real dsh tool registry; it injects systemPrompt.
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

  section('1. Mount the loader as an ordinary Cordis plugin')
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots: [new URL('./plugins', import.meta.url).pathname],
      // The suite must not touch the real profile: disable detection and seeding.
      profilePlugins: false,
      seedExamples: false,
      console: false,
      pythonBin: 'python3',
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const loader = root.get('mloader')
  check('loader provides the management service', typeof loader?.list === 'function')

  const plugins = loader?.list?.() ?? []
  // test/plugins holds both Python and WebAssembly plugins; only the Python ones matter here.
  const pythonPlugins = plugins.filter((plugin) => plugin.backend === 'python')
  check('two Python plugins are discovered', pythonPlugins.length === 2, `actual ${pythonPlugins.map((p) => p.id).join(',')}`)

  const hello = plugins.find((plugin) => plugin.id === 'py-hello')
  const decl = plugins.find((plugin) => plugin.id === 'py-decl')
  check('py-hello is applied', hello?.state === 'applied', `state=${hello?.state} error=${hello?.error}`)
  check('py-decl is applied', decl?.state === 'applied', `state=${decl?.state} error=${decl?.error}`)

  section('2. External plugins are not Cordis plugins')
  check('external plugins are not registered as Cordis plugins', typeof root.get('py-hello') === 'undefined')
  // The loader is the only Cordis plugin node; external plugins live in the registrar ledgers.
  check('py-hello has its own registration ledger', (hello?.registrations ?? 0) > 0, `registrations=${hello?.registrations}`)

  section('3. Tools are registered on the real tools service')
  const schemas = tools.schemas()
  const names = schemas.map((schema) => schema.name)
  check('py_greet is registered', names.includes('py_greet'), `present: ${names.join(',')}`)
  check('py_echo is registered', names.includes('py_echo'))
  check('py_add is registered (declarative style)', names.includes('py_add'))
  check('py_stats is registered (declarative style)', names.includes('py_stats'))
  check('mloader_status is registered', names.includes('mloader_status'))

  section('4. Call Python tools end to end')
  const greetDef = tools.get('py_greet')
  const greetResult = await greetDef.execute({ who: 'world' })
  check('py_greet returns the greeting', greetResult?.text === PY_GREETING, JSON.stringify(greetResult))

  const addDef = tools.get('py_add')
  const addResult = await addDef.execute({ a: 19, b: 23 })
  check('py_add returns 42', addResult?.sum === 42, JSON.stringify(addResult))

  const statsDef = tools.get('py_stats')
  const statsResult = await statsDef.execute({ values: [1, 2, 3, 4] })
  check('py_stats computes the statistics', statsResult?.mean === 2.5 && statsResult?.max === 4, JSON.stringify(statsResult))

  // An exception in a tool becomes a tool error and must not kill the process.
  section('5. Error isolation')
  let threw = false
  try {
    await tools.get('py_stats').execute({ values: 'not-an-array' })
  } catch {
    threw = true
  }
  check('a plugin exception becomes a tool error', threw)
  check('the plugin is still alive after the error', loader.list().find((p) => p.id === 'py-decl')?.state === 'applied')

  section('6. Output rendering')
  const greetSchema = schemas.find((schema) => schema.name === 'py_greet')
  check('the tool declares parameters', greetSchema?.parameters?.type === 'object')
  const rendered = greetDef.output.render({ who: 'x' }, greetResult)
  check('render returns ContentBlock[]', Array.isArray(rendered) && rendered[0]?.type === 'text')

  section('7. Status tool')
  const statusResult = await tools.get('mloader_status').execute({})
  check('mloader_status reports every plugin', statusResult?.count === loader.list().length, JSON.stringify(statusResult).slice(0, 200))

  section('7a. Model-facing management tools')
  const managementNames = ['mloader_info', 'mloader_load', 'mloader_unload', 'mloader_reload']
  check('management tools are registered', managementNames.every((name) => names.includes(name)), names.join(','))
  const info = await tools.get('mloader_info').execute({ id: 'py-hello' })
  check('info returns the command detail format', info.text.includes('Plugin py-hello:') && info.text.includes('Version:'))
  await tools.get('mloader_unload').execute({ id: 'py-hello' })
  check('unload revokes the plugin tools', tools.get('py_greet') === undefined)
  await tools.get('mloader_load').execute({ id: 'py-hello' })
  check('load restores the plugin tools', tools.get('py_greet') !== undefined)
  await tools.get('mloader_reload').execute({ id: 'py-hello' })
  check('reload leaves the plugin applied', loader.list().find((p) => p.id === 'py-hello')?.state === 'applied')
  let unknownFailed = false
  try { await tools.get('mloader_reload').execute({ id: 'missing' }) } catch { unknownFailed = true }
  check('unknown plugin produces a tool error', unknownFailed)

  section('8. Unload one plugin without affecting the others')
  await loader.unload('py-decl')
  const afterUnload = loader.list()
  check('py-decl is removed', !afterUnload.some((plugin) => plugin.id === 'py-decl'))
  const namesAfter = tools.schemas().map((schema) => schema.name)
  check('py_add is revoked', !namesAfter.includes('py_add'), `present: ${namesAfter.join(',')}`)
  check('py_greet is still registered', namesAfter.includes('py_greet'))

  section('9. Dispose the loader (all registrations revoked, child processes exited)')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const finalNames = tools.schemas().map((schema) => schema.name)
  check('every external tool is revoked', !finalNames.some((n) => n.startsWith('py_')), `leftover: ${finalNames.join(',')}`)
  check('management tools are revoked', managementNames.every((name) => !finalNames.includes(name)), finalNames.join(','))

  // Summary
  console.log('')
  if (failures.length === 0) {
    console.log(`All ${passed} assertions passed`)
    process.exit(0)
  } else {
    console.log(`${failures.length} of ${passed + failures.length} assertions failed`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\nLoader log:')
    for (const line of logger.lines.slice(-40)) console.log(`   ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\nThe integration suite crashed:', error)
  process.exit(1)
})
