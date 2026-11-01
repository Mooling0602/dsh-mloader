/**
 * Release of the bundled example plugins into the profile.
 *
 * The package ships examples under seeds/. Only a complete Python plugin is
 * released: a source-only example such as the WebAssembly module is left in
 * the package and never copied into a profile. Every start replaces each
 * released example in <profile>/mloader/plugins with the packaged copy, so the
 * released code always matches the installed loader. A release failure is a
 * warning, never a startup failure. The id hello-mloader is reserved for the
 * bundled example; discovery accepts it only with the bundled marker.
 *
 * @module seed
 */
import { cp, mkdir, readFile, readdir, rm, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Manifest name that marks one release-ready example plugin. */
const MANIFEST_NAME = 'mloader.plugin.json';
/** Only Python example plugins are released into a profile. */
const RELEASED_BACKEND = 'python';
/** Absolute directory that holds the bundled example sources. */
export const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seeds');
/** Return true when a path exists. */
async function exists(path) {
    try {
        await stat(path);
        return true;
    }
    catch {
        return false;
    }
}
/** Return true when a parsed manifest is a JSON object. */
function isRecord(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value);
}
/**
 * Replace the bundled examples in a plugin directory.
 *
 * A target directory is removed and the packaged copy is written in its place
 * on every start. This keeps the reference implementation current and removes
 * edits to it, because the bundled example is maintained by the loader rather
 * than by the operator. A directory without a complete Python manifest and
 * entry file is skipped, so source-only examples stay in the package. A
 * failure on one example is logged as a warning and does not stop the
 * remaining examples, because the seed must never block startup.
 *
 * @param targetDir - Plugin directory to populate, normally
 *   <profile>/mloader/plugins. An empty value releases nothing.
 * @param logger - Receives warnings and the release summary. Optional.
 * @returns Names of the newly released and replaced examples.
 */
export async function installSeedExamples(targetDir, logger) {
    const installed = [];
    const replaced = [];
    if (typeof targetDir !== 'string' || targetDir.length === 0) {
        return { installed, replaced };
    }
    let entries;
    try {
        entries = await readdir(SEED_DIR, { withFileTypes: true });
    }
    catch (error) {
        logger?.warn?.('bundled seed directory is unreadable: ' + messageOf(error));
        return { installed, replaced };
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const source = join(SEED_DIR, entry.name);
        const manifestPath = join(source, MANIFEST_NAME);
        if (!(await exists(manifestPath)))
            continue;
        let manifest;
        try {
            manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
        }
        catch (error) {
            logger?.warn?.('bundled example ' + entry.name + ' has an unreadable manifest: ' + messageOf(error));
            continue;
        }
        if (!isRecord(manifest) || manifest.backend !== RELEASED_BACKEND || typeof manifest.entry !== 'string') {
            logger?.warn?.('bundled example ' + entry.name + ' is not a complete Python plugin');
            continue;
        }
        if (!(await exists(join(source, manifest.entry)))) {
            logger?.warn?.('bundled example ' + entry.name + ' has no entry file at ' + manifest.entry);
            continue;
        }
        const target = join(targetDir, entry.name);
        const hadTarget = await exists(target);
        try {
            await mkdir(dirname(target), { recursive: true });
            if (hadTarget)
                await rm(target, { recursive: true, force: true });
            await cp(source, target, { recursive: true, force: true });
            if (hadTarget)
                replaced.push(entry.name);
            else
                installed.push(entry.name);
        }
        catch (error) {
            logger?.warn?.('example plugin ' + entry.name + ' was not installed: ' + messageOf(error));
        }
    }
    if (installed.length > 0) {
        logger?.info?.('seeded ' + installed.length + ' example plugin(s) into ' + targetDir + ': ' +
            installed.join(', '));
    }
    if (replaced.length > 0) {
        logger?.info?.('refreshed ' + replaced.length + ' example plugin(s) in ' + targetDir + ': ' +
            replaced.join(', '));
    }
    return { installed, replaced };
}
/** Extract a message from an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
