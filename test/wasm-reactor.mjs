/**
 * WebAssembly reactor initialization suite.
 *
 * A WASI reactor exports `_initialize` instead of `_start`, and its exported
 * functions trap until the host has called `_initialize`. This suite assembles
 * such a module in memory, so it needs no toolchain: one case reports ABI
 * version 1 only after initialization and must be applied, the other reports
 * version 2 after initialization and must be failed by the version check.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
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
    console.log('  ok: ' + name)
  } else {
    failures.push(name + (detail ? ': ' + detail : ''))
    console.log('  FAIL: ' + name + (detail ? ': ' + detail : ''))
  }
}

const section = (title) => console.log('\n' + title)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(label, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
  }
  throw new Error(label + ' did not become true within ' + timeoutMs + 'ms')
}

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

/** Encode an unsigned LEB128 integer. */
function uleb(value) {
  const bytes = []
  let remaining = value
  do {
    let byte = remaining & 0x7f
    remaining >>>= 7
    if (remaining !== 0) byte |= 0x80
    bytes.push(byte)
  } while (remaining !== 0)
  return bytes
}

/** Encode a signed LEB128 integer. */
function sleb(value) {
  const bytes = []
  let remaining = value
  for (;;) {
    let byte = remaining & 0x7f
    remaining >>= 7
    if ((remaining === 0 && (byte & 0x40) === 0) || (remaining === -1 && (byte & 0x40) !== 0)) {
      bytes.push(byte)
      return bytes
    }
    bytes.push(byte | 0x80)
  }
}

/** Concatenate a vector of byte arrays with its length prefix. */
function vec(items) {
  return [...uleb(items.length), ...items.flatMap((item) => item)]
}

/** Wrap one section with its id and byte length. */
function sectionBytes(id, payload) {
  return [id, ...uleb(payload.length), ...payload]
}

/** One function type section entry. */
function funcType(params, results) {
  return [0x60, ...vec(params.map((kind) => [kind])), ...vec(results.map((kind) => [kind]))]
}

/** Encode one UTF-8 string with its length prefix. */
function name(text) {
  const bytes = [...new TextEncoder().encode(text)]
  return [...uleb(bytes.length), ...bytes]
}

const I32 = 0x7f

/**
 * Build a minimal WASI reactor module that satisfies the core ABI.
 *
 * The module imports `fd_write` so the worker instantiates a WASI provider, and
 * it exports `_initialize` instead of `_start`. Initialization stores the
 * requested ABI version at address 0, and `mloader_abi_version` returns the
 * stored value, so the returned version is observable only when the host
 * initialized the module before the version check.
 *
 * @param options - Initialization and reply options.
 * @returns Compiled module bytes.
 */
function buildReactorModule({ versionAfterInitialize = 1 } = {}) {
  const declaration = '{"ok":true,"result":{"tools":[],"events":[]}}'
  const declarationBytes = [...new TextEncoder().encode(declaration)]

  const types = [
    funcType([I32], [I32]),
    funcType([I32, I32], []),
    funcType([I32, I32], [I32]),
    funcType([], [I32]),
    funcType([], []),
    funcType([I32, I32, I32, I32], [I32]),
  ]
  // alloc, free, call, result_ptr, abi_version, _initialize
  const functionTypes = [0, 1, 2, 3, 3, 4]
  const bodies = [
    [0x41, ...sleb(1024), 0x0b],
    [0x0b],
    [0x41, ...sleb(declarationBytes.length), 0x0b],
    [0x41, ...sleb(16), 0x0b],
    [0x41, 0x00, 0x28, 0x00, 0x00, 0x0b],
    [0x41, 0x00, 0x41, ...sleb(versionAfterInitialize), 0x36, 0x00, 0x00, 0x0b],
  ]

  const imported = [
    ...name('wasi_snapshot_preview1'),
    ...name('fd_write'),
    0x00,
    ...uleb(5),
  ]

  // The imported fd_write takes function index 0, so the defined functions
  // start at index 1.
  const exportedFunctions = [
    ['mloader_alloc', 1],
    ['mloader_free', 2],
    ['mloader_call', 3],
    ['mloader_result_ptr', 4],
    ['mloader_abi_version', 5],
    ['_initialize', 6],
  ]
  const exportEntries = [
    [...name('memory'), 0x02, ...uleb(0)],
    ...exportedFunctions.map(([exportName, index]) => [...name(exportName), 0x00, ...uleb(index)]),
  ]

  const dataPayload = vec([[
    0x00,
    0x41, ...sleb(16), 0x0b,
    ...vec(declarationBytes.map((byte) => [byte])),
  ]])
  const codePayload = vec(bodies.map((body) => {
    const entry = [0x00, ...body]
    return [...uleb(entry.length), ...entry]
  }))

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sectionBytes(1, vec(types)),
    ...sectionBytes(2, vec([imported])),
    ...sectionBytes(3, vec(functionTypes.map((index) => [index]))),
    ...sectionBytes(5, vec([[0x00, ...uleb(1)]])),
    ...sectionBytes(7, vec(exportEntries)),
    ...sectionBytes(10, codePayload),
    ...sectionBytes(11, dataPayload),
  ])
}

/** Mount the loader with the wasm backend enabled and no other plugin roots. */
async function mountLoader(roots) {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await sleep(200)
  const fiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots,
      wasm: { enabled: true },
      profilePlugins: false,
      seedExamples: false,
      console: false,
      watch: false,
      statusTool: false,
      command: false,
    },
  )
  return { root, fiber }
}

/** Write one wasm plugin directory and return the temporary root. */
async function writePlugin(id, bytes) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mloader-reactor-'))
  const pluginDir = join(rootDir, id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, version: '0.0.0', backend: 'wasm', entry: 'reactor.wasm' }),
  )
  await writeFile(join(pluginDir, 'reactor.wasm'), bytes)
  return rootDir
}

/** Start one module and return its final snapshot. */
async function runCase(id, bytes) {
  const pluginRoot = await writePlugin(id, bytes)
  const { root, fiber } = await mountLoader([pluginRoot])
  try {
    const stateOf = () => (root.get('mloader')?.list() ?? []).find((plugin) => plugin.id === id)
    await waitFor('the plugin is discovered', () => stateOf() !== undefined, 10000)
    await waitFor('the plugin settles', () => stateOf()?.state === 'applied' || stateOf()?.state === 'failed')
    return stateOf()
  } finally {
    await fiber.dispose().catch(() => {})
    await rm(pluginRoot, { recursive: true, force: true }).catch(() => {})
  }
}

async function main() {
  section('1. A reactor is initialized before the version check')
  const applied = await runCase('reactor-v1', buildReactorModule({ versionAfterInitialize: 1 }))
  check('the module is applied', applied?.state === 'applied', JSON.stringify(applied))
  check('it declares no tools', (applied?.tools ?? []).length === 0, JSON.stringify(applied?.tools))
  check('it declares no events', (applied?.events ?? []).length === 0, JSON.stringify(applied?.events))

  section('2. The version check still rejects a reactor after initialization')
  const rejected = await runCase('reactor-v2', buildReactorModule({ versionAfterInitialize: 2 }))
  check('the module is failed', rejected?.state === 'failed', JSON.stringify(rejected))
  check(
    'the error names both versions',
    /ABI version 2/.test(rejected?.error ?? '') && /supports 1/.test(rejected?.error ?? ''),
    rejected?.error,
  )

  if (failures.length === 0) {
    console.log('\nAll passed: ' + passed + ' assertions')
    process.exitCode = 0
  } else {
    console.log('\n' + failures.length + ' failed out of ' + (passed + failures.length))
    for (const failure of failures) console.log('   - ' + failure)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
