/**
 * Optional HTTP operator surface of the loader.
 *
 * The loader works without a web server. When the harness provides the
 * `webServer` service, this module registers routes that list hosted plugins,
 * switch a plugin at runtime and edit the loader's profile configuration. These
 * routes serve the browser half and are not part of the external plugin contract.
 *
 * The routes are registered inside the injected scope, so they appear when the
 * web server appears and are removed when the loader or the web server unloads.
 * A failure inside a route handler is logged and answered with an error status;
 * it never reaches the loader.
 *
 * @module http
 */
import { ConfigConflictError, ConfigUnavailableError, ConfigValidationError, readLoaderConfig, writeLoaderConfig } from './config-editor.js';
/** Path that lists every hosted plugin. */
export const PLUGINS_PATH = '/mloader/plugins';
/** Path that switches one hosted plugin on or off. */
export const TOGGLE_PATH = '/mloader/plugins/toggle';
/** Path that reads and edits the loader's profile configuration. */
export const CONFIG_PATH = '/mloader/config';
/** Largest accepted request body, in bytes. */
export const MAX_BODY_BYTES = 64 * 1024;
/**
 * Error thrown when a WebAssembly plugin is enabled while the backend is
 * switched off in the loader configuration.
 *
 * The toggle route maps this error to 409 Conflict: the request is well formed,
 * but the loader configuration refuses it. The manager throws this class so the
 * route can tell a configuration rejection from a start failure without parsing
 * the message.
 */
export class WasmDisabledError extends Error {
    constructor() {
        super('wasm backend is disabled (set config.wasm.enabled = true to opt in)');
        this.name = 'WasmDisabledError';
    }
}
/** Error raised when a request body exceeds {@link MAX_BODY_BYTES}. */
class BodyTooLargeError extends Error {
}
/**
 * Register the operator routes when the harness provides a web server.
 *
 * A context without `inject` support, or a harness without the service, leaves
 * the loader working and the routes absent. Route registration failures are
 * warnings: hosting plugins does not depend on the HTTP surface.
 *
 * @param ctx - The loader's own Cordis context.
 * @param target - Plugin management operations behind the routes.
 * @param logger - Loader logger. Route failures are reported here as warnings.
 */
export function registerMloaderHttp(ctx, target, logger) {
    if (typeof ctx.inject !== 'function') {
        logger?.debug?.('dsh-mloader: ctx.inject is unavailable; HTTP routes were not registered');
        return;
    }
    ctx.inject(['webServer'], (scope) => {
        // The callback only runs once the service is available, and nothing outside
        // this scope touches the routes. A harness without a web server leaves the
        // injected fiber pending and the loader unaffected.
        try {
            const server = scope.get('webServer');
            if (server === undefined || server === null || typeof server.register !== 'function') {
                logger?.warn?.('dsh-mloader: webServer service has no register method; HTTP routes were not registered');
                return;
            }
            const dispose = registerRoutes(server, target, ctx, logger);
            scope.effect(() => () => dispose(), 'dsh-mloader:http');
        }
        catch (error) {
            logger?.warn?.(`dsh-mloader: HTTP route registration failed: ${messageOf(error)}`);
        }
    });
}
/**
 * Register the operator routes on the web server.
 *
 * @param server - The harness web server service.
 * @param target - Plugin management operations behind the routes.
 * @param ctx - Loader context used to resolve the profile configuration editor.
 * @param logger - Loader logger, or undefined.
 * @returns One disposer that removes the routes.
 */
function registerRoutes(server, target, ctx, logger) {
    const disposers = [];
    try {
        disposers.push(server.register({
            kind: 'exact',
            path: PLUGINS_PATH,
            handler: guarded((req, res) => handleList(target, req, res), logger),
        }));
        disposers.push(server.register({
            kind: 'exact',
            path: TOGGLE_PATH,
            handler: guarded((req, res) => handleToggle(target, req, res, logger), logger),
        }));
        disposers.push(server.register({
            kind: 'exact',
            path: CONFIG_PATH,
            handler: guarded((req, res) => handleConfig(ctx, req, res), logger),
        }));
    }
    catch (error) {
        for (const dispose of disposers)
            safeDispose(dispose);
        throw error;
    }
    return () => { for (const dispose of disposers)
        safeDispose(dispose); };
}
/**
 * Wrap one route handler so no failure escapes into the web server.
 *
 * The loader must survive any request, so an unexpected error is logged and
 * answered with 500 when the response is still writable.
 *
 * @param handler - Handler to protect.
 * @param logger - Loader logger, or undefined.
 * @returns The guarded handler.
 */
function guarded(handler, logger) {
    return async (req, res) => {
        try {
            await handler(req, res);
        }
        catch (error) {
            logger?.warn?.(`dsh-mloader: HTTP route failed: ${messageOf(error)}`);
            try {
                sendJson(res, 500, { error: messageOf(error) });
            }
            catch {
                // The response is already sent or the socket is gone.
            }
        }
    };
}
/**
 * Answer one list request.
 *
 * @param target - Plugin management operations.
 * @param req - Incoming request.
 * @param res - Response to write.
 */
async function handleList(target, req, res) {
    const method = methodOf(req);
    if (method !== 'GET') {
        sendJson(res, 405, { error: `method ${method === '' ? 'unknown' : method} is not allowed` });
        return;
    }
    sendJson(res, 200, { plugins: target.list() });
}
/**
 * Answer one toggle request.
 *
 * The body must be `{"id": string, "enabled": boolean}`. A configuration
 * rejection is 409, an unknown plugin is 404, and a failed start is 500 with
 * the plugin snapshot after the failure.
 *
 * @param target - Plugin management operations.
 * @param req - Incoming request.
 * @param res - Response to write.
 * @param logger - Loader logger, or undefined.
 */
async function handleToggle(target, req, res, logger) {
    const method = methodOf(req);
    if (method !== 'POST') {
        sendJson(res, 405, { error: `method ${method === '' ? 'unknown' : method} is not allowed` });
        return;
    }
    let body;
    try {
        body = await readJsonBody(req);
    }
    catch (error) {
        if (error instanceof BodyTooLargeError) {
            sendJson(res, 413, { error: error.message });
            return;
        }
        sendJson(res, 400, { error: 'request body must be valid JSON' });
        return;
    }
    if (!isRecord(body)
        || typeof body.id !== 'string'
        || body.id.length === 0
        || typeof body.enabled !== 'boolean') {
        sendJson(res, 400, { error: 'request body must be {"id": string, "enabled": boolean}' });
        return;
    }
    const id = body.id;
    const enabled = body.enabled;
    if (!target.list().some((plugin) => plugin.id === id)) {
        sendJson(res, 404, { error: `unknown plugin "${id}"` });
        return;
    }
    try {
        const plugin = enabled ? await target.enable(id) : await target.disable(id);
        sendJson(res, 200, { plugin });
    }
    catch (error) {
        if (error instanceof WasmDisabledError) {
            sendJson(res, 409, { error: error.message });
            return;
        }
        if (error instanceof Error && error.message.startsWith('unknown plugin "')) {
            sendJson(res, 404, { error: error.message });
            return;
        }
        logger?.warn?.(`dsh-mloader: toggling plugin ${id} failed: ${messageOf(error)}`);
        const plugin = target.list().find((entry) => entry.id === id) ?? null;
        sendJson(res, 500, { error: messageOf(error), plugin });
    }
}
/** Answer a read or revision-checked write of the loader configuration. */
async function handleConfig(ctx, req, res) {
    const method = methodOf(req);
    if (method !== 'GET' && method !== 'POST') {
        sendJson(res, 405, { error: `method ${method === '' ? 'unknown' : method} is not allowed` });
        return;
    }
    try {
        if (method === 'GET') {
            sendJson(res, 200, readLoaderConfig(ctx));
            return;
        }
        const body = await readJsonBody(req);
        if (!isRecord(body))
            throw new ConfigValidationError('request body must be an object');
        await writeLoaderConfig(ctx, body.revision, body.changes);
        sendJson(res, 200, { saved: true });
    }
    catch (error) {
        if (error instanceof BodyTooLargeError)
            sendJson(res, 413, { error: error.message });
        else if (error instanceof ConfigConflictError)
            sendJson(res, 409, { error: error.message });
        else if (error instanceof ConfigUnavailableError)
            sendJson(res, 503, { error: error.message });
        else if (error instanceof ConfigValidationError || error instanceof SyntaxError) {
            sendJson(res, 400, { error: error.message });
        }
        else
            throw error;
    }
}
/** Read the request method in upper case, or an empty string when absent. */
function methodOf(req) {
    return typeof req.method === 'string' ? req.method.toUpperCase() : '';
}
/**
 * Read and parse one JSON request body.
 *
 * The body is capped at {@link MAX_BODY_BYTES}; a body above the cap throws
 * {@link BodyTooLargeError} before it is buffered in full, and an unparseable
 * body throws the parser error.
 *
 * @param req - Incoming request.
 * @returns The parsed JSON value.
 * @throws {BodyTooLargeError} When the body exceeds the cap.
 * @throws {SyntaxError} When the body is not valid JSON.
 */
async function readJsonBody(req) {
    return JSON.parse((await readBody(req)).toString('utf8'));
}
/**
 * Read a request body while enforcing the size cap.
 *
 * The async iterator of the request is the primary path. A request object that
 * only emits `data` and `end` events is read through those events instead.
 *
 * @param req - Incoming request.
 * @returns The body bytes.
 * @throws {BodyTooLargeError} When the body exceeds the cap.
 */
async function readBody(req) {
    const chunks = [];
    let size = 0;
    const append = (chunk) => {
        const buffer = Buffer.isBuffer(chunk)
            ? chunk
            : Buffer.from(typeof chunk === 'string' ? chunk : String(chunk));
        size += buffer.length;
        if (size > MAX_BODY_BYTES) {
            throw new BodyTooLargeError(`request body exceeds ${MAX_BODY_BYTES} bytes`);
        }
        chunks.push(buffer);
    };
    if (typeof req[Symbol.asyncIterator] === 'function') {
        for await (const chunk of req)
            append(chunk);
    }
    else {
        await new Promise((resolve, reject) => {
            let settled = false;
            req.on?.('data', (chunk) => {
                if (settled)
                    return;
                try {
                    append(chunk);
                }
                catch (error) {
                    settled = true;
                    reject(error);
                }
            });
            req.on?.('end', () => {
                if (settled)
                    return;
                settled = true;
                resolve();
            });
            req.on?.('error', (error) => {
                if (settled)
                    return;
                settled = true;
                reject(error);
            });
        });
    }
    return Buffer.concat(chunks);
}
/** Write one JSON response with its status and content type. */
function sendJson(res, status, body) {
    res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(body));
}
/** Run one route disposer and swallow its failure. */
function safeDispose(dispose) {
    try {
        dispose();
    }
    catch {
        // The web server may already be gone; the other route still has to be removed.
    }
}
/** Return true when a value is a non-array object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
/** Extract a message from an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
