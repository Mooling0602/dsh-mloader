# dsh-mloader unified plugin ABI v1

English | [简体中文](ABI-unified.zh.md)

This document is the normative contract shared by the loader, its backends and every external plugin. The loader and the backends implement it; a third-party plugin may rely on it. Statements here are requirements, not suggestions.

The companion documents specify the backend contracts and the package format:

- [python-sdk/PyABI](python-sdk/PyABI.md) specifies the Python runtime package, the two registration styles, the result schema inference and the child process transport.
- [wasm/WasmABI](wasm/WasmABI.md) specifies the WebAssembly core ABI and the worker isolation.
- [Package](Package.md) specifies the archive format and the installation rules shared by both backends. The Python backend implements it through the runtime command line; the WebAssembly backend remains a target contract.
- [python-sdk/Package](python-sdk/Package.md) and [wasm/Package](wasm/Package.md) specify the backend package layouts.

The current wire protocol is version 1. A change to a frame shape, a manifest field or the capability whitelist is a contract change, and a change that crosses the process or thread boundary requires a protocol version bump.

Baseline: dsh `0.2.1-rc.3`, Cordis `4.0.5`.

Operator configuration and implementation detail are not part of this contract. They live in [CONTEXT](../CONTEXT.md). User-facing instructions live in [README](../README.md).

## Contents

- [0. Design axioms](#0-design-axioms)
- [1. Structure](#1-structure)
- [2. Plugin declaration](#2-plugin-declaration)
- [3. ctx capability whitelist](#3-ctx-capability-whitelist)
- [4. RPC protocol](#4-rpc-protocol)
- [5. Lifecycle and ownership](#5-lifecycle-and-ownership)
- [6. Backend interface](#6-backend-interface)
- [7. Security model](#7-security-model)
- [8. Installation layout](#8-installation-layout)
- [9. What v1 does not do](#9-what-v1-does-not-do)

## 0. Design axioms

1. **The loader is an ordinary Cordis plugin.** It does not change the dsh loader, the bundle mechanism or `import()`, and it replaces no existing plugin.
2. **An external plugin is not a Cordis plugin.** It creates no Cordis plugin entity, no fiber node and no per-plugin `ctx` scope, and it never appears in a dsh plugin list. It sends registration intents over the protocol in this document, and the loader performs the real registrations on its own `ctx`.
3. **The capability surface is a whitelist, not a passthrough.** Only the five operations in §3 are reachable. Every other `ctx` facility is unavailable by design.
4. **Registrations are revocable.** Every registration a plugin causes belongs to that plugin's ledger and is revoked when the plugin unloads.
5. **External code never occupies the host main thread.** Python runs in a child process, WebAssembly runs in a worker thread, and the host continues its own execution chain without waiting for a plugin.

The consequence of axiom 2 is explicit: an external plugin has no per-plugin `ctx` isolation, cannot resolve host services through Cordis `inject`, and has no entry in plugin management. This is the trade that makes hosting non-Cordis code possible.

## 1. Structure

```plaintext
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

An external plugin sends declarations, not objects. The loader validates each declaration and turns it into a real registration on its own context. There is no `ctx.plugin()` call and no fiber node for an external plugin.

The tool names, event subscriptions and log entries that result from those declarations are visible to dsh exactly as if the loader had made them itself. The ledger remembers which registration belongs to which external plugin, so unloading one plugin revokes only its own registrations.

## 2. Plugin declaration

### 2.1 Manifest: `mloader.plugin.json`

The manifest is the authoritative source of plugin identity and backend selection. It lives at the plugin root and names either the entry file or the platform targets.

```json
{
  "id": "my-plugin",
  "name": "My Plugin",
  "version": "1.0.0",
  "backend": "python",
  "entry": "plugin.py",
  "enabled": true,
  "inject": [],
  "capabilities": { "tools": true, "events": true, "logger": true, "effect": true, "commands": true },
  "timeouts": { "startupMs": 10000, "callMs": 30000 },
  "env": {}
}
```

| Field | Required | Type | Default | Meaning |
| --- | --- | --- | --- | --- |
| `id` | yes | string | none | Plugin identifier, `^[a-z0-9][a-z0-9_-]{0,31}$`. Also the namespace used by logs. |
| `name` | no | string | `id` | Human readable name. |
| `version` | no | string | `"0.0.0"` | Informational version string. A manifest with `targets` must use a Semantic Versioning 2.0.0 string. |
| `backend` | yes | `"python"` or `"wasm"` | none | Selects the backend that hosts the plugin. |
| `entry` | conditionally | string | none | Entry file path relative to the manifest directory. It is resolved to an absolute path. It is required when `targets` is absent, and it must be absent when `targets` is present. |
| `targets` | conditionally | array | none | WebAssembly package targets, specified in [wasm/Package](wasm/Package.md) section 1. It is required for an installable WebAssembly package and absent for a directory-installed plugin. It is valid only with `"backend": "wasm"`, and a manifest with `targets` has no top-level `entry`. |
| `enabled` | no | boolean | `true` | When `false`, the plugin is discovered and reported but not started. |
| `inject` | no | string[] | `[]` | Metadata forwarded to the plugin in its startup payloads. It grants no capability and resolves no host service. |
| `capabilities` | no | object | all `true` | Switches `tools`, `events`, `logger`, `effect` and `commands`. They are declared metadata: v1 does not enforce them, so setting one to `false` states intent only. The enforced boundaries are the registration operation whitelist in §3 and the event whitelist in §3.3. |
| `timeouts.startupMs` | no | number | `10000` | Deadline for the startup handshake and WebAssembly module initialization, in milliseconds. |
| `timeouts.callMs` | no | number | `30000` | Deadline for one tool call or one event delivery, in milliseconds. |
| `env` | no | object | `{}` | Extra environment variables for a Python child process. Values are converted to strings. Ignored by the WebAssembly backend. |

The id `hello-mloader` is reserved for the bundled example. Discovery accepts that id only when the directory carries `.mloader.builtin.json` with the matching id and `source` set to `dsh-mloader`; a manifest with the reserved id and no valid marker is rejected.

Fields that are not listed are ignored and do not reach the plugin.

`targets` is the target contract for installable WebAssembly packages. The loader does not install a WebAssembly plugin from an archive, and a directory-installed WebAssembly plugin continues to use `entry`.

### 2.2 Discovery

The loader scans each configured root for `mloader.plugin.json`:

- A root may itself be a plugin directory. It may also contain plugin directories. Both layouts are scanned.
- Only directories are considered as plugin directories. A manifest directly in the root and a manifest in each plugin subdirectory are both candidates; discovered plugins are sorted by `id` after the scan.
- An unreadable root, invalid JSON, a missing required field or an invalid id or backend produces one error for that manifest. The other manifests still load.
- A duplicate plugin id is an error on the later manifest. The first manifest in scan order wins, because two records would compete for the same registrations.
- The entry path is resolved against the manifest directory. A backend starts its instance with that directory as the working directory when the backend has one, so a plugin may resolve its own resource files relative to it.

The roots are watched while the loader runs. A plugin directory that appears is discovered and started by the same rules as one present at startup, and a directory that disappears is unloaded and its registrations are revoked. This applies to the set of directories only: writing to a manifest or to an entry file of an installed plugin has no effect until the plugin is reloaded. The operator turns watching off with `watch: false`, and a directory added while it is off needs a restart.

### 2.3 Declaring capabilities

An external plugin reaches the capability surface through its backend's channel. The five operations of §3 are the whole surface, and a backend realizes the subset its channel supports. The Python backend sends each operation as a request frame during apply or after it ([PyABI §6](python-sdk/PyABI.md#6-process-transport-and-handshake)), so it carries all five. The WebAssembly backend has no inbound channel: it returns its tool, event and command declarations as the apply result, and it has no logging or cleanup operation ([WasmABI §3](wasm/WasmABI.md#3-declarations)). The loader validates every declaration against §3 and records it in the plugin's ledger, whichever channel delivered it.

## 3. ctx capability whitelist

### 3.1 The five operations

| # | RPC operation | Semantics |
| --- | --- | --- |
| 1 | `tools.register` | Registers a tool on the loader's context. |
| 2 | `events.on` | Subscribes to one whitelisted event. |
| 3 | `logger.log` | One-way log notification. No reply is awaited. |
| 4 | `effect.register` | Registers a cleanup that runs when the plugin unloads. |
| 5 | `commands.register` | Declares a command node in the global slash command namespace. |

The Python SDK exposes these operations as `ctx.tools.register`, `ctx.commands.register`, `ctx.on`, `ctx.logger` and `ctx.effect.register` ([PyABI §3.4](python-sdk/PyABI.md#34-the-context-surface)). The Python backend carries all five. The WebAssembly backend carries tool, event and command declarations; §2.3 states how it delivers them.

Nothing else is reachable. `ctx.session`, `ctx.llm`, `ctx.subprocess` and arbitrary `ctx.*` passthrough are not part of the contract, and a plugin cannot obtain them.

Command names share one global namespace with the commands dsh and other plugins already registered. A command node declares candidate names in priority order, and the loader registers the first name that is not already taken. When every candidate is taken, the loader keeps the command that is already there and skips the node; the plugin keeps loading. Section 3.6 specifies the declaration, the fallback and the retreat rule. A plugin that wants a predictable name should declare an uncommon one, for example a name that carries its own id. The loader's own `/mloader` command is a registration made by the loader as a regular Cordis plugin, not a capability offered to plugins.

### 3.2 Tool registration

`tools.register` accepts a `tool` object:

| Field | Required | Meaning |
| --- | --- | --- |
| `name` | yes | Must match `^[A-Za-z0-9_-]{1,64}$`. |
| `description` | yes | Non-empty human readable description. |
| `parameters` | no | Input schema in the subset of §3.5. Defaults to an empty object schema. |
| `output` | no | Result schema in the subset of §3.5. Defaults to an object schema with `additionalProperties: true`. |
| `timeoutMs` | no | Positive per-call timeout in milliseconds. It does not replace the manifest `callMs` deadline. |

The loader registers the prepared definition on its own context:

- A duplicate tool name within the same plugin is rejected.
- A name that dsh already has registered is rejected by the tool registry, and the registration fails.
- `output.render` cannot cross the plugin boundary, so the loader rebuilds it. The renderer turns the returned JSON value into a text block.
- A tool result must be JSON serializable. The handler's exception becomes a tool error and does not kill the process.

### 3.3 Event subscriptions

The only subscribable events are:

| Event | Fired when |
| --- | --- |
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

- A subscription to an event outside this list is rejected, and the rejection names the whitelist.
- A plugin may subscribe to each event once. A duplicate subscription is rejected.
- A subscription is observational. The handler return value does not change the host execution or the tool result, and the host chain advances whether or not the plugin answers.
- A handler must return promptly and must not wait for the host. The host dispatches events asynchronously, but a blocking handler can delay later work in the plugin process. Logging is a one-way notification and is safe from inside a handler.
- Python handler arity: zero positional parameters calls `handler()`, one receives the first argument if present, and more than one or a variadic positional parameter receives all arguments. Missing required arguments produce a handler error.
- An event with no subscribed handler is acknowledged with a null result.

### 3.4 Event payload projection

Every argument that crosses the process or thread boundary is projected into pure data first. The projection replaces cycles, functions and host objects with markers and caps depth at 6, arrays at 100 elements, object keys at 100 and strings at 4000 characters. The markers are `[Circular]`, `[Function]`, `[MaxDepth]`, `[Unreadable]` and `[Truncated]`. An `AbortSignal` becomes `{ "$type": "AbortSignal", "aborted": true|false, "reason": ... }`; the reason is present only when the host signal has one. An `Error` becomes `{ "$type": <name>, "message": ... }`.

For `tools/execute`, `tools/pre-execute`, `tools/post-execute`, `tools/result` and `tools/change`, the first argument is a live host execution object. It is projected into this stable shape:

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

Only scalar `id`, `name`, `kind` and `label` are copied from the agent; the agent tree is never exposed. Optional fields are present only when the host value has them.

### 3.5 JSON Schema subset

Tool parameters and tool output use the restricted schema subset the harness accepts:

- **Constraint keywords:** `type`, `oneOf`, `properties`, `required`, `additionalProperties`, `items`, `enum`, `const`.
- **Annotation keywords:** `description`, `title`, `default`, `examples`.
- **Types:** `object`, `array`, `string`, `number`, `integer`, `boolean`, `null`.
- A schema node must be an object. A node cannot declare both `type` and `oneOf`.
- `properties`, `items` and `oneOf` are traversed recursively, and a circular schema is rejected.

Everything else is rejected, including `format`, `minimum`, `maximum`, `pattern`, `$ref`, `anyOf`, `allOf`, `not`, `patternProperties` and `definitions`. The loader validates before registering and reports the plugin id, the tool name and the schema path, so a violation is attributable.

### 3.6 Command registration

A command node declares one human-facing entry in the global slash command namespace:

| Field | Required | Meaning |
| --- | --- | --- |
| `id` | no | Stable node id used to route execution. Defaults to the first candidate name. |
| `names` | yes | Non-empty array of candidate command names in priority order. Each matches `^[a-z][a-z0-9_-]{0,63}$`. |
| `description` | yes | Non-empty summary shown in the command list. |
| `input` | no | Object with a non-empty `hint` string, advertised as the input placeholder. |

The loader registers the node through the optional dsh commands service:

- The service is optional in dsh. When it is absent, every command node is skipped with a warning and the plugin stays `applied`.
- Candidate names are tried in order. The first name that is not already registered in the global namespace wins; the remaining candidates stay unused.
- When every candidate is already registered, the loader keeps the existing command and skips the node with a warning. The plugin stays `applied`. This is the retreat rule: an external plugin never replaces a command that is already there.
- A malformed declaration, a repeated node id, or a registration failure that is not a name conflict fails the apply handshake.
- The node id routes execution. The backend receives `command.call` with that id, so a change to the candidate names does not alter the handler binding.
- The registration belongs to the plugin ledger and is revoked when the plugin unloads, disables or fails. A failed plugin therefore loses its commands together with its tools and events.

A command handler receives the text after the registered command name, including the separator whitespace. It returns either a string, which becomes `{"kind": "success", "text": "..."}`, or an object with `kind` (`success` or `error`) and `text`. An error result is rendered by the dispatching UI. A thrown handler error or a command deadline is converted into an error result for that invocation.

Command execution does not pass through the model and adds no authority: the handler runs with the same access the plugin already has. The backend receives `command.call` with the payload `{"command": <node id>, "input": <raw text>}` and answers with the result object.

## 4. RPC protocol

The operation names and payload shapes below are shared by every backend. The frame envelope is the Python backend's framing of them ([PyABI §6](python-sdk/PyABI.md#6-process-transport-and-handshake)); the WebAssembly backend carries the same operations inside its own request and result buffers without the envelope ([WasmABI §2](wasm/WasmABI.md#2-request-and-result-contract)).

### 4.1 Frames

Every frame carries `"v": 1`. Request identifiers are matched by `id`; identifiers in the two directions are independent.

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

A `logger.log` frame carries `"notification": true`. It never receives a reply, and a failure to process it is only logged.

The `kind` field appears only on host generated failures: `timeout` when a deadline expired and `transport` when the frame could not be delivered. A rejection produced by a plugin carries `message` only.

A notification frame is processed and never answered. Every request frame receives exactly one reply. A reply for an unknown id and a frame that is neither a request nor a reply are logged and ignored; neither disturbs the channel.

### 4.2 Operations

Host payloads:

| Operation | Payload | Reply result |
| --- | --- | --- |
| `boot` | `pluginId`, `manifest` with `id`, `name`, `version`, `inject` | Python: `pluginId`, `python` version. |
| `apply` | `inject` | `tools`: sorted registered tool names, `events`: sorted subscribed event names. |
| `tool.call` | `tool`, `args` | The JSON value returned by the handler. |
| `event` | `event`, projected `args` array | The handler return value. |
| `command.call` | `command` (node id), `input` | The command result object with `kind` and `text`. |
| `dispose` | `reason` | `disposed: true` after cleanups run; the process then exits. |

Plugin payloads:

| Operation | Payload |
| --- | --- |
| `tools.register` | `tool` object as defined in §3.2. |
| `events.on` | `event` name from the whitelist. |
| `logger.log` | `level` (`debug`, `info`, `warn` or `error`), `message`, optional `data`. |
| `effect.register` | `label`. |
| `commands.register` | `command` object as defined in §3.6. |

An operation outside these lists is rejected with `ok:false` and an error message that names the whitelist.

The WebAssembly backend has no inbound request channel, so it sends none of the plugin payload operations. It returns `tools`, `events` and `commands` in its apply result instead. It is driven with `apply`, `tool.call`, `command.call` and `event` only: its initialization is the worker `ready` handshake, and its stop path terminates the worker without a `dispose` frame ([WasmABI §3](wasm/WasmABI.md#3-declarations), [WasmABI §5](wasm/WasmABI.md#5-worker-isolation-and-deadlines)).

### 4.3 Deadlines and failures

| Situation | Behavior |
| --- | --- |
| WebAssembly module initialization, `boot`, or `apply` exceeds `startupMs` (default 10000 ms) | The loader stops the backend, marks the plugin `failed`, and leaves the other plugins unaffected. |
| `tool.call` or event delivery exceeds `callMs` (default 30000 ms) | The call returns an error. What happens to the instance is backend-specific: the Python process stays alive ([PyABI §7](python-sdk/PyABI.md#7-deadlines-and-failures)), and the WebAssembly worker is terminated and the failure is reported, so the plugin becomes `failed` and its registrations are revoked ([WasmABI §5](wasm/WasmABI.md#5-worker-isolation-and-deadlines)). |
| `command.call` exceeds `callMs` (default 30000 ms) | The command invocation returns an error result. The Python process stays alive; the WebAssembly worker is terminated and the plugin becomes `failed` ([WasmABI §5](wasm/WasmABI.md#5-worker-isolation-and-deadlines)). |
| The backend crashes | The plugin's registrations are revoked and its state becomes `failed`. dsh and the other plugins continue. |
| A plugin request is invalid | It is rejected with `ok:false`, and the plugin can observe the rejection. |
| A request cannot be delivered | It fails immediately with a `transport` error instead of waiting for the deadline. |

The two deadlines come from the manifest: `timeouts.startupMs` covers WebAssembly module initialization as well as `boot` and `apply`, and `timeouts.callMs` covers `tool.call`, `command.call` and event delivery. A backend enforces a deadline with the mechanism its isolation boundary provides; the backend document specifies that mechanism.

## 5. Lifecycle and ownership

```plaintext
discovered -> loaded -> applied -> disposed
                   |
                   +-> failed
     +-> disabled
```

| State | Meaning |
| --- | --- |
| `discovered` | The manifest is accepted. The plugin is not started, for example because `autoEnable` is `false`. |
| `loaded` | The backend instance is created and the startup handshake is in progress. |
| `applied` | The handshake completed and the plugin's registrations are active. |
| `disabled` | The plugin is not started: the manifest says `enabled: false`, or the WebAssembly backend is disabled. |
| `failed` | A startup, apply or runtime failure occurred. Registrations are revoked. |
| `disposed` | The plugin is unloaded and its ledger is closed. |

- Each registration is recorded in the plugin's ledger by owner. Unloading a plugin revokes its registrations in reverse order; a reload does the same before starting a new instance.
- A registration attempted after the ledger is closed is disposed immediately rather than left dangling.
- A tool call for a plugin that is not `applied` fails with an error that names the current state.
- `reload` revokes the ledger, stops the backend instance and starts a fresh one. The new instance loads the plugin again, so module level state does not survive a reload.
- Command registrations belong to the same ledger. Disabling, unloading or failing a plugin revokes its commands together with its tools and events, and a reload registers them again.
- A crashed plugin becomes `failed` and is not restarted automatically. For the WebAssembly backend a worker that exits, reports an error or exceeds a call deadline follows the same rule: the registrations are revoked, the instance is dropped and the record becomes `failed`. An operator can reload it through the loader's optional `mloader` service or restart dsh.
- A plugin whose directory is deleted while the loader runs moves to `disposed` and is no longer listed. A plugin whose directory is created while the loader runs goes through the same startup path as a plugin present at startup, including the `enabled: false` and `autoEnable: false` rules.

## 6. Backend interface

A backend hosts exactly one external plugin. The backend kind comes from `manifest.backend`. The loader constructs an instance per plugin and drives it through this surface, declared structurally in `src/types.ts`:

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

  /** Run one command node declared by this plugin. */
  callCommand(command: string, input: string): Promise<unknown>

  /** Stop the instance, killing it if it does not stop in time. */
  stop(reason?: string): Promise<void>
}

interface RegistrarHandle {
  handle(op: string, payload?: Record<string, unknown>): Promise<unknown>
}
```

Both backends satisfy the same contract. Their physical differences are:

| Aspect | Python backend | WebAssembly backend |
| --- | --- | --- |
| Boundary | Operating system process | Worker thread in the host process |
| Transport | NDJSON over `stdin` and `stdout` | `postMessage` and shared linear memory |
| Registration channel | Plugin sends requests during `apply` through `setInboundHandler` | Plugin returns declarations as the `apply` result |
| Command dispatch | The plugin sends `commands.register` during apply, and the host calls `command.call` with the node id | The plugin declares `commands` in the apply result, and the host calls `command.call` with the node id |
| Timeout enforcement | Request deadline; kill the process on a boot timeout | Terminate the worker |
| Synchronous host callback | Possible in principle, not used by the SDK | Not possible; the worker cannot call back across threads |

A backend must never let plugin code occupy the host main thread, must reap the process or worker it created when startup fails, and must surface an unexpected failure after apply by failing every pending call and reporting it once to the loader. The loader then revokes the plugin's registrations, marks it `failed` and drops the instance handle. A stop that the loader requested is not a failure.

## 7. Security model

| Dimension | Python child process | WebAssembly worker thread |
| --- | --- | --- |
| Isolation boundary | Operating system process | Thread in the same address space |
| File system | Full access by default | No access (no WASI preopens) |
| Network | Allowed by default | No access |
| Crash isolation | Process level; the host is unaffected | Thread level; the host is unaffected |
| Infinite loop | A loop during startup is killed at the startup timeout; a loop during a call fails that call and the process stays alive | An initialization loop is terminated at the startup timeout; a loop during a call terminates the worker and marks the plugin `failed` ([WasmABI §5](wasm/WasmABI.md#5-worker-isolation-and-deadlines)) |
| Memory limit | None imposed by the loader | The worker's JavaScript heap is capped at 256 MB by `maxOldGenerationSizeMb`; WebAssembly linear memory is not capped |
| Environment | Sanitized; manifest `env` is applied afterwards | Not applicable |

Commands are a human-facing entry, not a new authority. A command handler runs with the same access as a tool handler and cannot reach host services outside §3. The namespace rule in §3.6 prevents an external plugin from replacing a command that dsh or another plugin already registered.

The Python sandbox is process isolation, not permission isolation. A Python plugin can read and write files and open network connections, so only trusted plugins should run. The WebAssembly isolation prevents a hang from blocking the host and prevents active IO, but it is not a security boundary against memory corruption in the module. Only trusted plugins should run.

Environment sanitization reduces accidental credential inheritance; it is not a security control that a plugin cannot bypass by reading files.

A crashing or hanging plugin must not take dsh down. The other plugins and the host keep running. A crash revokes the plugin's registrations and marks it `failed`; a call that exceeds its deadline fails at the caller. The backend document states what happens to the instance.

## 8. Installation layout

External plugins are installed under the profile, not inside the loader package:

```plaintext
~/.dsh/profiles/<profile>/
  cordis.patch.yml
  package.json
  mloader/
    .venv/                 shared Python environment, created with uv or the venv module
    plugins/
      <plugin-id>/
        mloader.plugin.json
        plugin.py
        pyproject.toml     optional Python dependencies
      <other-plugin>/
        mloader.plugin.json
        hello.wasm
```

The directory name is a convention. The plugin id comes from the manifest, not from the directory name.

A plugin is installed by placing its directory under one of the plugin roots. A Python package can be installed from an archive with the runtime command line; [python-sdk/Package](python-sdk/Package.md) section 6 specifies the commands, and the loader itself never reads an archive. Python plugins run in the shared environment of the profile when the loader manages one, so a plugin that needs an isolated dependency set is not supported. The package format in [Package](Package.md) is implemented for Python and remains a target contract for WebAssembly.

The profile's `node_modules` is not a supported install location. It is owned by the package manager, and `pnpm install` or `pnpm prune` can rebuild it, so hand-placed plugins there are not stable.

### 8.1 Roots resolution

`roots` accepts three forms:

| Form | Resolution |
| --- | --- |
| `~/.dsh/...` | The leading `~` is expanded to the home directory. |
| `./x` or `x` | Resolved against the profile directory, or against the current working directory when no profile is detected. |
| `/abs/path` | Used as is. |

Unless `profilePlugins` is `false`, `<profile>/mloader/plugins` is appended as the last root when the profile is known. Duplicate roots are removed, so listing the profile directory again does not load a plugin twice.

The profile directory is detected from `ctx.baseUrl`, which dsh sets to the file URL of the directory containing the active `cordis.yml`. If that is unavailable, the loader falls back to `DSH_PROFILE_DIR`, then `DSH_HOME` and `DSH_PROFILE`, then a scan of `~/.dsh/profiles` that succeeds only when exactly one candidate looks like a profile. A profile is recognized by having both `package.json` and `cordis.yml`. When no profile is detected, the loader warns and uses only the explicit roots.

### 8.2 Bundled example

When a profile is detected and `seedExamples` is `true`, the loader copies the complete bundled Python example `seeds/hello-mloader/` into `<profile>/mloader/plugins/` on startup, before discovery. Every start replaces the installed copy with the packaged copy, including files the reader added, and the copy carries `.mloader.builtin.json`, which is what admits the reserved id. Only a directory under `seeds/` with a complete Python manifest and entry file is released; source-only examples such as `seeds/wasm-mloader/` are never copied. `seedExamples: false` performs no file system work.

Do not run `dsh --from-default-profile` against a profile that holds plugins: that command deletes the whole profile directory, including `mloader/plugins`.

Loader configuration is operator material. The key reference is in [CONTEXT](../CONTEXT.md), and the packaged default layer is `cordis.patch.yml`.

### 8.3 Operator surfaces

dsh-mloader exposes three operator surfaces for the person running dsh:

- the External plugins section on the dsh Plugins page, which lists the hosted plugins and switches them on and off at runtime;
- HTTP routes under `/mloader` that serve the plugin list, runtime switch and loader configuration to the browser half;
- the `/mloader` slash command group, whose detail block lists the commands a hosted plugin registered.

They are internal to dsh-mloader and are not part of the external plugin ABI. An external plugin cannot call them, cannot register on them, and must not depend on their request or response shapes. The browser section and the HTTP routes exist only in a web profile; a non-web dsh profile mounts the loader and hosts plugins without them, and the slash command exists only when the optional commands service is available.

## 9. What v1 does not do

1. It does not replace Cordis, change the dsh loader or touch the bundle mechanism.
2. It does not support calls between external plugins, a service registry, or Cordis-style `inject` resolution of host services.
3. It does not provide a Python permission sandbox. Python plugins get process isolation only.
4. It does not persist plugin state. Plugins are discovered and mounted again on each start.
5. It does not support a plugin UI or a client half.
6. It does not allow a WebAssembly plugin to call back into the host synchronously.
7. It does not expose any capability outside the §3 whitelist to external plugins. Command registration is the only human-facing surface, and §3.6 bounds it.
8. It does not enable the WebAssembly backend by default. It ships a source-only WebAssembly example under `seeds/wasm-mloader/` that the loader never installs.
9. It does not restart a crashed plugin automatically.
10. It does not watch the files inside an installed plugin. A changed manifest or entry file takes effect only after a reload or a restart.
11. It does not give a Python plugin its own environment or select a Python version. All Python plugins of one profile share one environment created from the configured interpreter.
12. It does not install a package from an archive on its own. The Python runtime command line performs that installation.
