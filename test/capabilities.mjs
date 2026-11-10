/**
 * Tests for the capability switches a manifest declares.
 *
 * A manifest may turn off any of the five capabilities. The loader reads those
 * switches at the registration channel, so the same rule covers a Python plugin
 * sending requests and a WebAssembly module returning declarations.
 */

import { Context } from '@deepseek-ai/cordis'
import { PluginRegistrar } from '../src/registrar.js'

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

const ALL = { tools: true, events: true, logger: true, effect: true, commands: true }

function makeRoot() {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('tools', { register: () => () => {} })
  const commands = []
  root.provide('commands', {
    register: (command) => {
      commands.push(command.name)
      return () => {}
    },
  })
  return { root, logger, commands }
}

function makeRegistrar(root, logger, capabilities) {
  const spec = {
    id: 'caps-test',
    name: 'caps-test',
    version: '1.0.0',
    backend: 'python',
    entry: '/tmp/entry.py',
    baseDir: '/tmp',
    manifestPath: '/tmp/mloader.plugin.json',
    enabled: true,
    inject: [],
    capabilities,
    timeouts: { startupMs: 1000, callMs: 1000 },
    env: {},
    declared: {},
  }
  return new PluginRegistrar(
    spec,
    root,
    logger,
    async () => ({}),
    async () => undefined,
  )
}

async function expectRejected(name, registrar, op, payload, pattern) {
  try {
    await registrar.handle(op, payload)
  } catch (error) {
    check(name, pattern.test(error.message), error.message)
    return
  }
  check(name, false, 'the operation was accepted')
}

async function accept(name, registrar, op, payload) {
  try {
    await registrar.handle(op, payload)
    check(name, true)
  } catch (error) {
    check(name, false, error.message)
  }
}

const TOOL = { tool: { name: 'demo_tool', description: 'A demo tool.' } }
const COMMAND = { command: { names: ['demo-cmd'], description: 'A demo command.' } }

section('1. Every switch defaults to enabled')
{
  const { root, logger } = makeRoot()
  const registrar = makeRegistrar(root, logger, { ...ALL })
  await accept('tools.register is accepted', registrar, 'tools.register', TOOL)
  await accept('events.on is accepted', registrar, 'events.on', { event: 'tools/execute' })
  await accept('logger.log is accepted', registrar, 'logger.log', { level: 'info', message: 'hi' })
  await accept('effect.register is accepted', registrar, 'effect.register', { label: 'cleanup' })
  await accept('commands.register is accepted', registrar, 'commands.register', COMMAND)
  registrar.dispose()
}

section('2. A disabled switch rejects its operation')
for (const [capability, op, payload] of [
  ['tools', 'tools.register', TOOL],
  ['events', 'events.on', { event: 'tools/execute' }],
  ['logger', 'logger.log', { level: 'info', message: 'hi' }],
  ['effect', 'effect.register', { label: 'cleanup' }],
  ['commands', 'commands.register', COMMAND],
]) {
  const { root, logger } = makeRoot()
  const registrar = makeRegistrar(root, logger, { ...ALL, [capability]: false })
  await expectRejected(
    `capabilities.${capability} = false rejects ${op}`,
    registrar,
    op,
    payload,
    new RegExp(`capabilities\\.${capability} as false`, 'u'),
  )
  check(`no ${capability} registration is recorded`, registrar.snapshot().registrations === 0,
    String(registrar.snapshot().registrations))
  registrar.dispose()
}

section('3. One disabled switch leaves the others alone')
{
  const { root, logger } = makeRoot()
  const registrar = makeRegistrar(root, logger, { ...ALL, tools: false })
  await expectRejected('tools are refused', registrar, 'tools.register', TOOL, /capabilities\.tools/u)
  await accept('events still work', registrar, 'events.on', { event: 'tools/execute' })
  await accept('logging still works', registrar, 'logger.log', { level: 'info', message: 'hi' })
  await accept('cleanup registration still works', registrar, 'effect.register', { label: 'cleanup' })
  registrar.dispose()
}

section('4. An unknown operation still names the whitelist')
{
  const { root, logger } = makeRoot()
  const registrar = makeRegistrar(root, logger, { ...ALL })
  await expectRejected('an unknown operation is rejected', registrar, 'tools.unregister', {}, /whitelist/u)
  registrar.dispose()
}

section('5. A closed ledger rejects a registration before the switch is read')
{
  const { root, logger } = makeRoot()
  const registrar = makeRegistrar(root, logger, { ...ALL, tools: false })
  registrar.dispose()
  await expectRejected('a disposed registrar refuses', registrar, 'tools.register', TOOL, /has been unloaded/u)
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nPASS: ${passed} assertions`)
}
