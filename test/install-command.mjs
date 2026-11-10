/**
 * Tests for the /mloader install forms.
 *
 * The suite registers the real command handler on a capture double for the
 * dsh commands service, then drives the handler directly. The installer and the
 * lifecycle transitions are fakes, so the suite asserts dispatch, confirmation
 * state and summary rendering only.
 */

import { registerMloaderCommand } from '../src/commands/mloader.js'

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

function snapshot(id, state = 'applied', backend = 'wasm') {
  return { id, name: id, version: '0.1.0', backend, state, tools: [], events: [], registrations: 0 }
}

function installed(path, overrides = {}) {
  return {
    path,
    status: 'installed',
    id: path.replace(/\.pack$/u, ''),
    version: '0.1.0',
    backend: 'wasm',
    directory: `/plugins/${path.replace(/\.pack$/u, '')}`,
    warnings: [],
    ...overrides,
  }
}

function needs(path, message = 'the archive is already installed') {
  return { path, status: 'needs-confirmation', id: 'demo', version: '0.1.0', backend: 'wasm', warnings: [], message }
}

function failed(path, message = 'broken archive') {
  return { path, status: 'failed', warnings: [], message }
}

function makeTarget(options = {}) {
  const calls = []
  const target = {
    list: () => options.snapshots ?? [],
    enable: async (id) => {
      calls.push({ call: 'enable', id })
      return snapshot(id)
    },
    disable: async (id) => {
      calls.push({ call: 'disable', id })
      return snapshot(id, 'disabled')
    },
    reload: async (id) => {
      calls.push({ call: 'reload', id })
      return snapshot(id)
    },
  }
  if (options.withInstall !== false) {
    target.install = async (paths, callOptions) => {
      calls.push({ call: 'install', paths, options: callOptions })
      return options.install === undefined
        ? paths.map((path) => installed(path))
        : await options.install(paths, callOptions)
    }
  }
  if (options.withRemove !== false) {
    target.remove = async (id, callOptions) => {
      calls.push({ call: 'remove', id, options: callOptions })
      return options.remove === undefined
        ? { id, status: 'removed', directory: `/plugins/${id}`, trash: `/trash/${id}` }
        : await options.remove(id, callOptions)
    }
  }
  return { target, calls }
}

function setup(target, name = 'mloader') {
  let command
  const ctx = {
    get: (service) => service === 'commands'
      ? { register(definition) { command = definition; return () => undefined } }
      : undefined,
  }
  registerMloaderCommand(ctx, target, undefined, name)
  return command
}

const same = (left, right) => JSON.stringify(left) === JSON.stringify(right)

function removed(id, overrides = {}) {
  return { id, status: 'removed', directory: `/plugins/${id}`, trash: `/trash/${id}`, ...overrides }
}

console.log('install forms')
{
  const { target, calls } = makeTarget()
  const command = setup(target)
  const result = await command.handler({ rawInput: 'install a.pack b.pack' })
  check('installs two packages', result.kind === 'success', result.text)
  check('summarizes the installed count', result.text.includes('2 package(s) installed'))
  check('addresses the paths in order', same(calls[0].paths, ['a.pack', 'b.pack']))
  check('does not force the first attempt', calls[0].options.force === false)
}
{
  let round = 0
  const { target, calls } = makeTarget({
    install: (paths) => {
      round += 1
      return round === 1 ? paths.map((path) => needs(path)) : paths.map((path) => installed(path))
    },
  })
  const command = setup(target)
  const first = await command.handler({ rawInput: 'install a.pack' })
  check('reports the pending confirmation', first.kind === 'error' && first.text.includes('need confirmation'))
  check('names the confirmation command', first.text.includes('/mloader ok'))
  const confirmed = await command.handler({ rawInput: 'ok' })
  check('ok installs the pending package', confirmed.kind === 'success', confirmed.text)
  check('ok forces the pending paths', calls[1].options.force === true && same(calls[1].paths, ['a.pack']))
}
{
  let round = 0
  const { target, calls } = makeTarget({
    install: (paths) => {
      round += 1
      return round === 1 ? paths.map((path) => needs(path)) : paths.map((path) => installed(path))
    },
  })
  const command = setup(target)
  await command.handler({ rawInput: 'install a.pack' })
  const repeated = await command.handler({ rawInput: 'install a.pack' })
  check('repeating the same input confirms it', repeated.kind === 'success', repeated.text)
  check('the repeat forces only the pending paths', calls[1].options.force === true && same(calls[1].paths, ['a.pack']))
}
{
  let round = 0
  const { target, calls } = makeTarget({
    install: (paths) => {
      round += 1
      return round === 1 ? paths.map((path) => needs(path)) : paths.map((path) => installed(path))
    },
  })
  const command = setup(target)
  await command.handler({ rawInput: 'install a.pack' })
  await command.handler({ rawInput: 'install b.pack' })
  check('a different install does not confirm the pending one', calls[1].options.force === false && same(calls[1].paths, ['b.pack']))
}
{
  const { target } = makeTarget()
  const command = setup(target)
  const result = await command.handler({ rawInput: 'ok' })
  check('ok without a pending batch reports nothing to confirm', result.kind === 'error' && result.text.includes('Nothing to confirm'))
}
{
  const { target, calls } = makeTarget()
  const command = setup(target)
  await command.handler({ rawInput: 'install "my file.pack" other.mloader.pack' })
  check('keeps a quoted path together', same(calls[0].paths, ['my file.pack', 'other.mloader.pack']))
}
{
  const { target } = makeTarget()
  const command = setup(target)
  const result = await command.handler({ rawInput: 'install "unterminated' })
  check('reports an unterminated quote', result.kind === 'error' && result.text.includes('unterminated'))
}
{
  const { target } = makeTarget({ withInstall: false })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'install a.pack' })
  check('reports unavailable installation', result.kind === 'error' && result.text.includes('unavailable'))
}

console.log('summary, reload and failures')
{
  const { target, calls } = makeTarget({
    snapshots: [snapshot('reload-demo', 'applied')],
    install: (paths) => paths.map((path) => installed(path, { id: 'reload-demo' })),
  })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'install demo.pack' })
  check('reloads an updated loaded plugin', calls.some((call) => call.call === 'reload' && call.id === 'reload-demo'))
  check('reports the reload', result.text.includes('reloaded reload-demo'))
}
{
  const { target } = makeTarget({
    install: (paths) => [failed(paths[0]), installed(paths[1])],
  })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'install bad.pack good.pack' })
  check('renders a partial batch as an error', result.kind === 'error')
  check('keeps the successful package in the summary', result.text.includes('1 package(s) installed'))
  check('names the failed package', result.text.includes('bad.pack') && result.text.includes('broken archive'))
}
{
  const { target } = makeTarget({ install: () => [] })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'install nothing.pack' })
  check('handles an empty installer reply', result.text.includes('No package was installed'))
}

console.log('uninstall forms')
{
  const { target, calls } = makeTarget({ snapshots: [snapshot('plugin-a', 'applied')] })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'uninstall plugin-a' })
  check('removes a loaded plugin', result.kind === 'success', result.text)
  check('unloads before removing', calls[0]?.call === 'disable', JSON.stringify(calls))
  check('then removes it', calls[1]?.call === 'remove', JSON.stringify(calls))
  check('does not force the first attempt', calls[1].options.force === false)
  check('reports the trash destination', result.text.includes('/trash/plugin-a'), result.text)
}
{
  const { target, calls } = makeTarget({ snapshots: [snapshot('plugin-a', 'discovered')] })
  const command = setup(target)
  await command.handler({ rawInput: 'remove plugin-a' })
  check('a discovered plugin is not unloaded first', calls.every((call) => call.call !== 'disable'),
    JSON.stringify(calls))
  check('it is still removed', calls.some((call) => call.call === 'remove'))
}
{
  const { target, calls } = makeTarget({
    remove: (id, options) => (options.force
      ? removed(id, { changed: ['plugin.wasm'] })
      : { id, status: 'needs-confirmation', directory: `/plugins/${id}`, message: '2 file(s) were edited after installation: plugin.wasm' }),
  })
  const command = setup(target)
  const first = await command.handler({ rawInput: 'uninstall plugin-a' })
  check('an edited installation asks first', first.kind === 'error' && first.text.includes('needs confirmation'), first.text)
  check('the reason is shown', first.text.includes('edited after installation'), first.text)
  check('the force form is named', first.text.includes('--force'), first.text)
  const confirmed = await command.handler({ rawInput: 'ok' })
  check('ok confirms the pending removal', confirmed.kind === 'success', confirmed.text)
  check('ok forces the removal', calls.at(-1).options.force === true, JSON.stringify(calls))
}
{
  const { target, calls } = makeTarget({
    remove: (id) => ({ id, status: 'removed', directory: `/plugins/${id}`, trash: `/trash/${id}`, changed: ['plugin.wasm'] }),
  })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'uninstall plugin-a --force' })
  check('the force form removes directly', result.kind === 'success', result.text)
  check('force is passed through', calls[0].options.force === true)
  check('edited files are reported', result.text.includes('1 edited file'), result.text)
}
{
  const { target } = makeTarget()
  const command = setup(target)
  const bare = await command.handler({ rawInput: 'uninstall' })
  check('a bare uninstall asks for usage', bare.kind === 'error' && bare.text.includes('uninstall <id>'), bare.text)
}
{
  const { target } = makeTarget({
    remove: (id) => ({ id, status: 'failed', message: `plugin "${id}" is not installed` }),
  })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'uninstall missing' })
  check('a failed removal reports the reason', result.kind === 'error' && result.text.includes('is not installed'), result.text)
}
{
  const { target } = makeTarget({ snapshots: [snapshot('plugin-a', 'applied')] })
  delete target.remove
  const command = setup(target)
  const result = await command.handler({ rawInput: 'uninstall plugin-a' })
  check('a missing remove capability is reported', result.kind === 'error' && result.text.includes('unavailable'), result.text)
}
{
  const { target } = makeTarget({ snapshots: [snapshot('plugin-a', 'applied')] })
  const command = setup(target)
  await command.handler({ rawInput: 'uninstall plugin-a' })
  const again = await command.handler({ rawInput: 'ok' })
  check('a completed removal leaves nothing pending', again.kind === 'error' && again.text.includes('Nothing to confirm'), again.text)
}

console.log('unchanged forms')
{
  const { target, calls } = makeTarget({ snapshots: [snapshot('plugin-a', 'discovered')] })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'load plugin-a' })
  check('load still calls enable', result.kind === 'success' && calls[0]?.call === 'enable')
}
{
  const { target } = makeTarget()
  const command = setup(target)
  const result = await command.handler({ rawInput: 'help' })
  check('help lists the install form', result.kind === 'success' && result.text.includes('install <file>'))
  check('help lists the uninstall form', result.kind === 'success' && result.text.includes('uninstall <id>'))
  const bare = await command.handler({ rawInput: 'install' })
  check('a bare install word asks for usage', bare.kind === 'error' && bare.text.includes('Usage:'))
}
{
  const { target } = makeTarget({ snapshots: [] })
  const command = setup(target)
  const result = await command.handler({ rawInput: 'status' })
  check('status still lists plugins', result.kind === 'success')
}

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nAll passed: ${passed} assertions`)
}
