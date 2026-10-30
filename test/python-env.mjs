/**
 * Python environment suite.
 *
 * Covers the shared environment every Python plugin of a profile runs in:
 *   1. the environment bridge returns nothing when no profile is known;
 *   2. a pyproject plugin gets the profile virtual environment, and its
 *      requires-python declaration is reported and ignored;
 *   3. a requirements only plugin creates the environment with the venv module
 *      and reports a warning;
 *   4. uv is required for a pyproject plugin and is not required for the venv
 *      module fallback;
 *   5. the loader starts a Python plugin with the shared interpreter.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { sharedVenvPython, syncPythonEnvironment } from '../src/python-env.js'

const repo = fileURLToPath(new URL('..', import.meta.url))
const cli = join(repo, 'src', 'runtime', 'python_sdk', 'run_cli.py')

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log('  PASS ' + name)
  } else {
    failures.push(name + (detail ? ': ' + detail : ''))
    console.log('  FAIL ' + name + (detail ? ': ' + detail : ''))
  }
}

function section(title) {
  console.log('\n' + title)
}

function run(args, extraEnv = {}) {
  return spawnSync('python3', [cli, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...extraEnv },
  })
}

function runJson(args, extraEnv = {}) {
  const result = run(args, extraEnv)
  if (result.status !== 0) {
    throw new Error(
      'command failed: ' + args.join(' ') + '\nstdout:\n' + result.stdout +
      '\nstderr:\n' + result.stderr,
    )
  }
  const line = result.stdout.trim().split('\n').filter((item) => item.startsWith('{')).pop()
  if (line === undefined) throw new Error('no JSON result for ' + args.join(' '))
  return { result, payload: JSON.parse(line) }
}

function realPython() {
  const result = spawnSync('python3', ['-c', 'import sys; print(sys.executable)'], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('python3 is not available: ' + result.stderr)
  return result.stdout.trim()
}

async function writePlugin(dir, id, options = {}) {
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, version: '1.0.0', backend: 'python', entry: 'entry.py' }),
  )
  await writeFile(
    join(dir, 'entry.py'),
    ['from dsh_mloader_sdk import plugin', '', '@plugin', 'def apply(ctx):', '    pass', ''].join('\n'),
  )
  if (options.pyproject === true) {
    const lines = [
      '[project]',
      'name = "' + id + '"',
      'version = "1.0.0"',
      'dependencies = []',
      '',
    ]
    if (options.requiresPython) {
      lines.splice(3, 0, 'requires-python = "' + options.requiresPython + '"')
    }
    await writeFile(join(dir, 'pyproject.toml'), lines.join('\n'))
  }
  if (options.requirements === true) {
    await writeFile(join(dir, 'requirements.txt'), 'pip>=20\n')
  }
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

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-env-'))
    const env = { XDG_DATA_HOME: join(tempRoot, 'trash-data') }

    section('1. no profile means no shared environment')
    const bare = await syncPythonEnvironment(join(tempRoot, 'plugin'), {
      pythonBin: 'python3',
      logger: undefined,
    })
    check('the bridge returns undefined', bare === undefined, String(bare))

    section('2. a pyproject plugin uses the profile environment')
    const profile = join(tempRoot, 'profile')
    await mkdir(profile, { recursive: true })
    const projectPlugin = join(profile, 'mloader', 'plugins', 'env-project')
    await writePlugin(projectPlugin, 'env-project', { pyproject: true, requiresPython: '>=3.99' })
    const synced = runJson(['env', 'sync', '--profile', profile, '--plugin', projectPlugin, '--json'], env)
    check('the mode is uv', synced.payload.mode === 'uv', JSON.stringify(synced.payload))
    check('the interpreter is in the profile venv', synced.payload.python === sharedVenvPython(profile), synced.payload.python)
    check('the environment exists', existsSync(join(profile, 'mloader', '.venv', 'bin', 'python')))
    check('requires-python is reported and ignored', synced.payload.warnings.some((item) => item.includes('requires-python') && item.includes('ignored')), JSON.stringify(synced.payload.warnings))
    const prefix = spawnSync(synced.payload.python, ['-c', 'import sys; print(sys.prefix)'], { encoding: 'utf8' })
    check('the interpreter reports the venv as its prefix', prefix.stdout.trim() === join(profile, 'mloader', '.venv'), prefix.stdout.trim())
    const ensured = runJson(['env', 'ensure', '--profile', profile, '--json'], env)
    check('env ensure returns the same interpreter', ensured.payload.python === synced.payload.python, ensured.payload.python)
    const venvRoot = join(profile, 'mloader', '.venv')
    const launcher = join(venvRoot, 'bin', 'dsh-mloader-sdk')
    check('the SDK console script exists in the environment', existsSync(launcher), launcher)
    const version = spawnSync(launcher, ['--version'], { encoding: 'utf8' })
    check('the console script runs the installed SDK', version.status === 0 && version.stdout.trim() === '0.1.0', version.stdout + version.stderr)
    const active = spawnSync(launcher, ['env', 'ensure', '--json'], {
      encoding: 'utf8',
      env: { ...process.env, VIRTUAL_ENV: venvRoot },
    })
    const activePayload = active.status === 0 ? JSON.parse(active.stdout.trim().split('\n').pop()) : undefined
    check('the console script defaults to its owning profile', activePayload?.venv === venvRoot, active.stderr)

    section('3. a requirements only plugin uses the venv module')
    const legacyProfile = join(tempRoot, 'legacy-profile')
    const legacyPlugin = join(legacyProfile, 'mloader', 'plugins', 'legacy-plugin')
    await writePlugin(legacyPlugin, 'legacy-plugin', { requirements: true })
    const legacy = runJson(['env', 'sync', '--profile', legacyProfile, '--plugin', legacyPlugin, '--json'], env)
    check('the mode is python-venv', legacy.payload.mode === 'python-venv', JSON.stringify(legacy.payload))
    check('the warning names requirements.txt', legacy.payload.warnings.some((item) => item.includes('requirements.txt')), JSON.stringify(legacy.payload.warnings))
    const pyvenv = await readFile(join(legacyProfile, 'mloader', '.venv', 'pyvenv.cfg'), 'utf8')
    check('the venv module created the environment', pyvenv.includes('-m venv') && !pyvenv.includes('uv ='), pyvenv)

    section('4. uv is required for a pyproject plugin')
    const binDir = join(tempRoot, 'bin')
    await mkdir(binDir, { recursive: true })
    await symlink(realPython(), join(binDir, 'python3'))
    const noUvEnv = { ...env, PATH: binDir }
    const noUvProfile = join(tempRoot, 'no-uv-profile')
    const noUvPlugin = join(noUvProfile, 'mloader', 'plugins', 'no-uv-plugin')
    await writePlugin(noUvPlugin, 'no-uv-plugin', { pyproject: true })
    const missingUv = run(['env', 'sync', '--profile', noUvProfile, '--plugin', noUvPlugin, '--json'], noUvEnv)
    check('the command fails without uv', missingUv.status !== 0, String(missingUv.status))
    check('the reason asks for uv', missingUv.stderr.includes('uv is required'), missingUv.stderr)
    const fallbackProfile = join(tempRoot, 'fallback-profile')
    const fallbackPlugin = join(fallbackProfile, 'mloader', 'plugins', 'fallback-plugin')
    await writePlugin(fallbackPlugin, 'fallback-plugin', { requirements: true })
    const fallback = run(['env', 'sync', '--profile', fallbackProfile, '--plugin', fallbackPlugin, '--json'], noUvEnv)
    check('the venv fallback works without uv', fallback.status === 0, fallback.stderr)
    check('the fallback created an interpreter', existsSync(join(fallbackProfile, 'mloader', '.venv', 'bin', 'python')))

    section('5. the loader starts the plugin with the shared interpreter')
    const loaderProfile = join(tempRoot, 'loader-profile')
    await mkdir(join(loaderProfile, 'mloader', 'plugins'), { recursive: true })
    await writeFile(join(loaderProfile, 'package.json'), '{"name":"profile"}\n')
    await writeFile(join(loaderProfile, 'cordis.yml'), '- id: root\n')
    const loaderPlugin = join(loaderProfile, 'mloader', 'plugins', 'interpreter-check')
    await mkdir(loaderPlugin, { recursive: true })
    await writeFile(
      join(loaderPlugin, 'mloader.plugin.json'),
      JSON.stringify({ id: 'interpreter-check', backend: 'python', entry: 'plugin.py' }),
    )
    await writeFile(
      join(loaderPlugin, 'plugin.py'),
      [
        'import sys',
        'from dsh_mloader_sdk import plugin',
        '',
        '@plugin',
        'def apply(ctx):',
        '    @ctx.tools.register(',
        '        name="interpreter_check",',
        '        description="report the interpreter",',
        '        parameters={"type": "object", "properties": {}, "additionalProperties": False},',
        '    )',
        '    def _impl(args):',
        '        return {"python": sys.executable}',
        '',
      ].join('\n'),
    )
    const ctx = new Context()
    const lines = []
    const logger = (message) => lines.push(String(message))
    logger.debug = logger
    logger.info = logger
    logger.warn = logger
    logger.error = logger
    ctx.provide('logger', logger)
    ctx.provide('systemPrompt', systemPromptStub())
    ctx.plugin(ToolRuntime, {})
    await new Promise((resolve) => setTimeout(resolve, 200))
    const fiber = ctx.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: loaderProfile, seedExamples: false, console: false, pythonBin: 'python3' },
    )
    await new Promise((resolve) => setTimeout(resolve, 6000))
    const snapshot = ctx.get('mloader')?.list() ?? []
    check('the plugin is applied', snapshot.some((item) => item.id === 'interpreter-check' && item.state === 'applied'), JSON.stringify(snapshot))
    const tool = ctx.get('tools')?.get('interpreter_check')
    const result = await tool.execute({})
    check('the tool reports the shared interpreter', result.python === sharedVenvPython(loaderProfile), JSON.stringify(result))
    check('the environment exists under the profile', existsSync(join(loaderProfile, 'mloader', '.venv', 'bin', 'python')))
    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 500))

    console.log('')
    if (failures.length === 0) {
      console.log('All ' + passed + ' assertions passed')
      process.exitCode = 0
    } else {
      console.log(failures.length + ' of ' + (passed + failures.length) + ' assertions failed')
      for (const failure of failures) console.log('   - ' + failure)
      process.exitCode = 1
    }
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nThe Python environment suite crashed:', error)
  process.exit(1)
})
