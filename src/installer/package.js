/**
 * Validation of one dsh-mloader plugin package.
 *
 * A package is a zip archive with one `mloader.plugin.json` at its root. This
 * module validates the shared archive rules of docs/Package.md, reads the
 * manifest, and detects the backend. The backend decides who installs the
 * package: the loader's Node installer handles WebAssembly packages, and the
 * Python runtime command line handles Python packages.
 *
 * @module installer/package
 */
import { createHash } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { posix } from 'node:path';
import { RESERVED_PLUGIN_IDS } from '../contract.js';
import { MANIFEST_NAME } from '../discovery.js';
import { validateManifestFields } from '../manifest.js';
import { openZip } from './zip.js';
/** Manifest file name at the archive root. */
export { MANIFEST_NAME };
/** Install index file name inside an installed plugin directory. */
export const INDEX_NAME = '.mloader.index.json';
/** Maximum number of entries one archive may hold. */
export const MAX_ENTRIES = 4096;
/** Maximum total uncompressed size of one archive. */
export const MAX_UNPACKED_BYTES = 512 * 1024 * 1024;
/** Version of the install index format. */
export const INDEX_SCHEMA_VERSION = 1;
/** A Windows drive prefix in an archive entry name. */
const DRIVE_PATTERN = /^[A-Za-z]:/;
/** Error raised when a plugin package cannot be validated or installed. */
export class PackageError extends Error {
    /** Build one package error. */
    constructor(message) {
        super(message);
        this.name = 'PackageError';
    }
}
/** Return true when a value is a non-array object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Return the message of a thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Return true when one entry name is a safe relative path. */
function isSafeEntryName(name) {
    if (name.includes('\\'))
        return false;
    if (name.startsWith('/') || DRIVE_PATTERN.test(name))
        return false;
    const normalized = name.endsWith('/') ? name.slice(0, -1) : name;
    if (normalized.length === 0)
        return false;
    const parts = normalized.split('/');
    if (parts.some((part) => part === '' || part === '.' || part === '..'))
        return false;
    return posix.normalize(normalized) === normalized;
}
/** Validate the archive entries every package shares. */
function validateArchive(archive) {
    const seen = new Set();
    let total = 0;
    if (archive.entries.length > MAX_ENTRIES) {
        throw new PackageError(`the archive holds more than ${MAX_ENTRIES} entries`);
    }
    for (const entry of archive.entries) {
        if (!isSafeEntryName(entry.name)) {
            if (entry.name.includes('\\')) {
                throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} uses a backslash`);
            }
            if (entry.name.startsWith('/') || DRIVE_PATTERN.test(entry.name)) {
                throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} is absolute`);
            }
            throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} is not a safe relative path`);
        }
        if (entry.symbolicLink) {
            throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} is a symbolic link`);
        }
        if ((entry.flags & 0x1) !== 0) {
            throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} is encrypted`);
        }
        total += entry.uncompressedSize;
        if (total > MAX_UNPACKED_BYTES) {
            throw new PackageError(`the archive expands past ${MAX_UNPACKED_BYTES / (1024 * 1024)} MiB`);
        }
        const key = entry.name.toLowerCase();
        if (seen.has(key)) {
            throw new PackageError(`the archive holds ${JSON.stringify(entry.name)} more than once`);
        }
        seen.add(key);
    }
}
/**
 * Parse and validate one manifest object.
 *
 * The field rules come from the shared validator, so an archive is rejected for
 * the same reasons discovery rejects an installed directory. An archive carries
 * no built-in marker, so a reserved plugin id is always rejected here.
 *
 * @param raw - Manifest bytes.
 * @param source - Name used in diagnostics.
 * @returns The validated manifest.
 * @throws {PackageError} When the manifest is not a JSON object of the expected shape.
 */
function parseManifest(raw, source) {
    let parsed;
    try {
        parsed = JSON.parse(raw.toString('utf8'));
    }
    catch (error) {
        throw new PackageError(`${source} is not valid JSON: ${messageOf(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new PackageError(`${source} must contain a JSON object`);
    }
    const violation = validateManifestFields(parsed)[0];
    if (violation !== undefined) {
        throw new PackageError(`${source}: ${violation.message}`);
    }
    const id = parsed.id;
    // An archive carries no built-in marker, so it can never install a reserved
    // id. Discovery admits one through the marker; a package has no such escape.
    if (RESERVED_PLUGIN_IDS.has(id)) {
        throw new PackageError(`${source}: plugin id "${id}" is reserved for the bundled example`);
    }
    const backend = parsed.backend;
    const entry = parsed.entry;
    const name = typeof parsed.name === 'string' && parsed.name.length > 0 ? parsed.name : id;
    const version = typeof parsed.version === 'string' ? parsed.version : '0.0.0';
    return {
        id,
        name,
        version,
        backend,
        entry,
        enabled: parsed.enabled !== false,
        declared: parsed,
    };
}
/** Collect the prefixes of manifests that sit below the archive root. */
function nestedManifestPrefixes(archive) {
    const prefixes = [];
    for (const entry of archive.entries) {
        if (entry.name === MANIFEST_NAME)
            continue;
        if (entry.name.endsWith('/' + MANIFEST_NAME)) {
            prefixes.push(entry.name.slice(0, -MANIFEST_NAME.length));
        }
    }
    return prefixes.sort();
}
/** Validate the layout a WebAssembly package adds to the shared rules. */
function validateWasmLayout(path, bytes, archive, manifest) {
    if (bytes.length >= 2 && bytes.subarray(0, 2).toString('utf8') === '#!') {
        throw new PackageError('a WebAssembly package must not begin with a shebang line');
    }
    const main = archive.find('__main__.py');
    if (main !== undefined && !main.directory) {
        throw new PackageError('a WebAssembly package must not contain a __main__.py at its root');
    }
    const entry = archive.find(manifest.entry);
    if (entry === undefined || entry.directory) {
        throw new PackageError(`${path}: the manifest entry ${JSON.stringify(manifest.entry)} is not a file at the archive root`);
    }
}
/** Validate the checksums a packager shipped inside one package. */
function validateShippedIndex(path, archive, manifest) {
    const entry = archive.find(INDEX_NAME);
    if (entry === undefined || entry.directory)
        return undefined;
    let parsed;
    try {
        parsed = JSON.parse(archive.read(entry).toString('utf8'));
    }
    catch (error) {
        throw new PackageError(`${path}: the packaged index is not valid JSON: ${messageOf(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new PackageError('the packaged index must be a JSON object');
    }
    const version = parsed.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version > INDEX_SCHEMA_VERSION) {
        throw new PackageError(`the packaged index has an unsupported schemaVersion ${JSON.stringify(version)}`);
    }
    if (parsed.id !== manifest.id) {
        throw new PackageError('the packaged index id does not match the manifest id');
    }
    const fileMd5 = parsed.fileMd5;
    if (!isRecord(fileMd5)) {
        throw new PackageError('the packaged index has no fileMd5 object');
    }
    const checksums = {};
    for (const [relative, expected] of Object.entries(fileMd5)) {
        if (typeof expected !== 'string') {
            throw new PackageError('the packaged index fileMd5 map is malformed');
        }
        const file = archive.find(relative);
        if (file === undefined || file.directory) {
            throw new PackageError(`the packaged index names a missing file ${JSON.stringify(relative)}`);
        }
        const actual = createHash('md5').update(archive.read(file)).digest('hex');
        if (actual !== expected.toLowerCase()) {
            throw new PackageError(`the packaged checksum of ${JSON.stringify(relative)} does not match`);
        }
        checksums[relative] = actual;
    }
    return checksums;
}
/**
 * Open and validate one plugin package.
 *
 * The archive is validated before the caller extracts a byte: entry names must
 * be safe relative paths, symbolic link and encrypted entries are rejected, and
 * the manifest is checked against the shared manifest grammar. A nested
 * manifest is reported as a warning and its directory is never extracted.
 *
 * @param path - Archive path, already resolved by the caller.
 * @returns The opened package.
 * @throws {PackageError} When the file is not a valid package.
 */
export async function openPackage(path) {
    let info;
    try {
        info = await stat(path);
    }
    catch {
        throw new PackageError(`package not found: ${path}`);
    }
    if (!info.isFile()) {
        throw new PackageError(`package not found: ${path}`);
    }
    let bytes;
    try {
        bytes = await readFile(path);
    }
    catch (error) {
        throw new PackageError(`cannot read ${path}: ${messageOf(error)}`);
    }
    const archiveMd5 = createHash('md5').update(bytes).digest('hex');
    let archive;
    try {
        archive = openZip(bytes, {
            maxEntries: MAX_ENTRIES,
            maxUncompressedBytes: MAX_UNPACKED_BYTES,
        });
    }
    catch (error) {
        throw new PackageError(`${path} is not a zip archive: ${messageOf(error)}`);
    }
    validateArchive(archive);
    const manifestEntry = archive.find(MANIFEST_NAME);
    if (manifestEntry === undefined || manifestEntry.directory) {
        throw new PackageError(`${path} has no ${MANIFEST_NAME} at its root`);
    }
    const manifest = parseManifest(archive.read(manifestEntry), MANIFEST_NAME);
    const entryEntry = archive.find(manifest.entry);
    if (entryEntry === undefined || entryEntry.directory) {
        throw new PackageError(`${path}: the manifest entry ${JSON.stringify(manifest.entry)} is not a file at the archive root`);
    }
    if (manifest.backend === 'wasm') {
        validateWasmLayout(path, bytes, archive, manifest);
    }
    const warnings = [];
    for (const prefix of nestedManifestPrefixes(archive)) {
        warnings.push(`the directory ${JSON.stringify(prefix)} holds another manifest and is not extracted`);
    }
    const shippedIndex = manifest.backend === 'wasm'
        ? validateShippedIndex(path, archive, manifest)
        : undefined;
    return {
        path,
        archiveMd5,
        archive,
        manifest,
        backend: manifest.backend,
        entryEntry,
        warnings,
        shippedIndex,
    };
}
