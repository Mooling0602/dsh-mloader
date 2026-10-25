/**
 * dsh-mloader — Python 后端
 *
 * 每插件一个常驻子进程，走 NDJSON over stdio。
 * 协议见 docs/ABI.md §4。
 *
 * 设计要点：
 *   - stdout 是协议通道，插件里的任何 print() 都会被当成坏帧 —— 我们容忍解析失败
 *     并记日志，而不是让整个插件崩掉。
 *   - stderr 是诊断通道，原样转发给 loader logger。
 *   - 超时分两级：startup（启动）与 call（单次工具调用）。call 超时**不杀进程**。
 */

import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { PROTOCOL_VERSION } from '../contract.js'

const HERE = dirname(fileURLToPath(import.meta.url))
/** loader 自带的 Python 引导器；插件作者不需要关心它。 */
const BOOTSTRAP = join(HERE, '..', 'runtime', 'dsh_bootstrap.py')

const DEFAULT_RESTART_LIMIT = 3

/**
 * 把一行文本解析成协议帧。返回 null 表示不是合法帧（例如插件里的 stray print）。
 */
function parseFrame(line) {
  const text = line.trim()
  if (!text.startsWith('{')) return null
  try {
    const frame = JSON.parse(text)
    if (frame === null || typeof frame !== 'object') return null
    return frame
  } catch {
    return null
  }
}

/**
 * 一个 Python 插件实例。
 */
export class PythonBackendInstance {
  /**
   * @param spec - 来自 discovery 的 PluginSpec。
   * @param options.logger - loader logger。
   * @param options.pythonBin - Python 可执行文件，默认 `python3`。
   * @param options.onCrash - 进程意外退出时的回调。
   */
  constructor(spec, { logger, pythonBin = 'python3', onCrash } = {}) {
    this.spec = spec
    this.logger = logger
    this.pythonBin = pythonBin
    this.onCrash = onCrash
    this.capabilities = { tools: true, events: true, logger: true, effect: true }

    this.child = null
    this.nextId = 1
    /** id -> { resolve, reject, timer } */
    this.pending = new Map()
    /** 插件主动发起的请求：id -> op（用于记账） */
    this.inbound = new Map()
    this.buffer = ''
    this.stopped = false
    /** stdin 已不可写（对端死亡后置位），用于避免继续写导致 EPIPE 刷屏。 */
    this.stdinBroken = false
    this.exitReason = undefined
    this.restarts = 0

    /** 插件侧发起注册时调用的回调，由 apply() 设置。 */
    this.onInboundRequest = null
  }

  /** 启动子进程并完成 boot → ready 握手。 */
  async start() {
    const { spec, pythonBin } = this

    // 凭据隔离：与 dsh MCP 子进程同样的做法。
    const env = {}
    for (const [key, value] of Object.entries(process.env)) {
      if (key === undefined) continue
      if (/KEY|PASSWORD|SECRET|TOKEN/i.test(key)) continue
      if (key.startsWith('DSH_')) continue
      env[key] = value
    }
    Object.assign(env, spec.env, { PYTHONUNBUFFERED: '1' })

    const child = spawn(pythonBin, ['-u', BOOTSTRAP, spec.entry], {
      cwd: spec.baseDir,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    })
    this.child = child

    child.stdout.setEncoding('utf8')
    child.stdout.on('data', (chunk) => this.#onStdout(chunk))

    child.stderr.setEncoding('utf8')
    child.stderr.on('data', (chunk) => {
      const text = chunk.trim()
      if (text) this.logger?.debug?.(`[${spec.id}] ${text}`)
    })

    // ★ stdin 必须有 'error' 监听器，否则进程一死就往这里崩。
    //
    // 事故现场：dsh 重启时抛 `fatal uncaught exception: Error: write EPIPE`，
    // 直接把整个 dsh 杀掉。原因不是写入失败本身，而是**没人监听**：
    // 子进程已经退出，往它的 stdin 写会触发异步 'error' 事件，
    // EventEmitter 找不到监听器，就把它升级成 uncaught exception。
    // `#write` 里的 try/catch 挡不住 —— 那是同步异常，EPIPE 是异步的。
    //
    // 处理方式：EPIPE / ERR_STREAM_DESTROYED 是"对端已关闭"的正常后果，
    // 记录后忽略；其余错误也不该冒泡到 dsh，同样降级为 warn。
    child.stdin.on('error', (error) => {
      this.stdinBroken = true
      if (this.stopped) return // 正常关闭过程中的 EPIPE，不值得报警
      this.logger?.warn?.(`[${spec.id}] stdin write failed: ${error.message}`)
    })

    child.on('error', (error) => {
      this.#failAllPending(new Error(`python process failed to start: ${error.message}`))
    })

    child.on('exit', (code, signal) => {
      this.#onExit(code, signal)
    })

    // boot 超时由 startupMs 控制
    const ready = await this.#request(
      'boot',
      { pluginId: spec.id, manifest: { id: spec.id, name: spec.name, version: spec.version, inject: spec.inject } },
      spec.timeouts.startupMs,
    )
    if (!ready || ready.ok !== true) {
      const detail = ready?.error?.message ?? 'plugin did not reply ready'
      // ★ 启动失败必须自己收拾残局。
      //
      // 踩过的坑：插件在 apply 里卡死（例如 time.sleep(600)）时 boot 会超时，
      // 这里如果直接 throw，已经 spawn 出来的 Python 进程就成了孤儿 ——
      // 没人持有它的句柄，码头卸载时也不会回收它。
      // 实测能看到测试结束后 pgrep 仍能查到该进程。
      await this.#killNow()
      throw new Error(`[${spec.id}] boot failed: ${detail}`)
    }
    return ready.result
  }

  /**
   * 强制回收子进程：SIGTERM → 等待 → SIGKILL。
   * 不依赖 this.stopped，可在任何阶段调用。
   */
  async #killNow() {
    const child = this.child
    if (child === null) return
    try {
      if (!child.killed) child.kill('SIGTERM')
    } catch {
      // 已经退出
    }
    await new Promise((resolve) => {
      if (child.exitCode !== null || child.signalCode !== null) {
        resolve(undefined)
        return
      }
      const timer = setTimeout(() => {
        try {
          if (!child.killed) child.kill('SIGKILL')
        } catch {
          // ignore
        }
        resolve(undefined)
      }, 2000)
      if (typeof timer.unref === 'function') timer.unref()
      child.once('exit', () => {
        clearTimeout(timer)
        resolve(undefined)
      })
    })
  }

  #onStdout(chunk) {
    this.buffer += chunk
    let index
    while ((index = this.buffer.indexOf('\n')) !== -1) {
      const line = this.buffer.slice(0, index)
      this.buffer = this.buffer.slice(index + 1)
      if (!line.trim()) continue
      const frame = parseFrame(line)
      if (frame === null) {
        // 插件里的 stray print 污染了协议通道。记下来但别炸。
        this.logger?.warn?.(`[${this.spec.id}] non-protocol stdout: ${line.slice(0, 200)}`)
        continue
      }
      this.#onFrame(frame)
    }
  }

  #onFrame(frame) {
    // 应答：有 pending 的同 id
    if (frame.ok !== undefined || frame.error !== undefined) {
      const waiter = this.pending.get(frame.id)
      if (!waiter) {
        this.logger?.warn?.(`[${this.spec.id}] reply for unknown id ${frame.id}`)
        return
      }
      this.pending.delete(frame.id)
      clearTimeout(waiter.timer)
      waiter.resolve(frame)
      return
    }

    // 请求：插件发给宿主的注册意图
    if (typeof frame.op === 'string') {
      this.#handleInbound(frame)
      return
    }

    this.logger?.warn?.(`[${this.spec.id}] unrecognized frame: ${JSON.stringify(frame).slice(0, 200)}`)
  }

  #handleInbound(frame) {
    const handler = this.onInboundRequest
    const isNotification = frame.notification === true

    if (!handler) {
      if (!isNotification) {
        this.#respond(frame.id, { ok: false, error: { message: 'loader not ready to accept registrations' } })
      }
      return
    }

    // notification 是单向消息（如日志）：处理但不回包，永远不该让插件等。
    const promise = Promise.resolve().then(() => handler(frame.op, frame.payload ?? {}))
    if (isNotification) {
      promise.catch((error) => {
        this.logger?.debug?.(`[${this.spec.id}] notification "${frame.op}" failed: ${error?.message}`)
      })
      return
    }
    promise
      .then((result) => this.#respond(frame.id, { ok: true, result: result ?? null }))
      .catch((error) => this.#respond(frame.id, {
        ok: false,
        error: { message: error?.message ?? String(error) },
      }))
  }

  #respond(id, body) {
    this.#write({ v: PROTOCOL_VERSION, id, ...body })
  }

  #write(frame) {
    if (this.child === null || this.child.killed) return
    // stdin 已报错 / 已关闭：再写只会继续产生 EPIPE。直接丢弃。
    if (this.stdinBroken) return
    try {
      this.child.stdin.write(`${JSON.stringify(frame)}\n`)
    } catch (error) {
      // 同步异常（例如流已 destroyed）。异步 EPIPE 由 stdin 的 'error' 监听器接住。
      this.stdinBroken = true
      this.logger?.warn?.(`[${this.spec.id}] write failed: ${error.message}`)
    }
  }

  /**
   * 发一条请求并等待应答。
   * @returns 应答帧；超时返回 `{ ok:false, error:{ kind:'timeout' } }`。
   */
  async #request(op, payload, timeoutMs) {
    const id = this.nextId++
    const frame = { v: PROTOCOL_VERSION, id, op, payload }
    return await new Promise((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id)
        resolve({ id, ok: false, error: { kind: 'timeout', message: `${op} timed out after ${timeoutMs}ms` } })
      }, timeoutMs)
      // Node 的 timer 不应阻止进程退出
      if (typeof timer.unref === 'function') timer.unref()
      this.pending.set(id, { resolve, timer })
      this.#write(frame)
    })
  }

  /**
   * 注入注册通道：插件在 apply 期间发来的注册意图经此回调处理。
   * @param handler - `(op, payload) => Promise<unknown>`。
   */
  setInboundHandler(handler) {
    this.onInboundRequest = handler
  }

  /**
   * 投递 apply：插件执行 apply(ctx) / 注册 TOOLS，期间经 handler 回调宿主。
   * @param registrar - 用于取 pluginId 与超时配置的记录对象。
   */
  async apply(registrar) {
    const reply = await this.#request(
      'apply',
      { inject: this.spec.inject },
      this.spec.timeouts.startupMs,
    )
    if (reply.ok !== true) {
      throw new Error(`[${this.spec.id}] apply failed: ${reply.error?.message ?? 'unknown error'}`)
    }
    return reply.result
  }

  /** 调用该插件注册的一个工具。插件侧抛错 → 转成工具错误（不杀进程）。 */
  async callTool(name, args, signal) {
    if (this.stopped || this.child === null) {
      throw new Error(`plugin ${this.spec.id} is not running`)
    }
    const reply = await this.#request('tool.call', { tool: name, args }, this.spec.timeouts.callMs)
    if (reply.ok !== true) {
      const message = reply.error?.message ?? 'plugin tool failed'
      const error = new Error(message)
      error.kind = reply.error?.kind
      throw error
    }
    return reply.result
  }

  /** 把一个宿主事件投递给插件。 */
  async dispatchEvent(event, args) {
    if (this.stopped || this.child === null) return undefined
    const reply = await this.#request('event', { event, args }, this.spec.timeouts.callMs)
    if (reply.ok !== true) {
      throw new Error(reply.error?.message ?? `event ${event} failed`)
    }
    return reply.result
  }

  #failAllPending(error) {
    for (const [, waiter] of this.pending) {
      clearTimeout(waiter.timer)
      waiter.resolve({ ok: false, error: { message: error.message } })
    }
    this.pending.clear()
  }

  #onExit(code, signal) {
    const wasStopped = this.stopped
    this.stopped = true
    this.exitReason = { code, signal }
    this.#failAllPending(new Error(`plugin process exited (code=${code}, signal=${signal})`))
    if (wasStopped) return
    this.logger?.warn?.(`[${this.spec.id}] python process exited unexpectedly (code=${code}, signal=${signal})`)
    this.onCrash?.(this.spec.id, { code, signal })
  }

  /** 优雅关闭：发 dispose，等一会儿，然后强杀。 */
  async stop(reason = 'loader dispose') {
    if (this.stopped) return
    this.stopped = true
    this.onInboundRequest = null
    // 立刻让所有在途请求（含卡住的 boot）失败，避免卸载被 boot 拖住。
    this.#failAllPending(new Error(`[${this.spec.id}] stopped: ${reason}`))
    try {
      await this.#request('dispose', { reason }, 1000)
    } catch {
      // 插件可能已经死了，忽略
    }
    if (this.child && !this.child.killed) {
      // stdin.end() 在流已损坏时也会触发异步 EPIPE —— 同样需要兜住。
      try {
        this.child.stdin.end()
      } catch {
        // 已经不可写，忽略
      }
      await this.#killNow()
    }
  }
}

export { DEFAULT_RESTART_LIMIT }
