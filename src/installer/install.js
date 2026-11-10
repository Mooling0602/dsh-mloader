/**
 * Installation of dsh-mloader plugin packages.
 *
 * WebAssembly packages are installed in this process: the archive is extracted
 * into a staging directory outside the watched plugin root, the install index
 * is written, and the staging directory replaces the installed one after the
 * previous installation moved to the trash. Python packages are delegated to
 * the Python runtime command line, which owns the requirements merge and the
 * shared environment of a profile.
 *
 * @module installer/install
 */
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, mkdir, mkdtemp, readdir, readFile, rename, rm, stat, writeFile, } from 'node:fs/promises';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { expandHome, isValidPluginId } from '../contract.js';
import { PYTHON_CLI_SCRIPT } from '../python-env.js';
import { withShellPath } from '../shell-path.js';
import { INDEX_NAME, INDEX_SCHEMA_VERSION, MANIFEST_NAME, openPackage, PackageError, } from './package.js';
import { moveToTrash } from './trash.js';
/** Timeout for one Python command line invocation. */
const DEFAULT_TIMEOUT_MS = 300_000;
/** Maximum stdout or stderr text kept from one Python invocation. */
const MAX_CAPTURE_CHARS = 64 * 1024;
/** Return the message of a thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/** Return true when a value is a non-array object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Return an ISO 8601 timestamp with second precision. */
function nowIso() {
    return new Date().toISOString().replace(/\.\d{3}Z$/u, 'Z');
}
/** Return the lowercase hexadecimal MD5 of one file, streamed. */
async function md5OfFile(path) {
    const hash = createHash('md5');
    for await (const chunk of createReadStream(path)) {
        hash.update(chunk);
    }
    return hash.digest('hex');
}
/** Return the file checksums of one directory, excluding the install index. */
async function directoryMd5(directory) {
    const result = {};
    const walk = async (current) => {
        const entries = await readdir(current, { withFileTypes: true });
        for (const entry of entries) {
            const absolute = join(current, entry.name);
            if (entry.isDirectory()) {
                await walk(absolute);
                continue;
            }
            if (!entry.isFile())
                continue;
            const relative = absolute.slice(directory.length + 1).split(sep).join('/');
            if (relative === INDEX_NAME)
                continue;
            result[relative] = await md5OfFile(absolute);
        }
    };
    await walk(directory);
    const sorted = {};
    for (const key of Object.keys(result).sort())
        sorted[key] = result[key];
    return sorted;
}
/** Return a stable index serialization, sorted like the Python implementation. */
function serializeIndex(index) {
    const payload = {
        fileMd5: index.fileMd5,
        id: index.id,
        installedAt: index.installedAt,
        packageFile: index.packageFile,
        packageMd5: index.packageMd5,
        schemaVersion: index.schemaVersion,
        updatedAt: index.updatedAt,
    };
    return JSON.stringify(payload, null, 2) + '\n';
}
/** Read one install index, returning undefined when the file does not exist. */
async function readInstallIndex(directory) {
    const path = join(directory, INDEX_NAME);
    let raw;
    try {
        raw = await readFile(path, 'utf8');
    }
    catch (error) {
        const code = error instanceof Error && 'code' in error ? String(error.code) : '';
        if (code === 'ENOENT')
            return undefined;
        throw new PackageError(`cannot read the install index ${path}: ${messageOf(error)}`);
    }
    let parsed;
    try {
        parsed = JSON.parse(raw);
    }
    catch (error) {
        throw new PackageError(`cannot read the install index ${path}: ${messageOf(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new PackageError(`the install index ${path} must be a JSON object`);
    }
    return parsed;
}
/** Return the names of installed files that changed after the installation. */
async function changedFiles(directory, fileMd5) {
    if (!isRecord(fileMd5))
        return [];
    const changed = [];
    for (const [relative, expected] of Object.entries(fileMd5)) {
        if (typeof expected !== 'string')
            continue;
        const parts = relative.split('/');
        if (relative.length === 0 ||
            relative.startsWith('/') ||
            parts.some((part) => part === '' || part === '.' || part === '..')) {
            continue;
        }
        const absolute = join(directory, ...parts);
        try {
            const info = await stat(absolute);
            if (!info.isFile() || (await md5OfFile(absolute)) !== expected.toLowerCase()) {
                changed.push(relative);
            }
        }
        catch {
            changed.push(relative);
        }
    }
    return changed;
}
/** Return the nested manifest prefixes that an extraction must skip. */
function nestedPrefixes(packageDir) {
    const prefixes = [];
    for (const entry of packageDir.entries) {
        if (entry.name === MANIFEST_NAME)
            continue;
        if (entry.name.endsWith('/' + MANIFEST_NAME)) {
            prefixes.push(entry.name.slice(0, -MANIFEST_NAME.length));
        }
    }
    return prefixes;
}
/** Resolve and check the installation state of one target directory. */
async function preflightInstall(pluginsDir, opened) {
    const target = join(pluginsDir, opened.manifest.id);
    let info;
    try {
        info = await lstat(target);
    }
    catch {
        info = undefined;
    }
    if (info === undefined) {
        return { target, existing: false, index: undefined, needsConfirmation: false, reasons: [] };
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new PackageError(`${target} exists and is not a plugin directory`);
    }
    const index = await readInstallIndex(target);
    if (index === undefined) {
        return {
            target,
            existing: true,
            index: undefined,
            needsConfirmation: true,
            reasons: [`${target} exists without an install index`],
        };
    }
    const version = index.schemaVersion;
    if (typeof version !== 'number' || !Number.isInteger(version) || version > INDEX_SCHEMA_VERSION) {
        throw new PackageError(`${target} was installed by a newer loader (schemaVersion=${JSON.stringify(version)}); refusing to replace it`);
    }
    if (index.packageMd5 === opened.archiveMd5) {
        return {
            target,
            existing: true,
            index,
            needsConfirmation: true,
            reasons: [`${opened.path} is already installed at ${target}`],
        };
    }
    const changed = await changedFiles(target, index.fileMd5);
    if (changed.length > 0) {
        return {
            target,
            existing: true,
            index,
            needsConfirmation: true,
            reasons: [
                `${target} has files changed after installation (${changed.slice(0, 5).join(', ')})`,
            ],
        };
    }
    return { target, existing: true, index, needsConfirmation: false, reasons: [] };
}
/** Extract one opened archive into one staging directory. */
async function extractPackage(opened, staging) {
    const skipped = nestedPrefixes(opened.archive);
    const entries = [...opened.archive.entries].sort((left, right) => left.name.localeCompare(right.name));
    for (const entry of entries) {
        if (entry.name === INDEX_NAME)
            continue;
        if (skipped.some((prefix) => entry.name.startsWith(prefix)))
            continue;
        const target = join(staging, ...entry.name.replace(/\/+$/u, '').split('/'));
        if (!resolve(target).startsWith(resolve(staging) + sep)) {
            throw new PackageError(`the archive entry ${JSON.stringify(entry.name)} escapes the plugin directory`);
        }
        if (entry.directory) {
            await mkdir(target, { recursive: true });
            continue;
        }
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, opened.archive.read(entry));
    }
    const entry = join(staging, opened.manifest.entry);
    try {
        const info = await stat(entry);
        if (!info.isFile())
            throw new Error('not a file');
    }
    catch {
        throw new PackageError(`the manifest entry ${JSON.stringify(opened.manifest.entry)} was not extracted`);
    }
}
/** Install one WebAssembly package into the profile plugin directory. */
async function installWasm(opened, preflight, pluginsDir, logger) {
    await mkdir(pluginsDir, { recursive: true });
    const stagingParent = dirname(pluginsDir);
    await mkdir(stagingParent, { recursive: true });
    let staging;
    try {
        staging = await mkdtemp(join(stagingParent, `.mloader-${opened.manifest.id}-`));
        await extractPackage(opened, staging);
        const oldInstalledAt = preflight.index?.installedAt;
        const installedAt = typeof oldInstalledAt === 'string' && oldInstalledAt.length > 0
            ? oldInstalledAt
            : nowIso();
        const index = {
            schemaVersion: INDEX_SCHEMA_VERSION,
            id: opened.manifest.id,
            installedAt,
            updatedAt: nowIso(),
            packageFile: basename(opened.path),
            packageMd5: opened.archiveMd5,
            fileMd5: await directoryMd5(staging),
        };
        await writeFile(join(staging, INDEX_NAME), serializeIndex(index), 'utf8');
        if (preflight.existing) {
            const trashed = await moveToTrash(preflight.target);
            try {
                await rename(staging, preflight.target);
            }
            catch (error) {
                await rename(trashed, preflight.target).catch(() => undefined);
                throw error;
            }
        }
        else {
            await rename(staging, preflight.target);
        }
        staging = undefined;
        const status = preflight.existing ? 'updated' : 'installed';
        logger?.debug?.(`dsh-mloader: ${status} ${opened.manifest.id} at ${preflight.target}`);
        return {
            path: opened.path,
            status,
            id: opened.manifest.id,
            version: opened.manifest.version,
            backend: 'wasm',
            directory: preflight.target,
            warnings: opened.warnings,
        };
    }
    finally {
        if (staging !== undefined)
            await rm(staging, { recursive: true, force: true }).catch(() => undefined);
    }
}
/** Keep a capture buffer bounded while appending one chunk. */
function appendCapped(current, chunk) {
    const next = current + chunk;
    return next.length > MAX_CAPTURE_CHARS ? next.slice(0, MAX_CAPTURE_CHARS) : next;
}
/** Run the Python command line with captured output and a deadline. */
async function runPythonCommand(args, options) {
    const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    return await new Promise((resolvePromise, reject) => {
        const child = spawn(options.pythonBin, args, {
            env: withShellPath(process.env, options.shellPath),
            stdio: ['ignore', 'pipe', 'pipe'],
            windowsHide: true,
        });
        let stdout = '';
        let stderr = '';
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, timeoutMs);
        child.stdout?.on('data', (chunk) => { stdout = appendCapped(stdout, chunk.toString('utf8')); });
        child.stderr?.on('data', (chunk) => { stderr = appendCapped(stderr, chunk.toString('utf8')); });
        child.on('error', (error) => {
            clearTimeout(timer);
            reject(new Error(`cannot run the Python command line: ${messageOf(error)}`));
        });
        child.on('close', (code) => {
            clearTimeout(timer);
            resolvePromise({ stdout, stderr, code, timedOut });
        });
    });
}
/** Install one Python package through the Python runtime command line. */
async function installPython(opened, preflight, options, force, pluginsDir, profileDir) {
    const args = [PYTHON_CLI_SCRIPT, 'install', opened.path, '--plugins-dir', pluginsDir, '--python', options.pythonBin, '--json'];
    if (profileDir !== undefined)
        args.push('--profile', profileDir);
    if (force)
        args.push('--force');
    const runner = options.pythonRunner ?? ((commandArgs) => runPythonCommand(commandArgs, options));
    const outcome = await runner(args, { timeoutMs: options.timeoutMs ?? DEFAULT_TIMEOUT_MS });
    if (outcome.timedOut) {
        throw new PackageError(`installing ${opened.path} timed out`);
    }
    if (outcome.code !== 0) {
        const lines = outcome.stderr.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0);
        const detail = lines.length > 0 ? lines[lines.length - 1] : `exit code ${outcome.code}`;
        throw new PackageError(detail.replace(/^error:\s*/u, ''));
    }
    const last = outcome.stdout.split(/\r?\n/u).map((line) => line.trim()).filter((line) => line.length > 0).pop();
    if (last === undefined) {
        throw new PackageError('the Python command line returned no install result');
    }
    let parsed;
    try {
        parsed = JSON.parse(last);
    }
    catch (error) {
        throw new PackageError(`the Python command line returned an invalid install result: ${messageOf(error)}`);
    }
    if (!isRecord(parsed)) {
        throw new PackageError('the Python command line returned an invalid install result');
    }
    const warnings = [
        ...opened.warnings,
        ...(Array.isArray(parsed.warnings) ? parsed.warnings.map(String) : []),
    ];
    const status = parsed.updated === true ? 'updated' : 'installed';
    return {
        path: opened.path,
        status,
        id: typeof parsed.id === 'string' ? parsed.id : opened.manifest.id,
        version: typeof parsed.version === 'string' ? parsed.version : opened.manifest.version,
        backend: 'python',
        directory: typeof parsed.directory === 'string' ? parsed.directory : preflight.target,
        warnings,
    };
}
/**
 * Create the package installer the command group uses.
 *
 * The installer never trusts an archive and never executes plugin code.
 * WebAssembly packages are installed by this module; Python packages are
 * delegated to the Python runtime command line, which owns the requirements
 * merge and the shared environment.
 *
 * @param options - Profile, plugin directory, interpreter and logger.
 * @returns The installer, whose install calls never throw for a package failure.
 */
export function createPackageInstaller(options) {
    const pluginsDir = options.pluginsDir;
    const installer = {
        async install(paths, callOptions = {}) {
            const results = [];
            for (const path of paths) {
                results.push(await installer.installOne(path, callOptions));
            }
            return results;
        },
        async installOne(path, callOptions = {}) {
            const force = callOptions.force === true;
            try {
                if (pluginsDir === undefined || pluginsDir.length === 0) {
                    throw new PackageError('the profile plugin directory is unknown; the loader cannot install a package');
                }
                const opened = await openPackage(resolve(expandHome(path)));
                const preflight = await preflightInstall(pluginsDir, opened);
                if (preflight.needsConfirmation && !force) {
                    return {
                        path,
                        status: 'needs-confirmation',
                        id: opened.manifest.id,
                        version: opened.manifest.version,
                        backend: opened.backend,
                        warnings: opened.warnings,
                        message: preflight.reasons.join('; '),
                    };
                }
                const result = opened.backend === 'python'
                    ? await installPython(opened, preflight, options, force, pluginsDir, options.profileDir)
                    : await installWasm(opened, preflight, pluginsDir, options.logger);
                return { ...result, path };
            }
            catch (error) {
                return {
                    path,
                    status: 'failed',
                    warnings: [],
                    message: messageOf(error),
                };
            }
        },
        async remove(id, callOptions = {}) {
            try {
                if (pluginsDir === undefined || pluginsDir.length === 0) {
                    throw new PackageError('the profile plugin directory is unknown; the loader cannot remove a plugin');
                }
                return await removeInstalled(pluginsDir, id, callOptions.force === true);
            }
            catch (error) {
                return { id, status: 'failed', message: messageOf(error) };
            }
        },
    };
    return installer;
}
/**
 * Remove one installed plugin directory after checking what the operator owns.
 *
 * The install index records the checksum of every file the package provided, so
 * a file that no longer matches was edited after installation and belongs to the
 * operator. Replacing that directory without saying so would discard the edit
 * silently, which is why an edited installation needs the same second
 * confirmation an update needs. A directory without an index was placed by hand,
 * so nothing records its provenance and the removal asks as well.
 *
 * @param pluginsDir - Absolute profile plugin directory.
 * @param id - Plugin id, which is also the installed directory name.
 * @param force - Remove without asking even when the installation was edited.
 * @returns The removal outcome.
 * @throws {PackageError} When the id is malformed or the plugin is not installed.
 */
async function removeInstalled(pluginsDir, id, force) {
    if (!isValidPluginId(id)) {
        throw new PackageError(`${JSON.stringify(id)} is not a valid plugin id`);
    }
    const target = join(pluginsDir, id);
    let info;
    try {
        info = await lstat(target);
    }
    catch {
        throw new PackageError(`plugin "${id}" is not installed at ${target}`);
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
        throw new PackageError(`${target} is not a plugin directory`);
    }
    const index = await readInstallIndex(target);
    const changed = index === undefined ? [] : await changedFiles(target, index.fileMd5);
    if (!force) {
        if (index === undefined) {
            return {
                id,
                status: 'needs-confirmation',
                directory: target,
                message: `${target} carries no install index`,
            };
        }
        if (changed.length > 0) {
            return {
                id,
                status: 'needs-confirmation',
                directory: target,
                changed,
                message: `${changed.length} file(s) were edited after installation: ${changed.join(', ')}`,
            };
        }
    }
    const trash = await moveToTrash(target);
    return { id, status: 'removed', directory: target, trash, ...(changed.length > 0 ? { changed } : {}) };
}
