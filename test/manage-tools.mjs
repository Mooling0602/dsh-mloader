/** Tests model-facing plugin management and command parity. */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { runMloaderAction } from '../src/commands/mloader.js'
import { createManagementTools } from '../src/tools/manage.js'
import { apply } from '../src/index.js'

function targetFixture() {
  const plugin = {
    id: 'example', name: 'Example', version: '1.0.0', backend: 'python',
    state: 'applied', tools: ['example_tool'], events: [], registrations: 1,
  }
  const calls = []
  return {
    calls,
    plugin,
    list: () => [{ ...plugin }],
    async enable(id) { calls.push(['enable', id]); plugin.state = 'applied'; return { ...plugin } },
    async disable(id) { calls.push(['disable', id]); plugin.state = 'disabled'; return { ...plugin } },
    async reload(id) { calls.push(['reload', id]); plugin.state = 'applied'; return { ...plugin } },
  }
}

test('management tools preserve slash command output and lifecycle decisions', async () => {
  const target = targetFixture()
  const tools = Object.fromEntries(createManagementTools(target).map((tool) => [tool.name, tool]))
  assert.deepEqual(Object.keys(tools), ['mloader_info', 'mloader_load', 'mloader_unload', 'mloader_reload'])
  for (const tool of Object.values(tools)) {
    assert.deepEqual(tool.parameters.required, ['id'])
    assert.equal(tool.parameters.additionalProperties, false)
    assert.deepEqual(tool.output.render({}, { text: 'example' }), [{ type: 'text', text: 'example' }])
    await assert.rejects(tool.execute({}), /non-empty plugin identifier/)
    await assert.rejects(tool.execute({ id: 'missing' }), /Unknown plugin "missing"/)
  }
  const info = await tools.mloader_info.execute({ id: 'example' })
  assert.equal(info.text, (await runMloaderAction(target, 'info', 'example')).text)
  assert.match(info.text, /Version: 1\.0\.0/)
  assert.match((await tools.mloader_load.execute({ id: 'example' })).text, /already loaded/)
  assert.equal(target.calls.length, 0)
  assert.match((await tools.mloader_unload.execute({ id: 'example' })).text, /now disabled/)
  assert.match((await tools.mloader_unload.execute({ id: 'example' })).text, /nothing to unload/)
  assert.deepEqual(target.calls, [['disable', 'example']])
  assert.match((await tools.mloader_reload.execute({ id: 'example' })).text, /now applied/)
  assert.deepEqual(target.calls.at(-1), ['enable', 'example'])
  await tools.mloader_reload.execute({ id: 'example' })
  assert.deepEqual(target.calls.at(-1), ['reload', 'example'])
  target.disable = async () => { throw new Error('transition failed') }
  await assert.rejects(tools.mloader_unload.execute({ id: 'example' }), /transition failed/)
})

test('statusTool disables all model-facing loader tools', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mloader-tools-disabled-'))
  const disposers = []
  const tools = new Map()
  const ctx = {
    tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
    on() {}, off() {}, get() {},
    effect(fn) { disposers.push(fn()) },
    provide() {},
  }
  try {
    await apply(ctx, { roots: [root], profilePlugins: false, seedExamples: false, console: false, watch: false, statusTool: false, command: false })
    assert.deepEqual([...tools.keys()], [])
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(root, { recursive: true, force: true })
  }
})

test('statusTool enables management tools independently of command and disposes them', async () => {
  const root = await mkdtemp(join(tmpdir(), 'mloader-management-'))
  const disposers = []
  const tools = new Map()
  let manager
  try {
    const dir = join(root, 'example')
    await mkdir(dir)
    await writeFile(join(dir, 'mloader.plugin.json'), JSON.stringify({
      id: 'example', name: 'Example', version: '1.0.0', backend: 'python', entry: 'plugin.py',
    }))
    await writeFile(join(dir, 'plugin.py'), 'from dsh_mloader_sdk import plugin\n@plugin\ndef apply(ctx):\n    pass\n')
    const ctx = {
      tools: { register(tool) { tools.set(tool.name, tool); return () => tools.delete(tool.name) } },
      on() {}, off() {}, get() {},
      effect(fn) { disposers.push(fn()) },
      provide(name, service) { if (name === 'mloader') manager = service },
    }
    await apply(ctx, {
      roots: [root], profilePlugins: false, seedExamples: false, console: false,
      watch: false, statusTool: true, command: false,
    })
    assert.deepEqual([...tools.keys()].sort(), ['mloader_info', 'mloader_load', 'mloader_reload', 'mloader_status', 'mloader_unload'])
    const deadline = Date.now() + 10000
    while (manager.list().find((plugin) => plugin.id === 'example')?.state !== 'applied') {
      if (Date.now() > deadline) throw new Error('plugin did not start')
      await delay(20)
    }
    assert.match((await tools.get('mloader_info').execute({ id: 'example' })).text, /State: applied/)
    await tools.get('mloader_unload').execute({ id: 'example' })
    assert.equal(manager.list()[0].state, 'disabled')
    await tools.get('mloader_load').execute({ id: 'example' })
    assert.equal(manager.list()[0].state, 'applied')
    await tools.get('mloader_reload').execute({ id: 'example' })
    assert.equal(manager.list()[0].state, 'applied')
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    assert.equal(tools.size, 0)
    await rm(root, { recursive: true, force: true })
  }
})
