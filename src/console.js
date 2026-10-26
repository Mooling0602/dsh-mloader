/**
 * Terminal output channel for the loader.
 *
 * The harness logger keeps messages in memory but does not print them, so the
 * loader owns a separate console channel for the few lines a user needs to see
 * while it starts and stops. Writes are best effort: a closed or broken stdout
 * must never affect plugin loading.
 *
 * @module console
 */
const PREFIX = '[mloader]';
/**
 * Return true when terminal output is enabled for these settings.
 *
 * Output is off when `console` is false, when tests run with `NODE_ENV=test`,
 * and when no console implementation exists.
 *
 * @param settings - Loader settings.
 */
function shouldEmit(settings) {
    if (settings.console === false)
        return false;
    if (process.env.NODE_ENV === 'test')
        return false;
    return typeof console !== 'undefined';
}
/**
 * Create the terminal output channel.
 *
 * `lifecycle` and `warn`/`error` lines are printed when output is enabled.
 * `detail` lines are printed only when `console` is `'verbose'`.
 *
 * @param settings - Loader settings that select the verbosity.
 * @returns A channel whose writes never throw.
 */
export function createConsole(settings = {}) {
    const enabled = shouldEmit(settings);
    const write = (line) => {
        if (!enabled)
            return;
        try {
            console.log(line);
        }
        catch {
            // A terminal that cannot be written must not surface as a loader failure.
        }
    };
    return {
        enabled,
        lifecycle(message) {
            write(`${PREFIX} ${message}`);
        },
        detail(message) {
            if (settings.console !== 'verbose')
                return;
            write(`${PREFIX} ${message}`);
        },
        warn(message) {
            write(`${PREFIX} warn: ${message}`);
        },
        error(message) {
            write(`${PREFIX} error: ${message}`);
        },
    };
}
