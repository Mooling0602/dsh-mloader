# dsh-mloader WebAssembly core ABI v1

English | [简体中文](WasmABI.zh.md)

This document is the normative contract for a WebAssembly plugin and for the worker that hosts it. The shared contract is in [ABI-unified](../ABI-unified.md): the manifest schema, discovery, the capability whitelist, the operation payloads, the lifecycle, the security model and the installation layout. This document specifies the WebAssembly-specific parts.

The protocol version is 1. A change to an export, to a request or result shape or to the declaration object is a contract change.

## Contents

- [1. Required exports](#1-required-exports)
- [2. Request and result contract](#2-request-and-result-contract)
- [3. Declarations](#3-declarations)
- [4. WASI modules](#4-wasi-modules)
- [5. Worker isolation and deadlines](#5-worker-isolation-and-deadlines)
- [6. What the backend does not support](#6-what-the-backend-does-not-support)

## 1. Required exports

The core ABI depends on the WebAssembly core specification only. It does not require WASI for a plugin to work.

| Export | Signature | Purpose |
| --- | --- | --- |
| `memory` | memory | Linear memory used for request and result buffers. |
| `mloader_alloc` | `(len: i32) -> i32` | Allocate a buffer and return its pointer. |
| `mloader_free` | `(ptr: i32, len: i32) -> void` | Free a buffer. |
| `mloader_call` | `(ptr: i32, len: i32) -> i32` | Handle one request and return the result byte length. |
| `mloader_result_ptr` | `() -> i32` | Return the pointer of the result buffer. |
| `mloader_abi_version` | `() -> i32` | Report the core ABI version this module implements. |

The module must report `1`, the core ABI version this host implements. A module missing any of these exports, reporting a non-integer version or reporting any other value fails to initialize, and the plugin is marked `failed`. The manifest has no ABI version field; the export is the authoritative value.

A WASI reactor module also exports `_initialize`, which the worker calls before the version check. Section 4 specifies when it runs. It is not one of the six core exports.

A source-only Rust example that implements these exports lives in `seeds/wasm-mloader/` of the dsh-mloader repository. It is not installed by the loader; build it before use.

The manifest `entry` field names the `.wasm` file, resolved against the manifest directory. Selection through `targets` is a package format target contract and is not implemented; [Package](Package.md) section 1 specifies the field. The worker reads that file, compiles it and instantiates it.

## 2. Request and result contract

- A request is a UTF-8 JSON object `{"op": "...", "payload": {...}}`. The host allocates `len` bytes with `mloader_alloc`, writes the request, and calls `mloader_call`.
- The plugin writes its reply as UTF-8 JSON text into its result buffer and returns the byte length from `mloader_call`. The host reads the result at `mloader_result_ptr()`.
- The plugin must write either `{"ok": true, "result": ...}` or `{"ok": false, "error": {"message": "..."}}`. A reply whose `ok` is `false` fails the call, and a reply that is not valid JSON also fails it.
- The host calls `mloader_free(ptr, len)` for the request buffer after `mloader_call` returns. The result buffer is owned by the plugin and must remain valid until the next request.
- Invalid JSON in the reply fails the call and does not crash the host.

The operations and payload shapes are the shared ones in [ABI-unified](../ABI-unified.md) section 4.2. The WebAssembly backend uses three of them:

| Operation | Payload | Reply `result` |
| --- | --- | --- |
| `apply` | `inject` | The declaration object of section 3. |
| `tool.call` | `tool`, `args` | The JSON value returned by the handler. |
| `event` | `event`, projected `args` array | The handler return value. |

There is no `boot` request. Initialization is the worker handshake in section 5. There is no `dispose` request. Stopping the plugin terminates the worker.

## 3. Declarations

The `apply` reply declares the plugin's capabilities in its `result` object:

```json
{"ok": true, "result": {"tools": [], "events": []}}
```

- Each entry in `tools` is a tool object as specified in [ABI-unified](../ABI-unified.md) section 3.2. Each name in `events` must be in the whitelist of section 3.3.
- The loader performs the real registrations on its own context and records them in the plugin's ledger.
- A declaration the loader rejects fails the apply handshake, and the plugin is marked `failed`.
- The backend has no inbound request channel. A module cannot send `tools.register`, `events.on`, `logger.log` or `effect.register`, and the core ABI provides no way for it to initiate a message.
- There is no log channel and no cleanup channel. The manifest `capabilities` object is declared metadata and does not add one.

## 4. WASI modules

WASI is not part of the supported contract.

- A module that imports `wasi_snapshot_preview1` is instantiated with a minimal preview1 provider: no preopened directories, no environment variables, no arguments, and exit handling that does not terminate the host.
- The worker supports two startup shapes. A command module exports `_start`, which runs once for initialization and may call `proc_exit`. A reactor module exports `_initialize`, which the host calls before the ABI version check and before any other exported function.
- A reactor hook is not WASI specific. A module that imports WASI is initialized through the WASI provider, and a module that imports nothing gets `_initialize` called directly. A libc based module built for `wasm32-wasip1` is the second kind.
- A reactor runtime may trap when one of its exports runs before `_initialize`. A Go `wasip1` module built with `-buildmode=c-shared` and `//go:wasmexport` is a reactor, and it needs the reactor path.
- A Go `wasip1` command module uses the command model: `_start` may call `proc_exit`, so repeated calls after initialization are outside the supported behavior.
- A module that imports no WASI function needs no startup shape. Rust, C or Zig built for `wasm32-unknown-unknown` export the core ABI directly.
- No custom host imports are part of v1. A module that imports anything other than the WASI preview1 namespace fails to instantiate.

## 5. Worker isolation and deadlines

- The module never runs on the host main thread. V8 has no fuel metering and no API to interrupt WebAssembly execution, so a synchronous call with an infinite loop would freeze the main thread permanently, including the timeout timer. Every instance runs in a `worker_threads` worker.
- The host starts the worker, and the worker compiles and instantiates the module, then checks the required exports. A reactor is initialized through `_initialize` next, through the WASI provider when the module imports WASI and directly otherwise, and the version check runs after initialization, because a reactor runtime traps when one of its exports runs first. A command module has its version checked before `_start`, so a module written for another ABI shape never runs initialization code. The worker then posts `ready`. A failure posts `init-error` and the plugin is marked `failed`. Startup succeeds only on `ready`.
- Module initialization has no deadline of its own. A module whose `_start` or `_initialize` never returns never posts `ready`, and the plugin stays `loaded` until it is unloaded or dsh restarts. The worker can still be terminated, so a looping initializer does not block the host thread.
- The worker runs with `resourceLimits.maxOldGenerationSizeMb` set to 256 MB.
- The apply handshake uses the manifest `timeouts.startupMs`, and each `tool.call` or `event` delivery uses `timeouts.callMs`. On expiry the host terminates the worker, because terminating it is the only mechanism that stops a looping instance. A timed out call therefore ends the plugin's instance, unlike the Python backend, where the process stays alive.
- The host clears the worker handle before terminating it, so a late reply cannot settle a call that already failed.
- A worker exit or error rejects every pending call. `stop()` terminates the worker.
- The worker cannot call back into the host synchronously, because a host import cannot return across threads. Version 1 is declaration based, so this costs no capability.
- Arguments to the worker are projected into plain data, because `postMessage` uses structured clone, which throws on host objects such as `AbortSignal`. The projection of [ABI-unified](../ABI-unified.md) section 3.4 applies.
- The backend is off by default. The loader option `wasm.enabled` must be set to `true` before a WebAssembly plugin is started; the operator reference is [CONTEXT](../../CONTEXT.md).

## 6. What the backend does not support

- No logging channel. A module writes diagnostics to WASI stderr when it imports WASI, and has no equivalent of `ctx.logger`.
- No cleanup registration. Stopping the plugin terminates the worker, and no plugin code runs after that.
- No file system and no network access. WASI is instantiated with no preopens, no environment and no arguments.
- No custom host imports beyond the WASI preview1 namespace.
- No synchronous call from the plugin back into the host.
- No repeated calls into a Go `wasip1` command module after its `_start` called `proc_exit`.
