/**
 * Bytecode cache suite.
 *
 * The Python backend starts one child process per plugin, and the interpreter
 * writes `__pycache__` beside the entry file unless it is told not to. A cache
 * entry is invalidated by the source mtime in whole seconds plus the source
 * size, so an edit that keeps both unchanged makes a reload start the old code
 * again. The suite pins the default that writes no cache, and the switch that
 * restores the cache for an operator who prefers faster loads.
 */

import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log('  PASS ' + name)
  } else {
    failures.push(name + (detail ? ': ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ': ' + detail : ''))
  }
}

const section = (title) => console.log('\n' + title)
const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

function makeLogger() {
  const lines = []
  const push = (level) => (message) => lines.push(level + ': ' + message)
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

/** Write a minimal plugin whose tool returns a fixed string. */
async function writePlugin(root, value) {
  const Q = String.fromCharCode(34)
  const NL2 = String.fromCharCode(10)
  const dir = join(root, 'pyc-check')
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'mloader.plugin.json'), JSON.stringify({
    id: 'pyc-check',
    name: 'pyc-check',
    version: '1.0.0',
    backend: 'python',
    entry: 'plugin.py',
    enabled: true,
  }, null, 2))
  const src = [
    'from dsh_mloader_sdk import plugin',
    '',
    '',
    '@plugin',
    'def apply(ctx):',
    '    @ctx.tools.register(name=' + Q + 'pyc_value' + Q + ', description=' + Q + 'fixed value' + Q + ',',
    '        parameters={' + Q + 'type' + Q + ': ' + Q + 'object' + Q + ', ' + Q + 'properties' + Q + ': {}, ' + Q + 'additionalProperties' + Q + ': False})',
    '    def _impl(args):',
    '        return {' + Q + 'value' + Q + ': ' + Q + value + Q + '}',
  ].join(NL2) + NL2
  await writeFile(join(dir, 'plugin.py'), src)
  return dir
}

/** Mount the loader on a fresh context and return its pieces. */
async function mount(rootDir, settings) {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await tick(200)
  const tools = root.get('tools')
  root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      profilePlugins: false,
      seedExamples: false,
      console: false,
      pythonBin: 'python3',
      roots: [rootDir],
      ...settings,
    },
  )
  return { root, logger, tools }
}

/** True when the plugin directory holds a bytecode cache directory. */
async function hasPycache(dir) {
  try {
    const names = await readdir(dir)
    return names.includes('__pycache__')
  } catch {
    return false
  }
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-pyc-'))
  try {
    section('1. The default writes no bytecode cache')
    const defaultRoot = join(tempRoot, 'default')
    const defaultDir = await writePlugin(defaultRoot, 'v1')
    const live = await mount(defaultRoot, {})
    const applied = (root) => (root.get('mloader')?.list() ?? [])
    for (let i = 0; i < 150 && (applied(live.root).length === 0 || applied(live.root)[0].state !== 'applied'); i++) {
      await tick(100)
    }
    check(
      'the plugin is applied',
      applied(live.root)[0]?.state === 'applied',
      JSON.stringify(applied(live.root)),
    )
    check(
      'the default leaves no __pycache__ behind',
      (await hasPycache(defaultDir)) === false,
      'found __pycache__ in ' + defaultDir,
    )

    section('2. enablePyc keeps the bytecode cache')
    const cachedRoot = join(tempRoot, 'cached')
    const cachedDir = await writePlugin(cachedRoot, 'v1')
    const cached = await mount(cachedRoot, { enablePyc: true })
    for (let i = 0; i < 150 && (applied(cached.root).length === 0 || applied(cached.root)[0].state !== 'applied'); i++) {
      await tick(100)
    }
    check(
      'the plugin is applied with the cache enabled',
      applied(cached.root)[0]?.state === 'applied',
      JSON.stringify(applied(cached.root)),
    )
    const cachedHasPyc = await hasPycache(cachedDir)
    check('enablePyc writes a __pycache__ directory', cachedHasPyc, 'no __pycache__ in ' + cachedDir)
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }

  console.log('');
  if (failures.length > 0) {
    console.log('FAIL: ' + failures.length + ' of ' + (passed + failures.length) + ' assertions');
    for (const failure of failures) console.log('  - ' + failure)
    process.exitCode = 1
  } else {
    console.log('PASS: ' + passed + ' assertions');
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
