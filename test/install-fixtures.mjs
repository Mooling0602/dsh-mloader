/**
 * Fixture builders for the installer suites.
 *
 * The builders write zip archives with the stored method, so the suites do not
 * depend on a package writer. Every builder accepts the fields a malformed
 * package needs, such as an entry name with a traversal segment, a symbolic
 * link mode or an overridden checksum.
 */

import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { deflateRawSync } from 'node:zlib'

const CRC_TABLE = (() => {
  const table = new Uint32Array(256)
  for (let index = 0; index < 256; index += 1) {
    let value = index
    for (let bit = 0; bit < 8; bit += 1) {
      value = (value & 1) === 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1
    }
    table[index] = value >>> 0
  }
  return table
})()

/** Return the CRC-32 of one buffer. */
export function crc32(buffer) {
  let crc = 0xffffffff
  for (const byte of buffer) crc = CRC_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8)
  return (crc ^ 0xffffffff) >>> 0
}

/** Build one zip archive. */
export function buildZip(entries) {
  const localParts = []
  const centralParts = []
  let offset = 0
  for (const entry of entries) {
    const name = Buffer.from(entry.name, 'utf8')
    const data = Buffer.isBuffer(entry.data) ? entry.data : Buffer.from(entry.data ?? '', 'utf8')
    const method = entry.method ?? 0
    const payload = method === 8 ? deflateRawSync(data) : data
    const checksum = entry.crcOverride ?? crc32(data)
    const flags = entry.flags ?? 0
    const external = (entry.externalAttributes ?? 0) >>> 0
    const uncompressed = entry.claimUncompressedSize ?? data.length

    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt16LE(flags, 6)
    local.writeUInt16LE(method, 8)
    local.writeUInt32LE(checksum, 14)
    local.writeUInt32LE(payload.length, 18)
    local.writeUInt32LE(uncompressed, 22)
    local.writeUInt16LE(name.length, 26)
    local.writeUInt16LE(0, 28)
    localParts.push(local, name, payload)

    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE((3 << 8) | 20, 4)
    central.writeUInt16LE(20, 6)
    central.writeUInt16LE(flags, 8)
    central.writeUInt16LE(method, 10)
    central.writeUInt32LE(checksum, 16)
    central.writeUInt32LE(payload.length, 20)
    central.writeUInt32LE(uncompressed, 24)
    central.writeUInt16LE(name.length, 28)
    central.writeUInt16LE(0, 30)
    central.writeUInt16LE(0, 32)
    central.writeUInt16LE(0, 34)
    central.writeUInt16LE(0, 36)
    central.writeUInt32LE(external, 38)
    central.writeUInt32LE(offset, 42)
    centralParts.push(central, name)

    offset += local.length + name.length + payload.length
  }
  const centralOffset = offset
  const centralSize = centralParts.reduce((total, part) => total + part.length, 0)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(entries.length, 8)
  end.writeUInt16LE(entries.length, 10)
  end.writeUInt32LE(centralSize, 12)
  end.writeUInt32LE(centralOffset, 16)
  end.writeUInt16LE(0, 20)
  return Buffer.concat([...localParts, ...centralParts, end])
}

/** A minimal WebAssembly module header. */
export const WASM_BYTES = Buffer.from([0x00, 0x61, 0x73, 0x6d, 0x01, 0x00, 0x00, 0x00])

/** Build one WebAssembly package. */
export function wasmPackage(overrides = {}) {
  const manifest = {
    id: 'wasm-demo',
    name: 'Wasm Demo',
    version: '0.1.0',
    backend: 'wasm',
    entry: 'plugin.wasm',
    ...overrides.manifest,
  }
  const entries = overrides.entries ?? [
    { name: 'mloader.plugin.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: manifest.entry, data: overrides.wasm ?? WASM_BYTES },
  ]
  return { manifest, bytes: buildZip(entries) }
}

/** Build one Python package. */
export function pythonPackage(overrides = {}) {
  const manifest = {
    id: 'python-demo',
    name: 'Python Demo',
    version: '0.1.0',
    backend: 'python',
    entry: 'entry.py',
    ...overrides.manifest,
  }
  const entries = overrides.entries ?? [
    { name: 'mloader.plugin.json', data: JSON.stringify(manifest, null, 2) + '\n' },
    { name: manifest.entry, data: overrides.entryFile ?? 'print("hello")\n' },
  ]
  return { manifest, bytes: buildZip(entries) }
}

/** Create a temporary directory. */
export async function makeTempDir(prefix = 'mloader-test-') {
  return await mkdtemp(join(tmpdir(), prefix))
}

/** Write one archive file and return its path. */
export async function writeArchive(directory, name, bytes) {
  const path = join(directory, name)
  await writeFile(path, bytes)
  return path
}

/** Remove a temporary directory. */
export async function cleanup(directory) {
  await rm(directory, { recursive: true, force: true })
}
