/** Tests safe profile configuration edits and the operator route. */

import assert from 'node:assert/strict'
import test from 'node:test'
import { readLoaderConfig, writeLoaderConfig } from '../src/config-editor.js'
import { registerMloaderHttp } from '../src/http.js'

function fixture() {
  const entry = { options: { id: 'dsh-mloader', name: 'dsh-mloader', config: {
    shellPath: ['/old/bin'], pythonBin: 'python3', wasm: { enabled: false, other: 7 },
    unknown: { retained: true },
  } } }
  const routes = new Map()
  const editor = {
    entries: () => [entry],
    async edit(current, change) { current.options.config = change(current.options.config, {}) },
  }
  const server = { register(route) { routes.set(route.path, route); return () => routes.delete(route.path) } }
  const effects = []
  const ctx = {
    get(name) { return name === 'configEditor' ? editor : name === 'webServer' ? server : undefined },
    inject(_names, fn) { fn(ctx) },
    effect(fn) { effects.push(fn()) },
  }
  return { entry, editor, routes, ctx, effects }
}

async function request(route, method, body) {
  const req = {
    method,
    async *[Symbol.asyncIterator]() { if (body !== undefined) yield Buffer.from(body) },
  }
  const result = { status: 0, body: '' }
  const res = {
    writeHead(status) { result.status = status },
    end(text) { result.body = text },
  }
  await route.handler(req, res)
  return { status: result.status, json: JSON.parse(result.body) }
}

test('read and save preserve unedited fields and reject stale or invalid edits', async () => {
  const { ctx, entry, editor } = fixture()
  const snapshot = readLoaderConfig(ctx)
  assert.deepEqual(snapshot.config.shellPath, ['/old/bin'])
  assert.equal(snapshot.config.autoEnable, true)
  assert.equal(snapshot.config.wasmEnabled, false)
  assert.equal(snapshot.config.unknown, undefined)
  await writeLoaderConfig(ctx, snapshot.revision, { shellPath: ['/new/bin'], wasmEnabled: true })
  assert.deepEqual(entry.options.config.shellPath, ['/new/bin'])
  assert.deepEqual(entry.options.config.wasm, { enabled: true, other: 7 })
  assert.deepEqual(entry.options.config.unknown, { retained: true })
  await assert.rejects(writeLoaderConfig(ctx, snapshot.revision, { autoEnable: false }), /configuration changed/)
  const current = readLoaderConfig(ctx)
  for (const changes of [{ shellPath: [''] }, { pythonBin: '' }, { command: 'bad name' }, { unknown: 1 }, {}]) {
    await assert.rejects(writeLoaderConfig(ctx, current.revision, changes))
  }
  await assert.rejects(writeLoaderConfig(ctx, 'invalid', { watch: false }), /revision/)
  editor.entries = () => []
  assert.throws(() => readLoaderConfig(ctx), /unavailable/)
  await assert.rejects(writeLoaderConfig(ctx, current.revision, { watch: false }), /unavailable/)
})

test('configuration editing refuses ambiguous or unrelated profile entries', async () => {
  const { ctx, entry, editor } = fixture()
  const snapshot = readLoaderConfig(ctx)
  editor.entries = () => [entry, { options: { ...entry.options } }]
  assert.throws(() => readLoaderConfig(ctx), /unavailable/)
  await assert.rejects(writeLoaderConfig(ctx, snapshot.revision, { watch: false }), /unavailable/)
  editor.entries = () => [{ options: { ...entry.options, name: 'other-package' } }]
  assert.throws(() => readLoaderConfig(ctx), /unavailable/)
  await assert.rejects(writeLoaderConfig(ctx, snapshot.revision, { watch: false }), /unavailable/)
  assert.equal(entry.options.config.watch, undefined)
})

test('the revision is checked inside the editor transaction', async () => {
  const { ctx, entry, editor } = fixture()
  const snapshot = readLoaderConfig(ctx)
  editor.edit = async (current, change) => {
    current.options.config = { ...current.options.config, shellPath: ['/concurrent/bin'] }
    current.options.config = change(current.options.config, {})
  }
  await assert.rejects(writeLoaderConfig(ctx, snapshot.revision, { autoEnable: false }), /configuration changed/)
  assert.deepEqual(entry.options.config.shellPath, ['/concurrent/bin'])
  assert.equal(entry.options.config.autoEnable, undefined)
})

test('an editor refusal leaves the requested configuration unchanged', async () => {
  const { ctx, entry, editor } = fixture()
  const snapshot = readLoaderConfig(ctx)
  const before = structuredClone(entry.options.config)
  editor.edit = async (_entry, change) => {
    const candidate = change(structuredClone(entry.options.config), {})
    assert.equal(candidate.watch, false)
    throw new Error('higher priority configuration prevents saving')
  }
  await assert.rejects(writeLoaderConfig(ctx, snapshot.revision, { watch: false }), /higher priority/)
  assert.deepEqual(entry.options.config, before)
})

test('a route registration failure disposes earlier registrations', () => {
  const { ctx, routes, effects } = fixture()
  const server = ctx.get('webServer')
  const register = server.register
  server.register = (route) => {
    if (route.path === '/mloader/config') throw new Error('registration failed')
    return register(route)
  }
  registerMloaderHttp(ctx, { list: () => [], enable() {}, disable() {} })
  assert.equal(routes.size, 0)
  assert.equal(effects.length, 0)
})

test('configuration route validates methods, payloads and conflicts', async () => {
  const { ctx, routes, effects, editor } = fixture()
  registerMloaderHttp(ctx, { list: () => [], enable() {}, disable() {} })
  const route = routes.get('/mloader/config')
  assert.ok(route)
  assert.equal((await request(route, 'PUT')).status, 405)
  const initial = await request(route, 'GET')
  assert.equal(initial.status, 200)
  assert.equal((await request(route, 'POST', '{')).status, 400)
  assert.equal((await request(route, 'POST', JSON.stringify({ revision: initial.json.revision, changes: { statusTool: false } }))).status, 200)
  assert.equal((await request(route, 'POST', JSON.stringify({ revision: initial.json.revision, changes: { statusTool: true } }))).status, 409)
  assert.equal((await request(route, 'POST', 'x'.repeat(65537))).status, 413)
  editor.entries = () => []
  assert.equal((await request(route, 'GET')).status, 503)
  for (const dispose of effects) dispose()
  assert.equal(routes.size, 0)
})
