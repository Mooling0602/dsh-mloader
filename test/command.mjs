/**
 * Test for the /mloader command group.
 *
 * The test uses the real dsh CommandRuntime so registration, name validation,
 * descriptor resolution, async handler settlement and disposal are exercised as
 * they run in dsh. The lifecycle target is fake: this suite asserts command
 * dispatch, skip decisions and error mapping, while test/plugin-toggle.mjs
 * covers real hot loading.
 *
 * Covered:
 *   1. status list, with and without the explicit status word
 *   2. detail view for one plugin, including the error line
 *   3. unknown ids
 *   4. load on a loaded plugin skips without calling the target
 *   5. load on a disabled plugin calls enable
 *   6. unload on a loaded plugin calls disable
 *   7. unload on a disabled plugin skips without calling the target
 *   8. reload on a loaded plugin calls reload
 *   9. reload on a disabled plugin falls back to enable
 *   10. a rejected transition becomes an error result
 *   11. help and malformed input return the usage text
 *   12. reserved words take precedence over plugin ids
 *   13. invalid command name and missing commands service skip registration
 *   14. disposing the registration revokes the command
 */

import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import {
  COMMAND_NAME_PATTERN,
  DEFAULT_COMMAND_NAME,
  registerMloaderCommand,
} from '../src/commands/mloader.js'

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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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

/**
 * Build a test agent.
 *
 * CommandRuntime.execute appends command lifecycle events to the session, so the
 * agent needs a session with an append method.
 */
function makeAgent(id = 'test-agent') {
  const events = []
  return {
    id,
    session: {
      append(type, data) {
        events.push({ type, data })
        return undefined
      },
      events,
    },
  }
}

/** Build one controlled plugin snapshot. */
function makeSnapshot(overrides) {
  return {
    id: 'plugin',
    name: 'Plugin',
    version: '1.0.0',
    backend: 'python',
    state: 'applied',
    tools: [],
    events: [],
    registrations: 0,
    ...overrides,
  }
}

/**
 * Build a fake lifecycle target.
 *
 * The target records every transition call so tests can assert that a skipped
 * command did not touch it, and mutates its own snapshot map so the next command
 * sees the new state.
 */
function makeTarget(initial) {
  const calls = []
  const plugins = new Map(initial.map((plugin) => [plugin.id, { ...plugin }]))
  const failures = new Map()

  const copy = (plugin) => ({ ...plugin })

  return {
    calls,
    failEnable(id, message) {
      failures.set(`enable:${id}`, message)
    },
    list() {
      return [...plugins.values()].map(copy)
    },
    async enable(id) {
      calls.push({ op: 'enable', id })
      const failure = failures.get(`enable:${id}`)
      if (failure !== undefined) throw new Error(failure)
      const plugin = plugins.get(id)
      plugin.state = 'applied'
      plugin.tools = [`${id}_tool`]
      plugin.error = undefined
      return copy(plugin)
    },
    async disable(id) {
      calls.push({ op: 'disable', id })
      const plugin = plugins.get(id)
      plugin.state = 'disabled'
      plugin.tools = []
      plugin.events = []
      plugin.registrations = 0
      return copy(plugin)
    },
    async reload(id) {
      calls.push({ op: 'reload', id })
      const plugin = plugins.get(id)
      plugin.state = 'applied'
      plugin.tools = [`${id}_tool`]
      return copy(plugin)
    },
  }
}

/** Return the last transition the fake target recorded. */
function lastCall(target) {
  return target.calls[target.calls.length - 1]
}

/** Mount a real CommandRuntime and return its context. */
async function makeCommandsContext(logger) {
  const root = new Context()
  root.provide('logger', logger)
  root.plugin(CommandRuntime, {})
  await wait(250)
  return root
}

async function main() {
  const initial = [
    makeSnapshot({ id: 'alpha', name: 'Alpha', tools: ['alpha_tool'], events: ['tools/execute'], registrations: 2 }),
    makeSnapshot({ id: 'beta', name: 'Beta', state: 'disabled' }),
    makeSnapshot({ id: 'broken', name: 'Broken', state: 'failed', error: 'boot failed' }),
    makeSnapshot({ id: 'status', name: 'Status Named Plugin' }),
  ]

  section('1. The real commands service is ready')
  const logger = makeLogger()
  const root = await makeCommandsContext(logger)
  const commands = root.get('commands')
  check('commands service is available', commands !== undefined, typeof commands)
  check('commands.register is a function', typeof commands?.register === 'function')

  section('2. Registration and descriptor')
  const target = makeTarget(initial)
  const agent = makeAgent()
  const dispose = registerMloaderCommand(root, target, logger)

  check('default command name is mloader', DEFAULT_COMMAND_NAME === 'mloader', DEFAULT_COMMAND_NAME)
  check('command name matches the dsh rule', COMMAND_NAME_PATTERN.test(DEFAULT_COMMAND_NAME), DEFAULT_COMMAND_NAME)
  check('registerMloaderCommand returns a disposer', typeof dispose === 'function', typeof dispose)

  const definition = commands.find(agent, DEFAULT_COMMAND_NAME)
  check('the command is registered under its name', definition !== undefined)
  check('definition name is mloader', definition?.name === 'mloader', definition?.name)
  check(
    'description is the command group description',
    definition?.description === 'Manage the external plugins hosted by dsh-mloader.',
    definition?.description,
  )
  check(
    'input hint lists every form',
    definition?.input?.hint === '[status | <id> | load <id> | unload <id> | reload <id>]',
    definition?.input?.hint,
  )

  const run = async (input) => {
    const line = input.length > 0 ? `/${DEFAULT_COMMAND_NAME} ${input}` : `/${DEFAULT_COMMAND_NAME}`
    const result = await commands.execute(agent, line, [], new AbortController().signal)
    return result?.result
  }

  section('3. status lists every plugin')
  const listed = await run('')
  check('empty input returns success', listed?.kind === 'success', JSON.stringify(listed))
  check('list header reports the count', (listed?.text ?? '').includes('4 external plugin(s):'), listed?.text?.slice(0, 80))
  check('list names every plugin', ['alpha', 'beta', 'broken', 'status'].every((id) => (listed?.text ?? '').includes(`- ${id} (`)), listed?.text)
  check('list shows backend and state', (listed?.text ?? '').includes('- alpha (python, applied)'), listed?.text)

  const listedWithWord = await run('status')
  check('the status word returns the same list', listedWithWord?.kind === 'success' && listedWithWord?.text === listed?.text, JSON.stringify(listedWithWord?.kind))

  section('4. detail view for one plugin')
  const detail = await run('alpha')
  check('detail returns success', detail?.kind === 'success', JSON.stringify(detail))
  const detailText = detail?.text ?? ''
  check('detail includes the id', detailText.includes('Plugin alpha:'), detailText.slice(0, 80))
  check('detail includes the display name', detailText.includes('Name: Alpha'), detailText)
  check('detail includes the version', detailText.includes('Version: 1.0.0'), detailText)
  check('detail includes the backend', detailText.includes('Backend: python'), detailText)
  check('detail includes the loaded state', detailText.includes('State: applied (loaded)'), detailText)
  check('detail includes the tools', detailText.includes('Tools: alpha_tool'), detailText)
  check('detail includes the events', detailText.includes('Events: tools/execute'), detailText)
  check('detail includes the registration count', detailText.includes('Registrations: 2'), detailText)

  const detailDisabled = await run('beta')
  check('detail renders empty detail as none', (detailDisabled?.text ?? '').includes('Tools: none') && (detailDisabled?.text ?? '').includes('Events: none'), detailDisabled?.text)
  check('detail renders the not loaded state', (detailDisabled?.text ?? '').includes('State: disabled (not loaded)'), detailDisabled?.text)

  const detailBroken = await run('broken')
  check('detail renders the error line when present', (detailBroken?.text ?? '').includes('Error: boot failed'), detailBroken?.text)

  section('5. unknown ids')
  const unknownDetail = await run('ghost')
  check('unknown detail id returns an error', unknownDetail?.kind === 'error', JSON.stringify(unknownDetail))
  check('unknown detail text matches the contract', unknownDetail?.text === 'Unknown plugin "ghost".', unknownDetail?.text)

  const unknownLoad = await run('load ghost')
  check('unknown load id returns an error', unknownLoad?.kind === 'error' && unknownLoad?.text === 'Unknown plugin "ghost".', JSON.stringify(unknownLoad))
  const unknownUnload = await run('unload ghost')
  check('unknown unload id returns an error', unknownUnload?.kind === 'error' && unknownUnload?.text === 'Unknown plugin "ghost".', JSON.stringify(unknownUnload))
  const unknownReload = await run('reload ghost')
  check('unknown reload id returns an error', unknownReload?.kind === 'error' && unknownReload?.text === 'Unknown plugin "ghost".', JSON.stringify(unknownReload))
  check('unknown ids never reach the target', target.calls.length === 0, JSON.stringify(target.calls))

  section('6. load: skip when loaded, enable when not')
  const beforeSkip = target.calls.length
  const loadLoaded = await run('load alpha')
  check('load on a loaded plugin returns success', loadLoaded?.kind === 'success', JSON.stringify(loadLoaded))
  check('load on a loaded plugin skips with a clear message', (loadLoaded?.text ?? '').includes('is already loaded'), loadLoaded?.text)
  check('load on a loaded plugin does not call the target', target.calls.length === beforeSkip, JSON.stringify(target.calls))

  const loadDisabled = await run('load beta')
  check('load on a disabled plugin returns success', loadDisabled?.kind === 'success', JSON.stringify(loadDisabled))
  check('load calls enable for the plugin', JSON.stringify(lastCall(target)) === JSON.stringify({ op: 'enable', id: 'beta' }), JSON.stringify(lastCall(target)))
  check('load reports the new state', (loadDisabled?.text ?? '').includes('is now applied'), loadDisabled?.text)
  check('load reports the resulting tools', (loadDisabled?.text ?? '').includes('tools: beta_tool'), loadDisabled?.text)

  section('7. unload: skip when not loaded, disable when loaded')
  const unloadLoaded = await run('unload beta')
  check('unload on a loaded plugin returns success', unloadLoaded?.kind === 'success', JSON.stringify(unloadLoaded))
  check('unload calls disable for the plugin', JSON.stringify(lastCall(target)) === JSON.stringify({ op: 'disable', id: 'beta' }), JSON.stringify(lastCall(target)))
  check('unload reports the new state', (unloadLoaded?.text ?? '').includes('is now disabled'), unloadLoaded?.text)

  const beforeSkipUnload = target.calls.length
  const unloadDisabled = await run('unload beta')
  check('unload on a disabled plugin returns success', unloadDisabled?.kind === 'success', JSON.stringify(unloadDisabled))
  check('unload on a disabled plugin skips with a clear message', (unloadDisabled?.text ?? '').includes('is not loaded; nothing to unload'), unloadDisabled?.text)
  check('unload on a disabled plugin does not call the target', target.calls.length === beforeSkipUnload, JSON.stringify(target.calls))

  section('8. reload: reload when loaded, enable when not')
  const reloadLoaded = await run('reload alpha')
  check('reload on a loaded plugin returns success', reloadLoaded?.kind === 'success', JSON.stringify(reloadLoaded))
  check('reload calls reload for the plugin', JSON.stringify(lastCall(target)) === JSON.stringify({ op: 'reload', id: 'alpha' }), JSON.stringify(lastCall(target)))
  check('reload reports the new state', (reloadLoaded?.text ?? '').includes('is now applied'), reloadLoaded?.text)

  const reloadDisabled = await run('reload beta')
  check('reload on a disabled plugin returns success', reloadDisabled?.kind === 'success', JSON.stringify(reloadDisabled))
  check('reload falls back to enable', JSON.stringify(lastCall(target)) === JSON.stringify({ op: 'enable', id: 'beta' }), JSON.stringify(lastCall(target)))
  check('reload reports the resulting tools', (reloadDisabled?.text ?? '').includes('tools: beta_tool'), reloadDisabled?.text)

  section('9. a rejected transition becomes an error result')
  const failingTarget = makeTarget([makeSnapshot({ id: 'wasmish', name: 'Wasmish', backend: 'wasm', state: 'disabled' })])
  failingTarget.failEnable('wasmish', 'wasm backend is disabled (set config.wasm.enabled = true to opt in)')
  const failingRoot = await makeCommandsContext(makeLogger())
  registerMloaderCommand(failingRoot, failingTarget, makeLogger())
  const failingExecute = async (input) => {
    const result = await failingRoot.get('commands').execute(makeAgent(), `/mloader ${input}`, [], new AbortController().signal)
    return result?.result
  }
  const failedLoad = await failingExecute('load wasmish')
  check('enable failure returns an error result', failedLoad?.kind === 'error', JSON.stringify(failedLoad))
  check(
    'error result carries the thrown message',
    failedLoad?.text === 'wasm backend is disabled (set config.wasm.enabled = true to opt in)',
    failedLoad?.text,
  )

  section('10. help and malformed input return the usage text')
  const help = await run('help')
  check('help returns success', help?.kind === 'success', JSON.stringify(help))
  check('help includes the usage line', (help?.text ?? '').includes('Usage: /mloader'), help?.text)
  check(
    'help lists every form',
    ['status', '<id>', 'load <id>', 'unload <id>', 'reload <id>'].every((form) => (help?.text ?? '').includes(form)),
    help?.text,
  )

  const beforeMalformed = target.calls.length
  const statusExtra = await run('status extra')
  check('extra arguments after status return usage', statusExtra?.kind === 'error' && (statusExtra?.text ?? '').includes('Usage: /mloader'), JSON.stringify(statusExtra))
  const missingId = await run('load')
  check('a missing id returns usage', missingId?.kind === 'error' && (missingId?.text ?? '').includes('Usage: /mloader'), JSON.stringify(missingId))
  const unknownShape = await run('foo bar')
  check('an unknown shape returns usage', unknownShape?.kind === 'error' && (unknownShape?.text ?? '').includes('Usage: /mloader'), JSON.stringify(unknownShape))
  const tooMany = await run('load alpha extra')
  check('too many arguments return usage', tooMany?.kind === 'error' && (tooMany?.text ?? '').includes('Usage: /mloader'), JSON.stringify(tooMany))
  check('malformed input does not call the target', target.calls.length === beforeMalformed, JSON.stringify(target.calls))

  section('11. reserved words take precedence over plugin ids')
  const statusWord = await run('status')
  check('a bare status word lists plugins instead of selecting the plugin named status', (statusWord?.text ?? '').includes('external plugin(s)') && !(statusWord?.text ?? '').startsWith('Plugin status:'), statusWord?.text?.slice(0, 80))

  section('12. invalid command name is skipped')
  const invalidRoot = await makeCommandsContext(makeLogger())
  const invalidLogger = makeLogger()
  const invalidDispose = registerMloaderCommand(invalidRoot, makeTarget(initial), invalidLogger, 'Bad_Name!')
  check('invalid command name returns undefined', invalidDispose === undefined, typeof invalidDispose)
  check('invalid command name warning is logged', invalidLogger.lines.some((line) => line.includes('invalid command name')), invalidLogger.lines.join(' | '))
  check('invalid command name is not registered', invalidRoot.get('commands')?.find(makeAgent(), 'Bad_Name!') === undefined)

  section('13. missing commands service skips registration')
  const plainRoot = new Context()
  const plainLogger = makeLogger()
  plainRoot.provide('logger', plainLogger)
  let missingThrew = false
  let missingDispose
  try {
    missingDispose = registerMloaderCommand(plainRoot, makeTarget(initial), plainLogger)
  } catch {
    missingThrew = true
  }
  check('missing commands service does not throw', missingThrew === false)
  check('missing commands service returns undefined', missingDispose === undefined, typeof missingDispose)
  check('missing commands service is logged for diagnosis', plainLogger.lines.some((line) => line.includes('commands service is unavailable')), plainLogger.lines.join(' | '))

  const brokenRoot = new Context()
  const brokenLogger = makeLogger()
  brokenRoot.provide('logger', brokenLogger)
  brokenRoot.provide('commands', {})
  const brokenDispose = registerMloaderCommand(brokenRoot, makeTarget(initial), brokenLogger)
  check('a commands service without register returns undefined', brokenDispose === undefined, typeof brokenDispose)
  check('a commands service without register is logged as a warning', brokenLogger.lines.some((line) => line.includes('no register method')), brokenLogger.lines.join(' | '))

  section('14. disposal revokes the command')
  dispose()
  check('disposer removes the command', commands.find(agent, DEFAULT_COMMAND_NAME) === undefined)
  check('command is gone from the list', !commands.list(agent).some((entry) => entry.name === DEFAULT_COMMAND_NAME))

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS: ${passed} assertions`)
    process.exit(0)
  } else {
    console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\nTest script crashed:', error)
  process.exit(1)
})
