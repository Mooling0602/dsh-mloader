/**
 * Minimal ZIP reader for dsh-mloader plugin packages.
 *
 * A package is a zip archive. The loader receives untrusted archives, so this
 * module parses the central directory itself instead of trusting a streaming
 * reader, and it verifies every entry when the caller reads it. It supports
 * the two methods a package writer produces, stored and deflated, and rejects
 * encrypted entries, multi disk archives and ZIP64 archives. Prepended data is
 * supported because a Python package may be a `.pyz` application with a
 * shebang line before the zip payload.
 *
 * @module installer/zip
 */

import { inflateRawSync } from 'node:zlib'

/** Signature of the end of central directory record. */
const EOCD_SIGNATURE = 0x06054b50

/** Signature of one central directory entry. */
const CENTRAL_SIGNATURE = 0x02014b50

/** Signature of one local file header. */
const LOCAL_SIGNATURE = 0x04034b50

/** Length of the end of central directory record without its comment. */
const EOCD_LENGTH = 22

/** Longest possible end of central directory comment. */
const MAX_COMMENT_LENGTH = 0xffff

/** One central directory entry of an opened archive. */
export interface ZipEntry {
  /** Entry name as stored in the archive, with `/` separators. */
  readonly name: string
  /** True when the entry name ends with a slash. */
  readonly directory: boolean
  /** Compression method: 0 for stored, 8 for deflated. */
  readonly method: number
  /** Compressed size in bytes. */
  readonly compressedSize: number
  /** Uncompressed size in bytes. */
  readonly uncompressedSize: number
  /** CRC-32 of the uncompressed bytes. */
  readonly crc32: number
  /** General purpose bit flags from the central directory. */
  readonly flags: number
  /** External file attributes, used to detect symbolic link entries. */
  readonly externalAttributes: number
  /** Offset of the local file header, relative to the start of the zip payload. */
  readonly localHeaderOffset: number
  /** True when the entry declares a symbolic link in its external attributes. */
  readonly symbolicLink: boolean
}

/** An opened ZIP archive. */
export interface ZipArchive {
  /** Central directory entries in archive order. */
  readonly entries: readonly ZipEntry[]
  /** Find one entry by its exact name. */
  find(name: string): ZipEntry | undefined
  /** Read and verify one entry. */
  read(entry: ZipEntry): Buffer
  /** Find and read one entry by its exact name. */
  readFile(name: string): Buffer
}

/** Limits enforced while opening an archive. */
export interface ZipLimits {
  /** Maximum number of entries. */
  readonly maxEntries?: number
  /** Maximum total uncompressed size of every entry. */
  readonly maxUncompressedBytes?: number
}

/** Error raised when a buffer is not a supported ZIP archive. */
export class ZipError extends Error {
  /** Build one archive error. */
  constructor(message: string) {
    super(message)
    this.name = 'ZipError'
  }
}

/** CRC-32 lookup table, built once from the standard polynomial. */
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
function crc32Of(data: Buffer): number {
  let crc = 0xffffffff
  for (const byte of data) {
    crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8)
  }
  return (crc ^ 0xffffffff) >>> 0
}

/** Ensure that a range lies inside one buffer. */
function ensureRange(buffer: Buffer, offset: number, length: number, what: string): void {
  if (offset < 0 || length < 0 || offset + length > buffer.length) {
    throw new ZipError(`the archive is truncated while reading ${what}`)
  }
}

/** Find the end of central directory record of one buffer. */
function findEndOfCentralDirectory(buffer: Buffer): {
  offset: number
  entries: number
  size: number
  centralOffset: number
} {
  if (buffer.length < EOCD_LENGTH) {
    throw new ZipError('the archive is not a zip file: it is too short')
  }
  const first = Math.max(0, buffer.length - EOCD_LENGTH - MAX_COMMENT_LENGTH)
  for (let offset = buffer.length - EOCD_LENGTH; offset >= first; offset -= 1) {
    if (buffer.readUInt32LE(offset) !== EOCD_SIGNATURE) continue
    const commentLength = buffer.readUInt16LE(offset + 20)
    if (offset + EOCD_LENGTH + commentLength !== buffer.length) continue
    const disk = buffer.readUInt16LE(offset + 4)
    const centralDisk = buffer.readUInt16LE(offset + 6)
    const entriesOnDisk = buffer.readUInt16LE(offset + 8)
    const entries = buffer.readUInt16LE(offset + 10)
    const size = buffer.readUInt32LE(offset + 12)
    const centralOffset = buffer.readUInt32LE(offset + 16)
    if (disk !== 0 || centralDisk !== 0 || entriesOnDisk !== entries) {
      throw new ZipError('multi disk archives are not supported')
    }
    if (entries === 0xffff || size === 0xffffffff || centralOffset === 0xffffffff) {
      throw new ZipError('ZIP64 archives are not supported')
    }
    return { offset, entries, size, centralOffset }
  }
  throw new ZipError('the archive is not a zip file: no central directory record')
}

/** Decode one entry name. */
function decodeName(bytes: Buffer): string {
  const name = bytes.toString('utf8')
  if (name.length === 0) throw new ZipError('the archive holds an entry with an empty name')
  if (name.includes('\u0000')) throw new ZipError(`the archive entry ${JSON.stringify(name)} holds a NUL byte`)
  return name
}

/**
 * Open one ZIP archive from a buffer.
 *
 * Opening reads only the central directory. Entry contents are decompressed and
 * verified on {@link ZipArchive.read}, which lets the caller reject an archive
 * before extracting it while checking checksums at the moment of writing.
 *
 * @param buffer - Complete archive bytes.
 * @param limits - Entry count and unpacked size limits.
 * @returns The opened archive.
 * @throws {ZipError} When the buffer is not a supported zip or exceeds a limit.
 */
export function openZip(buffer: Buffer, limits: ZipLimits = {}): ZipArchive {
  const maxEntries = limits.maxEntries ?? Number.POSITIVE_INFINITY
  const maxUnpacked = limits.maxUncompressedBytes ?? Number.POSITIVE_INFINITY
  const end = findEndOfCentralDirectory(buffer)
  const concat = end.offset - end.size - end.centralOffset
  if (concat < 0) {
    throw new ZipError('the archive central directory offset is outside the file')
  }
  if (end.entries > maxEntries) {
    throw new ZipError(`the archive holds more than ${maxEntries} entries`)
  }

  const entries: ZipEntry[] = []
  let cursor = end.centralOffset + concat
  let total = 0
  for (let index = 0; index < end.entries; index += 1) {
    ensureRange(buffer, cursor, 46, 'a central directory entry')
    if (buffer.readUInt32LE(cursor) !== CENTRAL_SIGNATURE) {
      throw new ZipError('the archive central directory is malformed')
    }
    const flags = buffer.readUInt16LE(cursor + 8)
    const method = buffer.readUInt16LE(cursor + 10)
    const crc32 = buffer.readUInt32LE(cursor + 16)
    const compressedSize = buffer.readUInt32LE(cursor + 20)
    const uncompressedSize = buffer.readUInt32LE(cursor + 24)
    const nameLength = buffer.readUInt16LE(cursor + 28)
    const extraLength = buffer.readUInt16LE(cursor + 30)
    const commentLength = buffer.readUInt16LE(cursor + 32)
    const externalAttributes = buffer.readUInt32LE(cursor + 38)
    const localHeaderOffset = buffer.readUInt32LE(cursor + 42)
    ensureRange(buffer, cursor + 46, nameLength, 'an entry name')
    const name = decodeName(buffer.subarray(cursor + 46, cursor + 46 + nameLength))
    total += uncompressedSize
    if (total > maxUnpacked) {
      throw new ZipError(`the archive expands past ${maxUnpacked} bytes`)
    }
    entries.push({
      name,
      directory: name.endsWith('/'),
      method,
      compressedSize,
      uncompressedSize,
      crc32,
      flags,
      externalAttributes,
      localHeaderOffset,
      symbolicLink: ((externalAttributes >>> 16) & 0o170000) === 0o120000,
    })
    cursor += 46 + nameLength + extraLength + commentLength
  }

  const byName = new Map(entries.map((entry) => [entry.name, entry] as const))
  const archive: ZipArchive = {
    entries,
    find(name: string): ZipEntry | undefined {
      return byName.get(name)
    },
    read(entry: ZipEntry): Buffer {
      if ((entry.flags & 0x1) !== 0) {
        throw new ZipError(`the archive entry ${JSON.stringify(entry.name)} is encrypted`)
      }
      if (entry.directory) return Buffer.alloc(0)
      const local = entry.localHeaderOffset + concat
      ensureRange(buffer, local, 30, 'a local file header')
      if (buffer.readUInt32LE(local) !== LOCAL_SIGNATURE) {
        throw new ZipError(`the local header of ${JSON.stringify(entry.name)} is malformed`)
      }
      const nameLength = buffer.readUInt16LE(local + 26)
      const extraLength = buffer.readUInt16LE(local + 28)
      const dataStart = local + 30 + nameLength + extraLength
      ensureRange(buffer, dataStart, entry.compressedSize, 'entry data')
      const raw = buffer.subarray(dataStart, dataStart + entry.compressedSize)
      let content: Buffer
      if (entry.method === 0) {
        content = raw
      } else if (entry.method === 8) {
        try {
          content = inflateRawSync(raw)
        } catch (error) {
          throw new ZipError(
            `the archive entry ${JSON.stringify(entry.name)} cannot be inflated: ${messageOf(error)}`,
          )
        }
      } else {
        throw new ZipError(
          `the archive entry ${JSON.stringify(entry.name)} uses unsupported compression method ${entry.method}`,
        )
      }
      if (content.length !== entry.uncompressedSize) {
        throw new ZipError(`the archive entry ${JSON.stringify(entry.name)} has the wrong size`)
      }
      if (crc32Of(content) !== entry.crc32) {
        throw new ZipError(`the archive entry ${JSON.stringify(entry.name)} failed its checksum`)
      }
      return content
    },
    readFile(name: string): Buffer {
      const entry = byName.get(name)
      if (entry === undefined) throw new ZipError(`the archive has no entry ${JSON.stringify(name)}`)
      return archive.read(entry)
    },
  }
  return archive
}

/** Return the message of a thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}
