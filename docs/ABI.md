# dsh-mloader plugin ABI v1

This document is the normative contract for the loader, its backends and every
external plugin. The loader and the backends implement it; a third-party plugin may
rely on it. Statements here are requirements, not suggestions.

The current wire protocol is version 1. A change to a frame shape, a manifest field
or the capability whitelist is a contract change, and a change that crosses the
process or thread boundary requires a protocol version bump.

Baseline: dsh `0.2.1-rc.3`, Cordis `4.0.5`.

Operator configuration and implementation detail are not part of this contract. They
live in [CONTEXT.md](../CONTEXT.md). User-facing instructions live in
[README.md](../README.md).

## Contents

- [0. Design axioms](#0-design-axioms)
- [1. Structure](#1-structure)
- [2. Plugin declaration](#2-plugin-declaration)
- [3. ctx capability whitelist](#3-ctx-capability-whitelist)
- [4. RPC protocol](#4-rpc-protocol)
- [5. Lifecycle and ownership](#5-lifecycle-and-ownership)
- [6. Backend interface](#6-backend-interface)
- [7. WebAssembly core ABI](#7-webassembly-core-abi)
- [8. Security model](#8-security-model)
- [9. Installation layout](#9-installation-layout)
- [10. What v1 does not do](#10-what-v1-does-not-do)

## 0. Design axioms

1. **The loader is an ordinary Cordis plugin.** It does not change the dsh loader,
   the bundle mechanism or `import()`, and it replaces no existing plugin.
2. **An external plugin is not a Cordis plugin.** It creates no Cordis plugin entity,
   no fiber node and no per-plugin `ctx` scope, and it never appears in a dsh plugin
   list. It sends registration intents over the protocol in this document, and the
   loader performs the real registrations on its own `ctx`.
3. **The capability surface is a whitelist, not a passthrough.** Only the four
   operations in §3 are reachable. Every other `ctx` facility is unavailable by
   design.
4. **Registrations are revocable.** Every registration a plugin causes belongs to
   that plugin's ledger and is revoked when the plugin unloads.
5. **External code never occupies the host main thread.** Python runs in a child
   process, WebAssembly runs in a worker thread, and the host continues its own
   execution chain without waiting for a plugin.

The consequence of axiom 2 is explicit: an external plugin has no per-plugin `ctx`
isolation, cannot resolve host services through Cordis `inject`, and has no entry in
plugin management. This is the trade that makes hosting non-Cordis code possible.

## 1. Structure

```
dsh main process (Node, Cordis)
|
+-- Cordis container (unchanged)
|
+-- dsh-mloader                    one ordinary Cordis plugin, apply(ctx)
     |
     +-- Discovery                scans roots for mloader.plugin.json
     +-- Lifecycle                startup, reload, unload
     +-- BackendHost              one backend instance per plugin:
     |                            Python child process or WebAssembly worker thread
     |
     +-- for each plugin:
          PluginRegistrar         not a Cordis plugin, only a registration ledger
               |
               +-- registers on the loader's own ctx:
                    ctx.tools.register(...)  dsh sees a loader tool
                    ctx.on(event, ...)       dsh sees a loader listener
```

An external plugin sends declarations, not objects. The loader validates each
declaration and turns it into a real registration on its own context. There is no
`ctx.plugin()` call and no fiber node for an external plugin.

The tool names, event subscriptions and log entries that result from those
declarations are visible to dsh exactly as if the loader had made them itself. The
ledger remembers which registration belongs to which external plugin, so unloading
one plugin revokes only its own registrations.

## 2. Plugin declaration

### 2.1 Manifest: `mloader.plugin.json`

The manifest is the authoritative source of plugin identity and backend selection.
It lives next to the entry file.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "backend": "python",
  "entry": "plugin.py",
  "enabled": true,
  "inject": [],
  "capabilities": { "tools": true, "events": true, "logger": true, "effect": true },
  "timeouts": { "startupMs": 10000, "callMs": 30000 },
  "env": {}
}
```

| Field | Required | Type | Default | Meaning |
|---|---|---|---|---|
| `id` | yes | string | none | Plugin identifier, `^[a-z0-9][a-z0-9_-]{0,31}$`. Also the namespace used by logs. |
| `name` | no | string | `id` | Human readable name. |
| `version` | no | string | `"0.0.0"` | Informational version string. |
| `backend` | yes | `"python"` or `"wasm"` | none | Selects the backend that hosts the plugin. |
| `entry` | yes | string | none | Entry file path relative to the manifest directory. It is resolved to an absolute path. |
| `enabled` | no | boolean | `true` | When `false`, the plugin is discovered and reported but not started. |
| `inject` | no | string[] | `[]` | Metadata forwarded to the plugin in the boot and apply payloads. It grants no capability and resolves no host service. |
| `capabilities` | no | object | all `true` | Switches `tools`, `events`, `logger` and `effect`. They are declared metadata: v1 does not enforce them, so setting one to `false` states intent only. The enforced boundaries are the registration operation whitelist in §3 and the event whitelist in §3.3. |
| `timeouts.startupMs` | no | number | `10000` | Deadline for the boot and apply handshake, in milliseconds. |
| `timeouts.callMs` | no | number | `30000` | Deadline for one tool call or one event delivery, in milliseconds. |
| `env` | no | object | `{}` | Extra environment variables for a Python child process. Values are converted to strings. Ignored by the WebAssembly backend. |

Fields that are not listed are ignored and do not reach the plugin.

### 2.2 Discovery

The loader scans each configured root for `mloader.plugin.json`:

- A root may itself be a plugin directory. It may also contain plugin directories.
  Both layouts are scanned.
- Only directories are considered as plugin directories. A manifest directly in the
  root and a manifest in each plugin subdirectory are both candidates; discovered
  plugins are sorted by `id` after the scan.
- An unreadable root, invalid JSON, a missing required field or an invalid id or
  backend produces one error for that manifest. The other manifests still load.
- A duplicate plugin id is an error on the later manifest. The first manifest in scan
  order wins, because two records would compete for the same registrations.
- The process working directory of a backend instance is the manifest directory. A
  plugin may therefore resolve its own resource files relative to the process
  working directory.

### 2.3 Python SDK

The Python runtime is shipped in the loader repository under
`src/runtime/python_sdk/` and is additionally MIT licensed. It is a flat package with
import name `dsh_mloader_sdk`, standard library only, requiring Python 3.10 or later.
The package is split into the modules `channel`, `context`, `errors`, `runtime` and
`version`. Plugin code normally imports the public names from the package root, and
those modules are also importable directly, for example
`from dsh_mloader_sdk.context import Context`.

The loader starts a Python plugin as:

```
<pythonBin> -u <loader>/src/runtime/python_sdk/launch.py <plugin entry>
```

with the plugin base directory as working directory. `launch.py` loads the package
from the directory that contains it and registers it in `sys.modules`, so
`from dsh_mloader_sdk import ...` always resolves to the copy shipped beside
`launch.py`, even if a package with the same name is installed in the interpreter.

Public names exported by `dsh_mloader_sdk`:

| Name | Kind | Purpose |
|---|---|---|
| `plugin` | decorator | Marks the entry function `apply(ctx)`. |
| `tool` | decorator | Declares a tool without an `apply` function. |
| `ctx` | proxy | The capability context, usable from plugin import time onward. |
| `get_context()` | function | Returns the same context object as `ctx`. |
| `Context` | class | Type of the context object, for annotations. |
| `PluginCallError` | exception | The host rejected a request, for example an invalid registration. |
| `HostUnavailable` | exception | The host channel is closed, or `ctx` is used outside a running plugin process. |
| `PROTOCOL_VERSION` | integer | Wire protocol version, currently `1`. |
| `__version__` | string | Version of the SDK package. |

### 2.4 Style A: Cordis aligned

The plugin exports an entry function and registers capabilities inside it.

```python
from dsh_mloader_sdk import plugin

NAME = "my-plugin"

@plugin
def apply(ctx):
    ctx.logger.info("my-plugin mounted")

    @ctx.tools.register(
        name="greet",
        description="Greet one person.",
        parameters={
            "type": "object",
            "properties": {"who": {"type": "string"}},
            "required": ["who"],
            "additionalProperties": False,
        },
    )
    def greet(args):
        return {"text": f"hello {args['who']}"}

    @ctx.on("tools/execute")
    def observe(payload):
        ctx.logger.debug(f"tool executed: {payload}")

    ctx.effect.register("cleanup", lambda: ctx.logger.info("my-plugin unloading"))
```

A module level `apply` function is also honored when it is not decorated with
`@plugin`. A decorated entry function takes precedence over a plain `apply`.

### 2.5 Style B: declarative

The plugin declares tools as decorated functions and needs no entry function.

```python
from dsh_mloader_sdk import tool

@tool(
    name="add",
    description="Add two numbers.",
    parameters={
        "type": "object",
        "properties": {"a": {"type": "number"}, "b": {"type": "number"}},
        "required": ["a", "b"],
        "additionalProperties": False,
    },
)
def add(args):
    return {"sum": args["a"] + args["b"]}
```

A module level `TOOLS` list is honored as well. Each entry requires `name`,
`description` and `handler`; `parameters`, `output` and `timeoutMs` are optional.

### 2.6 Mixing and ordering

Both styles may be mixed in one plugin. Declared tools are registered first, then the
entry function runs. `@plugin(name="...")` is accepted for readability but has no
effect: the manifest is the identity authority.

### 2.7 Runtime errors

| Situation | Behavior |
|---|---|
| A tool handler raises | The `tool.call` reply is `ok:false` with the exception message. The plugin process stays alive. |
| An unknown tool is called | The reply is `ok:false` with an error message naming the tool. |
| A registration is rejected | The call site inside `apply` raises `PluginCallError`. The apply handshake then fails. |
| The plugin module fails to import | The boot reply is `ok:false` with `import failed: ...`, and the process exits with status 1. |
| A cleanup raises | The traceback goes to `stderr` and the remaining cleanups still run. |
| An unsupported host operation arrives | The reply is `ok:false`. |

`stdout` is the protocol channel only. A stray line that is not JSON is skipped and
reported on `stderr`.

## 3. ctx capability whitelist

### 3.1 The four operations

| # | Host API | RPC operation | Semantics |
|---|---|---|---|
| 1 | `ctx.tools.register(definition)` | `tools.register` | Registers a tool on the loader's context. |
| 2 | `ctx.on(event, listener)` | `events.on` | Subscribes to one whitelisted event. |
| 3 | `ctx.logger.{debug,info,warn,error}(message, data?)` | `logger.log` | One-way log notification. No reply is awaited. |
| 4 | `ctx.effect.register(label, cleanup?)` | `effect.register` | Registers a cleanup that runs when the plugin unloads. |

Nothing else is reachable. `ctx.session`, `ctx.llm`, `ctx.subprocess`, `ctx.commands`
and arbitrary `ctx.*` passthrough are not part of the contract, and a plugin cannot
obtain them.

Slash commands are deliberately not available to external plugins. A command is a
human-facing entry in a global namespace, so letting any external plugin register one
would pollute the user's command list. The loader's own `/mloader` command is a
registration made by the loader as a regular Cordis plugin, not a capability offered
to plugins.

### 3.2 Tool registration

`tools.register` accepts a `tool` object:

| Field | Required | Meaning |
|---|---|---|
| `name` | yes | Must match `^[A-Za-z0-9_-]{1,64}$`. |
| `description` | yes | Non-empty human readable description. |
| `parameters` | no | Input schema in the subset of §3.5. Defaults to an empty object schema. |
| `output` | no | Result schema in the subset of §3.5. Defaults to an object schema with `additionalProperties: true`. |
| `timeoutMs` | no | Positive per-call timeout in milliseconds. It does not replace the manifest `callMs` deadline. |

The loader registers the prepared definition on its own context:

- A duplicate tool name within the same plugin is rejected.
- A name that dsh already has registered is rejected by the tool registry, and the
  registration fails.
- `output.render` cannot cross the plugin boundary, so the loader rebuilds it. The
  renderer turns the returned JSON value into a text block.
- A tool result must be JSON serializable. The handler's exception becomes a tool
  error and does not kill the process.

### 3.3 Event subscriptions

The only subscribable events are:

| Event | Fired when |
|---|---|
| `tools/execute` | A tool is dispatched. |
| `tools/pre-execute` | A tool is about to execute. |
| `tools/post-execute` | A tool has executed. |
| `tools/result` | A tool result is produced. |
| `tools/change` | The tool set changes. |
| `agent/status` | An agent status changes. |
| `agent/created` | An agent is created. |
| `agent/disposed` | An agent is disposed. |
| `session/created` | A session is created. |
| `session/disposed` | A session is disposed. |

- A subscription to an event outside this list is rejected, and the rejection names
  the whitelist.
- A plugin may subscribe to each event once. A duplicate subscription is rejected.
- A subscription is observational. The handler return value does not change the host
  execution or the tool result, and the host chain advances whether or not the plugin
  answers.
- A handler must return promptly and must not wait for the host. The host is
  delivering the event and is not serving further requests from that plugin, so a
  synchronous host request from inside a handler deadlocks both sides. Logging is the
  exception: it is a one-way notification and is safe from inside a handler.
- Handler arity: zero parameters calls `handler()`, exactly one calls
  `handler(first)`, and more than one calls `handler(*args)`.
- An event with no subscribed handler is acknowledged with a null result.

### 3.4 Event payload projection

Every argument that crosses the process or thread boundary is projected into pure
data first. The projection replaces cycles, functions and host objects with markers
and caps depth at 6, arrays at 100 elements, object keys at 100 and strings at 4000
characters. The markers are `[Circular]`, `[Function]`, `[MaxDepth]`, `[Unreadable]`
and `[Truncated]`. An `AbortSignal` becomes
`{ "$type": "AbortSignal", "aborted": true|false, "reason": ... }`; the reason is
present only when the host signal has one. An `Error` becomes
`{ "$type": <name>, "message": ... }`.

For `tools/execute`, `tools/pre-execute`, `tools/post-execute`, `tools/result` and
`tools/change`, the first argument is a live host execution object. It is projected
into this stable shape:

```jsonc
{
  "$type": "ToolExecution",
  "callId": "...",
  "rootCallId": "...",     // when present
  "name": "bash",
  "parent": "...",         // when present
  "token": "...",          // when present
  "arguments": { "command": "ls" },
  "agent": { "id": "...", "name": "...", "kind": "...", "label": "..." },
  "aborted": false
}
```

Only scalar `id`, `name`, `kind` and `label` are copied from the agent; the agent
tree is never exposed. Optional fields are present only when the host value has them.

### 3.5 JSON Schema subset

Tool parameters and tool output use the restricted schema subset the harness
accepts:

- **Constraint keywords:** `type`, `oneOf`, `properties`, `required`,
  `additionalProperties`, `items`, `enum`, `const`.
- **Annotation keywords:** `description`, `title`, `default`, `examples`.
- **Types:** `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`.
- A schema node must be an object. A node cannot declare both `type` and `oneOf`.
- `properties`, `items` and `oneOf` are traversed recursively, and a circular schema
  is rejected.

Everything else is rejected, including `format`, `minimum`, `maximum`, `pattern`,
`$ref`, `anyOf`, `allOf`, `not`, `patternProperties` and `definitions`. The loader
validates before registering and reports the plugin id, the tool name and the schema
path, so a violation is attributable.

## 4. RPC protocol

### 4.1 Transport (Python backend)

- One JSON frame per line, UTF-8, terminated by `\n`. This is not the LSP
  `Content-Length` framing.
- `stdout` is the protocol channel. Diagnostics go to `stderr`, which the loader
  forwards to its logger.
- The child runs with `PYTHONUNBUFFERED=1`.
- The process is long lived. It is not started per call.
- The working directory is the plugin base directory.
- The inherited environment is sanitized before the process starts: variables whose
  names match `KEY`, `PASSWORD`, `SECRET` or `TOKEN` (case-insensitive), and any
  variable starting with `DSH_`, are removed. The manifest `env` object is applied
  afterwards and may set any value.

### 4.2 Frames

Every frame carries `"v": 1`. Request identifiers are matched by `id`; identifiers in
the two directions are independent.

Host to plugin request:

```json
{"v":1,"id":1,"op":"boot","payload":{"pluginId":"my-plugin","manifest":{"id":"my-plugin","name":"My Plugin","version":"1.0.0","inject":[]}}}
{"v":1,"id":2,"op":"apply","payload":{"inject":[]}}
{"v":1,"id":3,"op":"tool.call","payload":{"tool":"greet","args":{"who":"world"}}}
{"v":1,"id":4,"op":"event","payload":{"event":"tools/execute","args":[{"$type":"ToolExecution","name":"bash"}]}}
{"v":1,"id":5,"op":"dispose","payload":{"reason":"loader unload"}}
```

Plugin to host request:

```json
{"v":1,"id":101,"op":"tools.register","payload":{"tool":{"name":"greet","description":"Greet one person.","parameters":{"type":"object"}}}}
{"v":1,"id":102,"op":"events.on","payload":{"event":"tools/execute"}}
{"v":1,"id":103,"op":"logger.log","payload":{"level":"info","message":"ready","data":{}},"notification":true}
{"v":1,"id":104,"op":"effect.register","payload":{"label":"cleanup"}}
```

Reply in either direction:

```json
{"v":1,"id":1,"ok":true,"result":{}}
{"v":1,"id":1,"ok":false,"error":{"message":"reason","kind":"timeout|transport"}}
```

A `logger.log` frame carries `"notification": true`. It never receives a reply, and a
failure to process it is only logged.

The `kind` field appears only on host generated failures: `timeout` when a deadline
expired and `transport` when the frame could not be delivered. A rejection produced
by a plugin carries `message` only.

A notification frame is processed and never answered. Every request frame receives
exactly one reply. A reply for an unknown id and a frame that is neither a request nor
a reply are logged and ignored; neither disturbs the channel.

Host payloads:

| Operation | Payload | Reply result |
|---|---|---|
| `boot` | `pluginId`, `manifest` with `id`, `name`, `version`, `inject` | Python: `pluginId`, `python` version. |
| `apply` | `inject` | `tools`: sorted registered tool names, `events`: sorted subscribed event names. |
| `tool.call` | `tool`, `args` | The JSON value returned by the handler. |
| `event` | `event`, projected `args` array | The handler return value. |
| `dispose` | `reason` | `disposed: true` after cleanups run; the process then exits. |

Plugin payloads:

| Operation | Payload |
|---|---|
| `tools.register` | `tool` object as defined in §3.2. |
| `events.on` | `event` name from the whitelist. |
| `logger.log` | `level` (`debug`, `info`, `warn` or `error`), `message`, optional `data`. |
| `effect.register` | `label`. |

An operation outside these lists is rejected with `ok:false` and an error message
that names the whitelist.

### 4.3 Handshake and call sequence

```
host                                    plugin
 |  spawn                                  |
 |---- boot ------------------------------>|  load the entry module
 |<----------------------------- ready ----|
 |---- apply ----------------------------->|  register declared tools, run apply(ctx)
 |<-------------- tools.register (req) ----|
 |---- ack (ok:true) --------------------->|
 |<-------------- events.on (req) ---------|
 |---- ack (ok:true) --------------------->|
 |<------------------------ apply result --|
 |                                         |
 |---- tool.call ------------------------->|
 |<------------------------------ result --|
 |---- event ----------------------------->|
 |<------------------------------ result --|
 |---- dispose --------------------------->|  run cleanups, exit
```

Registration is host executed: the plugin requests it, and the host performs the real
registration and records the disposer in the plugin's ledger.

The runtime does not validate the manifest. Manifest validation happens during
discovery in the loader, before a backend instance exists. The boot step only loads
the plugin entry module and replies with the plugin id and the Python version.

### 4.4 Timeouts and failures

| Situation | Behavior |
|---|---|
| `boot` or `apply` exceeds `startupMs` (default 10000 ms) | The loader kills the process and marks the plugin `failed`. Other plugins are unaffected. |
| `tool.call` or event delivery exceeds `callMs` (default 30000 ms) | The call returns an error and the process stays alive. A tool timeout does not kill the plugin. |
| The process crashes, including `os._exit()` | The plugin's registrations are revoked and its state becomes `failed`. dsh and the other plugins continue. |
| A plugin request is invalid | It is rejected with `ok:false`, and the plugin can observe the rejection. |
| A frame cannot be delivered | The request fails immediately with a `transport` error instead of waiting for the timeout. |
| A non-protocol line appears on `stdout` | The line is skipped and a warning is logged. The plugin keeps running. |
| `dispose` does not answer within 1000 ms | The loader sends SIGTERM, waits at most 2000 ms, then sends SIGKILL. |

The two deadlines come from the manifest: `timeouts.startupMs` covers `boot` and
`apply`, and `timeouts.callMs` covers `tool.call` and event delivery.

## 5. Lifecycle and ownership

```
discovered -> loaded -> applied -> disposed
                   |
                   +-> failed
     +-> disabled
```

| State | Meaning |
|---|---|
| `discovered` | The manifest is accepted. The plugin is not started, for example because `autoEnable` is `false`. |
| `loaded` | The backend instance is created and the boot handshake is in progress. |
| `applied` | The handshake completed and the plugin's registrations are active. |
| `disabled` | The plugin is not started: the manifest says `enabled: false`, or the WebAssembly backend is disabled. |
| `failed` | A startup, apply or runtime failure occurred. Registrations are revoked. |
| `disposed` | The plugin is unloaded and its ledger is closed. |

- Each registration is recorded in the plugin's ledger by owner. Unloading a plugin
  revokes its registrations in reverse order; a reload does the same before starting
  a new instance.
- A registration attempted after the ledger is closed is disposed immediately rather
  than left dangling.
- A tool call for a plugin that is not `applied` fails with an error that names the
  current state.
- `reload` revokes the ledger, stops the backend instance and starts a fresh one. The
  plugin module is imported again in the new process, so module level state does not
  survive a reload.
- A crashed plugin becomes `failed` and is not restarted automatically. An operator can
  reload it through the loader's optional `mloader` service or restart dsh.

## 6. Backend interface

A backend hosts exactly one external plugin. The backend kind comes from
`manifest.backend`. The loader constructs an instance per plugin and drives it
through this surface, declared structurally in `src/types.ts`:

```ts
interface BackendInstance {
  readonly spec: PluginSpec

  /** Create the process or worker and complete the boot handshake. */
  start(): Promise<unknown>

  /** Install the callback for registration requests. Optional: the WebAssembly
      backend declares its registrations as the apply result instead. */
  setInboundHandler?(
    handler: (op: string, payload: Record<string, unknown>) => Promise<unknown>,
  ): void

  /** Deliver apply and return the registrations the plugin declared. */
  apply(registrar: RegistrarHandle): Promise<{ tools?: string[]; events?: string[] } | undefined>

  /** Call one tool registered by this plugin. */
  callTool(name: string, args: unknown, signal?: unknown): Promise<unknown>

  /** Deliver one host event. */
  dispatchEvent(event: string, args: unknown[]): Promise<unknown>

  /** Stop the instance, killing it if it does not stop in time. */
  stop(reason?: string): Promise<void>
}

interface RegistrarHandle {
  handle(op: string, payload?: Record<string, unknown>): Promise<unknown>
}
```

Both backends satisfy the same contract. Their physical differences are:

| Aspect | Python backend | WebAssembly backend |
|---|---|---|
| Boundary | Operating system process | Worker thread in the host process |
| Transport | NDJSON over `stdin` and `stdout` | `postMessage` and shared linear memory |
| Registration channel | Plugin sends requests during `apply` through `setInboundHandler` | Plugin returns declarations as the `apply` result |
| Timeout enforcement | Request deadline; kill the process on a boot timeout | Terminate the worker |
| Synchronous host callback | Possible in principle, not used by the SDK | Not possible; the worker cannot call back across threads |

A backend must never let plugin code occupy the host main thread, must reap the
process or worker it created when startup fails, and must surface a crash by failing
pending calls so the loader can revoke the plugin's registrations.

## 7. WebAssembly core ABI

The core ABI depends on the WebAssembly core specification only. It does not require
WASI for a plugin to work.

### 7.1 Required exports

| Export | Signature | Purpose |
|---|---|---|
| `memory` | memory | Linear memory used for request and result buffers. |
| `dsh_alloc` | `(len: i32) -> i32` | Allocate a buffer and return its pointer. |
| `dsh_free` | `(ptr: i32, len: i32) -> void` | Free a buffer. |
| `dsh_call` | `(ptr: i32, len: i32) -> i32` | Handle one request and return the result byte length. |
| `dsh_result_ptr` | `() -> i32` | Return the pointer of the result buffer. |

A module missing any of these exports fails to initialize, and the plugin is marked
`failed`.

### 7.2 Request and result contract

- A request is a UTF-8 JSON object `{"op": "...", "payload": {...}}`. The loader
  allocates `len` bytes with `dsh_alloc`, writes the request, and calls `dsh_call`.
- The operation and payload shapes are the same as the host payloads in §4.2.
- After `dsh_call` returns, the result is the JSON text at `dsh_result_ptr()` with the
  returned length. The plugin writes either
  `{"ok": true, "result": ...}` or `{"ok": false, "error": {"message": "..."}}`.
- The loader calls `dsh_free(ptr, len)` for the request buffer after `dsh_call`
  returns. The result buffer is owned by the plugin and must remain valid until the
  next request.
- The loader sends `boot`, `apply`, `tool.call`, `event` and `dispose` operations with
  the same payloads as the Python backend. In reply to `apply`, the plugin returns
  `{"tools": [...], "events": [...]}` as its result, and the loader performs the
  registrations.
- Invalid JSON from the plugin, or a result whose `ok` is `false`, becomes a failed
  call for the loader.

### 7.3 WASI modules

WASI is not part of the supported contract.

- A module that imports `wasi_snapshot_preview1` is instantiated with a minimal
  preview1 provider: no preopened directories, no environment variables, no
  arguments, and exit handling that does not terminate the host. If the module
  exports `_start`, it is called once for initialization.
- Go `wasip1` modules use a command model: `_start` may call `proc_exit`, so repeated
  calls after initialization are outside the supported behavior.
- Reactor style modules are the supported shape, for example Rust, C or Zig built for
  `wasm32-unknown-unknown`.
- No custom host imports are part of v1. A module that imports anything other than the
  WASI preview1 namespace fails to instantiate.

## 8. Security model

| Dimension | Python child process | WebAssembly worker thread |
|---|---|---|
| Isolation boundary | Operating system process | Thread in the same address space |
| File system | Full access by default | No access (no WASI preopens) |
| Network | Allowed by default | No access |
| Crash isolation | Process level; the host is unaffected | Thread level; the host is unaffected |
| Infinite loop | A loop during startup is killed at the startup timeout; a loop during a call fails that call and the process stays alive | The call deadline terminates the worker |
| Memory limit | None imposed by the loader | `maxOldGenerationSizeMb` is 256 |
| Environment | Sanitized; manifest `env` is applied afterwards | Not applicable |

The Python sandbox is process isolation, not permission isolation. A Python plugin can
read and write files and open network connections, so only trusted plugins should run.
The WebAssembly isolation prevents a hang from blocking the host and prevents active
IO, but it is not a security boundary against memory corruption in the module. Only
trusted plugins should run.

Environment sanitization reduces accidental credential inheritance; it is not a
security control that a plugin cannot bypass by reading files.

A crashing or hanging plugin must not take dsh down. The loader revokes that plugin's
registrations, marks it `failed`, and kills or terminates its process or worker. The
other plugins and the host keep running.

## 9. Installation layout

External plugins are installed under the profile, not inside the loader package:

```
~/.dsh/profiles/<profile>/
  cordis.patch.yml
  package.json
  mloader/
    plugins/
      <plugin-id>/
        mloader.plugin.json
        plugin.py
      <other-plugin>/
        mloader.plugin.json
        hello.wasm
```

The directory name is a convention. The plugin id comes from the manifest, not from
the directory name.

The profile's `node_modules` is not a supported install location. It is owned by the
package manager, and `pnpm install` or `pnpm prune` can rebuild it, so hand-placed
plugins there are not stable.

### 9.1 Roots resolution

`roots` accepts three forms:

| Form | Resolution |
|---|---|
| `~/.dsh/...` | The leading `~` is expanded to the home directory. |
| `./x` or `x` | Resolved against the profile directory, or against the current working directory when no profile is detected. |
| `/abs/path` | Used as is. |

Unless `profilePlugins` is `false`, `<profile>/mloader/plugins` is appended as the
last root when the profile is known. Duplicate roots are removed, so listing the
profile directory again does not load a plugin twice.

The profile directory is detected from `ctx.baseUrl`, which dsh sets to the file URL
of the directory containing the active `cordis.yml`. If that is unavailable, the
loader falls back to `DSH_PROFILE_DIR`, then `DSH_HOME` and `DSH_PROFILE`, then a scan
of `~/.dsh/profiles` that succeeds only when exactly one candidate looks like a
profile. A profile is recognized by having both `package.json` and `cordis.yml`. When
no profile is detected, the loader warns and uses only the explicit roots.

### 9.2 Bundled example

When a profile is detected and `seedExamples` is `true`, the loader copies the
bundled example `seed/hello-mloader/` into `<profile>/mloader/plugins/` on startup,
before discovery. If the destination directory exists, the example is skipped as a
whole and nothing is overwritten. `seedExamples: false` performs no file system work.

Do not run `dsh --from-default-profile` against a profile that holds plugins: that
command deletes the whole profile directory, including `mloader/plugins`.

Loader configuration is operator material. The key reference is in
[CONTEXT.md](../CONTEXT.md), and the packaged default layer is `cordis.patch.yml`.

### 9.3 Operator surfaces

dsh-mloader exposes three operator surfaces for the person running dsh:

- the External plugins section on the dsh Plugins page, which lists the hosted plugins
  and switches them on and off at runtime;
- two HTTP routes under `/mloader` that serve the plugin list and the runtime switch to
  the browser half;
- the `/mloader` slash command group.

They are internal to dsh-mloader and are not part of the external plugin ABI. An
external plugin cannot call them, cannot register on them, and must not depend on
their request or response shapes. The browser section and the HTTP routes exist only
in a web profile; a non-web dsh profile mounts the loader and hosts plugins without
them, and the slash command exists only when the optional commands service is
available.

## 10. What v1 does not do

1. It does not replace Cordis, change the dsh loader or touch the bundle mechanism.
2. It does not support calls between external plugins, a service registry, or
   Cordis-style `inject` resolution of host services.
3. It does not provide a Python permission sandbox. Python plugins get process
   isolation only.
4. It does not persist plugin state. Plugins are discovered and mounted again on each
   start.
5. It does not support a plugin UI or a client half.
6. It does not allow a WebAssembly plugin to call back into the host synchronously.
7. It does not expose slash commands or any capability outside the §3 whitelist to
   external plugins.
8. It does not enable the WebAssembly backend by default, and it ships no bundled
   WebAssembly example.
9. It does not restart a crashed plugin automatically.
