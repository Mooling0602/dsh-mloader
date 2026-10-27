/**
 * Hot refresh suite.
 *
 * Mounts the loader on a real Cordis context with the real dsh tools service and
 * a temporary plugin root, then installs and deletes plugin directories while
 * the loader runs. Adding a directory must mount that plugin and deleting it must
 * unmount it, without a restart.
 *
 * The suite also pins what watching deliberately leaves alone: editing the files
 * of an installed plugin changes nothing until an explicit reload, a plugin whose
 * manifest is disabled stays disabled when it appears, `autoEnable: false` leaves
 * a hot-added plugin discovered, and `watch: false` installs no watcher at all.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

/** Directory of this suite, used to locate the checked-in Python fixture. */
const HERE = dirname(fileURLToPath(import.meta.url))

/** Checked-in Python plugin that the suite copies into the temporary root. */
const FIXTURE = join(HERE, 'plugins', 'python-hello')

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

const section = (title) => console.log(`\n${title}`)

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(intervalMs)
  }
  return predicate()
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

/**
 * Write a minimal Python plugin into its own directory below a root.
 *
 * @param root - Plugin root the directory is created in.
 * @param id - Plugin id, also the directory name and tool name prefix.
 * @param options - Manifest tweaks: `enabled` and `tool` default to a working plugin.
 */
async function writePythonPlugin(root, id, options = {}) {
  const { enabled = true, tool = `${id.replace(/-/g, '_')}_ping` } = options
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      backend: 'python',
      entry: 'plugin.py',
      enabled,
    }, null, 2),
  )
  await writeFile(
    join(dir, 'plugin.py'),
    `"""Minimal plugin used by the hot refresh suite."""

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="${tool}",
        description="test tool ${tool}",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def _impl(args):
        return {"ok": True, "tool": "${tool}"}
`,
  )
  return dir
}

/** Mount the loader on a fresh context and return the pieces the checks need. */
async function mountLoader(settings) {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await tick(200)
  const tools = root.get('tools')
  const fiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      profilePlugins: false,
      seedExamples: false,
      console: false,
      pythonBin: 'python3',
      ...settings,
    },
  )
  return { root, logger, tools, fiber }
}

/** Snapshot of one plugin, or undefined when the loader does not track it. */
const stateOf = (root, id) => (root.get('mloader')?.list() ?? []).find((plugin) => plugin.id === id)

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-watch-'))
  try {
    section('1. A plugin installed while the loader runs is mounted')
    const liveRoot = join(tempRoot, 'live')
    await mkdir(liveRoot, { recursive: true })
    await cp(FIXTURE, join(liveRoot, 'python-hello'), { recursive: true })

    const live = await mountLoader({ roots: [liveRoot] })
    const booted = await waitFor(() => stateOf(live.root, 'py-hello')?.state === 'applied')
    check('the fixture is mounted at boot', booted, JSON.stringify(stateOf(live.root, 'py-hello')))
    check(
      'the fixture tool is registered',
      live.tools.schemas().some((schema) => schema.name === 'py_greet'),
      live.tools.schemas().map((schema) => schema.name).join(','),
    )

    await writePythonPlugin(liveRoot, 'hot-added')
    const added = await waitFor(() => stateOf(live.root, 'hot-added')?.state === 'applied')
    check('the new plugin is mounted without a restart', added, JSON.stringify(stateOf(live.root, 'hot-added')))
    check(
      'the new tool is registered',
      live.tools.schemas().some((schema) => schema.name === 'hot_added_ping'),
      live.tools.schemas().map((schema) => schema.name).join(','),
    )
    const call = await live.tools.get('hot_added_ping')?.execute({})
    check('the new tool runs', call?.tool === 'hot_added_ping', JSON.stringify(call))
    const rescanLine = live.logger.lines.find((line) => line.startsWith('info: dsh-mloader: rescan'))
    check('the rescan is logged', rescanLine !== undefined, live.logger.lines.slice(-5).join(' | '))

    section('2. A plugin deleted while the loader runs is unmounted')
    await rm(join(liveRoot, 'hot-added'), { recursive: true, force: true })
    const removed = await waitFor(() => stateOf(live.root, 'hot-added') === undefined)
    check('the deleted plugin is no longer tracked', removed, JSON.stringify(stateOf(live.root, 'hot-added')))
    const revoked = await waitFor(
      () => !live.tools.schemas().some((schema) => schema.name === 'hot_added_ping'),
      5000,
    )
    check('its tool is revoked', revoked, live.tools.schemas().map((schema) => schema.name).join(','))
    check(
      'the plugin that stayed on disk is unaffected',
      stateOf(live.root, 'py-hello')?.state === 'applied',
      JSON.stringify(stateOf(live.root, 'py-hello')),
    )

    section('3. Editing files of an installed plugin is not a directory change')
    const linesBeforeEdit = live.logger.lines.length
    await writeFile(join(liveRoot, 'python-hello', 'plugin.py'), '# edited without a restart\n')
    await tick(1200)
    const after = stateOf(live.root, 'py-hello')
    check('the plugin keeps running', after?.state === 'applied', JSON.stringify(after))
    check(
      'its tool is still registered',
      live.tools.schemas().some((schema) => schema.name === 'py_greet'),
      live.tools.schemas().map((schema) => schema.name).join(','),
    )
    const editRescans = live.logger.lines
      .slice(linesBeforeEdit)
      .filter((line) => line.includes('rescan'))
    check('the edit triggers no rescan', editRescans.length === 0, editRescans.join(' | '))

    section('4. A manifest-disabled plugin stays disabled when it appears')
    await writePythonPlugin(liveRoot, 'hot-disabled', { enabled: false })
    const disabled = await waitFor(() => stateOf(live.root, 'hot-disabled') !== undefined)
    check('the new plugin is tracked', disabled, JSON.stringify(stateOf(live.root, 'hot-disabled')))
    check(
      'it is tracked as disabled, not started',
      stateOf(live.root, 'hot-disabled')?.state === 'disabled',
      JSON.stringify(stateOf(live.root, 'hot-disabled')),
    )
    check(
      'its tool is not registered',
      !live.tools.schemas().some((schema) => schema.name === 'hot_disabled_ping'),
      live.tools.schemas().map((schema) => schema.name).join(','),
    )
    const enabledByHand = await live.root.get('mloader')?.enable('hot-disabled')
    check('the operator can still enable it', enabledByHand?.state === 'applied', JSON.stringify(enabledByHand))

    section('5. A broken directory does not disturb the running plugins')
    await mkdir(join(liveRoot, 'not-a-plugin'), { recursive: true })
    await writeFile(join(liveRoot, 'not-a-plugin', 'readme.txt'), 'no manifest here\n')
    await writeFile(
      join(liveRoot, 'not-a-plugin', 'mloader.plugin.json'),
      JSON.stringify({ id: 'Broken', backend: 'python', entry: 'plugin.py' }),
    )
    await tick(1500)
    check(
      'an invalid manifest is not mounted',
      stateOf(live.root, 'Broken') === undefined,
      JSON.stringify(stateOf(live.root, 'Broken')),
    )
    check(
      'the healthy plugins keep running',
      stateOf(live.root, 'py-hello')?.state === 'applied'
        && stateOf(live.root, 'hot-disabled')?.state === 'applied',
      JSON.stringify(live.root.get('mloader')?.list()),
    )

    section('5a. A directory caught mid copy recovers once its files are complete')
    const partialDir = join(liveRoot, 'partial')
    await mkdir(partialDir, { recursive: true })
    await writeFile(
      join(partialDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'partial',
        name: 'partial',
        version: '1.0.0',
        backend: 'python',
        entry: 'plugin.py',
      }),
    )
    // The manifest lands first; the entry file follows, as a directory copy does.
    await tick(900)
    await writeFile(
      join(partialDir, 'plugin.py'),
      `"""Plugin whose entry file arrived after its manifest."""

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="partial_ping",
        description="test tool partial_ping",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def _impl(args):
        return {"ok": True}
`,
    )
    const recovered = await waitFor(() => stateOf(live.root, 'partial')?.state === 'applied', 15000)
    check('the plugin recovers after a retry', recovered, JSON.stringify(stateOf(live.root, 'partial')))
    const retryLine = live.logger.lines.find((line) => line.includes('retrying partial'))
    check('the retry is logged', retryLine !== undefined, live.logger.lines.slice(-6).join(' | '))

    section('5b. A plugin that never becomes valid stops being retried')
    const deadDir = join(liveRoot, 'dead-on-arrival')
    await mkdir(deadDir, { recursive: true })
    await writeFile(
      join(deadDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'dead-on-arrival',
        name: 'dead-on-arrival',
        version: '1.0.0',
        backend: 'python',
        entry: 'missing.py',
      }),
    )
    const failed = await waitFor(() => stateOf(live.root, 'dead-on-arrival')?.state === 'failed', 15000)
    check(
      'the broken plugin is tracked as failed',
      failed,
      JSON.stringify(stateOf(live.root, 'dead-on-arrival')),
    )
    const giveUp = await waitFor(
      () => live.logger.lines.some((line) => line.includes('giving up on dead-on-arrival')),
      20000,
    )
    check('the retry budget is bounded', giveUp, live.logger.lines.slice(-6).join(' | '))
    const attempts = live.logger.lines.filter((line) => line.includes('retrying dead-on-arrival')).length
    check('the plugin is retried a bounded number of times', attempts === 3, `attempts=${attempts}`)

    section('6. Removing the loader closes the watcher')
    await live.fiber.dispose()
    await tick(500)
    const linesAtTeardown = live.logger.lines.length
    await writePythonPlugin(liveRoot, 'after-teardown')
    await tick(1200)
    const afterTeardown = live.logger.lines.slice(linesAtTeardown)
    check(
      'no rescan runs after teardown',
      !afterTeardown.some((line) => line.includes('rescan')),
      afterTeardown.join(' | '),
    )
    check(
      'the plugin added after teardown is not mounted',
      stateOf(live.root, 'after-teardown') === undefined,
      JSON.stringify(stateOf(live.root, 'after-teardown')),
    )

    section('7. autoEnable: false leaves a hot-added plugin discovered')
    const lazyRoot = join(tempRoot, 'lazy')
    await mkdir(lazyRoot, { recursive: true })
    const lazy = await mountLoader({ roots: [lazyRoot], autoEnable: false })
    await writePythonPlugin(lazyRoot, 'lazy-added')
    const discovered = await waitFor(() => stateOf(lazy.root, 'lazy-added') !== undefined)
    check('the new plugin is discovered', discovered, JSON.stringify(stateOf(lazy.root, 'lazy-added')))
    check(
      'it is not started automatically',
      stateOf(lazy.root, 'lazy-added')?.state === 'discovered',
      JSON.stringify(stateOf(lazy.root, 'lazy-added')),
    )
    const startedByHand = await lazy.root.get('mloader')?.enable('lazy-added')
    check('the operator can enable it', startedByHand?.state === 'applied', JSON.stringify(startedByHand))
    await lazy.fiber.dispose()
    await tick(400)

    section('8. watch: false installs no watcher')
    const manualRoot = join(tempRoot, 'manual')
    await mkdir(manualRoot, { recursive: true })
    const manual = await mountLoader({ roots: [manualRoot], watch: false })
    await tick(600)
    await writePythonPlugin(manualRoot, 'never-seen')
    await tick(1500)
    check(
      'a directory added without watching stays unknown',
      stateOf(manual.root, 'never-seen') === undefined,
      JSON.stringify(stateOf(manual.root, 'never-seen')),
    )
    const rescanLines = manual.logger.lines.filter((line) => line.includes('rescan'))
    check('no rescan is logged', rescanLines.length === 0, rescanLines.join(' | '))
    await manual.fiber.dispose()
    await tick(400)

    section('9. A root that does not exist yet is watched through its parent')
    const lateRoot = join(tempRoot, 'late', 'plugins')
    const late = await mountLoader({ roots: [lateRoot] })
    await tick(600)
    await mkdir(lateRoot, { recursive: true })
    await writePythonPlugin(lateRoot, 'late-arrival')
    const lateMounted = await waitFor(() => stateOf(late.root, 'late-arrival')?.state === 'applied')
    check('the plugin is mounted once the root appears', lateMounted, JSON.stringify(stateOf(late.root, 'late-arrival')))
    await late.fiber.dispose()
    await tick(400)

    console.log('')
    if (failures.length === 0) {
      console.log(`PASS: ${passed} assertions`)
      process.exitCode = 0
    } else {
      console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exitCode = 1
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
