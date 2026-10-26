/**
 * Bundled example plugin (seed) test.
 *
 * Verifies that installing the loader into a profile releases the example plugin
 * for the operator to read and edit. Covered:
 *   1. First release: files land and content is complete.
 *   2. User changes are never overwritten.
 *   3. Idempotence: repeated runs change nothing.
 *   4. `seedExamples: false` does not touch the disk.
 *   5. An unwritable target does not break the loader (warning only).
 *   6. End to end: release, discovery, apply and a callable tool.
 *   7. The released example is a valid plugin (manifest and tool schema).
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { installSeedExamples, SEED_DIR } from '../src/seed.js'
import { discover } from '../src/discovery.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ok   ${name}`)
  } else {
    failures.push(detail ? `${name} [${detail}]` : name)
    console.log(`  FAIL ${name}${detail ? ` [${detail}]` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

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

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-seed-'))

    section('1. The bundled example exists and is complete')
    const seedEntries = await readdir(SEED_DIR, { withFileTypes: true })
    const seedNames = seedEntries.filter((entry) => entry.isDirectory()).map((entry) => entry.name)
    check('seed directory holds at least one example', seedNames.length >= 1, JSON.stringify(seedNames))
    check('it contains hello-mloader', seedNames.includes('hello-mloader'), JSON.stringify(seedNames))

    const helloDir = join(SEED_DIR, 'hello-mloader')
    const helloFiles = await readdir(helloDir)
    check('the example has mloader.plugin.json', helloFiles.includes('mloader.plugin.json'), JSON.stringify(helloFiles))
    check('the example has plugin.py', helloFiles.includes('plugin.py'), JSON.stringify(helloFiles))

    // The example must pass discovery, otherwise releasing it would be pointless.
    const foundSeed = await discover([SEED_DIR], null)
    check('the example passes discovery validation', foundSeed.specs.length >= 1, JSON.stringify(foundSeed.errors))
    check('the example id is hello-mloader', foundSeed.specs.some((spec) => spec.id === 'hello-mloader'),
      JSON.stringify(foundSeed.specs.map((spec) => spec.id)))

    section('2. First release')
    const profileA = join(tempRoot, 'profile-a')
    const targetA = join(profileA, 'mloader', 'plugins')
    const loggerA = makeLogger()
    const first = await installSeedExamples(targetA, loggerA)

    check('hello-mloader was released', first.installed.includes('hello-mloader'), JSON.stringify(first))
    check('no example was skipped', first.skipped.length === 0, JSON.stringify(first.skipped))

    const installedDir = join(targetA, 'hello-mloader')
    const installedFiles = await readdir(installedDir)
    check('the target holds the manifest', installedFiles.includes('mloader.plugin.json'), JSON.stringify(installedFiles))
    check('the target holds plugin.py', installedFiles.includes('plugin.py'), JSON.stringify(installedFiles))

    const sourcePy = await readFile(join(helloDir, 'plugin.py'), 'utf8')
    const targetPy = await readFile(join(installedDir, 'plugin.py'), 'utf8')
    check('content matches the packaged copy', sourcePy === targetPy)

    section('3. User changes are never overwritten')
    await writeFile(join(installedDir, 'plugin.py'), '# content edited by the user\n')
    await writeFile(join(installedDir, 'my-notes.txt'), 'my notes')

    const loggerB = makeLogger()
    const second = await installSeedExamples(targetA, loggerB)
    check('the second run skips the existing example', second.skipped.includes('hello-mloader'), JSON.stringify(second))
    check('the second run installs nothing', second.installed.length === 0, JSON.stringify(second.installed))

    const afterEdit = await readFile(join(installedDir, 'plugin.py'), 'utf8')
    check('the user edited plugin.py is preserved', afterEdit.includes('content edited by the user'), afterEdit.slice(0, 40))
    const afterNotes = await readFile(join(installedDir, 'my-notes.txt'), 'utf8')
    check('the user added file is preserved', afterNotes === 'my notes')

    section('4. Idempotence: repeated runs have no side effect')
    const snapshots = []
    for (let i = 0; i < 3; i++) {
      await installSeedExamples(targetA, makeLogger())
      const files = (await readdir(installedDir)).sort()
      snapshots.push(files.join(','))
    }
    check('three runs leave the file list unchanged', new Set(snapshots).size === 1, JSON.stringify(snapshots))

    section('5. seedExamples: false does not touch the disk')
    const profileB = join(tempRoot, 'profile-b')
    const targetB = join(profileB, 'mloader', 'plugins')

    const rootB = new Context()
    const loggerB2 = makeLogger()
    rootB.provide('logger', loggerB2)
    rootB.provide('systemPrompt', systemPromptStub())
    rootB.plugin(ToolRuntime, {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    const fiberB = rootB.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: profileB, seedExamples: false, console: false, pythonBin: 'python3', statusTool: false, command: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 1200))

    let targetBCreated = true
    try {
      await readdir(targetB)
    } catch {
      targetBCreated = false
    }
    check('the target plugin directory was not created', targetBCreated === false, String(targetBCreated))
    await fiberB.dispose()
    await new Promise((resolve) => setTimeout(resolve, 300))

    section('6. An unwritable target warns without throwing')
    const readOnlyBase = join(tempRoot, 'readonly')
    await mkdir(readOnlyBase, { recursive: true })
    await chmod(readOnlyBase, 0o500)
    const loggerC = makeLogger()
    let threw = false
    try {
      await installSeedExamples(join(readOnlyBase, 'mloader', 'plugins'), loggerC)
    } catch {
      threw = true
    }
    check('no exception was thrown', threw === false)
    await chmod(readOnlyBase, 0o700)

    section('7. End to end: release, discover, apply and call tools')
    const profileD = join(tempRoot, 'profile-d')
    const root = new Context()
    const loggerD = makeLogger()
    root.provide('logger', loggerD)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await new Promise((resolve) => setTimeout(resolve, 200))

    // Only a profile directory is given: discovery and seeding are automatic.
    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: profileD, pythonBin: 'python3' },
    )
    await new Promise((resolve) => setTimeout(resolve, 4000))

    const mloader = root.get('mloader')
    const list = mloader?.list() ?? []
    check('the example is discovered automatically', list.some((plugin) => plugin.id === 'hello-mloader'), JSON.stringify(list.map((plugin) => plugin.id)))
    check('the example state is applied', list.find((plugin) => plugin.id === 'hello-mloader')?.state === 'applied',
      JSON.stringify(list.map((plugin) => `${plugin.id}:${plugin.state}`)))

    const tools = root.get('tools')
    const names = tools.schemas().map((schema) => schema.name)
    check('hello_mloader is registered', names.includes('hello_mloader'), JSON.stringify(names))
    check('hello_add is registered', names.includes('hello_add'), JSON.stringify(names))

    const greet = await tools.get('hello_mloader').execute({ who: 'mloader', excited: true })
    check('hello_mloader returns the greeting', greet?.message === 'Hello, mloader!', JSON.stringify(greet))
    check('the result carries the plugin name', greet?.plugin === 'hello-mloader', JSON.stringify(greet))

    const sum = await tools.get('hello_add').execute({ a: 2, b: 40 })
    check('hello_add sums correctly', sum?.sum === 42, JSON.stringify(sum))

    let rejected = false
    try {
      await tools.get('hello_add').execute({ a: 1 })
    } catch {
      rejected = true
    }
    check('a missing required argument is rejected', rejected === true)

    await fiber.dispose()
    await new Promise((resolve) => setTimeout(resolve, 600))

    section('8. The released example is not overwritten on the next start')
    const filesBefore = (await readdir(join(profileD, 'mloader', 'plugins', 'hello-mloader'))).sort()
    const root2 = new Context()
    root2.provide('logger', makeLogger())
    root2.provide('systemPrompt', systemPromptStub())
    root2.plugin(ToolRuntime, {})
    await new Promise((resolve) => setTimeout(resolve, 200))
    const fiber2 = root2.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: profileD, pythonBin: 'python3', statusTool: false, command: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 2500))
    const filesAfter = (await readdir(join(profileD, 'mloader', 'plugins', 'hello-mloader'))).sort()
    check('the file list stays the same', filesBefore.join(',') === filesAfter.join(','),
      `${filesBefore.join(',')} vs ${filesAfter.join(',')}`)
    const stillApplied = (root2.get('mloader')?.list() ?? []).find((plugin) => plugin.id === 'hello-mloader')
    check('the second start still reports applied', stillApplied?.state === 'applied', JSON.stringify(stillApplied))
    await fiber2.dispose()
    await new Promise((resolve) => setTimeout(resolve, 400))

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
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\nTest script crashed:', error)
  process.exit(1)
})
