/**
 * Bundled example release test.
 *
 * Verifies that installing the loader into a profile releases only the complete
 * Python example and leaves the source-only WebAssembly example in the package.
 * Covered:
 *   1. The complete Python example and the source-only wasm example are present.
 *   2. First release: only the Python example lands and its content is complete.
 *   3. An existing copy is replaced on the next release.
 *   4. Idempotence: repeated runs leave the same file set.
 *   5. The reserved id is rejected without the built-in marker.
 *   6. `seedExamples: false` does not touch the disk.
 *   7. An unwritable target does not break the loader (warning only).
 *   8. End to end: release, discovery, apply, a callable tool and the pair of example commands.
 *   9. The released example is a valid plugin (manifest and tool schema).
 */

import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
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
    check('it contains the source-only wasm example', seedNames.includes('wasm-mloader'), JSON.stringify(seedNames))

    const helloDir = join(SEED_DIR, 'hello-mloader')
    const helloFiles = await readdir(helloDir)
    check('the example has mloader.plugin.json', helloFiles.includes('mloader.plugin.json'), JSON.stringify(helloFiles))
    check('the example has plugin.py', helloFiles.includes('plugin.py'), JSON.stringify(helloFiles))
    check('the example has the built-in marker', helloFiles.includes('.mloader.builtin.json'), JSON.stringify(helloFiles))

    const wasmDir = join(SEED_DIR, 'wasm-mloader')
    const wasmFiles = await readdir(wasmDir)
    check('the wasm example ships as source', wasmFiles.includes('Cargo.toml') && wasmFiles.includes('build.sh'),
      JSON.stringify(wasmFiles))
    check('the wasm example has no release manifest', !wasmFiles.includes('mloader.plugin.json'),
      JSON.stringify(wasmFiles))
    check('the wasm example has a manifest template', wasmFiles.includes('mloader.plugin.json.in'),
      JSON.stringify(wasmFiles))

    // The complete example must pass discovery; the source-only one must not appear.
    const foundSeed = await discover([SEED_DIR], null)
    check('the example passes discovery validation', foundSeed.specs.length >= 1, JSON.stringify(foundSeed.errors))
    check('only hello-mloader is discovered', foundSeed.specs.length === 1 && foundSeed.specs[0].id === 'hello-mloader',
      JSON.stringify(foundSeed.specs.map((spec) => spec.id)))

    section('1b. The reserved id needs the built-in marker')
    const reservedRoot = join(tempRoot, 'reserved-root')
    await mkdir(reservedRoot, { recursive: true })
    await writeFile(
      join(reservedRoot, 'mloader.plugin.json'),
      JSON.stringify({ id: 'hello-mloader', backend: 'python', entry: 'plugin.py' }),
    )
    await writeFile(join(reservedRoot, 'plugin.py'), 'pass\n')
    const rejectedReserved = await discover([reservedRoot], null)
    check('a reserved id without the marker is rejected', rejectedReserved.specs.length === 0 && rejectedReserved.errors.length === 1,
      JSON.stringify(rejectedReserved))
    check('the reason names the reservation', rejectedReserved.errors[0]?.message.includes('reserved'),
      JSON.stringify(rejectedReserved.errors))
    await writeFile(
      join(reservedRoot, '.mloader.builtin.json'),
      JSON.stringify({ schemaVersion: 1, id: 'hello-mloader', source: 'dsh-mloader' }),
    )
    const admittedReserved = await discover([reservedRoot], null)
    check('the built-in marker admits the reserved id', admittedReserved.specs.some((spec) => spec.id === 'hello-mloader'),
      JSON.stringify(admittedReserved))

    section('2. First release')
    const profileA = join(tempRoot, 'profile-a')
    const targetA = join(profileA, 'mloader', 'plugins')
    const loggerA = makeLogger()
    const first = await installSeedExamples(targetA, loggerA)

    check('hello-mloader was released', first.installed.includes('hello-mloader'), JSON.stringify(first))
    check('only the complete Python example was released', first.installed.length === 1 && !first.installed.includes('wasm-mloader'),
      JSON.stringify(first))
    check('nothing was replaced on the first run', first.replaced.length === 0, JSON.stringify(first.replaced))

    check('the source-only wasm example was not copied', !existsSync(join(targetA, 'wasm-mloader')),
      JSON.stringify(await readdir(targetA)))
    const installedDir = join(targetA, 'hello-mloader')
    const installedFiles = await readdir(installedDir)
    check('the target holds the manifest', installedFiles.includes('mloader.plugin.json'), JSON.stringify(installedFiles))
    check('the target holds plugin.py', installedFiles.includes('plugin.py'), JSON.stringify(installedFiles))

    const sourcePy = await readFile(join(helloDir, 'plugin.py'), 'utf8')
    const targetPy = await readFile(join(installedDir, 'plugin.py'), 'utf8')
    check('content matches the packaged copy', sourcePy === targetPy)

    section('3. An existing copy is replaced')
    await writeFile(join(installedDir, 'plugin.py'), '# content edited by the user\n')
    await writeFile(join(installedDir, 'my-notes.txt'), 'my notes')

    const loggerB = makeLogger()
    const second = await installSeedExamples(targetA, loggerB)
    check('the second run replaces the existing example', second.replaced.includes('hello-mloader'), JSON.stringify(second))
    check('the second run installs nothing new', second.installed.length === 0, JSON.stringify(second.installed))

    const afterEdit = await readFile(join(installedDir, 'plugin.py'), 'utf8')
    check('plugin.py matches the packaged copy again', afterEdit === sourcePy, afterEdit.slice(0, 40))
    const afterFiles = await readdir(installedDir)
    check('the user added file is removed', !afterFiles.includes('my-notes.txt'), JSON.stringify(afterFiles))

    section('4. Idempotence: repeated runs leave the same file set')
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

    section('7. End to end: release, discover, apply, call tools and run the commands')
    const profileD = join(tempRoot, 'profile-d')
    const root = new Context()
    const loggerD = makeLogger()
    root.provide('logger', loggerD)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    root.plugin(CommandRuntime, {})
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

    const commands = root.get('commands')
    const commandAgent = { id: 'seed-command', session: { append() {} } }
    check(
      'the example registers /hello-mloader with its input hint',
      commands?.find(commandAgent, 'hello-mloader')?.input?.hint === 'who',
      JSON.stringify(commands?.find(commandAgent, 'hello-mloader')),
    )
    const commandRun = await commands.execute(commandAgent, '/hello-mloader Ada', [], new AbortController().signal)
    check('the example command succeeds', commandRun?.result?.kind === 'success', JSON.stringify(commandRun))
    const commandText = commandRun?.result?.text ?? ''
    check(
      'the example command returns multi-line text so the chat card can expand it',
      commandText.split('\n').length >= 2,
      JSON.stringify(commandRun?.result),
    )
    check('the example command greets its input', commandText.includes('Hello, Ada!'), JSON.stringify(commandRun?.result))

    check(
      'the example exposes hello_add as /hello-add',
      commands?.find(commandAgent, 'hello-add')?.input?.hint === 'a b',
      JSON.stringify(commands?.find(commandAgent, 'hello-add')),
    )
    const addRun = await commands.execute(commandAgent, '/hello-add 2 40', [], new AbortController().signal)
    const addText = addRun?.result?.text ?? ''
    check('the addition command succeeds', addRun?.result?.kind === 'success', JSON.stringify(addRun))
    check(
      'the addition command computes the sum and returns multi-line text',
      addText.includes('= 42') && addText.split('\n').length >= 2,
      JSON.stringify(addRun?.result),
    )
    const badAddRun = await commands.execute(commandAgent, '/hello-add nope', [], new AbortController().signal)
    check(
      'the addition command reports a usage error',
      badAddRun?.result?.kind === 'error' && (badAddRun?.result?.text ?? '').startsWith('Usage:'),
      JSON.stringify(badAddRun?.result),
    )

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

    section('8. The released example is refreshed on the next start')
    const installedD = join(profileD, 'mloader', 'plugins', 'hello-mloader')
    await writeFile(join(installedD, 'plugin.py'), '# edited before the next start\n')
    await writeFile(join(installedD, 'user-extra.txt'), 'extra')
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
    const refreshedPy = await readFile(join(installedD, 'plugin.py'), 'utf8')
    check('the next start replaces the edited entry', refreshedPy === sourcePy, refreshedPy.slice(0, 40))
    const filesAfter = await readdir(installedD)
    check('the next start removes extra files', !filesAfter.includes('user-extra.txt'), JSON.stringify(filesAfter))
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
