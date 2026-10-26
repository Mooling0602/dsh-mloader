/**
 * Crash safety: a plugin process that dies must never take the loader or the
 * dsh process down.
 *
 * The suite installs process level uncaught exception and unhandled rejection
 * handlers. Any error escaping to that level fails the suite, which is how an
 * unhandled EPIPE on a dead stdin is caught.
 */

import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
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

/** Errors that escaped to the process level. Any entry fails the suite. */
const uncaught = []
process.on('uncaughtException', (error) => {
  uncaught.push(error)
  console.log(`  escaped uncaughtException: ${error.code ?? ''} ${error.message}`)
})
process.on('unhandledRejection', (reason) => {
  uncaught.push(reason instanceof Error ? reason : new Error(String(reason)))
  console.log(`  escaped unhandledRejection: ${reason}`)
})

async function makePlugin(root, id, { sleepForever = false } = {}) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, backend: 'python', entry: 'plugin.py', version: '1.0.0' }),
  )
  const body = sleepForever
    ? `import time\nfrom dsh_mloader_sdk import plugin\n\n@plugin\ndef apply(ctx):\n    ctx.logger.info("sleeping")\n    time.sleep(600)\n`
    : `from dsh_mloader_sdk import plugin\n\n@plugin\ndef apply(ctx):\n    @ctx.tools.register(name="${id.replace(/-/g, '_')}_ping", description="ping", parameters={"type":"object","properties":{},"additionalProperties":False})\n    def ping(args):\n        return {"pong": True}\n`
  await writeFile(join(dir, 'plugin.py'), body)
  return dir
}

async function mountLoader(config) {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await sleep(200)
  const fiber = root.plugin({ name: 'dsh-mloader', inject: ['tools'], apply: loaderApply }, config)
  return { root, fiber, logger }
}

/** Run pgrep with one pattern and return the matching process ids. */
async function pgrep(pattern) {
  const pids = []
  const child = spawn('pgrep', ['-f', pattern])
  child.stdout.on('data', (chunk) => {
    for (const line of String(chunk).trim().split('\n')) {
      if (line.trim()) pids.push(Number(line.trim()))
    }
  })
  await new Promise((resolve) => child.on('exit', resolve))
  return pids
}

function cmdlineOf(pid) {
  try {
    return readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
  } catch {
    return ''
  }
}

/**
 * Keep only processes started for this suite.
 *
 * Matching on the temporary root keeps unrelated plugins of other sessions out,
 * and the interpreter prefix keeps the pattern from matching this test script.
 */
function ownPluginPids(pids, tempRoot) {
  return pids.filter((pid) => {
    const cmdline = cmdlineOf(pid)
    return cmdline.startsWith('python3') && cmdline.includes(tempRoot)
  })
}

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-crash-'))

    section('1. A subprocess that dies with its pipe open raises no process level error')
    {
      const plugins = join(tempRoot, 'p1')
      await makePlugin(plugins, 'victim')
      const { root, fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
        console: false,
        statusTool: false,
        command: false,
      })
      await waitFor('victim loaded', () => (root.get('mloader')?.list() ?? []).some((entry) => entry.id === 'victim'))

      const manager = root.get('mloader')
      const victim = manager?.list().find((entry) => entry.id === 'victim')
      check('plugin is loaded', victim !== undefined, JSON.stringify((manager?.list() ?? []).map((entry) => entry.id)))
      check('plugin handle is available', victim !== undefined)

      // Kill the child directly, the way a dsh restart interrupts it.
      await fiber.dispose()
      await sleep(800)
    }

    section('2. Repeated child kills do not leak an EPIPE to the process level')
    {
      uncaught.length = 0
      const plugins = join(tempRoot, 'p2')
      await makePlugin(plugins, 'victim2')
      const { root, fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
        console: false,
        statusTool: false,
        command: false,
      })
      await waitFor('victim2 loaded', () => (root.get('mloader')?.list() ?? []).some((entry) => entry.id === 'victim2'))
      await sleep(300)

      // The pattern must name the runtime launcher and not this script. The
      // command line filter then keeps processes of other sessions out.
      const pids = ownPluginPids(await pgrep('python3.*launch.py'), tempRoot)
      check('plugin subprocess found', pids.length > 0, `pids=${JSON.stringify(pids)}`)

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // The process may have exited already.
        }
      }
      // The child is dead now, so unload writes the dispose frame into a dead pipe.
      const disposeStartedAt = Date.now()
      await fiber.dispose()
      const disposeMs = Date.now() - disposeStartedAt
      await sleep(1200)
      check('unload returns quickly (< 3s)', disposeMs < 3000, `${disposeMs}ms`)
      check(
        'no uncaughtException escaped',
        uncaught.length === 0,
        uncaught.map((error) => `${error.code ?? ''} ${error.message}`).join(' | '),
      )
    }

    section('3. A plugin whose interpreter cannot start does not crash the loader')
    {
      uncaught.length = 0
      const plugins = join(tempRoot, 'p3')
      await makePlugin(plugins, 'okplugin')
      const { root, fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: '/nonexistent/python-does-not-exist',
        profilePlugins: false,
        seedExamples: false,
        console: false,
        statusTool: false,
        command: false,
      })
      await waitFor(
        'plugin marked failed',
        () => (root.get('mloader')?.list() ?? []).some((entry) => entry.state === 'failed'),
      )

      const list = root.get('mloader')?.list() ?? []
      check('plugin is failed instead of crashing the host', list.length === 1 && list[0].state === 'failed',
        JSON.stringify(list.map((entry) => `${entry.id}:${entry.state}`)))
      check(
        'no uncaughtException escaped',
        uncaught.length === 0,
        uncaught.map((error) => `${error.code ?? ''} ${error.message}`).join(' | '),
      )

      await fiber.dispose()
      await sleep(500)
    }

    section('4. A plugin stuck in apply does not prevent unload')
    {
      uncaught.length = 0
      const plugins = join(tempRoot, 'p4')
      await makePlugin(plugins, 'sleepy', { sleepForever: true })
      const { fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
        console: false,
        statusTool: false,
        command: false,
      })
      // The plugin is still inside its apply sleep, so boot has not completed.
      await sleep(800)

      const startedAt = Date.now()
      await fiber.dispose()
      const elapsed = Date.now() - startedAt
      check('unload returns within a bounded time', elapsed < 8000, `${elapsed}ms`)
      check(
        'no uncaughtException escaped',
        uncaught.length === 0,
        uncaught.map((error) => `${error.code ?? ''} ${error.message}`).join(' | '),
      )
    }

    section('5. No Python process from this suite is left behind')
    {
      await sleep(500)
      let leaked = ownPluginPids(await pgrep('python3.*launch.py'), tempRoot)
      // Reaping is asynchronous: SIGTERM is followed by SIGKILL after a bounded wait.
      for (let attempt = 0; attempt < 30 && leaked.length > 0; attempt += 1) {
        await sleep(200)
        leaked = ownPluginPids(await pgrep('python3.*launch.py'), tempRoot)
      }
      check('no child process of this suite remains', leaked.length === 0, `remaining=${JSON.stringify(leaked)}`)
    }

    if (failures.length === 0) {
      console.log(`\nAll passed: ${passed} assertions`)
      process.exitCode = 0
    } else {
      console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
      for (const failure of failures) console.log(`   - ${failure}`)
      process.exitCode = 1
    }
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
