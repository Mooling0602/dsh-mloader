/**
 * WebAssembly ABI version negotiation suite.
 *
 * The modules are assembled in memory, so the suite runs without a Rust or Go
 * toolchain. Three cases: a module that reports ABI version 1 (accepted), one
 * that reports version 2 (rejected), and one that omits the version export
 * (rejected with the missing-export message).
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
    console.log(`  ok: ${name}`)
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL: ${name}${detail ? `: ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(label, predicate, timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(50)
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

const I32 = 0x7f

/**
 * Build a minimal WebAssembly module that satisfies the core ABI.
 *
 * All handlers return 0, so a successful module applies with no tools. The
 * module exports the WASI-free shape only.
 */
function buildModule({ abiVersion = 1, includeVersionExport = true } = {}) {
  const types = [
    funcType([I32], [I32]),
    funcType([I32, I32], []),
    funcType([I32, I32], [I32]),
    funcType([], [I32]),
  ]
  const functionTypes = [0, 1, 2, 3]
  const exportedFunctions = [
    ['mloader_alloc', 0],
    ['mloader_free', 1],
    ['mloader_call', 2],
    ['mloader_result_ptr', 3],
  ]
  const bodies = [
    [0x41, ...sleb(0), 0x0b],
    [0x0b],
    [0x41, ...sleb(0), 0x0b],
    [0x41, ...sleb(0), 0x0b],
  ]
  if (includeVersionExport) {
    functionTypes.push(3)
    exportedFunctions.push(['mloader_abi_version', 4])
    bodies.push([0x41, ...sleb(abiVersion), 0x0b])
  }

  const exportEntries = [
    [...new TextEncoder().encode('memory')],
    ...exportedFunctions.map(([name]) => [...new TextEncoder().encode(name)]),
  ]
  const exportKinds = [0x02, ...exportedFunctions.map(() => 0x00)]
  const exportIndices = [0, ...exportedFunctions.map(([, index]) => index)]
  const exportsPayload = vec(exportEntries.map((bytes, index) => [
    ...uleb(bytes.length),
    ...bytes,
    exportKinds[index],
    ...uleb(exportIndices[index]),
  ]))
  const codePayload = vec(bodies.map((body) => {
    const entry = [0x00, ...body]
    return [...uleb(entry.length), ...entry]
  }))

  return new Uint8Array([
    0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00,
    ...sectionBytes(1, vec(types)),
    ...sectionBytes(3, vec(functionTypes.map((index) => [index]))),
    ...sectionBytes(5, vec([[0x00, ...uleb(1)]])),
    ...sectionBytes(7, exportsPayload),
    ...sectionBytes(10, codePayload),
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
  return { root, fiber, logger }
}

/** Write one wasm plugin directory and return the temporary root. */
async function writePlugin(id, bytes) {
  const rootDir = await mkdtemp(join(tmpdir(), 'mloader-abi-'))
  const pluginDir = join(rootDir, id)
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, version: '0.0.0', backend: 'wasm', entry: 'abi.wasm' }),
  )
  await writeFile(join(pluginDir, 'abi.wasm'), bytes)
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
  section('1. A module that reports ABI version 1 is accepted')
  const accepted = await runCase('abi-v1', buildModule({ abiVersion: 1 }))
  check('the module is applied', accepted?.state === 'applied', JSON.stringify(accepted))
  check('it declares no tools', (accepted?.tools ?? []).length === 0, JSON.stringify(accepted?.tools))

  section('2. A module that reports an unsupported version is rejected')
  const unsupported = await runCase('abi-v2', buildModule({ abiVersion: 2 }))
  check('the module is failed', unsupported?.state === 'failed', JSON.stringify(unsupported))
  check(
    'the error names both versions',
    /ABI version 2/.test(unsupported?.error ?? '') && /supports 1/.test(unsupported?.error ?? ''),
    unsupported?.error,
  )

  section('3. A module without the version export is rejected')
  const missing = await runCase('abi-missing', buildModule({ includeVersionExport: false }))
  check('the module is failed', missing?.state === 'failed', JSON.stringify(missing))
  check(
    'the error lists the missing export',
    /missing required exports/.test(missing?.error ?? '') && /mloader_abi_version/.test(missing?.error ?? ''),
    missing?.error,
  )

  if (failures.length === 0) {
    console.log(`\nAll passed: ${passed} assertions`)
    process.exitCode = 0
  } else {
    console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
    for (const failure of failures) console.log(`   - ${failure}`)
    process.exitCode = 1
  }
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
