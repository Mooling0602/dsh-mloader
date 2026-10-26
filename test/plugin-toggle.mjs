/**
 * Runtime plugin toggle suite.
 *
 * Mounts the loader on a real Cordis context with the real dsh tools service
 * and a fake web server service, then drives the two operator routes end to
 * end: listing the hosted plugins, switching one off and on again, enabling a
 * plugin whose manifest starts it disabled, recovering a plugin after its
 * process crashed, and the error statuses. No HTTP socket is opened; the
 * captured route handlers are called with stub request and response objects.
 *
 * A final section mounts the loader on a context that never provides a web
 * server at all and checks that hosting plugins is unaffected, so the optional
 * HTTP surface cannot break a non-web dsh profile.
 */

import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

/** Directory of this suite, used to locate the checked-in Python fixture. */
const HERE = dirname(fileURLToPath(import.meta.url))

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
async function waitFor(predicate, timeoutMs = 10000, intervalMs = 100) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await tick(intervalMs)
  }
  return predicate()
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

/**
 * Build a fake web server service that records the registered routes and lets
 * the suite remove one the way the real service does.
 */
function installFakeWebServer() {
  const routes = new Map()
  const removed = []
  const server = {
    routes,
    removed,
    register(route) {
      const key = `${route.kind} ${route.path}`
      if (routes.has(key)) throw new Error(`duplicate route ${key}`)
      routes.set(key, route)
      let live = true
      return () => {
        if (!live) return
        live = false
        removed.push(key)
        routes.delete(key)
      }
    },
  }
  return server
}

/** Build a request stub: the handler reads the method and iterates the body. */
function makeRequest(method, body) {
  const chunks = body === undefined ? [] : [Buffer.from(body)]
  return {
    method,
    url: '/',
    headers: { 'content-type': 'application/json' },
    on() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk
    },
  }
}

/** Build a response stub that records the status, headers and body. */
function makeResponse() {
  const res = {
    status: 0,
    headers: {},
    body: '',
    writeHead(status, headers) {
      res.status = status
      Object.assign(res.headers, headers ?? {})
      return res
    },
    setHeader(name, value) {
      res.headers[name.toLowerCase()] = value
      return res
    },
    end(body) {
      res.body = body ?? ''
      return res
    },
  }
  return res
}

/** Call one route handler and return the recorded response. */
async function callRoute(route, method, body) {
  const request = makeRequest(method, body)
  const response = makeResponse()
  await route.handler(request, response)
  const contentType = response.headers['content-type'] ?? ''
  let json
  let parsed = false
  try {
    json = JSON.parse(response.body)
    parsed = true
  } catch {
    parsed = false
  }
  return { status: response.status, contentType, body: response.body, json, parsed }
}

/** Create a minimal Python plugin that registers one tool. */
async function makePythonPlugin(root, id, toolName, enabled = true) {
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
      enabled,
    }, null, 2),
  )
  await writeFile(
    join(dir, 'plugin.py'),
    `"""Minimal plugin used by the runtime toggle suite."""

from dsh_mloader_sdk import plugin

NAME = "${id}"


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="${toolName}",
        description="test tool ${toolName}",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def _impl(args):
        return {"ok": True, "tool": "${toolName}"}
`,
  )
  return dir
}

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-toggle-'))
    const pluginRoot = join(tempRoot, 'roots')
    await mkdir(pluginRoot, { recursive: true })

    // The applied plugin is the checked-in Python hello fixture under a fresh
    // manifest, so the route assertions read one known plugin id.
    const helloDir = join(pluginRoot, 'python-hello')
    await cp(join(HERE, 'plugins', 'python-hello'), helloDir, { recursive: true })
    await rm(join(helloDir, '__pycache__'), { recursive: true, force: true })
    await writeFile(
      join(helloDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'python-hello',
        name: 'Python Hello',
        version: '1.0.0',
        backend: 'python',
        entry: 'plugin.py',
        enabled: true,
      }, null, 2),
    )
    // A manifest that disables the plugin: boot skips it, the route may enable it.
    await makePythonPlugin(pluginRoot, 'python-off', 'off_ping', false)
    // A WebAssembly plugin without the backend enabled: boot skips it and the
    // toggle route has to reject the enable with 409.
    const wasmDir = join(pluginRoot, 'wasm-off')
    await mkdir(wasmDir, { recursive: true })
    await writeFile(
      join(wasmDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'wasm-off',
        name: 'WASM Off',
        version: '1.0.0',
        backend: 'wasm',
        entry: 'hello.wasm',
        enabled: true,
      }, null, 2),
    )
    // A plugin whose tool kills its own process: after the crash the toggle
    // route must be able to start a new process from the failed record.
    const crashDir = join(pluginRoot, 'python-crash')
    await mkdir(crashDir, { recursive: true })
    await writeFile(
      join(crashDir, 'mloader.plugin.json'),
      JSON.stringify({
        id: 'python-crash',
        name: 'Python Crash',
        version: '1.0.0',
        backend: 'python',
        entry: 'plugin.py',
        enabled: true,
      }, null, 2),
    )
    await writeFile(
      join(crashDir, 'plugin.py'),
      `"""Plugin whose tool kills its own process, used by the recovery suite."""

import os

from dsh_mloader_sdk import plugin

NAME = "python-crash"


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="crash_now",
        description="Terminate the plugin process immediately",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def _impl(args):
        os._exit(1)
`,
    )

    const root = new Context()
    const logger = makeLogger()
    root.provide('logger', logger)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await tick(200)
    const tools = root.get('tools')

    section('1. Routes register when the webServer service appears')
    const server = installFakeWebServer()
    root.plugin({
      name: 'fake-web-server',
      apply(ctx) {
        ctx.provide('webServer', server)
      },
    })
    await tick(100)
    check('the fake web server is provided', root.get('webServer') === server)

    const loaderFiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [pluginRoot],
        // The suite must not touch the real profile: disable detection and seeding.
        profilePlugins: false,
        seedExamples: false,
        console: false,
        pythonBin: 'python3',
        wasm: { enabled: false },
      },
    )

    const routesReady = await waitFor(() => server.routes.size === 2, 5000)
    check(
      'the GET list route is registered as an exact route',
      routesReady && server.routes.has('exact /mloader/plugins'),
      JSON.stringify([...server.routes.keys()]),
    )
    check(
      'the POST toggle route is registered as an exact route',
      routesReady && server.routes.has('exact /mloader/plugins/toggle'),
      JSON.stringify([...server.routes.keys()]),
    )
    const listRoute = server.routes.get('exact /mloader/plugins')
    const toggleRoute = server.routes.get('exact /mloader/plugins/toggle')

    const booted = await waitFor(() => {
      const plugins = root.get('mloader')?.list() ?? []
      const hello = plugins.find((plugin) => plugin.id === 'python-hello')
      const off = plugins.find((plugin) => plugin.id === 'python-off')
      const wasm = plugins.find((plugin) => plugin.id === 'wasm-off')
      return hello?.state === 'applied' && off?.state === 'disabled' && wasm?.state === 'disabled'
    }, 20000)
    check(
      'boot applies the enabled plugin and skips the disabled ones',
      booted,
      JSON.stringify(root.get('mloader')?.list()),
    )

    section('2. GET /mloader/plugins lists every hosted plugin')
    const listResponse = await callRoute(listRoute, 'GET')
    check('the list responds 200', listResponse.status === 200, `status=${listResponse.status}`)
    check(
      'the list response is JSON',
      listResponse.parsed && listResponse.contentType.startsWith('application/json'),
      `content-type=${listResponse.contentType}`,
    )
    const listed = listResponse.json?.plugins ?? []
    check(
      'every plugin record is listed',
      listed.length === 4,
      JSON.stringify(listed.map((plugin) => plugin.id)),
    )
    const listedHello = listed.find((plugin) => plugin.id === 'python-hello')
    check('the snapshot reports the applied state', listedHello?.state === 'applied', JSON.stringify(listedHello))
    check('the snapshot reports the backend', listedHello?.backend === 'python')
    check(
      'the snapshot lists the registered tools',
      listedHello?.tools?.includes('py_greet') && listedHello?.tools?.includes('py_echo'),
      JSON.stringify(listedHello?.tools),
    )
    check(
      'the manifest-disabled plugin is listed as disabled',
      listed.find((plugin) => plugin.id === 'python-off')?.state === 'disabled',
    )
    check(
      'the wasm-disabled error is reported in the snapshot',
      typeof listed.find((plugin) => plugin.id === 'wasm-off')?.error === 'string',
    )

    section('3. The toggle route switches a plugin off')
    const offResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'python-hello', enabled: false }),
    )
    check('the toggle responds 200', offResponse.status === 200, `status=${offResponse.status}`)
    check(
      'the toggle response is JSON',
      offResponse.parsed && offResponse.contentType.startsWith('application/json'),
      `content-type=${offResponse.contentType}`,
    )
    check(
      'the returned snapshot is disabled',
      offResponse.json?.plugin?.state === 'disabled',
      JSON.stringify(offResponse.json),
    )
    check(
      'the returned snapshot keeps the id',
      offResponse.json?.plugin?.id === 'python-hello',
      JSON.stringify(offResponse.json?.plugin?.id),
    )
    const toolsAfterOff = tools.schemas().map((schema) => schema.name)
    check(
      'the plugin tools are revoked from the tools runtime',
      !toolsAfterOff.includes('py_greet') && !toolsAfterOff.includes('py_echo'),
      `present: ${toolsAfterOff.join(',')}`,
    )
    check(
      'the record stays tracked in the disabled state',
      (root.get('mloader')?.list() ?? []).some(
        (plugin) => plugin.id === 'python-hello' && plugin.state === 'disabled',
      ),
    )
    const statusAfterOff = await tools.get('mloader_status').execute({})
    check(
      'the status tool still works and counts every record',
      statusAfterOff?.count === 4,
      JSON.stringify(statusAfterOff),
    )
    const statesAfterOff = Object.fromEntries(
      (root.get('mloader')?.list() ?? []).map((plugin) => [plugin.id, plugin.state]),
    )
    check(
      'the other plugins are unaffected',
      statesAfterOff['python-off'] === 'disabled' && statesAfterOff['wasm-off'] === 'disabled',
      JSON.stringify(statesAfterOff),
    )

    section('4. The toggle route switches the plugin back on')
    const onResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'python-hello', enabled: true }),
    )
    check('the toggle responds 200', onResponse.status === 200, `status=${onResponse.status}`)
    check(
      'the returned snapshot is applied',
      onResponse.json?.plugin?.state === 'applied',
      JSON.stringify(onResponse.json),
    )
    const toolsAfterOn = tools.schemas().map((schema) => schema.name)
    check(
      'the plugin tools are registered again',
      toolsAfterOn.includes('py_greet') && toolsAfterOn.includes('py_echo'),
      `present: ${toolsAfterOn.join(',')}`,
    )
    const greet = await tools.get('py_greet').execute({ who: 'world' })
    check('the tool is callable after the restart', greet?.text === 'Hello, world!', JSON.stringify(greet))

    section('5. A manifest-disabled plugin can be enabled manually')
    const enableResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'python-off', enabled: true }),
    )
    check('the toggle responds 200', enableResponse.status === 200, `status=${enableResponse.status}`)
    check(
      'the manifest-disabled plugin is applied after the toggle',
      enableResponse.json?.plugin?.state === 'applied',
      JSON.stringify(enableResponse.json),
    )
    check(
      'its tool is registered',
      tools.schemas().some((schema) => schema.name === 'off_ping'),
    )
    const ping = await tools.get('off_ping').execute({})
    check('its tool is callable', ping?.ok === true, JSON.stringify(ping))

    section('6. A crashed plugin can be re-enabled through the toggle route')
    const crashBefore = (root.get('mloader')?.list() ?? []).find(
      (plugin) => plugin.id === 'python-crash',
    )
    check('the crash plugin starts applied', crashBefore?.state === 'applied', JSON.stringify(crashBefore))
    let crashCallFailed = false
    try {
      await tools.get('crash_now').execute({})
    } catch {
      crashCallFailed = true
    }
    check('the tool call fails when the plugin process dies', crashCallFailed)
    const crashMarked = await waitFor(
      () => (root.get('mloader')?.list() ?? []).find(
        (plugin) => plugin.id === 'python-crash',
      )?.state === 'failed',
      5000,
    )
    check('the plugin is marked failed after the crash', crashMarked)
    const crashedRecord = (root.get('mloader')?.list() ?? []).find(
      (plugin) => plugin.id === 'python-crash',
    )
    check(
      'the failed record carries the crash error',
      typeof crashedRecord?.error === 'string',
      JSON.stringify(crashedRecord),
    )
    check(
      'the crashed plugin tool is revoked',
      !tools.schemas().some((schema) => schema.name === 'crash_now'),
    )
    const retryResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'python-crash', enabled: true }),
    )
    check(
      're-enabling a crashed plugin responds 200',
      retryResponse.status === 200,
      `status=${retryResponse.status} body=${retryResponse.body}`,
    )
    check(
      'the returned snapshot is applied',
      retryResponse.json?.plugin?.state === 'applied',
      JSON.stringify(retryResponse.json),
    )
    check(
      'the plugin tool is registered again',
      tools.schemas().some((schema) => schema.name === 'crash_now'),
    )

    section('7. Error statuses and methods')
    const unknownResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'nope', enabled: true }),
    )
    check('an unknown plugin id responds 404', unknownResponse.status === 404, `status=${unknownResponse.status}`)
    check(
      'the 404 body carries the manager message',
      unknownResponse.parsed && unknownResponse.json?.error === 'unknown plugin "nope"',
      JSON.stringify(unknownResponse.json),
    )
    const malformedResponse = await callRoute(toggleRoute, 'POST', '{not json')
    check('malformed JSON responds 400', malformedResponse.status === 400, `status=${malformedResponse.status}`)
    check(
      'the 400 body is JSON with an error',
      malformedResponse.parsed && typeof malformedResponse.json?.error === 'string',
      JSON.stringify(malformedResponse.json),
    )
    const incompleteResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'python-hello' }),
    )
    check(
      'a body without the enabled flag responds 400',
      incompleteResponse.status === 400,
      `status=${incompleteResponse.status}`,
    )
    const oversizedResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'python-hello', enabled: true, pad: 'x'.repeat(70 * 1024) }),
    )
    check(
      'a body above 64 KiB responds 413',
      oversizedResponse.status === 413,
      `status=${oversizedResponse.status}`,
    )
    const wrongListMethod = await callRoute(listRoute, 'POST')
    check(
      'a POST to the list route responds 405 with JSON',
      wrongListMethod.status === 405
        && wrongListMethod.parsed
        && wrongListMethod.contentType.startsWith('application/json'),
      `status=${wrongListMethod.status}`,
    )
    const wrongToggleMethod = await callRoute(toggleRoute, 'GET')
    check(
      'a GET to the toggle route responds 405',
      wrongToggleMethod.status === 405,
      `status=${wrongToggleMethod.status}`,
    )
    const wasmResponse = await callRoute(
      toggleRoute,
      'POST',
      JSON.stringify({ id: 'wasm-off', enabled: true }),
    )
    check('a disabled wasm backend responds 409', wasmResponse.status === 409, `status=${wasmResponse.status}`)
    check(
      'the 409 body explains the configuration',
      wasmResponse.parsed && /wasm backend is disabled/.test(String(wasmResponse.json?.error)),
      JSON.stringify(wasmResponse.json),
    )
    check(
      'the wasm plugin stays disabled',
      (root.get('mloader')?.list() ?? []).find((plugin) => plugin.id === 'wasm-off')?.state === 'disabled',
    )

    section('8. The optional mloader service exposes the transitions')
    const service = root.get('mloader')
    check('the service lists plugins', typeof service?.list === 'function')
    check('the service enables plugins', typeof service?.enable === 'function')
    check('the service disables plugins', typeof service?.disable === 'function')
    check('the service dispatches toggles', typeof service?.setEnabled === 'function')
    const serviceOff = await service?.disable('python-off')
    check('the service disables a plugin', serviceOff?.state === 'disabled', JSON.stringify(serviceOff))
    const serviceOn = await service?.enable('python-off')
    check('the service enables it again', serviceOn?.state === 'applied', JSON.stringify(serviceOn))

    section('9. Unloading the loader removes the routes')
    await loaderFiber.dispose()
    const routesGone = await waitFor(() => server.routes.size === 0, 5000)
    check(
      'both routes are removed with the injected scope',
      routesGone,
      JSON.stringify([...server.routes.keys()]),
    )
    check('both route disposers ran', server.removed.length === 2, JSON.stringify(server.removed))
    const toolsGone = await waitFor(
      () => !tools.schemas().some(
        (schema) => ['py_greet', 'py_echo', 'off_ping', 'crash_now'].includes(schema.name),
      ),
      5000,
    )
    check('every external tool is revoked on unload', toolsGone)

    section('10. A context without a webServer service is unaffected')
    const plainRoot = new Context()
    const plainLogger = makeLogger()
    plainRoot.provide('logger', plainLogger)
    plainRoot.provide('systemPrompt', systemPromptStub())
    plainRoot.plugin(ToolRuntime, {})
    await tick(200)
    const plainTools = plainRoot.get('tools')
    const plainFiber = plainRoot.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [pluginRoot],
        profilePlugins: false,
        seedExamples: false,
        console: false,
        pythonBin: 'python3',
        wasm: { enabled: false },
      },
    )
    const plainBooted = await waitFor(
      () => (plainRoot.get('mloader')?.list() ?? []).some(
        (plugin) => plugin.id === 'python-hello' && plugin.state === 'applied',
      ),
      20000,
    )
    check('the loader mounts and hosts plugins without a web server', plainBooted)
    check('the mloader service is provided', typeof plainRoot.get('mloader')?.list === 'function')
    check(
      'the hosted tool is registered on the plain context',
      plainTools.schemas().some((schema) => schema.name === 'py_greet'),
    )
    // Cordis does not export its fiber state enum; the loader is active as 2.
    check('the loader fiber is active, not waiting or failed', plainFiber.state === 2, `state=${plainFiber.state}`)
    const webWarnings = plainLogger.lines.filter((line) => /webServer|HTTP route/.test(line))
    check(
      'no web server warning is logged',
      webWarnings.length === 0,
      JSON.stringify(webWarnings),
    )
    await plainFiber.dispose()
    const plainGone = await waitFor(
      () => !plainTools.schemas().some((schema) => schema.name === 'py_greet'),
      5000,
    )
    check('the plain context disposes cleanly too', plainGone)

    console.log('')
    if (failures.length === 0) {
      console.log(`All ${passed} assertions passed`)
      process.exitCode = 0
    } else {
      console.log(`${failures.length} of ${passed + failures.length} assertions failed`)
      for (const failure of failures) console.log(`   - ${failure}`)
      console.log('\nLoader log:')
      for (const line of logger.lines.slice(-40)) console.log(`   ${line}`)
      process.exitCode = 1
    }
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nThe plugin toggle suite crashed:', error)
  process.exit(1)
})
