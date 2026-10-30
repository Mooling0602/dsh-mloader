/**
 * Python backend: one long-lived child process per plugin speaking NDJSON.
 *
 * One instance owns one child process and the frame ids it sends. A request
 * settles on a reply, on its deadline, or immediately when the frame cannot be
 * delivered, so the host never waits on a reply that cannot arrive. The process
 * boundary is the isolation boundary: plugin code never runs on the host main
 * thread.
 *
 * The wire contract is protocol version 1, specified in `docs/ABI-unified.md`
 * section 4 and `docs/python-sdk/PyABI.md` section 6.
 *
 * @module backends/python
 */

import { spawn } from 'node:child_process'
import type { ChildProcess } from 'node:child_process'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { PROTOCOL_VERSION } from '../contract.js'
import { projectEventArgs } from '../serialize.js'
import type {
  ApplyResult,
  BackendInstance,
  LoaderLogger,
  PluginCapabilities,
  PluginSpec,
  RegistrarHandle,
} from '../types.js'

const RUNTIME_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'runtime', 'python_sdk')

/**
 * Launcher of the bundled Python runtime.
 *
 * The compiled backend file sits beside its source, so the path resolves to
 * `src/runtime/python_sdk/launch.py` inside the package.
 */
const LAUNCH_SCRIPT = join(RUNTIME_DIR, 'launch.py')

/** Error object carried by a reply frame. */
interface ProtocolError {
  kind?: string
  message?: string
}

/** A protocol frame as it crosses the child process boundary. */
interface ProtocolFrame {
  v?: number
  id?: number
  op?: string
  payload?: Record<string, unknown>
  ok?: boolean
  error?: ProtocolError
  result?: unknown
  notification?: boolean
}

/** A frame that carries a reply to one host request. */
type ReplyFrame = ProtocolFrame & { ok: boolean }

/** A host request waiting for its reply. */
interface PendingRequest {
  resolve(frame: ReplyFrame): void
  timer: ReturnType<typeof setTimeout>
}

/** A frame written by the host. */
interface OutboundFrame {
  v: number
  id?: number
  op?: string
  payload?: unknown
  ok?: boolean
  result?: unknown
  error?: ProtocolError
  notification?: boolean
}

/** How the child process ended. */
export interface PythonProcessExit {
  /** Exit status, or null when the child was killed by a signal. */
  code: number | null
  /** Signal that killed the child, or null on a normal exit. */
  signal: NodeJS.Signals | null
}

/** Callback for the plugin registration channel. */
type InboundHandler = (op: string, payload: Record<string, unknown>) => Promise<unknown>

/** Callback for an unexpected child process exit. */
type CrashHandler = (pluginId: string, info: PythonProcessExit) => void

/** Options of a Python backend instance. */
export interface PythonBackendOptions {
  /** Loader logger. Diagnostics and non-protocol lines are reported through it. */
  logger?: LoaderLogger
  /** Python interpreter to start. Defaults to `python3`. */
  pythonBin?: string
  /** Called once when the child exits without being stopped by the loader. */
  onCrash?: CrashHandler
  /** Keep the `__pycache__` directory the child writes. Defaults to false. */
  enablePyc?: boolean
}

/**
 * Parse one stdout line into a protocol frame.
 *
 * @param line - One complete line from the child process.
 * @returns The frame, or null when the line is not a JSON object.
 */
function parseFrame(line: string): ProtocolFrame | null {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  try {
    const frame = JSON.parse(text) as unknown
    if (frame === null || typeof frame !== 'object') return null
    return frame as ProtocolFrame
  } catch {
    return null
  }
}

/**
 * Return the message of an unknown thrown value.
 *
 * @param error - Caught value.
 * @returns A message safe to log.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Backend for one Python plugin, hosted in one child process.
 *
 * The instance owns the process from `start()` until `stop()`. A crashed
 * process fails every pending request, reports through `onCrash` and stays
 * dead; restarting a plugin is the loader's decision, not this instance's.
 */
export class PythonBackendInstance implements BackendInstance {
  /** Specification of the hosted plugin. */
  readonly spec: PluginSpec

  /** Capabilities the manifest declared, carried for the loader's bookkeeping. */
  readonly capabilities: PluginCapabilities

  private readonly logger: LoaderLogger | undefined
  private readonly pythonBin: string
  private readonly onCrash: CrashHandler | undefined
  private readonly enablePyc: boolean

  private child: ChildProcess | null = null
  private nextId = 1
  private readonly pending = new Map<number, PendingRequest>()
  private buffer = ''
  private stopped = false
  /**
   * Set once stdin reported an error. Writing after the peer closed produces
   * another EPIPE, so later frames are dropped instead.
   */
  private stdinBroken = false
  private onInboundRequest: InboundHandler | null = null

  /**
   * Create the instance. The process is not started until {@link start}.
   *
   * @param spec - Normalised plugin specification from discovery.
   * @param options - Logger, interpreter and crash callback.
   */
  constructor(spec: PluginSpec, options: PythonBackendOptions = {}) {
    const { logger, pythonBin = 'python3', onCrash, enablePyc = false } = options
    this.spec = spec
    this.logger = logger
    this.pythonBin = pythonBin
    this.onCrash = onCrash
    this.enablePyc = enablePyc
    this.capabilities = { tools: true, events: true, logger: true, effect: true }
  }

  /**
   * Start the child process and complete the boot handshake.
   *
   * The child runs `pythonBin -u launch.py <entry>` with the plugin base
   * directory as its working directory and a sanitised environment. The
   * reply deadline is the manifest startup timeout.
   *
   * @returns The boot reply result the plugin sent.
   * @throws {Error} When the process cannot start, or boot fails or times out.
   *   The spawned process is always reaped before the error is thrown.
   */
  async start(): Promise<unknown> {
    const { spec, pythonBin } = this

    const env: NodeJS.ProcessEnv = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (value === undefined) continue
      if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue
      if (key.startsWith('DSH_')) continue
      env[key] = value
    }
    Object.assign(env, spec.env, { PYTHONUNBUFFERED: '1' })
    // The interpreter caches compiled bytecode beside the entry file and
    // invalidates a cache entry by the source mtime in whole seconds plus the
    // source size. An edit that keeps both unchanged therefore reloads the old
    // code, which makes a reload look successful while it is not. The default
    // writes no cache at all; an operator who wants faster loads enables it.
    if (!this.enablePyc) env.PYTHONDONTWRITEBYTECODE = '1'

    const child = spawn(pythonBin, ['-u', LAUNCH_SCRIPT, spec.entry], {
      cwd: spec.baseDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.stdout?.setEncoding('utf8')
    child.stdout?.on('data', (chunk: string) => this.#onStdout(chunk))

    child.stderr?.setEncoding('utf8')
    child.stderr?.on('data', (chunk: string) => {
      const text = chunk.trim()
      if (text) this.logger?.debug?.(`[${spec.id}] ${text}`)
    })

    // A write to the stdin of an exited child fails asynchronously. Without an
    // 'error' listener, EventEmitter raises it as an uncaught exception, which
    // kills the host; a try/catch around write() cannot catch an asynchronous
    // error event.
    child.stdin?.on('error', (error: Error) => {
      this.stdinBroken = true
      if (this.stopped) return
      this.logger?.warn?.(`[${spec.id}] stdin write failed: ${error.message}`)
    })

    child.on('error', (error: Error) => {
      this.#failAllPending(new Error(`python process failed to start: ${error.message}`))
    })

    child.on('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      this.#onExit(code, signal)
    })

    const ready = await this.#request(
      'boot',
      {
        pluginId: spec.id,
        manifest: { id: spec.id, name: spec.name, version: spec.version, inject: spec.inject },
      },
      spec.timeouts.startupMs,
    )
    if (ready.ok !== true) {
      const detail = ready.error?.message ?? 'plugin did not reply ready'
      // A failed startup must reap the process it spawned: no handle would own
      // it afterwards, so an unload could never reach it.
      await this.#killNow()
      throw new Error(`[${spec.id}] boot failed: ${detail}`)
    }
    return ready.result
  }

  /**
   * Reap the child process: SIGTERM, a bounded wait, then SIGKILL.
   *
   * Does not depend on `stopped`, so it is safe during any phase.
   */
  async #killNow(): Promise<void> {
    const child = this.child
    if (child === null) return
    try {
      if (!child.killed) child.kill('SIGTERM')
    } catch {
      // The process already exited.
    }
    await new Promise<void>((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve()
        return
      }
      const timer = setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL')
        } catch {
          // The process already exited.
        }
        resolve()
      }, 2000)
      timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve()
      })
    })
  }

  /**
   * Split one stdout chunk into lines and dispatch each complete line.
   *
   * @param chunk - Decoded text chunk.
   */
  #onStdout(chunk: string): void {
    this.buffer += chunk
    let index: number
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      const frame = parseFrame(line)
      if (frame === null) {
        this.logger?.warn?.(`[${this.spec.id}] non-protocol stdout: ${line.slice(0, 200)}`)
        continue
      }
      this.#onFrame(frame)
    }
  }

  /**
   * Dispatch one protocol frame: a reply to a pending request, or a request
   * from the plugin.
   *
   * @param frame - Parsed frame.
   */
  #onFrame(frame: ProtocolFrame): void {
    if (frame.ok !== undefined || frame.error !== undefined) {
      const id = frame.id
      const waiter = typeof id === 'number' ? this.pending.get(id) : undefined
      if (waiter === undefined) {
        this.logger?.warn?.(`[${this.spec.id}] reply for unknown id ${String(frame.id)}`)
        return
      }
      this.pending.delete(id as number)
      clearTimeout(waiter.timer)
      waiter.resolve(frame as ReplyFrame)
      return
    }

    if (typeof frame.op === 'string') {
      this.#handleInbound(frame)
      return
    }

    this.logger?.warn?.(`[${this.spec.id}] unrecognized frame: ${JSON.stringify(frame).slice(0, 200)}`)
  }

  /**
   * Handle a request the plugin sent while applying or while serving.
   *
   * A notification is one way: it is processed but never answered, so the
   * plugin never waits on logging. A request is answered with the handler
   * result or with the handler error.
   *
   * @param frame - Inbound request frame.
   */
  #handleInbound(frame: ProtocolFrame): void {
    const handler = this.onInboundRequest
    const isNotification = frame.notification === true
    const op = frame.op as string

    if (handler === null) {
      if (!isNotification) {
        this.#respond(frame.id, {
          ok: false,
          error: { message: 'loader not ready to accept registrations' },
        })
      }
      return
    }

    const promise = Promise.resolve().then(() => handler(op, frame.payload ?? {}))
    if (isNotification) {
      promise.catch((error: unknown) => {
        this.logger?.debug?.(`[${this.spec.id}] notification "${op}" failed: ${messageOf(error)}`)
      })
      return
    }
    promise
      .then((result) => this.#respond(frame.id, { ok: true, result: result ?? null }))
      .catch((error: unknown) => this.#respond(frame.id, {
        ok: false,
        error: { message: messageOf(error) },
      }))
  }

  /**
   * Write a reply to one inbound request.
   *
   * @param id - Id of the request being answered.
   * @param body - Reply payload.
   */
  #respond(id: number | undefined, body: { ok: boolean; result?: unknown; error?: ProtocolError }): void {
    this.#write({ v: PROTOCOL_VERSION, id, ...body })
  }

  /**
   * Write one frame to the child's stdin.
   *
   * Serialisation and the write are separate failure domains. A frame that
   * cannot be serialised is dropped and only that frame is lost; the channel
   * stays usable. Only a write failure marks the channel broken.
   *
   * @param frame - Frame to write.
   * @returns True when the frame was written, false when it was dropped.
   */
  #write(frame: OutboundFrame): boolean {
    if (this.child === null || this.child.killed) return false
    if (this.stdinBroken) return false

    let line: string
    try {
      line = `${JSON.stringify(frame)}\n`
    } catch (error: unknown) {
      this.logger?.warn?.(
        `[${this.spec.id}] frame not serializable (op=${frame.op ?? '?'}): ${messageOf(error)}`,
      )
      return false
    }

    const stdin = this.child.stdin
    if (stdin === null) {
      this.stdinBroken = true
      return false
    }

    try {
      stdin.write(line)
      return true
    } catch (error: unknown) {
      this.stdinBroken = true
      this.logger?.warn?.(`[${this.spec.id}] write failed (op=${frame.op ?? '?'}): ${messageOf(error)}`)
      return false
    }
  }

  /**
   * Send one request and wait for its reply.
   *
   * @param op - Operation name.
   * @param payload - Operation payload.
   * @param timeoutMs - Deadline for the reply.
   * @returns The reply frame. A timeout or a frame that could not be delivered
   *   resolves with `ok: false` and an error whose `kind` is `timeout` or
   *   `transport` respectively.
   */
  async #request(op: string, payload: unknown, timeoutMs: number): Promise<ReplyFrame> {
    const id = this.nextId++
    const frame: OutboundFrame = { v: PROTOCOL_VERSION, id, op, payload }
    return await new Promise<ReplyFrame>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({
          id,
          ok: false,
          error: { kind: 'timeout', message: `${op} timed out after ${timeoutMs}ms` },
        })
      }, timeoutMs)
      timer.unref()
      this.pending.set(id, { resolve, timer })
      if (!this.#write(frame)) {
        this.pending.delete(id)
        clearTimeout(timer)
        resolve({
          id,
          ok: false,
          error: {
            kind: 'transport',
            message: `${op} could not be delivered to plugin ${this.spec.id} `
              + '(stdin closed or payload not serializable)',
          },
        })
      }
    })
  }

  /**
   * Install the callback for registration requests from the plugin.
   *
   * @param handler - `(op, payload) => Promise<unknown>`. Its result becomes
   *   the reply, and a thrown error becomes a failed reply.
   */
  setInboundHandler(handler: InboundHandler): void {
    this.onInboundRequest = handler
  }

  /**
   * Deliver the apply request and return the registrations the plugin declared.
   *
   * The deadline is the manifest startup timeout.
   *
   * @returns The apply reply result.
   * @throws {Error} When the plugin rejects apply or the deadline expires.
   */
  async apply(_registrar: RegistrarHandle): Promise<ApplyResult | undefined> {
    const reply = await this.#request(
      'apply',
      { inject: this.spec.inject },
      this.spec.timeouts.startupMs,
    )
    if (reply.ok !== true) {
      throw new Error(`[${this.spec.id}] apply failed: ${reply.error?.message ?? 'unknown error'}`)
    }
    return reply.result as ApplyResult | undefined
  }

  /**
   * Call one tool registered by this plugin.
   *
   * A handler exception becomes a tool error and leaves the process alive. The
   * deadline is the manifest call timeout.
   *
   * @param name - Tool name as registered by the plugin.
   * @param args - Arguments supplied by the model.
   * @returns The JSON value the plugin handler returned.
   * @throws {Error} When the call fails, times out or cannot be delivered. The
   *   `kind` property carries the reply error kind when there is one.
   */
  async callTool(name: string, args: unknown, _signal?: unknown): Promise<unknown> {
    if (this.stopped || this.child === null) {
      throw new Error(`plugin ${this.spec.id} is not running`)
    }
    const reply = await this.#request('tool.call', { tool: name, args }, this.spec.timeouts.callMs)
    if (reply.ok !== true) {
      const message = reply.error?.message ?? 'plugin tool failed'
      const error = new Error(message) as Error & { kind?: string }
      error.kind = reply.error?.kind
      throw error
    }
    return reply.result
  }

  /**
   * Deliver one host event to the plugin.
   *
   * Arguments are projected into plain data before they cross the process
   * boundary. The deadline is the manifest call timeout; a failed delivery
   * rejects and leaves the process alive.
   *
   * @param event - Event name from the whitelist.
   * @param args - Listener arguments, without the waterfall `next` function.
   * @returns The plugin handler result.
   * @throws {Error} When the plugin rejects the event or the deadline expires.
   */
  async dispatchEvent(event: string, args: unknown[]): Promise<unknown> {
    if (this.stopped || this.child === null) return undefined
    const payload = { event, args: projectEventArgs(event, args) }
    const reply = await this.#request('event', payload, this.spec.timeouts.callMs)
    if (reply.ok !== true) {
      throw new Error(reply.error?.message ?? `event ${event} failed`)
    }
    return reply.result
  }

  /**
   * Fail every pending request so no caller keeps waiting on a dead channel.
   *
   * @param error - Failure reported to every pending request.
   */
  #failAllPending(error: Error): void {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, error: { message: error.message } })
    }
    this.pending.clear()
  }

  /**
   * Handle an unexpected child exit: fail pending requests and report a crash.
   *
   * @param code - Exit status.
   * @param signal - Signal that ended the process.
   */
  #onExit(code: number | null, signal: NodeJS.Signals | null): void {
    const wasStopped = this.stopped
    this.stopped = true
    this.#failAllPending(new Error(`plugin process exited (code=${code}, signal=${signal})`))
    if (wasStopped) return
    this.logger?.warn?.(`[${this.spec.id}] python process exited unexpectedly (code=${code}, signal=${signal})`)
    this.onCrash?.(this.spec.id, { code, signal })
  }

  /**
   * Stop the plugin: fail in-flight requests, ask for dispose, then reap.
   *
   * Idempotent. The dispose request is bounded, and the process is killed when
   * it does not exit on its own.
   *
   * @param reason - Reason recorded in the dispose frame.
   */
  async stop(reason = 'loader dispose'): Promise<void> {
    if (this.stopped) return
    this.stopped = true
    this.onInboundRequest = null
    this.#failAllPending(new Error(`[${this.spec.id}] stopped: ${reason}`))
    try {
      await this.#request('dispose', { reason }, 1000)
    } catch {
      // The plugin may already be gone.
    }
    if (this.child !== null && !this.child.killed) {
      try {
        this.child.stdin?.end()
      } catch {
        // The stream is already unusable.
      }
      await this.#killNow()
    }
  }
}
