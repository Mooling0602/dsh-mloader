/**
 * Profile plugin directory suite.
 *
 * Verifies the contract that a plugin installed under
 * `<profile>/mloader/plugins/<plugin-id>` is discovered and mounted.
 *
 * Coverage:
 *   1. `profilePluginsDir()` builds the expected path from explicit arguments
 *      and from the DSH_* environment variables.
 *   2. `resolveRoots()` appends the profile plugin directory and removes
 *      duplicates.
 *   3. `includeProfileDir: false` appends nothing.
 *   4. `~` expands and relative roots resolve against the profile.
 *   5. A plugin really placed in the profile plugin directory is discovered and
 *      started.
 *   6. With explicit roots and a profile directory both present, plugins from
 *      both are loaded.
 *   7. A missing profile plugin directory is not an error (first use is a
 *      normal state).
 *   8. With `profilePlugins: false` the loader does not scan the profile.
 */

import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { discover } from '../src/discovery.js'
import { expandHome, profilePluginsDir, resolveProfileDir, resolveRoots } from '../src/contract.js'

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

function makeLogger() {
  const lines = []
  const push = (level) => (message) => lines.push(`${level}: ${message}`)
  const logger = (..._a) => logger
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
    refreshContext: (a) => a,
    assemble: async () => ({ sections: [] }),
  }
}

/**
 * Create a minimal working Python plugin directory.
 *
 * The shape must match a real plugin: `from dsh_mloader_sdk import plugin`,
 * a `@plugin def apply(ctx)` entry, and `ctx.tools.register(...)`.
 */
async function makePythonPlugin(root, id, toolName) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, backend: 'python', entry: 'plugin.py', version: '1.0.0' }, null, 2),
  )
  await writeFile(
    join(dir, 'plugin.py'),
    `"""Minimal test plugin."""

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
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-profile-'))

    section('1. profilePluginsDir path assembly')
    check(
      'explicit profileDir becomes <profile>/mloader/plugins',
      profilePluginsDir('/home/u/.dsh/profiles/web') === '/home/u/.dsh/profiles/web/mloader/plugins',
      profilePluginsDir('/home/u/.dsh/profiles/web'),
    )
    // Any of the three variables may be the profile source; test each in turn.
    const saved = {
      DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
      DSH_HOME: process.env.DSH_HOME,
      DSH_PROFILE: process.env.DSH_PROFILE,
    }
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }

    process.env.DSH_PROFILE_DIR = '/env/profile'
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
    check(
      'DSH_PROFILE_DIR is preferred',
      profilePluginsDir() === '/env/profile/mloader/plugins',
      String(profilePluginsDir()),
    )

    // Regression: the dsh main process may lack DSH_PROFILE_DIR, so detection
    // must fall back to DSH_HOME plus DSH_PROFILE.
    delete process.env.DSH_PROFILE_DIR
    process.env.DSH_HOME = '/env/home'
    process.env.DSH_PROFILE = 'web'
    check(
      'DSH_HOME plus DSH_PROFILE is used without DSH_PROFILE_DIR',
      profilePluginsDir() === '/env/home/profiles/web/mloader/plugins',
      String(profilePluginsDir()),
    )
    check(
      'the derived directory uses profiles (plural)',
      String(profilePluginsDir()).includes('/profiles/'),
      String(profilePluginsDir()),
    )

    // All three missing: detection gives up.
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
    check('undefined when no source is available', profilePluginsDir() === undefined, String(profilePluginsDir()))

    restore()

    section('1b. resolveProfileDir precedence')
    check('the explicit argument wins over environment variables', resolveProfileDir('/explicit') === '/explicit', String(resolveProfileDir('/explicit')))

    // ctx.baseUrl is what makes a fresh install work without configuration: a
    // real dsh process has no DSH_* variables, only the baseUrl that
    // dsh-app-boot sets to the profile directory file URL.
    section('1c. ctx.baseUrl detection (the out-of-the-box path)')
    const realProfile = join(tempRoot, 'realprof')
    await mkdir(join(realProfile, 'mloader'), { recursive: true })
    await writeFile(join(realProfile, 'package.json'), '{"name":"prof"}\n')
    await writeFile(join(realProfile, 'cordis.yml'), '- id: root\n')
    const profileUrl = pathToFileURL(realProfile).href + '/'

    check('a profile is recognised from baseUrl', resolveProfileDir(undefined, profileUrl) === realProfile,
      String(resolveProfileDir(undefined, profileUrl)))
    check('a baseUrl without a trailing slash works too',
      resolveProfileDir(undefined, profileUrl.slice(0, -1)) === realProfile,
      String(resolveProfileDir(undefined, profileUrl.slice(0, -1))))

    // baseUrl must beat the environment variables: in a real dsh they may be
    // missing, while a shell tool may export them pointing at another profile.
    const envBackup = process.env.DSH_PROFILE_DIR
    process.env.DSH_PROFILE_DIR = '/bogus/profile'
    check('baseUrl wins over DSH_PROFILE_DIR',
      resolveProfileDir(undefined, profileUrl) === realProfile,
      String(resolveProfileDir(undefined, profileUrl)))
    if (envBackup === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = envBackup

    // A directory that does not look like a profile must not be accepted. The
    // assertion only checks that the baseUrl candidate itself is rejected,
    // because environment or single-profile fallbacks may legitimately answer.
    const plainDir = join(tempRoot, 'not-a-profile')
    await mkdir(plainDir, { recursive: true })
    await writeFile(join(plainDir, 'package.json'), '{"name":"x"}\n') // no cordis.yml
    const plainUrl = pathToFileURL(plainDir).href + '/'
    check('a directory without cordis.yml is not a profile', resolveProfileDir(undefined, plainUrl) !== plainDir,
      String(resolveProfileDir(undefined, plainUrl)))
    check('a non-file baseUrl is rejected', resolveProfileDir(undefined, 'https://example.com/') !== plainDir,
      String(resolveProfileDir(undefined, 'https://example.com/')))
    check('an invalid baseUrl does not throw', (() => {
      try { resolveProfileDir(undefined, 'not-a-url'); return true } catch { return false }
    })())
    check('an undefined baseUrl does not throw', (() => {
      try { resolveProfileDir(undefined, undefined); return true } catch { return false }
    })())

    section('1d. baseUrl feeds resolveRoots and profilePluginsDir')
    const rootsViaBase = resolveRoots([], { baseUrl: profileUrl })
    check('roots are derived from baseUrl',
      rootsViaBase.length === 1 && rootsViaBase[0] === join(realProfile, 'mloader', 'plugins'),
      JSON.stringify(rootsViaBase))
    check('profilePluginsDir accepts baseUrl',
      profilePluginsDir(undefined, profileUrl) === join(realProfile, 'mloader', 'plugins'),
      String(profilePluginsDir(undefined, profileUrl)))

    section('2. resolveRoots appends the profile directory')
    const r1 = resolveRoots(['/abs/one'], { profileDir: '/p/web' })
    check('the explicit root is kept', r1[0] === '/abs/one', JSON.stringify(r1))
    check('the profile plugin directory is appended', r1.includes('/p/web/mloader/plugins'), JSON.stringify(r1))
    check('there are 2 roots', r1.length === 2, JSON.stringify(r1))

    const r2 = resolveRoots(['/p/web/mloader/plugins'], { profileDir: '/p/web' })
    check('a duplicate profile directory is removed', r2.length === 1, JSON.stringify(r2))

    const r3 = resolveRoots([], { profileDir: '/p/web' })
    check('an empty roots list still yields the profile directory', r3.length === 1 && r3[0] === '/p/web/mloader/plugins', JSON.stringify(r3))

    section('3. Relative paths resolve against the profile, ~ expands')
    const r4 = resolveRoots(['./mine'], { profileDir: '/p/web', includeProfileDir: false })
    check('a relative path is based on profileDir', r4[0] === '/p/web/mine', JSON.stringify(r4))
    check('expandHome expands ~/', expandHome('~/x') === join(process.env.HOME ?? '', 'x'), expandHome('~/x'))
    check('expandHome leaves /abs alone', expandHome('/abs/x') === '/abs/x', expandHome('/abs/x'))

    section('4. includeProfileDir:false appends nothing')
    const r5 = resolveRoots(['/abs/one'], { profileDir: '/p/web', includeProfileDir: false })
    check('only the explicit root remains', r5.length === 1 && r5[0] === '/abs/one', JSON.stringify(r5))

    section('5. A plugin placed in the profile plugin directory is discovered')
    const fakeProfile = join(tempRoot, 'profile')
    const profilePlugins = join(fakeProfile, 'mloader', 'plugins')
    await makePythonPlugin(profilePlugins, 'from-profile', 'tool_from_profile')
    await makePythonPlugin(join(tempRoot, 'extra'), 'from-extra', 'tool_from_extra')

    const roots = resolveRoots([join(tempRoot, 'extra')], { profileDir: fakeProfile })
    check('roots contain 2 directories', roots.length === 2, JSON.stringify(roots))

    const found = await discover(roots, null)
    const ids = found.specs.map((s) => s.id).sort()
    check('plugins from both sources are discovered', ids.join(',') === 'from-extra,from-profile', JSON.stringify(ids))
    check('discovery reports no errors', found.errors.length === 0, JSON.stringify(found.errors))

    section('6. End to end: the loader loads plugins from the profile directory')
    const root = new Context()
    const logger = makeLogger()
    root.provide('logger', logger)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { roots: [join(tempRoot, 'extra')], profileDir: fakeProfile, pythonBin: 'python3', seedExamples: false, console: false },
    )
    await new Promise((r) => setTimeout(r, 3500))

    const mloader = root.get('mloader')
    const loadedIds = (mloader?.list() ?? []).map((p) => p.id).sort()
    check('the loader mounts the plugin from the profile', loadedIds.includes('from-profile'), JSON.stringify(loadedIds))
    check('the loader also mounts the plugin from explicit roots', loadedIds.includes('from-extra'), JSON.stringify(loadedIds))
    const states = (mloader?.list() ?? []).map((p) => `${p.id}:${p.state}${p.error ? ' err=' + p.error : ''}`)
    check('both plugins are applied', (mloader?.list() ?? []).filter((p) => p.state === 'applied').length === 2, JSON.stringify(states))

    const tools = root.get('tools')
    check('the profile plugin tool is callable', (await tools.get('tool_from_profile').execute({}))?.ok === true)
    check('the explicit roots plugin tool is callable', (await tools.get('tool_from_extra').execute({}))?.ok === true)

    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 500))

    section('7. A missing profile plugin directory is not an error')
    const emptyProfile = join(tempRoot, 'empty-profile')
    const roots2 = resolveRoots([], { profileDir: emptyProfile })
    check('a path is still returned', roots2.length === 1, JSON.stringify(roots2))
    const found2 = await discover(roots2, null)
    check('discovery returns 0 plugins', found2.specs.length === 0, JSON.stringify(found2.specs))
    check('one missing-directory error is reported instead of throwing', found2.errors.length === 1, JSON.stringify(found2.errors))

    section('8. profilePlugins:false does not scan the profile (end to end)')
    const root3 = new Context()
    const logger3 = makeLogger()
    root3.provide('logger', logger3)
    root3.provide('systemPrompt', systemPromptStub())
    root3.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiber3 = root3.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [join(tempRoot, 'extra')],
        profileDir: fakeProfile,
        profilePlugins: false,
        seedExamples: false,
        console: false,
        pythonBin: 'python3',
      },
    )
    await new Promise((r) => setTimeout(r, 3500))
    const ids3 = (root3.get('mloader')?.list() ?? []).map((p) => p.id).sort()
    check('only the explicit roots are loaded', ids3.join(',') === 'from-extra', JSON.stringify(ids3))
    check('from-profile is absent', !ids3.includes('from-profile'), JSON.stringify(ids3))
    await fiber3.dispose()
    await new Promise((r) => setTimeout(r, 400))

    console.log('')
    if (failures.length === 0) {
      console.log(`All ${passed} assertions passed`)
      process.exitCode = 0
    } else {
      console.log(`${failures.length} of ${passed + failures.length} assertions failed`)
      for (const f of failures) console.log(`   - ${f}`)
      console.log('\nLog:')
      for (const line of logger.lines.slice(-20)) console.log(`   ${line}`)
      process.exitCode = 1
    }
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nThe profile install suite crashed:', error)
  process.exit(1)
})
