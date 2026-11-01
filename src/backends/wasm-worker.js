/**
 * Worker thread that runs one WebAssembly plugin instance.
 *
 * The worker owns the compiled module and its linear memory. The host thread
 * sends one JSON request per message and receives one JSON reply. Plugin code
 * runs only inside this thread, so a module that loops forever can be stopped
 * by terminating the worker; it can never occupy the host main thread.
 *
 * The other side of that boundary is that a host import cannot return across
 * threads. Version 1 is declaration based: the apply result lists the tools and
 * events, and the host performs the registrations itself.
 *
 * The ABI is specified in `docs/wasm/WasmABI.md`.
 *
 * @module backends/wasm-worker
 */
import { readFileSync } from 'node:fs';
import { parentPort, workerData } from 'node:worker_threads';
/** Exports the core ABI requires every module to provide. */
const REQUIRED_EXPORTS = [
    'memory',
    'mloader_alloc',
    'mloader_free',
    'mloader_call',
    'mloader_result_ptr',
    'mloader_abi_version',
];
/** Core ABI version this host implements; a module reports its own through `mloader_abi_version`. */
const SUPPORTED_ABI_VERSION = 1;
/** Namespace of the optional WASI imports. */
const WASI_NAMESPACE = 'wasi_snapshot_preview1';
let pluginExports = null;
/** Return the message of an unknown thrown value. */
function messageOf(error) {
    return error instanceof Error ? error.message : String(error);
}
/**
 * Load and instantiate the module named in `workerData.entry`.
 *
 * A module that imports the WASI preview1 namespace is instantiated with a
 * minimal provider: no preopened directories, no environment and no arguments.
 *
 * The worker supports the command and reactor shapes. A command module exports
 * `_start`, which runs once for initialization. A reactor module exports
 * `_initialize`, which runs before the version check and before any other
 * exported function, because a reactor runtime such as Go traps when one of its
 * exports runs before initialization. The hook is not WASI specific: a module
 * without WASI imports gets it called directly, and a module with WASI imports
 * gets it called through the WASI provider.
 *
 * @throws {Error} When the file cannot be read, the module fails to compile or
 *   instantiate, a required export is missing, or the reported ABI version is
 *   not supported.
 */
async function init() {
    const { entry } = workerData;
    const bytes = readFileSync(entry);
    const module = await WebAssembly.compile(bytes);
    const needsWasi = WebAssembly.Module.imports(module)
        .some((imported) => imported.module === WASI_NAMESPACE);
    let importObject = {};
    let wasi = null;
    if (needsWasi) {
        const { WASI: Wasi } = await import('node:wasi');
        wasi = new Wasi({
            version: 'preview1',
            args: [],
            env: {},
            returnOnExit: true,
            preopens: {},
        });
        importObject = { [WASI_NAMESPACE]: wasi.wasiImport };
    }
    const instance = await WebAssembly.instantiate(module, importObject);
    const exports_ = instance.exports;
    pluginExports = exports_;
    const missing = REQUIRED_EXPORTS.filter((name) => !(name in exports_));
    if (missing.length > 0) {
        throw new Error(`wasm module missing required exports: ${missing.join(', ')}`);
    }
    // A reactor must be initialized before any exported function runs,
    // including the version export: a reactor runtime such as Go traps when an
    // export is called first. The hook is not WASI specific, because a libc based
    // module can export it without importing WASI. The version check therefore
    // runs after initialization for this shape, because the module cannot report
    // its version before its runtime exists. The module is sandboxed, so
    // initialization has no capability to use and the check still fails the
    // plugin when the version does not match.
    if (typeof exports_._initialize === 'function') {
        if (wasi === null) {
            exports_._initialize();
        }
        else {
            wasi.initialize(instance);
        }
        checkVersion(exports_);
        return;
    }
    if (wasi === null) {
        checkVersion(exports_);
        return;
    }
    // A WASI command module keeps the version check before `_start`, so a module
    // written against a different ABI shape never executes initialization code.
    checkVersion(exports_);
    // A Go wasip1 command calls proc_exit after _start, so later calls are
    // outside the supported behavior; the reactor shape is the supported one.
    if (typeof exports_._start === 'function') {
        wasi.start(instance);
    }
}
/**
 * Check the core ABI version the module reports.
 *
 * @param exports_ - Instance exports.
 * @throws {Error} When the version is not an integer or differs from the
 *   version this host implements.
 */
function checkVersion(exports_) {
    const version = exports_.mloader_abi_version();
    if (!Number.isInteger(version) || version !== SUPPORTED_ABI_VERSION) {
        throw new Error(`wasm module reports ABI version ${String(version)}, `
            + `but this host supports ${SUPPORTED_ABI_VERSION}`);
    }
}
/**
 * Invoke the plugin with one JSON request and return its raw JSON reply.
 *
 * The request buffer is freed after the call. The result buffer is owned by the
 * plugin and is read before the next request is sent.
 *
 * @param op - Operation name.
 * @param payload - Operation payload.
 * @returns JSON text the plugin returned, or an empty string for no result.
 * @throws {Error} When the module is not initialized or `mloader_call` throws.
 */
function invoke(op, payload) {
    const exports_ = pluginExports;
    if (exports_ === null)
        throw new Error('wasm module is not initialized');
    const request = JSON.stringify({ op, payload });
    const bytes = new TextEncoder().encode(request);
    const requestPtr = exports_.mloader_alloc(bytes.byteLength);
    new Uint8Array(exports_.memory.buffer, requestPtr, bytes.byteLength).set(bytes);
    const resultLength = exports_.mloader_call(requestPtr, bytes.byteLength);
    const resultPtr = exports_.mloader_result_ptr();
    let text = '';
    if (resultLength > 0) {
        const view = new Uint8Array(exports_.memory.buffer, resultPtr, resultLength);
        text = new TextDecoder().decode(view);
    }
    try {
        exports_.mloader_free(requestPtr, bytes.byteLength);
    }
    catch {
        // A failed free does not invalidate the result already read.
    }
    return text;
}
if (parentPort === null) {
    throw new Error('the WebAssembly worker must run inside a worker thread');
}
const port = parentPort;
init()
    .then(() => {
    port.on('message', (message) => {
        const { id, op, payload } = message;
        try {
            port.postMessage({ id, ok: true, text: invoke(op, payload) });
        }
        catch (error) {
            port.postMessage({ id, ok: false, error: messageOf(error) });
        }
    });
    port.postMessage({ type: 'ready' });
})
    .catch((error) => {
    port.postMessage({ type: 'init-error', error: messageOf(error) });
});
