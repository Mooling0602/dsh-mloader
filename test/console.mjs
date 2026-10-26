/**
 * Terminal output test.
 *
 * Verifies the console channel contract:
 *   1. Lifecycle lines are printed by default.
 *   2. Detail lines are printed only in verbose mode.
 *   3. `console: false` silences every level.
 *   4. A failing write (EPIPE and similar) never breaks the loader.
 *
 * The terminal is the operator's only observation channel for hosted plugins,
 * so these properties are part of the contract rather than a convenience.
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { createConsole } from '../src/console.js'

const failures = []
let passed = 0

/**
 * Reference to the real stdout.
 *
 * captureConsole replaces console.log, while check() reports through
 * console.log. Keeping the original reference here means assertion results are
 * never swallowed by the active capture.
 */
const report = console.log.bind(console)

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    report(`  ok   ${name}`)
  } else {
    failures.push(detail ? `${name} [${detail}]` : name)
    report(`  FAIL ${name}${detail ? ` [${detail}]` : ''}`)
  }
}

const section = (title) => report(`\n${title}`)

/** Replace console.log with a collector and return the captured lines. */
function captureConsole() {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.map((arg) => (typeof arg === 'string' ? arg : String(arg))).join(' '))
  }
  return {
    lines,
    restore() {
      console.log = original
    },
  }
}

/** Build the minimal systemPrompt stub the tool runtime needs. */
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

async function main() {
  section('1. Lifecycle output at the default level')
  {
    const capture = captureConsole()
    const out = createConsole({})
    out.lifecycle('mounted py-hello')
    out.lifecycle('unloaded py-hello')
    capture.restore()

    check('lifecycle writes two lines', capture.lines.length === 2, `actual ${capture.lines.length}`)
    check('lines carry the [mloader] prefix', capture.lines[0]?.startsWith('[mloader] '), capture.lines[0])
    check('line content is complete', capture.lines[0]?.includes('mounted py-hello'), capture.lines[0])
  }

  section('2. detail is silent by default and printed in verbose mode')
  {
    const defaultCapture = captureConsole()
    const defaultOut = createConsole({})
    defaultOut.detail('scanned 1 root')
    defaultCapture.restore()
    check('default level drops detail lines', defaultCapture.lines.length === 0, `actual ${defaultCapture.lines.length}`)

    const verboseCapture = captureConsole()
    const verboseOut = createConsole({ console: 'verbose' })
    verboseOut.detail('scanned 1 root')
    verboseCapture.restore()
    check('verbose level prints detail lines', verboseCapture.lines.length === 1, `actual ${verboseCapture.lines.length}`)
    check('verbose content is complete', verboseCapture.lines[0]?.includes('scanned 1 root'), verboseCapture.lines[0])
  }

  section('3. console: false is completely silent')
  {
    const capture = captureConsole()
    const out = createConsole({ console: false })
    out.lifecycle('mounted x')
    out.detail('detail')
    out.warn('warning')
    out.error('error')
    capture.restore()
    check('no level writes anything', capture.lines.length === 0, `actual ${capture.lines.length}`)
    check('enabled flag is false', out.enabled === false)
  }

  section('4. warn and error carry a level marker')
  {
    const capture = captureConsole()
    const out = createConsole({})
    out.warn('profile directory not detected')
    out.error('load failed: entry does not exist')
    capture.restore()

    check('warn line carries the warn marker', capture.lines[0]?.includes('warn:'), capture.lines[0])
    check('error line carries the error marker', capture.lines[1]?.includes('error:'), capture.lines[1])
    check('warn content is kept', capture.lines[0]?.includes('profile directory not detected'))
    check('error content is kept', capture.lines[1]?.includes('entry does not exist'))
  }

  section('5. A failing write does not throw (EPIPE guard)')
  {
    const out = createConsole({})
    const original = console.log
    console.log = () => {
      throw new Error('EPIPE')
    }
    let threw = false
    try {
      out.lifecycle('mounted x')
      out.warn('warning')
      out.error('error')
    } catch {
      threw = true
    }
    console.log = original
    check('console write failure is swallowed', threw === false)
  }

  section('6. Real loader: output on mount and on unload')
  {
    const capture = captureConsole()
    const root = new Context()
    const logger = (..._args) => logger
    Object.assign(logger, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
    root.provide('logger', logger)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [new URL('./plugins', import.meta.url).pathname],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const mountLines = capture.lines.filter((line) => line.includes('[mloader]'))
    check('mounting writes to the terminal', mountLines.length > 0, `actual ${mountLines.length}`)
    check(
      'mount output mentions py-hello',
      mountLines.some((line) => line.includes('py-hello')),
      mountLines.join(' | '),
    )
    check(
      'a ready summary line is printed',
      mountLines.some((line) => line.includes('ready')),
      mountLines.join(' | '),
    )

    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))

    const unloadLines = capture.lines.filter((line) => line.includes('unloaded'))
    check('unloading writes to the terminal', unloadLines.length > 0, `actual ${unloadLines.length}`)
    check(
      'the final unloaded line is printed',
      capture.lines.some((line) => line.trim() === '[mloader] unloaded'),
      capture.lines.slice(-3).join(' | '),
    )
    capture.restore()
  }

  section('7. Real loader: console: false is silent')
  {
    const capture = captureConsole()
    const root = new Context()
    const logger = (..._args) => logger
    Object.assign(logger, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
    root.provide('logger', logger)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [new URL('./plugins', import.meta.url).pathname],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
        console: false,
      },
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))
    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))
    capture.restore()

    const mloaderLines = capture.lines.filter((line) => line.includes('[mloader]'))
    check('console:false writes nothing', mloaderLines.length === 0, `actual ${mloaderLines.length}`)
  }

  console.log('')
  if (failures.length === 0) {
    report(`PASS: ${passed} assertions`)
    process.exit(0)
  } else {
    report(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
    for (const failure of failures) report(`  - ${failure}`)
    process.exit(1)
  }
}

main().catch((error) => {
  report(`Test script crashed: ${error?.stack ?? error}`)
  process.exit(1)
})
