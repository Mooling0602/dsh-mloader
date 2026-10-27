/**
 * Output inference suite.
 *
 * A tool that declares no `output` schema inherits the host default, an object
 * schema, which rejects a handler returning a bare string or number. The Python
 * runtime closes that gap by deriving a schema from the handler's return
 * annotation.
 *
 * The suite pins the whole contract: every supported annotation shape maps to the
 * expected schema, an explicit `output` argument wins over the annotation, and a
 * handler without an annotation keeps the host default. It also asserts the
 * inference holds for the declarative `@tool` style, which builds its payload on a
 * different code path than `ctx.tools.register`.
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

/** The plugin source the suite installs, one tool per annotation shape. */
const PLUGIN_SOURCE = `"""Plugin used by the output inference suite."""

from typing import Any, Optional, Union

from dsh_mloader_sdk import plugin, tool


@plugin
def apply(ctx):
    @ctx.tools.register(name="anno_str", description="str annotation")
    def anno_str(_args) -> str:
        return "Hello, world!"

    @ctx.tools.register(name="anno_int", description="int annotation")
    def anno_int(_args) -> int:
        return 42

    @ctx.tools.register(name="anno_float", description="float annotation")
    def anno_float(_args) -> float:
        return 1.5

    @ctx.tools.register(name="anno_bool", description="bool annotation")
    def anno_bool(_args) -> bool:
        return True

    @ctx.tools.register(name="anno_dict", description="dict annotation")
    def anno_dict(_args) -> dict:
        return {"ok": True}

    @ctx.tools.register(name="anno_list", description="list annotation")
    def anno_list(_args) -> list:
        return [1, 2]

    @ctx.tools.register(name="anno_list_str", description="list[str] annotation")
    def anno_list_str(_args) -> list[str]:
        return ["a", "b"]

    @ctx.tools.register(name="anno_optional", description="Optional[str] annotation")
    def anno_optional(_args) -> Optional[str]:
        return "present"

    @ctx.tools.register(name="anno_union", description="Union[str, int] annotation")
    def anno_union(_args) -> Union[str, int]:
        return "either"

    @ctx.tools.register(
        name="anno_explicit",
        description="Explicit output wins",
        output={"type": "object", "properties": {}, "additionalProperties": True},
    )
    def anno_explicit(_args) -> str:
        return "ignored by the schema"

    @ctx.tools.register(name="anno_absent", description="No annotation")
    def anno_absent(_args):
        return {"ok": True}

    @ctx.tools.register(name="anno_any", description="Any annotation")
    def anno_any(_args) -> Any:
        return {"ok": True}


@tool(name="declared_str", description="Declarative style, str annotation")
def declared_str(_args) -> str:
    return "declared"
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
  const tempRoot = await mkdtemp(join(tmpdir(), 'mloader-output-'))
  const pluginRoot = join(tempRoot, 'plugins')
  try {
    const pluginDir = join(pluginRoot, 'anno-demo')
    await mkdir(pluginDir, { recursive: true })
    await writeFile(
      join(pluginDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'anno-demo',
        name: 'Annotated handlers',
        version: '1.0.0',
        backend: 'python',
        entry: 'plugin.py',
        enabled: true,
        inject: ['tools'],
      }, null, 2),
    )
    await writeFile(join(pluginDir, 'plugin.py'), PLUGIN_SOURCE)

    const { root, tools, fiber } = await mountLoader(pluginRoot)
    try {
      const mounted = await waitFor(() => (root.get('mloader')?.list() ?? []).some((plugin) => plugin.id === 'anno-demo' && plugin.state === 'applied'))
      check('the plugin mounts', mounted, JSON.stringify(root.get('mloader')?.list() ?? []))

      const schemaOf = (name) => tools.get(name)?.output?.schema

      section('1. Scalar annotations map to their type')
      check('-> str yields a string schema', schemaOf('anno_str')?.type === 'string', JSON.stringify(schemaOf('anno_str')))
      check('-> int yields an integer schema', schemaOf('anno_int')?.type === 'integer', JSON.stringify(schemaOf('anno_int')))
      check('-> float yields a number schema', schemaOf('anno_float')?.type === 'number', JSON.stringify(schemaOf('anno_float')))
      check('-> bool yields a boolean schema', schemaOf('anno_bool')?.type === 'boolean', JSON.stringify(schemaOf('anno_bool')))

      section('2. Container annotations carry an items schema')
      check('-> dict yields an object schema', schemaOf('anno_dict')?.type === 'object', JSON.stringify(schemaOf('anno_dict')))
      check('-> list yields an array schema', schemaOf('anno_list')?.type === 'array', JSON.stringify(schemaOf('anno_list')))
      check('-> list[str] describes the elements', schemaOf('anno_list_str')?.items?.type === 'string', JSON.stringify(schemaOf('anno_list_str')))

      section('3. Union annotations reduce to the non optional members')
      check('-> Optional[str] yields a string schema', schemaOf('anno_optional')?.type === 'string', JSON.stringify(schemaOf('anno_optional')))
      const unionSchema = schemaOf('anno_union')
      check('-> Union[str, int] yields a oneOf', Array.isArray(unionSchema?.oneOf) && unionSchema.oneOf.length === 2, JSON.stringify(unionSchema))

      section('4. Inference defers to the caller and to the host default')
      const explicit = schemaOf('anno_explicit')
      check('an explicit output wins over the annotation', explicit?.additionalProperties === true && explicit?.properties !== undefined, JSON.stringify(explicit))
      check('a handler without an annotation keeps the host default', schemaOf('anno_absent')?.type === 'object', JSON.stringify(schemaOf('anno_absent')))
      check('-> Any states no schema and keeps the host default', schemaOf('anno_any')?.type === 'object', JSON.stringify(schemaOf('anno_any')))

      section('5. The declarative style infers the same way')
      check('@tool with -> str yields a string schema', schemaOf('declared_str')?.type === 'string', JSON.stringify(schemaOf('declared_str')))

      section('6. An inferred schema accepts the value the harness validates')
      const greetings = [
        ['anno_str', "Hello, world!"],
        ['anno_int', 42],
        ['anno_float', 1.5],
        ['anno_bool', true],
        ['declared_str', 'declared'],
      ]
      for (const [name, expected] of greetings) {
        const result = await tools.get(name).execute({})
        check(`${name} returns its annotated value`, result === expected, JSON.stringify(result))
      }
      const listResult = await tools.get('anno_list_str').execute({})
      check('anno_list_str returns the list', Array.isArray(listResult) && listResult.join(',') === 'a,b', JSON.stringify(listResult))
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
