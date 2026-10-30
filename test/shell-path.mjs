/** Tests the loader shellPath setting at the Python process boundary. */

import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { spawnSync } from 'node:child_process'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import test from 'node:test'
import { apply } from '../src/index.js'
import { syncPythonEnvironment } from '../src/python-env.js'
import { withShellPath } from '../src/shell-path.js'

async function observePath(shellPath) {
  const temp = await mkdtemp(join(tmpdir(), 'mloader-shell-path-'))
  const plugin = join(temp, 'plugins', 'path-observer')
  const output = join(temp, 'path.json')
  const disposers = []
  let manager
  try {
    await mkdir(plugin, { recursive: true })
    await writeFile(join(plugin, 'mloader.plugin.json'), JSON.stringify({
      id: 'path-observer', name: 'path-observer', version: '1.0.0',
      backend: 'python', entry: 'entry.py', env: { OBSERVED_PATH_FILE: output },
    }))
    await writeFile(join(plugin, 'entry.py'), [
      'import json',
      'import os',
      'import subprocess',
      'import sys',
      'from dsh_mloader_sdk import plugin',
      '',
      '@plugin',
      'def apply(ctx):',
      `    child = subprocess.check_output([sys.executable, "-c", "import os; print(os.environ.get('PATH', ''))"], text=True).rstrip("\\n")`,
      '    with open(os.environ["OBSERVED_PATH_FILE"], "w") as stream:',
      '        json.dump({"path": os.environ.get("PATH", ""), "child": child}, stream)',
      '',
    ].join('\n'))
    const ctx = {
      tools: { register() { return () => {} } },
      on() {}, off() {},
      effect(fn) { disposers.push(fn()) },
      provide(name, service) { if (name === 'mloader') manager = service },
    }
    const config = {
      roots: [join(temp, 'plugins')], profilePlugins: false, seedExamples: false,
      console: false, watch: false, statusTool: false, command: false,
    }
    if (shellPath !== undefined) config.shellPath = shellPath
    await apply(ctx, config)
    const deadline = Date.now() + 10000
    while (Date.now() < deadline) {
      const record = manager?.list().find((item) => item.id === 'path-observer')
      if (record?.state === 'failed') throw new Error(record.error)
      if (record?.state === 'applied') return JSON.parse(await readFile(output, 'utf8'))
      await delay(20)
    }
    throw new Error('path observer did not start')
  } finally {
    for (const dispose of disposers.reverse()) await dispose()
    await rm(temp, { recursive: true, force: true })
  }
}

test('shellPath does not introduce an empty current-directory PATH entry', () => {
  assert.deepEqual(withShellPath({}, ['/custom/bin']), { PATH: '/custom/bin' })
  assert.deepEqual(withShellPath({ Path: '/original' }, ['/custom/bin']), {
    Path: ['/custom/bin', '/original'].join(delimiter),
  })
})

test('shellPath makes uv discoverable during environment setup', { skip: process.platform === 'win32' }, async () => {
  const temp = await mkdtemp(join(tmpdir(), 'mloader-uv-path-'))
  const originalPath = process.env.PATH
  try {
    const python = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
    assert.equal(python.status, 0, python.stderr)
    const bin = join(temp, 'bin')
    const plugin = join(temp, 'plugin')
    await mkdir(bin)
    await mkdir(plugin)
    await writeFile(join(plugin, 'pyproject.toml'), '[project]\nname = "test-plugin"\nversion = "1.0.0"\ndependencies = []\n')
    await writeFile(join(bin, 'uv'), '#!/bin/sh\necho shell-path-uv-found >&2\nexit 42\n', { mode: 0o755 })
    process.env.PATH = '/nonexistent-mloader-path'
    const options = { profileDir: join(temp, 'profile'), pythonBin: python.stdout.trim() }
    await assert.rejects(syncPythonEnvironment(plugin, options), /uv is required/)
    await assert.rejects(syncPythonEnvironment(plugin, { ...options, shellPath: [bin] }), /shell-path-uv-found/)
    assert.equal(process.env.PATH, '/nonexistent-mloader-path')
  } finally {
    if (originalPath === undefined) delete process.env.PATH
    else process.env.PATH = originalPath
    await rm(temp, { recursive: true, force: true })
  }
})

test('omitted and empty shellPath preserve inherited PATH', async () => {
  const inherited = process.env.PATH ?? ''
  for (const shellPath of [undefined, []]) {
    assert.deepEqual(await observePath(shellPath), { path: inherited, child: inherited })
    assert.equal(process.env.PATH ?? '', inherited)
  }
})

test('shellPath prepends directories in order without replacing inherited PATH', async () => {
  const inherited = process.env.PATH ?? ''
  const directories = [join(tmpdir(), 'mloader-first'), join(tmpdir(), 'mloader-second')]
  const expected = [...directories, inherited].join(delimiter)
  assert.deepEqual(await observePath(directories), { path: expected, child: expected })
  assert.equal(process.env.PATH ?? '', inherited)
})
