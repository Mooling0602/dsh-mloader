/**
 * Slash command registration for external plugins.
 *
 * The suite mounts the real dsh CommandRuntime and the loader, then executes
 * commands through the same surface a user uses. It covers the Python
 * registration channel, candidate fallback and the retreat rule when every
 * candidate is taken, the absent service degradation, a Python command timeout,
 * the WebAssembly declaration and command.call, failure convergence after a
 * WebAssembly command timeout, ledger revocation and the status output.
 *
 * The WebAssembly section needs the compiled command fixture. It skips that
 * section when the binary is absent; the Python section always runs.
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { format as formatStatus } from '../src/tools/status.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok: ${name}`)
  } else {
    failures.push(`${name}${detail ? ': ' + detail : ''}`)
    console.log(`  FAIL: ${name}${detail ? ': ' + detail : ''}`)
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

/** Build a test agent. The command runtime appends lifecycle events to its session. */
function makeAgent() {
  return {
    id: 'command-test',
    session: {
      append() {
        return undefined
      },
    },
  }
}

/** Execute one command line through the real command runtime. */
async function execute(commands, agent, line) {
  return await commands.execute(agent, line, [], new AbortController().signal)
}

/** Write one generated Python plugin into a temporary root. */
async function writePlugin(root, id, body, manifest = {}) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: '1.0.0',
      backend: 'python',
      entry: 'plugin.py',
      ...manifest,
    }),
  )
  await writeFile(join(dir, 'plugin.py'), body)
  return dir
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-command-'))
  const wasmDir = fileURLToPath(new URL('./fixtures/wasm-command', import.meta.url))
  const wasmAvailable = existsSync(join(wasmDir, 'command.wasm'))

  await writePlugin(tempRoot, 'command-a', `
from dsh_mloader_sdk import Context, plugin

@plugin
def apply(ctx: Context):
    @ctx.commands.register(names="shared", description="Shared command from A.")
    def shared(input):
        return "a"
`)
  await writePlugin(tempRoot, 'command-b', `
from dsh_mloader_sdk import Context, plugin

@plugin
def apply(ctx: Context):
    @ctx.commands.register(
        names=["shared", "shared-fallback"],
        description="Command B with a fallback name.",
    )
    def fallback(input):
        return "b"
`)
  await writePlugin(tempRoot, 'command-c', `
from dsh_mloader_sdk import Context, plugin

@plugin
def apply(ctx: Context):
    @ctx.commands.register(
        names=["shared", "shared-fallback"],
        description="Command C whose candidates are all taken.",
    )
    def taken(input):
        return "c"
`)
  await writePlugin(
    tempRoot,
    'python-command',
    `
import time
from dsh_mloader_sdk import Context, plugin

@plugin
def apply(ctx: Context):
    @ctx.commands.register(
        names="py-echo",
        description="Echo the command input.",
        input_hint="text",
    )
    def echo(input):
        if input.strip() == "fail":
            return {"kind": "error", "text": "requested failure"}
        return {"kind": "success", "text": f"echo[{input}]"}

    @ctx.commands.register(names=["py-second"], description="Second command.")
    def second(input):
        return "second"

    @ctx.commands.register(names="py-slow", description="Slow command.")
    def slow(input):
        time.sleep(1)
        return {"kind": "success", "text": "slow done"}
`,
    { timeouts: { startupMs: 10000, callMs: 400 } },
  )

  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  root.plugin(CommandRuntime, {})
  await sleep(300)

  const commands = root.get('commands')
  check('the real commands service is available', commands !== undefined, typeof commands)
  const agent = makeAgent()

  const roots = [tempRoot, ...(wasmAvailable ? [wasmDir] : [])]
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots,
      pythonBin: 'python3',
      wasm: { enabled: wasmAvailable },
      profilePlugins: false,
      seedExamples: false,
      console: false,
      watch: false,
      statusTool: false,
      command: false,
    },
  )

  const expected = 4 + (wasmAvailable ? 1 : 0)
  await waitFor('plugins settle', () => {
    const entries = root.get('mloader')?.list() ?? []
    return entries.length === expected &&
      entries.every((entry) => entry.state !== 'loaded' && entry.state !== 'discovered')
  })
  const loader = root.get('mloader')
  const stateOf = (id) => loader.list().find((plugin) => plugin.id === id)

  section('1. A Python plugin registers commands and runs them')
  check('python-command is applied', stateOf('python-command')?.state === 'applied', JSON.stringify(stateOf('python-command')))
  const pythonCommands = stateOf('python-command')?.commands ?? []
  check(
    'the snapshot lists the registered names',
    ['py-echo', 'py-second', 'py-slow'].every((name) => pythonCommands.includes(name)),
    JSON.stringify(pythonCommands),
  )
  check(
    'the command service resolves the command and its hint',
    commands.find(agent, 'py-echo')?.description === 'Echo the command input.' &&
      commands.find(agent, 'py-echo')?.input?.hint === 'text',
    JSON.stringify(commands.find(agent, 'py-echo')),
  )
  const echo = await execute(commands, agent, '/py-echo  hello world')
  check('the command succeeds', echo?.result?.kind === 'success', JSON.stringify(echo))
  check(
    'the raw input reaches the handler verbatim',
    echo?.result?.text === 'echo[  hello world]',
    JSON.stringify(echo?.result),
  )
  const failed = await execute(commands, agent, '/py-echo fail')
  check(
    'a plugin error result is preserved',
    failed?.result?.kind === 'error' && failed?.result?.text === 'requested failure',
    JSON.stringify(failed?.result),
  )
  const second = await execute(commands, agent, '/py-second')
  check(
    'a returned string becomes a successful text result',
    second?.result?.kind === 'success' && second?.result?.text === 'second',
    JSON.stringify(second?.result),
  )

  section('2. Candidate names are tried in order and the existing command wins')
  const commandA = stateOf('command-a')
  const commandB = stateOf('command-b')
  const commandC = stateOf('command-c')
  check(
    'the three fillers are applied',
    [commandA, commandB, commandC].every((plugin) => plugin?.state === 'applied'),
    JSON.stringify([commandA?.state, commandB?.state, commandC?.state]),
  )
  check('A registered the first candidate', commandA?.commands.includes('shared'), JSON.stringify(commandA?.commands))
  check(
    'B fell back to its second candidate',
    commandB?.commands.includes('shared-fallback') && !commandB?.commands.includes('shared'),
    JSON.stringify(commandB?.commands),
  )
  check('C stayed applied without a command', commandC?.commands.length === 0, JSON.stringify(commandC?.commands))
  check(
    'the retreat is logged',
    logger.lines.some((line) => line.includes('every candidate name')),
    logger.lines.slice(-10).join(' | '),
  )
  const shared = await execute(commands, agent, '/shared')
  check('the existing command still belongs to A', shared?.result?.text === 'a', JSON.stringify(shared?.result))
  const fallback = await execute(commands, agent, '/shared-fallback')
  check('the fallback name runs B', fallback?.result?.text === 'b', JSON.stringify(fallback?.result))

  section('3. A missing commands service skips commands without failing the plugin')
  const plainRoot = new Context()
  const plainLogger = makeLogger()
  plainRoot.provide('logger', plainLogger)
  plainRoot.provide('systemPrompt', systemPromptStub())
  plainRoot.plugin(ToolRuntime, {})
  await sleep(300)
  const plainFiber = plainRoot.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots: [tempRoot],
      pythonBin: 'python3',
      profilePlugins: false,
      seedExamples: false,
      console: false,
      watch: false,
      statusTool: false,
      command: false,
    },
  )
  await waitFor('plain loader settles', () => {
    const entries = plainRoot.get('mloader')?.list() ?? []
    return entries.length === 4 &&
      entries.every((entry) => entry.state !== 'loaded' && entry.state !== 'discovered')
  })
  const plainList = plainRoot.get('mloader').list()
  check(
    'plugins still apply without a commands service',
    plainList.every((plugin) => plugin.state === 'applied'),
    JSON.stringify(plainList.map((plugin) => `${plugin.id}:${plugin.state}`)),
  )
  check('no command is listed', plainList.every((plugin) => plugin.commands.length === 0), JSON.stringify(plainList.map((plugin) => plugin.commands)))
  check(
    'the skip is logged',
    plainLogger.lines.some((line) => line.includes('commands service is unavailable')),
    plainLogger.lines.slice(-10).join(' | '),
  )
  await plainFiber.dispose()
  await sleep(600)

  section('4. A Python command timeout fails the command and keeps the process')
  const slowStarted = Date.now()
  const slow = await execute(commands, agent, '/py-slow')
  const slowElapsed = Date.now() - slowStarted
  check('the slow command returns an error result', slow?.result?.kind === 'error', JSON.stringify(slow?.result))
  check('the error names the deadline', /timed out/i.test(slow?.result?.text ?? ''), slow?.result?.text)
  check('the deadline uses callMs=400', slowElapsed < 4000, `${slowElapsed}ms`)
  await sleep(1200)
  check('the plugin stayed applied', stateOf('python-command')?.state === 'applied', JSON.stringify(stateOf('python-command')))
  const afterSlow = await execute(commands, agent, '/py-echo ok')
  check(
    'a later command still runs',
    afterSlow?.result?.kind === 'success' && afterSlow?.result?.text === 'echo[ ok]',
    JSON.stringify(afterSlow?.result),
  )

  if (wasmAvailable) {
    section('5. A WebAssembly plugin declares commands and dispatches command.call')
    const wasm = stateOf('wasm-command')
    check('wasm-command is applied', wasm?.state === 'applied', JSON.stringify(wasm))
    check(
      'the first candidate is registered',
      wasm?.commands.includes('wasm-command-hello'),
      JSON.stringify(wasm?.commands),
    )
    check('the unused candidate is not registered', !wasm?.commands.includes('wasm-command-hi'))
    const hello = await execute(commands, agent, '/wasm-command-hello Ada')
    check(
      'the wasm command succeeds',
      hello?.result?.kind === 'success' && hello?.result?.text === 'hello Ada',
      JSON.stringify(hello?.result),
    )
    const wasmError = await execute(commands, agent, '/wasm-command-hello error')
    check(
      'the wasm error result is preserved',
      wasmError?.result?.kind === 'error' && wasmError?.result?.text === 'wasm command error',
      JSON.stringify(wasmError?.result),
    )

    section('6. A WebAssembly command timeout converges on the failed plugin')
    const loopStarted = Date.now()
    const loop = await execute(commands, agent, '/wasm-command-loop')
    const loopElapsed = Date.now() - loopStarted
    check('the looping command returns an error result', loop?.result?.kind === 'error', JSON.stringify(loop?.result))
    check('the command deadline is used', loopElapsed < 4000, `${loopElapsed}ms`)
    await waitFor('wasm-command failed', () => stateOf('wasm-command')?.state === 'failed')
    const failedWasm = stateOf('wasm-command')
    check('the plugin is failed after the worker termination', failedWasm?.state === 'failed')
    check('the failed record names the timeout', /timeout|timed out/i.test(failedWasm?.error ?? ''), failedWasm?.error)
    check('the commands are revoked', commands.find(agent, 'wasm-command-hello') === undefined)
    const reloaded = await loader.reload('wasm-command')
    check('the reloaded plugin is applied', reloaded.state === 'applied', JSON.stringify(reloaded))
    check(
      'the command is registered again',
      reloaded.commands.includes('wasm-command-hello'),
      JSON.stringify(reloaded.commands),
    )
    const afterReload = await execute(commands, agent, '/wasm-command-hello again')
    check('the command runs after the reload', afterReload?.result?.text === 'hello again', JSON.stringify(afterReload?.result))
  } else {
    console.log('\nskip: the WebAssembly section needs test/fixtures/wasm-command/command.wasm')
    console.log('   run test/fixtures/wasm-command/build.sh to build it.')
  }

  section('7. Disabling a plugin revokes its commands and enabling restores them')
  const disabled = await loader.disable('python-command')
  check('disable leaves the plugin disabled', disabled.state === 'disabled', JSON.stringify(disabled))
  check('the disabled plugin lists no commands', disabled.commands.length === 0, JSON.stringify(disabled.commands))
  check('the command service no longer resolves the command', commands.find(agent, 'py-echo') === undefined)
  const enabled = await loader.enable('python-command')
  check('enable restores the plugin', enabled.state === 'applied', JSON.stringify(enabled))
  check('the command is registered again', enabled.commands.includes('py-echo'), JSON.stringify(enabled.commands))
  const restored = await execute(commands, agent, '/py-echo back')
  check('the restored command runs', restored?.result?.text === 'echo[ back]', JSON.stringify(restored?.result))

  section('8. The status surface reports the commands')
  const statusText = formatStatus({ plugins: loader.list() })
  check('the status text lists the command names', statusText.includes('commands=[py-echo'), statusText)

  section('9. The loader disposes cleanly')
  await loaderFiber.dispose()
  await sleep(800)
  check('the Python command is gone', commands.find(agent, 'py-echo') === undefined)
  if (wasmAvailable) {
    check('the WebAssembly command is gone', commands.find(agent, 'wasm-command-hello') === undefined)
  }
  await rm(tempRoot, { recursive: true, force: true }).catch(() => {})

  if (failures.length === 0) {
    console.log(`\nAll passed: ${passed} assertions`)
    process.exit(0)
  }
  console.log(`\n${failures.length} failed out of ${passed + failures.length}`)
  for (const failure of failures) console.log(`   - ${failure}`)
  console.log('\nRelated log lines:')
  for (const line of logger.lines.slice(-60)) console.log(`   ${line}`)
  process.exit(1)
}

main().catch((error) => {
  console.error('\nTest script failed:', error)
  process.exit(1)
})
