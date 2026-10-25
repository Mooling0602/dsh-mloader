/**
 * dsh-mloader — WASM 后端（宿主侧）
 *
 * 核心设计：**主线程永不执行外来 wasm 代码。**
 *
 * 原因：V8 没有 fuel metering，也没有中断 wasm 的 API。同进程同步调用一次死循环
 * 就会永久阻塞 dsh 主线程 —— 连超时定时器都跑不到。唯一的解法是把 wasm 放
 * 独立 worker 线程，超时就 worker.terminate()。
 *
 *   ┌────────────── 主线程 ──────────────┐      ┌───── worker 线程 ─────┐
 *   │ WasmBackendInstance                │      │ wasm 实例             │
 *   │   postMessage({id, op, payload}) ──┼─────▶│   invoke()            │
 *   │   setTimeout(callMs) ──▶ terminate │      │   postMessage 结果    │
 *   └────────────────────────────────────┘      └───────────────────────┘
 *
 * ABI 见 docs/ABI.md §7。
 */

import { Worker } from 'node:worker_threads'
import { projectEventArgs } from '../serialize.js'

export class WasmBackendInstance {
  constructor(spec, { logger }) {
    this.spec = spec
    this.logger = logger
    this.capabilities = { tools: true, events: true, logger: true, effect: true }

    this.worker = null
    this.started = false
    this.stopped = false
    this.seq = 0
    /** @type {Map<number, {resolve: Function, reject: Function, timer: any}>} */
    this.pending = new Map()
    this.consecutiveTimeouts = 0
  }

  setInboundHandler(_handler) {
    // worker 线程无法同步回调宿主；v1 的 apply 返回声明式注册，无需此通道。
  }

  async start() {
    this.worker = await this.#spawnWorker()
    this.started = true
    return this
  }

  #spawnWorker() {
    const worker = new Worker(new URL('./wasm-worker.js', import.meta.url), {
      workerData: { entry: this.spec.entry },
      // 尽力而为的内存上限，避免插件无限分配拖垮宿主。
      resourceLimits: { maxOldGenerationSizeMb: 256 },
    })

    return new Promise((resolve, reject) => {
      const cleanup = () => {
        worker.off('message', onMessage)
        worker.off('error', onError)
        worker.off('exit', onExit)
      }
      const onMessage = (message) => {
        if (message.type === 'ready') {
          cleanup()
          worker.on('message', (reply) => this.#onReply(reply))
          worker.on('exit', (code) => this.#onWorkerExit(worker, code))
          resolve(worker)
        } else if (message.type === 'init-error') {
          cleanup()
          reject(new Error(`[${this.spec.id}] wasm init failed: ${message.error}`))
        }
      }
      const onError = (error) => {
        cleanup()
        reject(new Error(`[${this.spec.id}] wasm worker error: ${error.message}`))
      }
      const onExit = (code) => {
        cleanup()
        reject(new Error(`[${this.spec.id}] wasm worker exited during init (code=${code})`))
      }
      worker.on('message', onMessage)
      worker.on('error', onError)
      worker.on('exit', onExit)
    })
  }

  #onWorkerExit(worker, code) {
    if (this.worker !== worker) return // 已被替换或主动终止
    this.logger?.warn?.(`[${this.spec.id}] wasm worker exited (code=${code})`)
    this.worker = null
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`[${this.spec.id}] wasm worker exited (code=${code})`))
      this.pending.delete(id)
    }
  }

  #onReply(reply) {
    const entry = this.pending.get(reply.id)
    if (!entry) return
    this.pending.delete(reply.id)
    clearTimeout(entry.timer)

    if (!reply.ok) {
      entry.reject(new Error(reply.error ?? 'wasm plugin call failed'))
      return
    }
    if (!reply.text) {
      this.consecutiveTimeouts = 0
      entry.resolve(undefined)
      return
    }
    let frame
    try {
      frame = JSON.parse(reply.text)
    } catch (error) {
      entry.reject(new Error(`[${this.spec.id}] wasm returned invalid JSON: ${error.message}`))
      return
    }
    if (frame.ok === false) {
      entry.reject(new Error(frame.error?.message ?? 'wasm plugin call failed'))
      return
    }
    this.consecutiveTimeouts = 0
    entry.resolve(frame.result)
  }

  /**
   * 发一条请求给 worker，超时就终止线程。
   * 这是整个 WASM 后端存在的理由：**主线程永远有时间跑超时定时器**。
   */
  #invoke(op, payload, timeoutMs) {
    if (!this.worker || this.stopped) {
      return Promise.reject(new Error(`plugin ${this.spec.id} is not running`))
    }
    const worker = this.worker
    const id = ++this.seq

    return new Promise((resolve, reject) => {
      const timer = setTimeout(async () => {
        this.pending.delete(id)
        this.consecutiveTimeouts += 1
        // ★ 唯一能真正杀掉死循环的手段
        this.logger?.error?.(
          `[${this.spec.id}] wasm "${op}" exceeded ${timeoutMs}ms; terminating worker`,
        )
        this.worker = null
        try {
          await worker.terminate()
        } catch {
          // 已经没了
        }
        reject(
          new Error(
            `[${this.spec.id}] wasm call "${op}" timed out after ${timeoutMs}ms ` +
            '(worker terminated — plugin may contain an infinite loop)',
          ),
        )
      }, timeoutMs)

      this.pending.set(id, { resolve, reject, timer })
      try {
        worker.postMessage({ id, op, payload })
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(new Error(`[${this.spec.id}] postMessage failed: ${error.message}`))
      }
    })
  }

  /** 投递 apply：插件返回要注册的工具清单，由宿主完成真实注册。 */
  async apply(registrar) {
    const result = await this.#invoke(
      'apply',
      { inject: this.spec.inject },
      this.spec.timeouts?.startupMs ?? 10000,
    )

    const tools = Array.isArray(result?.tools) ? result.tools : []
    for (const toolSpec of tools) {
      await registrar.handle('tools.register', { tool: toolSpec })
    }

    const events = Array.isArray(result?.events) ? result.events : []
    for (const event of events) {
      await registrar.handle('events.on', { event })
    }

    return { tools: tools.map((tool) => tool.name), events }
  }

  async callTool(name, args, _signal) {
    return this.#invoke('tool.call', { tool: name, args }, this.spec.timeouts?.callMs ?? 30000)
  }

  async dispatchEvent(event, args) {
    try {
      // 与 Python 后端同一条硬规则：过线程/进程边界的东西必须是纯数据。
      // postMessage 用 structuredClone，遇到 AbortSignal / 宿主对象会直接抛
      // DataCloneError；投影掉它们（见 src/serialize.js）。
      return await this.#invoke(
        'event',
        { event, args: projectEventArgs(event, args) },
        this.spec.timeouts?.callMs ?? 30000,
      )
    } catch (error) {
      this.logger?.warn?.(`[${this.spec.id}] event ${event} failed: ${error.message}`)
      return undefined
    }
  }

  async stop(_reason) {
    this.stopped = true
    const worker = this.worker
    this.worker = null

    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer)
      entry.reject(new Error(`[${this.spec.id}] plugin stopped`))
      this.pending.delete(id)
    }

    if (worker) {
      try {
        await worker.terminate()
      } catch {
        // 已经没了
      }
    }
  }
}

export const wasmBackend = {
  kind: 'wasm',
  async createInstance(spec, options) {
    const instance = new WasmBackendInstance(spec, options)
    await instance.start()
    return instance
  },
}
