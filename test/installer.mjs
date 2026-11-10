/**
 * Tests for package installation.
 *
 * WebAssembly packages run through the real installer against a temporary
 * profile. Python packages use an injected command runner, so the suite asserts
 * the delegation contract without creating a shared environment.
 */

import { mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { createPackageInstaller } from '../src/installer/install.js'
import {
  cleanup,
  makeTempDir,
  pythonPackage,
  wasmPackage,
  writeArchive,
} from './install-fixtures.mjs'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(detail ? `${name} [${detail}]` : name)
    console.log(`  FAIL ${name}${detail ? ` [${detail}]` : ''}`)
  }
}

async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

const root = await makeTempDir('mloader-installer-test-')
const profileDir = join(root, 'profile')
const pluginsDir = join(profileDir, 'mloader', 'plugins')
const archiveDir = join(root, 'archives')
process.env.XDG_DATA_HOME = join(root, 'xdg')
await mkdir(archiveDir, { recursive: true })
const installer = createPackageInstaller({ profileDir, pluginsDir, pythonBin: 'python3' })
const manifestOf = (id) => ({ id, name: id, version: '0.1.0', backend: 'wasm', entry: 'plugin.wasm' })

console.log('WebAssembly installation')
const first = await writeArchive(archiveDir, 'wasm-demo-1.mloader.pack', wasmPackage().bytes)
const installed = await installer.installOne(first)
check('installs a WebAssembly package', installed.status === 'installed', installed.message)
check('reports the plugin id', installed.id === 'wasm-demo')
check('reports the directory', installed.directory === join(pluginsDir, 'wasm-demo'))
check('extracts the manifest', await exists(join(pluginsDir, 'wasm-demo', 'mloader.plugin.json')))
check('extracts the module', await exists(join(pluginsDir, 'wasm-demo', 'plugin.wasm')))
const indexPath = join(pluginsDir, 'wasm-demo', '.mloader.index.json')
const index = JSON.parse(await readFile(indexPath, 'utf8'))
check('writes index schema version 1', index.schemaVersion === 1)
check('writes the plugin id', index.id === 'wasm-demo')
check('writes the archive md5', /^[0-9a-f]{32}$/u.test(index.packageMd5))
check('writes the package file name', index.packageFile === 'wasm-demo-1.mloader.pack')
check('lists the extracted files', 'plugin.wasm' in index.fileMd5 && 'mloader.plugin.json' in index.fileMd5)
check('does not list the index', !('.mloader.index.json' in index.fileMd5))
check('writes an update timestamp', typeof index.updatedAt === 'string' && index.updatedAt.endsWith('Z'))

const second = await installer.installOne(first)
check('refuses an identical archive without force', second.status === 'needs-confirmation')
check('names the identical archive', /already installed/u.test(second.message ?? ''))
const forced = await installer.installOne(first, { force: true })
check('reinstalls an identical archive with force', forced.status === 'updated', forced.message)
const forcedIndex = JSON.parse(await readFile(indexPath, 'utf8'))
check('preserves the first installation timestamp', forcedIndex.installedAt === index.installedAt)

await writeFile(join(pluginsDir, 'wasm-demo', 'plugin.wasm'), Buffer.from('edited'))
const version2 = wasmPackage({ manifest: { version: '0.2.0' } })
const changed = await installer.installOne(
  await writeArchive(archiveDir, 'wasm-demo-2.mloader.pack', version2.bytes),
)
check('refuses to replace edited files', changed.status === 'needs-confirmation')
check('names the changed file', /plugin\.wasm/u.test(changed.message ?? ''))
const replaced = await installer.installOne(
  await writeArchive(archiveDir, 'wasm-demo-3.mloader.pack', wasmPackage({ manifest: { version: '0.3.0' } }).bytes),
  { force: true },
)
check('replaces an edited installation with force', replaced.status === 'updated', replaced.message)

const trashed = await readdir(join(root, 'xdg', 'Trash', 'files')).catch(() => [])
check('moves the previous installation to the trash', trashed.length >= 1)

console.log('WebAssembly layout and update rules')
const nested = wasmPackage({
  entries: [
    { name: 'mloader.plugin.json', data: JSON.stringify(manifestOf('nested-demo')) },
    { name: 'plugin.wasm', data: Buffer.from('wasm') },
    { name: 'sub/mloader.plugin.json', data: '{}' },
    { name: 'LICENSE', data: 'MIT' },
  ],
})
const nestedResult = await installer.installOne(await writeArchive(archiveDir, 'nested.mloader.pack', nested.bytes))
check('installs a package with a nested manifest', nestedResult.status === 'installed', nestedResult.message)
check('warns about the nested manifest', nestedResult.warnings.some((line) => line.includes('another manifest')))
check('does not extract the nested directory', !(await exists(join(pluginsDir, 'nested-demo', 'sub'))))

const withoutIndex = join(pluginsDir, 'no-index-demo')
await mkdir(withoutIndex, { recursive: true })
const noIndexResult = await installer.installOne(
  await writeArchive(archiveDir, 'no-index.mloader.pack', wasmPackage({ manifest: manifestOf('no-index-demo') }).bytes),
)
check('asks for confirmation without an install index', noIndexResult.status === 'needs-confirmation')
check('names the missing index', /without an install index/u.test(noIndexResult.message ?? ''))

const newer = join(pluginsDir, 'newer-demo')
await mkdir(newer, { recursive: true })
await writeFile(join(newer, '.mloader.index.json'), JSON.stringify({ schemaVersion: 2, id: 'newer-demo' }))
const newerResult = await installer.installOne(
  await writeArchive(archiveDir, 'newer.mloader.pack', wasmPackage({ manifest: manifestOf('newer-demo') }).bytes),
  { force: true },
)
check('refuses an index from a newer loader', newerResult.status === 'failed')
check('names the newer schema', /newer loader/u.test(newerResult.message ?? ''))

console.log('batch and errors')
const good = await writeArchive(archiveDir, 'good.mloader.pack', wasmPackage({ manifest: manifestOf('good-demo') }).bytes)
const bad = await writeArchive(archiveDir, 'bad.mloader.pack', Buffer.from('not a zip'))
const batch = await installer.install([bad, good])
check('continues after a failed package', batch.length === 2 && batch[0].status === 'failed' && batch[1].status === 'installed')
const missing = await installer.installOne(join(archiveDir, 'missing.mloader.pack'))
check('reports a missing package', missing.status === 'failed' && /package not found/u.test(missing.message ?? ''))
const spaced = await writeArchive(archiveDir, 'with space.mloader.pack', wasmPackage({ manifest: manifestOf('spaced-demo') }).bytes)
const spacedResult = await installer.installOne(spaced)
check('installs a path with a space', spacedResult.status === 'installed', spacedResult.message)
const noProfile = createPackageInstaller({ pythonBin: 'python3' })
const noProfileResult = await noProfile.installOne(spaced)
check('reports a missing profile directory', noProfileResult.status === 'failed' && /plugin directory is unknown/u.test(noProfileResult.message ?? ''))

console.log('Python delegation')
const calls = []
const pythonRunner = async (args, options) => {
  calls.push({ args, options })
  return {
    stdout: JSON.stringify({ id: 'python-demo', version: '0.1.0', directory: join(pluginsDir, 'python-demo'), updated: false, warnings: ['runtime warning'] }) + '\n',
    stderr: '',
    code: 0,
    timedOut: false,
  }
}
const pythonInstaller = createPackageInstaller({ profileDir, pluginsDir, pythonBin: 'python3', pythonRunner })
const pythonArchive = await writeArchive(archiveDir, 'python-demo.mloader.pack', pythonPackage().bytes)
const pythonResult = await pythonInstaller.installOne(pythonArchive)
check('delegates a Python package', pythonResult.status === 'installed', pythonResult.message)
check('reports the Python backend', pythonResult.backend === 'python')
check('merges the command line warnings', pythonResult.warnings.includes('runtime warning'))
const delegated = calls[0]
check('passes install and the archive', delegated.args[1] === 'install' && delegated.args[2] === pythonArchive)
check('passes the profile and plugin directory', delegated.args.includes('--profile') && delegated.args.includes('--plugins-dir'))
check('passes the JSON switch', delegated.args.includes('--json'))
check('does not force a plain install', !delegated.args.includes('--force'))
await pythonInstaller.installOne(pythonArchive, { force: true })
check('passes force to a confirmed install', calls[1].args.includes('--force'))

const failingInstaller = createPackageInstaller({
  profileDir,
  pluginsDir,
  pythonBin: 'python3',
  pythonRunner: async () => ({ stdout: '', stderr: 'error: the env is broken\n', code: 1, timedOut: false }),
})
const failing = await failingInstaller.installOne(pythonArchive)
check('reports a Python command failure', failing.status === 'failed' && /env is broken/u.test(failing.message ?? ''))

const timeoutInstaller = createPackageInstaller({
  profileDir,
  pluginsDir,
  pythonBin: 'python3',
  pythonRunner: async () => ({ stdout: '', stderr: '', code: null, timedOut: true }),
})
const timedOut = await timeoutInstaller.installOne(pythonArchive)
check('reports a Python command timeout', timedOut.status === 'failed' && /timed out/u.test(timedOut.message ?? ''))

console.log('removal')
const removeTarget = join(pluginsDir, 'wasm-demo')
check('the plugin is installed before removal', await exists(removeTarget))
const edited = join(removeTarget, 'plugin.wasm')
await writeFile(edited, Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x02, 0x00, 0x00, 0x00]))
const pendingRemove = await installer.remove('wasm-demo')
check('an edited installation needs confirmation', pendingRemove.status === 'needs-confirmation', pendingRemove.message)
check('the confirmation names the edited file', (pendingRemove.changed ?? []).includes('plugin.wasm'),
  JSON.stringify(pendingRemove.changed))
check('nothing was removed yet', await exists(removeTarget))
const removed = await installer.remove('wasm-demo', { force: true })
check('a forced removal succeeds', removed.status === 'removed', removed.message)
check('the directory is gone', !(await exists(removeTarget)))
check('the removal reports the trash destination', typeof removed.trash === 'string' && removed.trash.length > 0)
check('the trash holds the removed directory', await exists(removed.trash))
const missingRemove = await installer.remove('wasm-demo')
check('removing a plugin that is not installed fails', missingRemove.status === 'failed', missingRemove.message)
check('the failure names the id', /not installed/u.test(missingRemove.message ?? ''))
const badId = await installer.remove('../escape')
check('removing an invalid id fails', badId.status === 'failed', badId.message)
check('the invalid id failure is explicit', /not a valid plugin id/u.test(badId.message ?? ''))

const handPlaced = join(pluginsDir, 'hand-placed')
await mkdir(handPlaced, { recursive: true })
await writeFile(join(handPlaced, 'mloader.plugin.json'), JSON.stringify(manifestOf('hand-placed')))
const noIndex = await installer.remove('hand-placed')
check('a hand-placed directory needs confirmation', noIndex.status === 'needs-confirmation', noIndex.message)
check('the reason names the missing index', /no install index/u.test(noIndex.message ?? ''))
const removedHandPlaced = await installer.remove('hand-placed', { force: true })
check('a hand-placed directory removes with force', removedHandPlaced.status === 'removed', removedHandPlaced.message)
check('the hand-placed directory is gone', !(await exists(handPlaced)))

const profilelessInstaller = createPackageInstaller({ pythonBin: 'python3' })
const profilelessRemove = await profilelessInstaller.remove('anything')
check('removal without a profile directory fails', profilelessRemove.status === 'failed', profilelessRemove.message)
check('the failure names the missing directory', /plugin directory is unknown/u.test(profilelessRemove.message ?? ''))

await cleanup(root)

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nAll passed: ${passed} assertions`)
}
