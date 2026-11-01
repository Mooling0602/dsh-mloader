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

import { readFileSync } from 'node:fs'
import { parentPort, workerData } from 'node:worker_threads'
import type { WASI } from 'node:wasi'

/**
 * The project compiles against the ES2023 library set, which does not declare
 * the WebAssembly global. This module declares the subset of that API it uses.
 */
interface WasmModule {}

/** One import used by a compiled module. */
interface WasmImport {
  module: string
  name: string
}

/** A compiled WebAssembly module. */
interface WasmModuleApi {
  compile(bytes: Uint8Array): Promise<WasmModule>
  instantiate(module: WasmModule, importObject: Record<string, unknown>): Promise<WasmInstance>
  Module: { imports(module: WasmModule): WasmImport[] }
}

/** An instantiated WebAssembly module. */
interface WasmInstance {
  exports: Record<string, unknown>
}

/** Linear memory of a WebAssembly instance. */
interface WasmMemory {
  buffer: ArrayBuffer
}

/** The six exports the core ABI requires, plus the optional WASI entry. */
interface PluginExports {
  memory: WasmMemory
  mloader_alloc(length: number): number
  mloader_free(ptr: number, length: number): void
  mloader_call(ptr: number, length: number): number
  mloader_result_ptr(): number
  mloader_abi_version(): number
  _start?: () => void
}

declare const WebAssembly: WasmModuleApi

/** Exports the core ABI requires every module to provide. */
const REQUIRED_EXPORTS = [
  'memory',
  'mloader_alloc',
  'mloader_free',
  'mloader_call',
  'mloader_result_ptr',
  'mloader_abi_version',
]

/** Core ABI version this host implements; a module reports its own through `mloader_abi_version`. */
const SUPPORTED_ABI_VERSION = 1

/** Namespace of the optional WASI imports. */
const WASI_NAMESPACE = 'wasi_snapshot_preview1'

let pluginExports: PluginExports | null = null

/** Return the message of an unknown thrown value. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Load and instantiate the module named in `workerData.entry`.
 *
 * A module that imports the WASI preview1 namespace is instantiated with a
 * minimal provider: no preopened directories, no environment and no arguments.
 * Its `_start` export, if any, is called once for initialization.
 *
 * @throws {Error} When the file cannot be read, the module fails to compile or
 *   instantiate, or a required export is missing.
 */
async function init(): Promise<void> {
  const { entry } = workerData as { entry: string }
  const bytes = readFileSync(entry)
  const module = await WebAssembly.compile(bytes)

  const needsWasi = WebAssembly.Module.imports(module)
    .some((imported) => imported.module === WASI_NAMESPACE)

  let importObject: Record<string, unknown> = {}
  let wasi: WASI | null = null

  if (needsWasi) {
    const { WASI: Wasi } = await import('node:wasi')
    wasi = new Wasi({
      version: 'preview1',
      args: [],
      env: {},
      returnOnExit: true,
      preopens: {},
    })
    importObject = { [WASI_NAMESPACE]: wasi.wasiImport }
  }

  const instance = await WebAssembly.instantiate(module, importObject)
  const exports_ = instance.exports as unknown as PluginExports
  pluginExports = exports_

  const missing = REQUIRED_EXPORTS.filter((name) => !(name in exports_))
  if (missing.length > 0) {
    throw new Error(`wasm module missing required exports: ${missing.join(', ')}`)
  }

  // The version check runs before `_start`, so a module written against a
  // different ABI shape never executes initialization code on this host.
  const version = exports_.mloader_abi_version()
  if (!Number.isInteger(version) || version !== SUPPORTED_ABI_VERSION) {
    throw new Error(
      `wasm module reports ABI version ${String(version)}, `
      + `but this host supports ${SUPPORTED_ABI_VERSION}`,
    )
  }

  // A Go wasip1 command calls proc_exit after _start, so later calls are
  // outside the supported behavior; the reactor shape is the supported one.
  if (wasi !== null && typeof exports_._start === 'function') {
    wasi.start(instance)
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
function invoke(op: string, payload: unknown): string {
  const exports_ = pluginExports
  if (exports_ === null) throw new Error('wasm module is not initialized')

  const request = JSON.stringify({ op, payload })
  const bytes = new TextEncoder().encode(request)

  const requestPtr = exports_.mloader_alloc(bytes.byteLength)
  new Uint8Array(exports_.memory.buffer, requestPtr, bytes.byteLength).set(bytes)

  const resultLength = exports_.mloader_call(requestPtr, bytes.byteLength)

  const resultPtr = exports_.mloader_result_ptr()
  let text = ''
  if (resultLength > 0) {
    const view = new Uint8Array(exports_.memory.buffer, resultPtr, resultLength)
    text = new TextDecoder().decode(view)
  }

  try {
    exports_.mloader_free(requestPtr, bytes.byteLength)
  } catch {
    // A failed free does not invalidate the result already read.
  }

  return text
}

if (parentPort === null) {
  throw new Error('the WebAssembly worker must run inside a worker thread')
}

const port = parentPort

init()
  .then(() => {
    port.on('message', (message: { id: number; op: string; payload: unknown }) => {
      const { id, op, payload } = message
      try {
        port.postMessage({ id, ok: true, text: invoke(op, payload) })
      } catch (error: unknown) {
        port.postMessage({ id, ok: false, error: messageOf(error) })
      }
    })
    port.postMessage({ type: 'ready' })
  })
  .catch((error: unknown) => {
    port.postMessage({ type: 'init-error', error: messageOf(error) })
  })
