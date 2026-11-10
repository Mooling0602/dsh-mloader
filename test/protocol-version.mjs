/**
 * Tests for the protocol version in the frame envelope.
 *
 * Both directions carry `v`, and both sides must refuse a frame written by a
 * runtime that speaks another version. A host that accepted such a frame would
 * act on a payload shape it does not know, which is what the field prevents.
 *
 * The fixture reaches the host through the runtime channel rather than through
 * standard output: the runtime detaches the process streams before plugin code
 * runs, so writing to file descriptor 1 would reach the null device. Patching
 * the runtime version and using the public API exercises the same code path a
 * real mismatch takes.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { PROTOCOL_VERSION } from '../src/contract.js'
import { PythonBackendInstance } from '../src/backends/python.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(detail ? `${name} [${detail}]` : name)
    console.log(`  FAIL ${name}${detail ? ` [${detail}]` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

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

const root = await mkdtemp(join(tmpdir(), 'mloader-protocol-'))

/** Write one plugin directory from a Python entry body. */
async function writePlugin(id, body) {
  const directory = join(root, id)
  await mkdir(directory, { recursive: true })
  await writeFile(
    join(directory, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', backend: 'python', entry: 'plugin.py' }),
  )
  await writeFile(join(directory, 'plugin.py'), body)
  return directory
}

function makeSpec(directory, id) {
  return {
    id,
    name: id,
    version: '1.0.0',
    backend: 'python',
    entry: join(directory, 'plugin.py'),
    baseDir: directory,
    manifestPath: join(directory, 'mloader.plugin.json'),
    enabled: true,
    inject: [],
    capabilities: { tools: true, events: true, logger: true, effect: true, commands: true },
    timeouts: { startupMs: 1500, callMs: 800 },
    env: {},
    declared: {},
  }
}

async function runInstance(id, body) {
  const directory = await writePlugin(id, body)
  const logger = makeLogger()
  const spec = makeSpec(directory, id)
  const backend = new PythonBackendInstance(spec, {
    pythonBin: 'python3',
    logger,
    onCrash: () => undefined,
  })
  let bootError
  try {
    await backend.start()
  } catch (error) {
    bootError = error
  }
  let crashState
  try {
    crashState = backend.spec.id === id
  } catch {
    crashState = undefined
  }
  await backend.stop().catch(() => undefined)
  return { logger, bootError, crashState }
}

/** A plugin whose runtime speaks another protocol version for every frame. */
function foreignVersionBody() {
  return `
import dsh_mloader_sdk.channel as channel_module
import dsh_mloader_sdk.runtime as runtime_module

channel_module.PROTOCOL_VERSION = 99
runtime_module.PROTOCOL_VERSION = 99

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    pass
`
}

section('1. Frames from another version do not complete the handshake')
{
  const { logger, bootError } = await runInstance('foreign-version', foreignVersionBody())
  check('the boot does not complete', bootError !== undefined)
  check(
    'the mismatch is reported',
    logger.lines.some((line) => line.includes('protocol version 99')),
    logger.lines.join(' | '),
  )
  check(
    'the report names the version this loader speaks',
    logger.lines.some((line) => line.includes(`is not ${PROTOCOL_VERSION}`)),
    logger.lines.join(' | '),
  )
  check(
    'the mismatch is reported once',
    logger.lines.filter((line) => line.includes('protocol version 99')).length === 1,
    logger.lines.join(' | '),
  )
}

section('2. A plugin that speaks the current version still boots')
{
  const body = `
from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(name="versioned_tool", description="A tool from a matching version.")
    def versioned_tool(args):
        return {"ok": True}
`
  const { logger, bootError } = await runInstance('current-version', body)
  check('the boot completes', bootError === undefined, String(bootError))
  check(
    'no version complaint is logged',
    !logger.lines.some((line) => line.includes('protocol version')),
    logger.lines.join(' | '),
  )
}

await rm(root, { recursive: true, force: true })

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nPASS: ${passed} assertions`)
}
