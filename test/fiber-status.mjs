/**
 * Fiber status isolation suite.
 *
 * Cordis delivers `internal/status` to every listener, and a listener that
 * reads any transition as its own unload aborts the hosted plugins of a loader
 * that is still running. This suite mounts the loader with a real Python plugin
 * and disposes an unrelated sibling fiber: the hosted plugin must stay applied
 * and callable. It then disposes the loader fiber and checks that a real
 * teardown still removes the plugin.
 */

import { cp, mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

/** Directory of this suite, used to locate the checked-in Python fixture. */
const HERE = dirname(fileURLToPath(import.meta.url))

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

/** The Cordis fiber state for an active plugin, which the loader never imports. */
const FIBER_ACTIVE = 2

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

function systemPromptStub() {
  return {
    section: () => () => {},
    context: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    suppressRuntimeContext: () => () => {},
    refreshContext: (assembly) => assembly,
    assemble: async () => ({ sections: [] }),
  }
}

/** Mount the loader on a fresh context and return the pieces the checks need. */
async function mountLoader(settings) {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await sleep(200)
  const tools = root.get('tools')
  const fiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      profilePlugins: false,
      seedExamples: false,
      console: false,
      watch: false,
      pythonBin: 'python3',
      ...settings,
    },
  )
  return { root, fiber, tools, logger }
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-fiber-status-'))
  try {
    const pluginRoot = join(tempRoot, 'plugins')
    await cp(join(HERE, 'plugins', 'python-hello'), join(pluginRoot, 'python-hello'), { recursive: true })
    const { root, fiber, tools } = await mountLoader({ roots: [pluginRoot] })
    const stateOf = () =>
      (root.get('mloader')?.list() ?? []).find((plugin) => plugin.id === 'py-hello')

    section('1. A sibling fiber transition does not stop hosted plugins')
    await waitFor('the fixture plugin is applied', () => stateOf()?.state === 'applied')
    check('the fixture plugin is mounted at boot', stateOf()?.state === 'applied', JSON.stringify(stateOf()))

    const before = await tools.get('py_greet')?.execute({ who: 'fiber' })
    check('its tool answers before the sibling transition', before?.text === 'Hello, fiber!', JSON.stringify(before))

    const sibling = root.plugin({ name: 'sibling-plugin', apply: () => {} })
    await waitFor('the sibling fiber is active', () => sibling.state === FIBER_ACTIVE, 3000)
    await sibling.dispose()
    await sleep(300)

    check('the plugin is still applied', stateOf()?.state === 'applied', JSON.stringify(stateOf()))
    let after
    try {
      after = await tools.get('py_greet')?.execute({ who: 'fiber' })
    } catch (error) {
      after = { error: error.message }
    }
    check('its tool still answers after the sibling transition', after?.text === 'Hello, fiber!', JSON.stringify(after))

    section('2. Disposing the loader still tears its plugins down')
    await fiber.dispose()
    await sleep(300)
    check(
      'the hosted registrations are gone',
      !tools.schemas().some((schema) => schema.name === 'py_greet'),
      tools.schemas().map((schema) => schema.name).join(','),
    )
    check('the plugin is no longer tracked', stateOf() === undefined, JSON.stringify(stateOf()))

    if (failures.length === 0) {
      console.log(`\nAll passed: ${passed} assertions`)
      process.exitCode = 0
    } else {
      console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
      for (const failure of failures) console.log(`   - ${failure}`)
      process.exitCode = 1
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
