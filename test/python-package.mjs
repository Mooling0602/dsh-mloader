/**
 * Python package suite.
 *
 * Covers the command line that packs, installs, updates and removes a Python
 * plugin package:
 *   1. pack writes the manifest, entry, module, pyproject and requirements and
 *      skips interpreter caches;
 *   2. install extracts the package, merges requirements only entries into
 *      pyproject.toml, drops requirements.txt and writes the install index;
 *   3. installing the same archive twice is refused;
 *   4. changed installed files block an update until --force is passed;
 *   5. remove refuses without --yes and moves the directory to the trash;
 *   6. the TOML fallback used on Python 3.10 reads and merges dependencies;
 *   7. a requirements only package keeps the file and uses the venv module;
 *   8. unsafe entries and a missing manifest are rejected without a partial
 *      plugin directory.
 *
 * The suite needs python3 and uv on PATH. It writes the profile and the trash
 * into a temporary directory.
 */

import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { appendFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = fileURLToPath(new URL('..', import.meta.url))
const cli = join(repo, 'src', 'runtime', 'python_sdk', 'run_cli.py')
const python = process.env.PYTHON ?? 'python3'

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
  return spawnSync(python, [cli, ...args], {
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

function lastJson(result) {
  const line = result.stdout.trim().split('\n').filter((item) => item.startsWith('{')).pop()
  return line === undefined ? undefined : JSON.parse(line)
}

async function makePlugin(root, id, options = {}) {
  const dir = join(root, id)
  await mkdir(join(dir, 'demo_module'), { recursive: true })
  await mkdir(join(dir, '__pycache__'), { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({
      id,
      name: id,
      version: options.version ?? '1.0.0',
      backend: 'python',
      entry: 'entry.py',
    }),
  )
  await writeFile(
    join(dir, 'entry.py'),
    [
      'from dsh_mloader_sdk import plugin',
      '',
      '@plugin',
      'def apply(ctx):',
      '    pass',
      '',
    ].join('\n'),
  )
  await writeFile(join(dir, 'demo_module', '__init__.py'), 'VALUE = 1\n')
  await writeFile(join(dir, '__pycache__', 'stale.pyc'), 'stale')
  if (options.pyproject !== false) {
    await writeFile(
      join(dir, 'pyproject.toml'),
      [
        '[project]',
        'name = "' + id + '"',
        'version = "' + (options.version ?? '1.0.0') + '"',
        'dependencies = []',
        '',
      ].join('\n'),
    )
  }
  if (options.requirements !== null) {
    await writeFile(join(dir, 'requirements.txt'), options.requirements ?? 'pip>=20\n')
  }
  return dir
}

function zipNames(path) {
  const script = [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1]) as archive:',
    '    print("\\n".join(archive.namelist()))',
  ].join('\n')
  const result = spawnSync(python, ['-c', script, path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error('cannot list ' + path + ': ' + result.stderr)
  return result.stdout.trim().split('\n').filter(Boolean)
}

function makeUnsafeArchive(path) {
  const script = [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1], "w") as archive:',
    '    archive.writestr("../escape.txt", "x")',
  ].join('\n')
  const result = spawnSync(python, ['-c', script, path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

function makeManifestlessArchive(path) {
  const script = [
    'import sys, zipfile',
    'with zipfile.ZipFile(sys.argv[1], "w") as archive:',
    '    archive.writestr("entry.py", "pass")',
  ].join('\n')
  const result = spawnSync(python, ['-c', script, path], { encoding: 'utf8' })
  if (result.status !== 0) throw new Error(result.stderr)
}

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-package-'))
    const trashRoot = join(tempRoot, 'trash-data')
    const profile = join(tempRoot, 'profile')
    await mkdir(join(profile, 'mloader', 'plugins'), { recursive: true })
    const env = { XDG_DATA_HOME: trashRoot }

    section('1. pack writes a portable archive')
    const plugin = await makePlugin(tempRoot, 'pkg-demo')
    const archive = join(tempRoot, 'pkg-demo.mloader.pack')
    const packed = runJson(['pack', plugin, '-o', archive, '--json'], env).payload
    check('pack reports the plugin id', packed.id === 'pkg-demo', JSON.stringify(packed))
    check('pack reports the entry count', packed.entries === 6, String(packed.entries))
    const names = zipNames(archive)
    check('the manifest is at the archive root', names.includes('mloader.plugin.json'), JSON.stringify(names))
    check('the shipped index is present', names.includes('.mloader.index.json'), JSON.stringify(names))
    check('the module is packed', names.includes('demo_module/__init__.py'), JSON.stringify(names))
    check('pyproject is packed', names.includes('pyproject.toml'), JSON.stringify(names))
    check('requirements is packed', names.includes('requirements.txt'), JSON.stringify(names))
    check('the bytecode cache is not packed', !names.some((name) => name.endsWith('.pyc')), JSON.stringify(names))

    section('2. install extracts, merges and writes the index')
    const installed = runJson(['install', archive, '--profile', profile, '--json'], env).payload
    const target = join(profile, 'mloader', 'plugins', 'pkg-demo')
    check('install reports the target directory', installed.directory === target, installed.directory)
    check('the plugin directory exists', existsSync(join(target, 'mloader.plugin.json')))
    check('requirements.txt is not extracted', !existsSync(join(target, 'requirements.txt')))
    const pyproject = await readFile(join(target, 'pyproject.toml'), 'utf8')
    check('requirements only entries are merged into pyproject', pyproject.includes('"pip>=20"'), pyproject)
    check('the merge is reported', installed.requirementsMerged.includes('pip>=20'), JSON.stringify(installed.requirementsMerged))
    const index = JSON.parse(await readFile(join(target, '.mloader.index.json'), 'utf8'))
    check('the index has schema version 1', index.schemaVersion === 1, JSON.stringify(index))
    check('the index records the archive md5', index.packageMd5 === packed.md5, index.packageMd5)
    check('the index covers the entry file', typeof index.fileMd5['entry.py'] === 'string', JSON.stringify(index.fileMd5))
    check('the index does not cover requirements.txt', index.fileMd5['requirements.txt'] === undefined, JSON.stringify(index.fileMd5))
    check('the shared environment was created', existsSync(join(profile, 'mloader', '.venv', 'bin', 'python')))

    section('3. installing the same archive twice is refused')
    const duplicate = run(['install', archive, '--profile', profile, '--json'], env)
    check('the duplicate install fails', duplicate.status !== 0, String(duplicate.status))
    check('the reason names the installed path', duplicate.stderr.includes('already installed'), duplicate.stderr)

    section('4. changed files block an update until --force')
    await appendFile(join(target, 'entry.py'), '\n# edited after install\n')
    const readme = join(plugin, 'README.md')
    await writeFile(readme, 'readme\n')
    const archive2 = join(tempRoot, 'pkg-demo-2.mloader.pack')
    runJson(['pack', plugin, '-o', archive2, '--json'], env)
    const blocked = run(['install', archive2, '--profile', profile, '--json'], env)
    check('an update over edited files fails', blocked.status !== 0, String(blocked.status))
    check('the reason names the changed file', blocked.stderr.includes('changed after installation'), blocked.stderr)
    const forced = runJson(['install', archive2, '--profile', profile, '--force', '--json'], env).payload
    check('--force performs the update', forced.updated === true, JSON.stringify(forced))
    const entry = await readFile(join(target, 'entry.py'), 'utf8')
    check('the update replaced the edited entry', !entry.includes('edited after install'), entry)
    check('the previous directory reached the trash', existsSync(join(trashRoot, 'Trash', 'files')), trashRoot)

    section('5. remove needs confirmation and moves to the trash')
    const refused = run(['remove', 'pkg-demo', '--profile', profile], env)
    check('remove without --yes fails', refused.status !== 0, String(refused.status))
    check('the reason asks for the confirmation', refused.stderr.includes('--yes'), refused.stderr)
    const removed = runJson(['remove', 'pkg-demo', '--profile', profile, '--yes', '--json'], env).payload
    check('remove reports the plugin id', removed.id === 'pkg-demo', JSON.stringify(removed))
    check('the plugin directory is gone', !existsSync(target), target)
    check('the removed directory reached the trash', existsSync(removed.trash), removed.trash)

    section('6. the dependency reader works without tomllib')
    const runtimeDir = join(repo, 'src', 'runtime', 'python_sdk')
    const fallback = spawnSync(python, ['-c', [
      'import json, sys',
      'sys.path.insert(0, ' + JSON.stringify(runtimeDir) + ')',
      'import dependencies as d',
      'd._tomllib = None',
      "text = '[project]\\nname = \"x\"\\ndependencies = [\"a>=1\"]\\nrequires-python = \">=3.10\"\\n'",
      'deps, requires = d.read_project(text)',
      'merged, added = d.merge_project_dependencies(text, ["b>=2", "a>=2"])',
      'print(json.dumps({"deps": deps, "requires": requires, "added": added, "merged": d.read_project(merged)[0]}))',
    ].join('\n')], { encoding: 'utf8' })
    check('the fallback reader exits cleanly', fallback.status === 0, fallback.stderr)
    const parsed = fallback.status === 0 ? JSON.parse(fallback.stdout.trim()) : {}
    check('the fallback reader finds the declared dependencies', JSON.stringify(parsed.deps) === '["a>=1"]', fallback.stdout)
    check('the fallback reader finds requires-python', parsed.requires === '>=3.10', JSON.stringify(parsed))
    check('the fallback merge appends only the new package', JSON.stringify(parsed.merged) === '["a>=1","b>=2"]', JSON.stringify(parsed))

    section('7. a requirements only package keeps the file and uses venv')
    const legacyPlugin = await makePlugin(tempRoot, 'legacy-demo', { pyproject: false })
    const legacyArchive = join(tempRoot, 'legacy-demo.mloader.pack')
    runJson(['pack', legacyPlugin, '-o', legacyArchive, '--json'], env)
    const legacyProfile = join(tempRoot, 'legacy-profile')
    const legacyResult = runJson(['install', legacyArchive, '--profile', legacyProfile, '--json'], env).payload
    const legacyTarget = join(legacyProfile, 'mloader', 'plugins', 'legacy-demo')
    check('the requirements only package installs', legacyResult.id === 'legacy-demo', JSON.stringify(legacyResult))
    check('requirements.txt is extracted', existsSync(join(legacyTarget, 'requirements.txt')))
    check('no pyproject is invented', !existsSync(join(legacyTarget, 'pyproject.toml')))
    check('the environment mode is python-venv', legacyResult.environment.mode === 'python-venv', JSON.stringify(legacyResult.environment))
    const legacyCfg = await readFile(join(legacyProfile, 'mloader', '.venv', 'pyvenv.cfg'), 'utf8')
    check('the venv module created the environment', legacyCfg.includes('-m venv') && !legacyCfg.includes('uv ='), legacyCfg)

    section('8. unsafe archives leave no directory behind')
    const unsafe = join(tempRoot, 'unsafe.pack')
    makeUnsafeArchive(unsafe)
    const rejected = run(['install', unsafe, '--profile', profile, '--json'], env)
    check('a path traversal entry is rejected', rejected.status !== 0, String(rejected.status))
    check('the reason names the entry', rejected.stderr.includes('not a safe relative path'), rejected.stderr)
    check('no partial plugin directory was created', !existsSync(join(tempRoot, 'escape.txt')))
    const manifestless = join(tempRoot, 'manifestless.pack')
    makeManifestlessArchive(manifestless)
    const noManifest = run(['install', manifestless, '--profile', profile, '--json'], env)
    check('a package without a manifest is rejected', noManifest.status !== 0, String(noManifest.status))
    check('the reason names the manifest', noManifest.stderr.includes('mloader.plugin.json'), noManifest.stderr)

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
  console.error('\nThe Python package suite crashed:', error)
  process.exit(1)
})
