/**
 * Release of the bundled example plugins into the profile.
 *
 * The package ships one reference plugin under `seed/`. On first start the
 * loader copies each example into `<profile>/mloader/plugins`, so a fresh
 * install has working code to read and edit. The release is all or nothing per
 * example: an existing target directory is skipped and never merged, because
 * the operator is expected to edit the released copy. A release failure is a
 * warning, never a startup failure.
 *
 * @module seed
 */
import { cp, mkdir, readdir, stat } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
/** Absolute directory that holds the bundled example plugins. */
export const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed');
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
/**
 * Copy the bundled examples into a plugin directory.
 *
 * An existing target directory means the example was released before or the
 * operator replaced it with their own work, so the example is reported as
 * skipped and the target is left byte for byte untouched. A failure on one
 * example is logged as a warning and does not stop the remaining examples,
 * because the seed is reference material that must never block startup.
 *
 * @param targetDir - Plugin directory to populate, normally
 *   `<profile>/mloader/plugins`. An empty value releases nothing.
 * @param logger - Receives warnings and the release summary. Optional.
 * @returns Names of the released and skipped examples.
 */
export async function installSeedExamples(targetDir, logger) {
    const installed = [];
    const skipped = [];
    if (typeof targetDir !== 'string' || targetDir.length === 0) {
        return { installed, skipped };
    }
    let entries;
    try {
        entries = await readdir(SEED_DIR, { withFileTypes: true });
    }
    catch (error) {
        logger?.warn?.(`bundled seed directory is unreadable: ${messageOf(error)}`);
        return { installed, skipped };
    }
    for (const entry of entries) {
        if (!entry.isDirectory())
            continue;
        const source = join(SEED_DIR, entry.name);
        const target = join(targetDir, entry.name);
        if (await exists(target)) {
            skipped.push(entry.name);
            continue;
        }
        try {
            await mkdir(dirname(target), { recursive: true });
            await cp(source, target, { recursive: true, force: false, errorOnExist: false });
            installed.push(entry.name);
        }
        catch (error) {
            logger?.warn?.(`example plugin ${entry.name} was not installed: ${messageOf(error)}`);
        }
    }
    if (installed.length > 0) {
        logger?.info?.(`seeded ${installed.length} example plugin(s) into ${targetDir}: ${installed.join(', ')}`);
    }
    return { installed, skipped };
}
/** Extract a message from an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
