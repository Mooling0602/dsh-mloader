/**
 * WebAssembly initialization deadline suite.
 *
 * The module is assembled in memory, so the suite runs without a Go or Rust
 * toolchain. A `_initialize` function that loops forever proves that the host
 * terminates the worker at the manifest startup deadline and marks the plugin
 * failed instead of leaving it in `loaded`.
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

async function waitFor(label, predicate, timeoutMs = 10000) {
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
 * Build a module whose required exports are valid but whose `_initialize`
 * function never returns.
 */
function buildModule() {
  const types = [
    funcType([I32], [I32]),
    funcType([I32, I32], []),
    funcType([I32, I32], [I32]),
    funcType([], [I32]),
    funcType([], []),
  ]
  const functionTypes = [0, 1, 2, 3, 3, 4]
  const exportedFunctions = [
    ['mloader_alloc', 0],
    ['mloader_free', 1],
    ['mloader_call', 2],
    ['mloader_result_ptr', 3],
    ['mloader_abi_version', 4],
    ['_initialize', 5],
  ]
  const bodies = [
    [0x41, 0x00, 0x0b],
    [0x0b],
    [0x41, 0x00, 0x0b],
    [0x41, 0x00, 0x0b],
    [0x41, 0x01, 0x0b],
    [0x03, 0x40, 0x0c, 0x00, 0x0b, 0x0b],
  ]

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
    ...sectionBytes(5, vec([[0x00, 0x01]])),
    ...sectionBytes(7, exportsPayload),
    ...sectionBytes(10, codePayload),
  ])
}

async function main() {
  const rootDir = await mkdtemp(join(tmpdir(), 'mloader-init-deadline-'))
  const pluginDir = join(rootDir, 'init-deadline')
  await mkdir(pluginDir, { recursive: true })
  await writeFile(
    join(pluginDir, 'mloader.plugin.json'),
    JSON.stringify({
      id: 'init-deadline',
      name: 'Init Deadline',
      version: '0.0.0',
      backend: 'wasm',
      entry: 'deadline.wasm',
      timeouts: { startupMs: 300, callMs: 1000 },
    }),
  )
  await writeFile(join(pluginDir, 'deadline.wasm'), buildModule())

  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await sleep(200)

  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots: [rootDir],
      wasm: { enabled: true },
      profilePlugins: false,
      seedExamples: false,
      console: false,
      watch: false,
      statusTool: false,
      command: false,
    },
  )

  const stateOf = () => (root.get('mloader')?.list() ?? []).find((plugin) => plugin.id === 'init-deadline')
  const startedAt = Date.now()
  let beats = 0
  const heartbeat = setInterval(() => { beats += 1 }, 20)
  try {
    await waitFor('the plugin settles', () => stateOf()?.state === 'failed')
  } finally {
    clearInterval(heartbeat)
  }
  const elapsed = Date.now() - startedAt
  const record = stateOf()

  section('1. A looping initializer is stopped at the startup deadline')
  check('the plugin is failed', record?.state === 'failed', JSON.stringify(record))
  check(
    'the error names the initialization deadline',
    /init exceeded|startup/i.test(record?.error ?? ''),
    record?.error,
  )
  check('the error carries the manifest deadline', /300ms/.test(record?.error ?? ''), record?.error)
  check('the failure arrives near the deadline', elapsed >= 250 && elapsed < 5000, String(elapsed))
  check('the host main thread stayed responsive', beats >= 3, 'beats=' + beats + ', elapsed=' + elapsed + 'ms')

  await loaderFiber.dispose().catch(() => {})
  await rm(rootDir, { recursive: true, force: true }).catch(() => {})

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
