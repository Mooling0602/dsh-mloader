/**
 * Encoding suite.
 *
 * The backend encodes requests and decodes both output streams as UTF-8, so the
 * child must use the same codec no matter what its environment says. An
 * inherited `PYTHONIOENCODING`, or an ASCII locale with the UTF-8 mode disabled,
 * would otherwise select another codec and the first non-ASCII character would
 * raise inside a read or a write.
 *
 * The suite pins the normalization against a manifest that sets
 * `PYTHONIOENCODING` to ASCII, which keeps the assertion independent of the
 * environment that runs it.
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
    passed++
    console.log(`  PASS ${name}`)
  } else {
    failures.push(`${name}${detail ? `: ${detail}` : ''}`)
    console.log(`  FAIL ${name}${detail ? `: ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

const tick = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/** Poll until the predicate holds or the deadline passes. */
async function waitFor(predicate, timeoutMs = 15000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(intervalMs)
  }
  return predicate()
}

function makeLogger() {
  const logger = (..._args) => logger
  for (const level of ['debug', 'info', 'warn', 'error']) logger[level] = () => {}
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

/** The plugin source the suite installs. */
const PLUGIN_SOURCE = `"""Plugin used by the encoding suite."""

from dsh_mloader_sdk import plugin


@plugin
def apply(ctx):
    @ctx.tools.register(name="echo_text", description="Return the text it is given")
    def echo_text(args) -> dict:
        return {"text": args.get("text")}

    @ctx.tools.register(name="noisy_apply", description="Print a non-ASCII diagnostic")
    def noisy_apply(_args) -> dict:
        print("\u4e2d\u6587 diagnostic from the plugin")
        return {"ok": True}

    @ctx.tools.register(name="echo_after_noise", description="Prove the channel still works")
    def echo_after_noise(_args) -> dict:
        return {"text": "still here"}
`

/** Mount the loader on a fresh context with one temporary plugin root. */
async function mountLoader(rootPath) {
  const root = new Context()
  root.provide('logger', makeLogger())
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await tick(200)
  const tools = root.get('tools')
  const fiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots: [rootPath],
      profilePlugins: false,
      seedExamples: false,
      console: false,
      pythonBin: 'python3',
      watch: false,
    },
  )
  return { root, tools, fiber }
}

async function main() {
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-encoding-'))
  const pluginRoot = join(tempRoot, 'plugins')
  try {
    const pluginDir = join(pluginRoot, 'encoding-demo')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'encoding-demo',
        name: 'Encoding demo',
        version: '1.0.0',
        backend: 'python',
        entry: 'plugin.py',
        enabled: true,
        inject: ['tools'],
        // Forces the codec the normalization has to override.
        env: { PYTHONIOENCODING: 'ascii' },
      }, null, 2),
    )
    await writeFile(join(pluginDir, 'plugin.py'), PLUGIN_SOURCE)

    const { root, tools, fiber } = await mountLoader(pluginRoot)
    try {
      const mounted = await waitFor(() => (root.get('mloader')?.list() ?? [])
        .some((plugin) => plugin.id === 'encoding-demo' && plugin.state === 'applied'))
      check('the plugin mounts with PYTHONIOENCODING set to ascii', mounted,
        JSON.stringify(root.get('mloader')?.list() ?? []))

      /** Run one tool call, reporting a thrown error as a failed assertion. */
      const call = async (name, args) => {
        try {
          return { value: await tools.get(name).execute(args) }
        } catch (error) {
          return { error: error instanceof Error ? error.message : String(error) }
        }
      }

      section('1. A non-ASCII value crosses the boundary in both directions')
      const echoed = await call('echo_text', { text: '\u4e2d\u6587' })
      check('the request decodes and the reply re-encodes', echoed.value?.text === '\u4e2d\u6587',
        echoed.error ?? JSON.stringify(echoed.value))

      section('2. A stray non-ASCII diagnostic does not break the channel')
      const noisy = await call('noisy_apply', {})
      check('the call succeeds', noisy.value?.ok === true, noisy.error ?? JSON.stringify(noisy.value))
      const after = await call('echo_after_noise', {})
      check('the next call still round trips', after.value?.text === 'still here',
        after.error ?? JSON.stringify(after.value))
    } finally {
      await fiber.dispose()
      await tick(400)
    }

    console.log('')
    if (failures.length === 0) {
      console.log(`PASS: ${passed} assertions`)
      process.exitCode = 0
    } else {
      console.log(`FAIL: ${failures.length} of ${passed + failures.length} assertions`)
      for (const failure of failures) console.log(`  - ${failure}`)
      process.exitCode = 1
    }
  } finally {
    await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
