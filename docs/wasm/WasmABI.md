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
| `dsh_alloc` | `(len: i32) -> i32` | Allocate a buffer and return its pointer. |
| `dsh_free` | `(ptr: i32, len: i32) -> void` | Free a buffer. |
| `dsh_call` | `(ptr: i32, len: i32) -> i32` | Handle one request and return the result byte length. |
| `dsh_result_ptr` | `() -> i32` | Return the pointer of the result buffer. |

A module missing any of these exports fails to initialize, and the plugin is marked `failed`.

The manifest `entry` field names the `.wasm` file, resolved against the manifest directory. A WebAssembly package selects the artifact through `targets` instead; [Package](Package.md) section 1 specifies the field. The worker reads that file, compiles it and instantiates it.

## 2. Request and result contract

- A request is a UTF-8 JSON object `{"op": "...", "payload": {...}}`. The host allocates `len` bytes with `dsh_alloc`, writes the request, and calls `dsh_call`.
- The plugin writes its reply as UTF-8 JSON text into its result buffer and returns the byte length from `dsh_call`. The host reads the result at `dsh_result_ptr()`.
- The plugin must write either `{"ok": true, "result": ...}` or `{"ok": false, "error": {"message": "..."}}`. A reply whose `ok` is `false` fails the call, and a reply that is not valid JSON also fails it.
- The host calls `dsh_free(ptr, len)` for the request buffer after `dsh_call` returns. The result buffer is owned by the plugin and must remain valid until the next request.
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

- A module that imports `wasi_snapshot_preview1` is instantiated with a minimal preview1 provider: no preopened directories, no environment variables, no arguments, and exit handling that does not terminate the host. If the module exports `_start`, it is called once for initialization.
- Go `wasip1` modules use a command model: `_start` may call `proc_exit`, so repeated calls after initialization are outside the supported behavior.
- Reactor style modules are the supported shape, for example Rust, C or Zig built for `wasm32-unknown-unknown`.
- No custom host imports are part of v1. A module that imports anything other than the WASI preview1 namespace fails to instantiate.

## 5. Worker isolation and deadlines

- The module never runs on the host main thread. V8 has no fuel metering and no API to interrupt WebAssembly execution, so a synchronous call with an infinite loop would freeze the main thread permanently, including the timeout timer. Every instance runs in a `worker_threads` worker.
- The host starts the worker, and the worker compiles and instantiates the module, checks the required exports, calls `_start` when WASI provides one, and then posts `ready`. A failure posts `init-error` and the plugin is marked `failed`. Startup succeeds only on `ready`.
- Module initialization has no deadline of its own. A module whose `_start` never returns never posts `ready`, and the plugin stays `loaded` until it is unloaded or dsh restarts. The worker can still be terminated, so a looping initializer does not block the host thread.
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
