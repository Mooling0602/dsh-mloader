/**
 * Tests for the package zip reader.
 *
 * The suites build archives with test/install-fixtures.mjs, so they exercise
 * the reader without a zip dependency and can construct malformed entries that
 * a real writer refuses to produce.
 */

import { ZipError, openZip } from '../src/installer/zip.js'
import { buildZip } from './install-fixtures.mjs'

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

function throwsLike(name, run, pattern) {
  try {
    run()
  } catch (error) {
    check(name, error instanceof ZipError && pattern.test(error.message), error.message)
    return
  }
  check(name, false, 'no error was raised')
}

console.log('stored entries')
const stored = openZip(buildZip([{ name: 'a.txt', data: 'hello' }, { name: 'dir/', data: '' }]))
check('lists both entries', stored.entries.length === 2)
check('reads a stored file', stored.readFile('a.txt').toString('utf8') === 'hello')
check('marks a directory entry', stored.find('dir/')?.directory === true)
check('finds an entry by name', stored.find('a.txt')?.uncompressedSize === 5)
check('missing entry is undefined', stored.find('missing.txt') === undefined)
throwsLike('reading a missing entry fails', () => stored.readFile('missing.txt'), /has no entry/u)

console.log('deflated entries')
const deflated = openZip(buildZip([{ name: 'b.txt', data: 'x'.repeat(2048), method: 8 }]))
check('reads a deflated file', deflated.readFile('b.txt').toString('utf8') === 'x'.repeat(2048))

console.log('prepended data')
const payload = buildZip([{ name: 'entry.py', data: 'print(1)\n' }])
const prepended = openZip(Buffer.concat([Buffer.from('#!/usr/bin/env python3\n'), payload]))
check('reads a package with prepended data', prepended.readFile('entry.py').toString('utf8') === 'print(1)\n')

console.log('limits')
throwsLike(
  'rejects too many entries',
  () => openZip(buildZip([{ name: 'a', data: '' }, { name: 'b', data: '' }]), { maxEntries: 1 }),
  /more than 1 entries/u,
)
throwsLike(
  'rejects an unpacked size limit',
  () => openZip(buildZip([{ name: 'a', data: 'x'.repeat(32) }]), { maxUncompressedBytes: 8 }),
  /expands past 8 bytes/u,
)

console.log('malformed entries')
throwsLike(
  'rejects a checksum mismatch',
  () => openZip(buildZip([{ name: 'a.txt', data: 'hello', crcOverride: 0 }])).readFile('a.txt'),
  /failed its checksum/u,
)
throwsLike(
  'rejects an encrypted entry',
  () => openZip(buildZip([{ name: 'a.txt', data: 'hello', flags: 1 }])).readFile('a.txt'),
  /is encrypted/u,
)
throwsLike(
  'rejects an unsupported method',
  () => openZip(buildZip([{ name: 'a.txt', data: 'hello', method: 99 }])).readFile('a.txt'),
  /unsupported compression method 99/u,
)
throwsLike(
  'rejects a truncated archive',
  () => openZip(buildZip([{ name: 'a.txt', data: 'hello' }]).subarray(0, 10)),
  /too short|no central directory|truncated/u,
)
throwsLike('rejects a non zip buffer', () => openZip(Buffer.from('hello world')), /not a zip file/u)

if (failures.length > 0) {
  console.error(`\n${failures.length} failed`)
  process.exitCode = 1
} else {
  console.log(`\nAll passed: ${passed} assertions`)
}
