/**
 * Tests for plugin package validation.
 *
 * Each case writes one archive to a temporary directory and asks the package
 * layer to open it, covering the shared archive rules and the manifest grammar.
 */

import { openPackage, PackageError } from '../src/installer/package.js'
import {
  buildZip,
  cleanup,
  makeTempDir,
  pythonPackage,
  wasmPackage,
  writeArchive,
} from './install-fixtures.mjs'

const failures = []
let passed = 0
const directory = await makeTempDir('mloader-package-test-')
let counter = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed += 1
    console.log(`  ok   ${name}`)
  } else {
    failures.push(detail ? `${name} [${detail}]` : name)
    console.log(`  FAIL ${name}${detail ? ` [${detail}]` : ''}`)
  }
}

async function write(bytes) {
  counter += 1
  return await writeArchive(directory, `package-${counter}.mloader.pack`, bytes)
}

async function rejects(name, bytes, pattern) {
  try {
    await openPackage(await write(bytes))
  } catch (error) {
    check(name, error instanceof PackageError && pattern.test(error.message), error.message)
    return
  }
  check(name, false, 'no error was raised')
}

async function accepts(name, bytes) {
  try {
    const opened = await openPackage(await write(bytes))
    check(name, true)
    return opened
  } catch (error) {
    check(name, false, error.message)
    return undefined
  }
}

console.log('valid packages')
const wasm = await accepts('opens a WebAssembly package', wasmPackage().bytes)
if (wasm !== undefined) {
  check('detects the WebAssembly backend', wasm.backend === 'wasm')
  check('reads the manifest id', wasm.manifest.id === 'wasm-demo')
  check('reads the manifest entry', wasm.manifest.entry === 'plugin.wasm')
  check('computes the archive MD5', /^[0-9a-f]{32}$/u.test(wasm.archiveMd5))
  check('keeps the entry archive entry', wasm.entryEntry.name === 'plugin.wasm')
  check('has no warnings', wasm.warnings.length === 0)
}
const python = await accepts('opens a Python package', pythonPackage().bytes)
if (python !== undefined) check('detects the Python backend', python.backend === 'python')

const nested = await accepts(
  'accepts a nested manifest with a warning',
  buildZip([
    { name: 'mloader.plugin.json', data: JSON.stringify({ id: 'nested-demo', backend: 'python', entry: 'entry.py' }) },
    { name: 'entry.py', data: 'print(1)\n' },
    { name: 'sub/mloader.plugin.json', data: '{}' },
  ]),
)
if (nested !== undefined) {
  check('warns about the nested manifest', nested.warnings.some((line) => line.includes('another manifest')))
}

console.log('archive safety')
await rejects(
  'rejects a missing manifest',
  buildZip([{ name: 'entry.py', data: 'print(1)\n' }]),
  /has no mloader\.plugin\.json at its root/u,
)
await rejects(
  'rejects a traversal entry',
  buildZip([{ name: '../evil.txt', data: 'x' }]),
  /not a safe relative path/u,
)
await rejects(
  'rejects an absolute entry',
  buildZip([{ name: '/etc/passwd', data: 'x' }]),
  /is absolute/u,
)
await rejects(
  'rejects a backslash entry',
  buildZip([{ name: 'dir\\file.txt', data: 'x' }]),
  /uses a backslash/u,
)
await rejects(
  'rejects a symbolic link entry',
  buildZip([{ name: 'link', data: 'target', externalAttributes: 0o120777 << 16 }]),
  /is a symbolic link/u,
)
await rejects(
  'rejects an encrypted entry',
  buildZip([{ name: 'entry.py', data: 'x', flags: 1 }]),
  /is encrypted/u,
)
await rejects(
  'rejects duplicate names',
  buildZip([
    { name: 'entry.py', data: 'x' },
    { name: 'Entry.py', data: 'y' },
  ]),
  /more than once/u,
)
await rejects(
  'rejects an over long entry list',
  buildZip(Array.from({ length: 4097 }, (_, index) => ({ name: `file-${index}.txt`, data: '' }))),
  /more than 4096 entries/u,
)
await rejects(
  'rejects an oversized unpacked archive',
  buildZip([{ name: 'big.bin', data: 'x', claimUncompressedSize: 512 * 1024 * 1024 + 1 }]),
  /expands past 512 MiB|expands past \d+ bytes/u,
)

console.log('manifest grammar')
await rejects(
  'rejects an invalid plugin id',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"Bad Id","backend":"python","entry":"entry.py"}' }]),
  /id must match/u,
)
await rejects(
  'rejects the reserved example id',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"hello-mloader","backend":"python","entry":"entry.py"}' }]),
  /reserved for the bundled example/u,
)
await rejects(
  'rejects an unknown backend',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"demo","backend":"native","entry":"entry.py"}' }]),
  /backend must be "python" or "wasm"/u,
)
await rejects(
  'rejects an entry with a separator',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"demo","backend":"python","entry":"sub/entry.py"}' }]),
  /entry must name a file at the plugin root/u,
)
await rejects(
  'rejects an entry that escapes the plugin root',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"demo","backend":"python","entry":"../entry.py"}' }]),
  /entry must name a file at the plugin root/u,
)
await rejects(
  'rejects an entry that names the plugin root itself',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"demo","backend":"python","entry":".."}' }]),
  /entry must name a file at the plugin root/u,
)
await rejects(
  'rejects a manifest entry that the archive lacks',
  buildZip([{ name: 'mloader.plugin.json', data: '{"id":"demo","backend":"python","entry":"entry.py"}' }]),
  /is not a file at the archive root/u,
)
await rejects(
  'rejects a WebAssembly shebang',
  Buffer.concat([
    Buffer.from('#!/usr/bin/env python3\n'),
    wasmPackage().bytes,
  ]),
  /must not begin with a shebang/u,
)
await rejects(
  'rejects a WebAssembly package with a root main module',
  buildZip([
    { name: 'mloader.plugin.json', data: '{"id":"demo","backend":"wasm","entry":"plugin.wasm"}' },
    { name: 'plugin.wasm', data: 'wasm' },
    { name: '__main__.py', data: 'print(1)\n' },
  ]),
  /__main__\.py/u,
)

console.log('shipped index')
await rejects(
  'rejects a shipped checksum mismatch',
  buildZip([
    { name: 'mloader.plugin.json', data: '{"id":"demo","backend":"wasm","entry":"plugin.wasm"}' },
    { name: 'plugin.wasm', data: 'wasm' },
    {
      name: '.mloader.index.json',
      data: JSON.stringify({ schemaVersion: 1, id: 'demo', fileMd5: { 'plugin.wasm': '0'.repeat(32) } }),
    },
  ]),
  /packaged checksum/u,
)
await accepts(
  'accepts a shipped checksum index',
  buildZip([
    { name: 'mloader.plugin.json', data: '{"id":"demo","backend":"wasm","entry":"plugin.wasm"}' },
    { name: 'plugin.wasm', data: 'wasm' },
    { name: '.mloader.index.json', data: JSON.stringify({ schemaVersion: 1, id: 'demo', fileMd5: {} }) },
  ]),
)

console.log('file errors')
try {
  await openPackage(directory + '/missing.mloader.pack')
  check('reports a missing package', false)
} catch (error) {
  check('reports a missing package', error instanceof PackageError && /package not found/u.test(error.message))
}
const notZip = await writeArchive(directory, 'not-zip.pack', Buffer.from('hello'))
try {
  await openPackage(notZip)
  check('reports a non zip package', false)
} catch (error) {
  check('reports a non zip package', error instanceof PackageError && /is not a zip archive/u.test(error.message))
}

await cleanup(directory)

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nAll passed: ${passed} assertions`)
}
