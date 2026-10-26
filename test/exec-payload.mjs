/**
 * Regression test: host objects cross the process boundary safely.
 *
 * The properties asserted here:
 *   1. A payload with a reference cycle and an AbortSignal serialises through
 *      the projection instead of throwing.
 *   2. A tool call still works after a dirty event payload was delivered.
 *   3. The plugin receives projected plain data, not live host objects.
 *   4. One frame that cannot be serialised does not close the channel.
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import {
  MAX_DEPTH,
  projectEventArgs,
  projectToolExecution,
  toTransportable,
} from '../src/serialize.js'

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

function withTimeout(promise, ms, label) {
  let timer = null
  const guard = new Promise((_resolve, reject) => {
    timer = setTimeout(
      () => reject(new Error(`${label} did not return within ${ms}ms; the channel looks broken`)),
      ms,
    )
  })
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer))
}

/**
 * Build a payload as dangerous as the real dsh exec object: a cyclic agent
 * tree, a real AbortSignal, a function and a value deeper than the projection
 * limit.
 */
function makeHostileExec() {
  const controller = new AbortController()
  const agent = { id: 'agent-1', name: 'main', kind: 'root' }
  agent.self = agent
  agent.ctx = { fiber: { scope: { agent } } }
  return {
    callId: 'call-1',
    name: 'exec_ping',
    arguments: { marker: 'first' },
    agent,
    signal: controller.signal,
    fn: () => 'not serializable',
    nested: { deep: { deeper: { deepest: { evenDeeper: { tooDeep: { way: { too: { far: 1 } } } } } } } },
  }
}

async function main() {
  section('1. Projection: cycles, AbortSignal, functions and depth')

  const hostile = makeHostileExec()
  let projected
  let serializeError = null
  try {
    projected = toTransportable(hostile)
  } catch (error) {
    serializeError = error
  }
  check('projection does not throw', serializeError === null, serializeError?.message)

  let jsonText = null
  try {
    jsonText = JSON.stringify(projected)
  } catch (error) {
    serializeError = error
  }
  check('projected value can be JSON.stringify-ed', jsonText !== null, serializeError?.message)
  check('projected value can be structuredClone-d', (() => {
    try {
      structuredClone(projected)
      return true
    } catch {
      return false
    }
  })())

  const plainJson = (() => {
    try {
      JSON.stringify(hostile)
      return true
    } catch {
      return false
    }
  })()
  check('control: the raw object is not serialisable (fixture is dangerous)', plainJson === false)

  const agentProjection = projected.agent
  check('cycle is marked as [Circular]', agentProjection?.self === '[Circular]', JSON.stringify(agentProjection))
  check('AbortSignal is projected to a $type', projected.signal?.$type === 'AbortSignal', JSON.stringify(projected.signal))
  check('AbortSignal keeps the aborted state', projected.signal?.aborted === false, JSON.stringify(projected.signal))
  check('function is marked instead of dropped', projected.fn === '[Function]', JSON.stringify(projected.fn))
  check('excessive depth is truncated', JSON.stringify(projected.nested).includes('MaxDepth'), JSON.stringify(projected.nested))

  const { proxy: revoked, revoke } = Proxy.revocable({}, {})
  revoke()
  const hostileHostObjects = {
    'revoked proxy': revoked,
    'throwing getter': { get boom() { throw new Error('nope') } },
    'proxy with throwing ownKeys': new Proxy({}, { ownKeys() { throw new Error('keys') } }),
    'NaN and Infinity': { a: NaN, b: Infinity },
    'symbol key': { [Symbol('s')]: 1, a: 2 },
  }
  for (const [label, value] of Object.entries(hostileHostObjects)) {
    let ok = true
    let snapshot
    try {
      snapshot = JSON.stringify(toTransportable(value))
    } catch (error) {
      ok = false
      snapshot = error.message
    }
    check(`projection survives ${label}`, ok, snapshot?.slice(0, 120))
  }

  const execProjection = projectToolExecution(hostile)
  check('exec projection keeps the name', execProjection.name === 'exec_ping', JSON.stringify(execProjection))
  check('exec projection keeps the arguments', execProjection.arguments?.marker === 'first', JSON.stringify(execProjection))
  check('exec projection carries $type', execProjection.$type === 'ToolExecution', JSON.stringify(execProjection))
  check(
    'exec projection does not expose the agent tree',
    Object.keys(execProjection.agent ?? {}).length <= 4,
    JSON.stringify(execProjection.agent),
  )
  check('exec projection has no usable signal object', execProjection.signal === undefined, JSON.stringify(execProjection.signal))
  check('exec projection can be JSON.stringify-ed', (() => {
    try {
      JSON.stringify(execProjection)
      return true
    } catch {
      return false
    }
  })())
  check(`exec projection is far smaller than the generic one (depth limit ${MAX_DEPTH})`, JSON.stringify(execProjection).length < 2000,
    `${JSON.stringify(execProjection).length} chars`)

  const projectedArgs = projectEventArgs('tools/execute', [hostile, 'tail'])
  check('projectEventArgs projects the first argument as an exec', projectedArgs[0]?.$type === 'ToolExecution', JSON.stringify(projectedArgs[0]))
  check('projectEventArgs keeps later arguments', projectedArgs[1] === 'tail', JSON.stringify(projectedArgs[1]))
  check('projectEventArgs result is serialisable', (() => {
    try {
      JSON.stringify(projectedArgs)
      return true
    } catch {
      return false
    }
  })())

  section('2. Real Python subprocess: tools still work after a dirty payload')

  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', {
    section: () => () => {},
    context: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    suppressRuntimeContext: () => () => {},
    refreshContext: (assembly) => assembly,
    assemble: async () => ({ sections: [] }),
  })
  root.plugin(ToolRuntime, {})
  await new Promise((resolve) => setTimeout(resolve, 200))

  const roots = [new URL('./exec-payload', import.meta.url).pathname]
  root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots, pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const loader = root.get('mloader')
  const record = loader?.list().find((plugin) => plugin.id === 'py-exec-observer')
  check('fixture plugin is applied', record?.state === 'applied', JSON.stringify(record))
  check('fixture subscribes to tools/execute', (record?.events ?? []).includes('tools/execute'), JSON.stringify(record?.events))

  const tools = root.get('tools')
  const pingDef = tools.get('exec_ping')
  check('exec_ping is registered', pingDef !== undefined)
  check('exec_describe is registered', tools.get('exec_describe') !== undefined)

  const before = await withTimeout(pingDef.execute({ marker: 'before' }), 8000, 'exec_ping(before)')
  check('tool works before the event is triggered', before?.marker === 'before', JSON.stringify(before)?.slice(0, 300))

  const hostileExec = makeHostileExec()
  let dispatchError = null
  let chainResult
  try {
    chainResult = await withTimeout(
      root.waterfall({}, 'tools/execute', hostileExec, async () => 'body-result'),
      8000,
      'waterfall(tools/execute, hostile exec)',
    )
  } catch (error) {
    dispatchError = error
  }
  check('waterfall with a cyclic exec does not throw', dispatchError === null, dispatchError?.message)
  check('chain is intact (body result returned)', chainResult === 'body-result', JSON.stringify(chainResult))

  await new Promise((resolve) => setTimeout(resolve, 500))

  let after
  let afterError = null
  const t0 = Date.now()
  try {
    after = await withTimeout(pingDef.execute({ marker: 'after' }), 8000, 'exec_ping(after)')
  } catch (error) {
    afterError = error
  }
  const elapsed = Date.now() - t0

  check('tool call still succeeds after the dirty payload', afterError === null, afterError?.message)
  check('tool returns the right content', after?.marker === 'after', JSON.stringify(after)?.slice(0, 300))
  check('call takes milliseconds instead of the call timeout', elapsed < 2000, `${elapsed}ms`)

  section('3. The plugin receives projected plain data')

  let describe
  let describeError = null
  try {
    describe = await withTimeout(tools.get('exec_describe').execute({}), 8000, 'exec_describe')
  } catch (error) {
    describeError = error
  }
  check('exec_describe call succeeds', describeError === null, describeError?.message)

  const received = describe?.received
  check('plugin actually received the event', Array.isArray(received) && received.length > 0,
    JSON.stringify(received)?.slice(0, 300))

  const first = Array.isArray(received) ? received[0] : undefined
  check('first received argument carries $type=ToolExecution', first?.$type === 'ToolExecution', JSON.stringify(first)?.slice(0, 300))
  check('received name is correct', first?.name === 'exec_ping', JSON.stringify(first?.name))
  check('received arguments are correct', first?.arguments?.marker === 'first', JSON.stringify(first?.arguments))
  check(
    'plugin did not receive a live host object',
    isPlainData(first),
    JSON.stringify(first)?.slice(0, 400),
  )

  section('4. One failed frame does not close the channel')

  const stillApplied = loader.list().find((plugin) => plugin.id === 'py-exec-observer')
  check('fixture is still applied', stillApplied?.state === 'applied', JSON.stringify(stillApplied))
  check(
    'event subscription is still active',
    (stillApplied?.events ?? []).includes('tools/execute'),
    JSON.stringify(stillApplied?.events),
  )

  let repeat
  let repeatError = null
  try {
    repeat = await withTimeout(pingDef.execute({ marker: 'repeat' }), 8000, 'exec_ping(repeat)')
  } catch (error) {
    repeatError = error
  }
  check('repeated call still works (channel is reusable)', repeatError === null && repeat?.marker === 'repeat',
    repeatError?.message ?? JSON.stringify(repeat)?.slice(0, 300))

  console.log('')
  if (failures.length === 0) {
    console.log(`PASS: ${passed} assertions`)
  } else {
    console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
    for (const failure of failures) console.log(`  - ${failure}`)
    process.exitCode = 1
  }
}

/** Assert that a value has no cycle, no function and no live AbortSignal. */
function isPlainData(value, seen = new Set()) {
  if (value === null || value === undefined) return true
  const type = typeof value
  if (type === 'string' || type === 'number' || type === 'boolean') return true
  if (type === 'function') return false
  if (seen.has(value)) return false
  seen.add(value)
  if (typeof value === 'object') {
    if (typeof value.addEventListener === 'function' && typeof value.aborted === 'boolean') return false
    for (const key of Object.keys(value)) {
      if (!isPlainData(value[key], seen)) return false
    }
  }
  return true
}

main().then(
  () => process.exit(process.exitCode ?? 0),
  (error) => {
    console.error('\nTest script crashed:', error)
    process.exit(1)
  },
)
