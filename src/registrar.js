/**
 * dsh-mloader — 插件注册器
 *
 * 定位：外部插件**不是** Cordis 插件，也不产生 Cordis 插件实体。
 * 它们只是"一组注册意图"，由注册器在 **loader 自己的 ctx** 上落到真实 dsh API。
 *
 * 因此：
 *   - dsh 的插件列表看不到它们（本来也看不到动态插件）
 *   - Cordis 的 fiber 树上只有 loader 一个节点
 *   - 卸载单个插件 = 播放该插件自己的 disposer 账本
 */

import { EVENT_WHITELIST, PLUGIN_STATE } from './contract.js'
import { validateToolSchema } from './contract.js'

/**
 * 一个外部插件的注册账本。
 *
 * 每一次对宿主的注册都必须经过 `track()` 记账，卸载时逆序撤销。
 * 这是"独立管理生命周期"的全部实现基础。
 */
export class PluginRegistrar {
  /**
   * @param spec - 来自 discovery 的 PluginSpec。
   * @param ctx - **loader 自己的** Cordis 上下文（不是插件的）。
   * @param logger - loader logger。
   * @param invokeTool - `(tool, args) => Promise<unknown>`，由后端提供。
   * @param dispatchEvent - `(event, args) => Promise<void>`，由后端提供。
   */
  constructor(spec, ctx, logger, invokeTool, dispatchEvent) {
    this.spec = spec
    this.ctx = ctx
    this.logger = logger
    this.invokeTool = invokeTool
    this.dispatchEvent = dispatchEvent

    this.state = PLUGIN_STATE.DISCOVERED
    this.instance = null

    /** @type {Array<{ label: string, dispose: () => unknown }>} */
    this.entries = []
    this.disposed = false
    this.tools = new Map()
    this.subscriptions = new Map()
    this.error = null
  }

  // ── 账本 ────────────────────────────────────────────────────────────────

  /** 记录一个 disposer。账本已关闭时立即执行，不留悬挂注册。 */
  #track(label, dispose) {
    if (this.disposed) {
      safeDispose(dispose, label)
      return
    }
    this.entries.push({ label, dispose })
  }

  /** 撤销该插件的全部注册（逆序）。 */
  dispose() {
    if (this.disposed) return
    this.disposed = true
    for (const entry of this.entries.splice(0).reverse()) {
      safeDispose(entry.dispose, entry.label)
    }
    this.tools.clear()
    this.subscriptions.clear()
    this.state = PLUGIN_STATE.DISPOSED
  }

  get registrationCount() {
    return this.entries.length
  }

  // ── 插件侧 RPC 请求的处理（白名单） ──────────────────────────────────────

  /**
   * 处理一条来自插件实例的 RPC 请求。
   * @param op - 操作名（docs/ABI.md §3）。
   * @param payload - 操作参数。
   */
  async handle(op, payload = {}) {
    if (this.disposed) throw new Error(`plugin ${this.spec.id} has been unloaded`)
    switch (op) {
      case 'tools.register':
        return this.#registerTool(payload)
      case 'events.on':
        return this.#subscribeEvent(payload)
      case 'logger.log':
        return this.#log(payload)
      case 'effect.register':
        return this.#registerEffect(payload)
      default:
        throw new Error(
          `unsupported operation "${op}" ` +
          '(whitelist: tools.register, events.on, logger.log, effect.register)',
        )
    }
  }

  #registerTool(payload) {
    const spec = payload?.tool
    if (!spec || typeof spec !== 'object') throw new Error('tools.register requires payload.tool')
    if (this.tools.has(spec.name)) {
      throw new Error(`tool "${spec.name}" already registered by plugin ${this.spec.id}`)
    }

    const definition = buildToolDefinition(spec, this.spec.id, this.invokeTool)
    // loader 的 ctx 上注册；dsh 侧看到的是 loader 注册的工具，不是"某个插件"注册的。
    const dispose = this.ctx.tools.register(definition)
    this.tools.set(spec.name, dispose)
    this.#track(`tool:${spec.name}`, () => {
      this.tools.delete(spec.name)
      dispose()
    })
    this.logger?.debug?.(`[${this.spec.id}] registered tool ${spec.name}`)
    return { registered: spec.name }
  }

  #subscribeEvent(payload) {
    const event = payload?.event
    if (typeof event !== 'string') throw new Error('events.on requires payload.event')
    if (!EVENT_WHITELIST.has(event)) {
      throw new Error(
        `event "${event}" is not in the mloader whitelist ` +
        `(${[...EVENT_WHITELIST].join(', ')})`,
      )
    }
    if (this.subscriptions.has(event)) {
      throw new Error(`plugin ${this.spec.id} already subscribes to "${event}"`)
    }

    // ★ 事件监听器必须**同步把执行链传下去**，插件分发则异步投递。
    //
    // Cordis 的 waterfall 语义（读 `cordis/lib/index.js` 的 `waterfall()` 实现确认）：
    //   const next = () => (cbs.shift() ?? inner)(...args)
    // 即：监听器收到的最后一个参数就是 `next`，**必须调用它并返回它的结果**，
    // 否则后续监听器和真正的执行体都不会跑 —— 工具执行链直接断掉（返回值变 undefined）。
    //
    // 而如果 `await` 了插件回包（最初的事故写法），宿主就阻塞在事件分发上；
    // 插件此时若回调宿主（ctx.logger 当年是同步 RPC），
    // 就成了「宿主等插件事件回包 / 插件等宿主 RPC 回包」的永久互等，
    // 堵死 tools 通道，dsh 所有工具调用（含 bash）一起超时。
    //
    // 最终策略：
    //   1. 插件分发 fire-and-forget，绝不让它决定主链路进度；
    //   2. 同步调用 next() 传递执行链，保证工具执行不受影响。
    const listener = (...args) => {
      if (this.disposed || this.state === PLUGIN_STATE.DISABLED) {
        // 已卸载：仍然要把执行链传下去，否则会破坏 dsh 的工具执行。
        const next = args[args.length - 1]
        return typeof next === 'function' ? next() : undefined
      }

      // waterfall 事件：最后一个参数是 next
      const next = typeof args[args.length - 1] === 'function' ? args[args.length - 1] : undefined
      const eventArgs = next ? args.slice(0, -1) : args

      void this.dispatchEvent(event, eventArgs).catch((error) => {
        this.logger?.warn?.(`[${this.spec.id}] event "${event}" dispatch failed: ${error.message}`)
      })

      // 同步传递执行链 —— 不等待插件。
      return next ? next() : undefined
    }

    const dispose = this.ctx.on(event, listener)
    this.subscriptions.set(event, dispose)
    this.#track(`event:${event}`, () => {
      this.subscriptions.delete(event)
      if (typeof dispose === 'function') dispose()
    })
    this.logger?.debug?.(`[${this.spec.id}] subscribed ${event}`)
    return { subscribed: event }
  }

  #log(payload) {
    if (typeof payload?.message !== 'string') throw new Error('logger.log requires payload.message')
    const level = ['debug', 'info', 'warn', 'error'].includes(payload.level) ? payload.level : 'info'
    const fn = this.logger?.[level]
    if (typeof fn === 'function') {
      const data = payload.data
      fn.call(this.logger, `[${this.spec.id}] ${payload.message}${data === undefined ? '' : ` ${safeStringify(data)}`}`)
    }
    return { logged: level }
  }

  #registerEffect(payload) {
    const label = typeof payload?.label === 'string' ? payload.label : `plugin:${this.spec.id}`
    // 在 loader 的 ctx 上挂 effect：loader 卸载时该锚点也会被清理。
    const dispose = this.ctx.effect(() => () => {
      this.logger?.debug?.(`[${this.spec.id}] effect ${label} cleaned up`)
    }, `external-effect:${this.spec.id}:${label}`)
    this.#track(`effect:${label}`, () => {
      if (typeof dispose === 'function') dispose()
    })
    return { registered: label }
  }

  /** 生成对外可见的状态快照（供 mloader_status 工具使用）。 */
  snapshot() {
    return {
      id: this.spec.id,
      name: this.spec.name,
      version: this.spec.version,
      backend: this.spec.backend,
      state: this.state,
      tools: [...this.tools.keys()],
      events: [...this.subscriptions.keys()],
      registrations: this.registrationCount,
      ...(this.error ? { error: this.error } : {}),
    }
  }
}

function safeDispose(dispose, label) {
  try {
    const result = dispose()
    if (result && typeof result.then === 'function') result.catch(() => {})
  } catch {
    void label
  }
}

/**
 * 把插件侧声明的纯 JSON 工具规格，重建为 dsh 的 ToolDefinition。
 *
 * 跨进程/wasm 传不了函数，所以 `output.render` 必须在这里重建 ——
 * dsh 要求每个工具声明 `output: { schema, render }`。
 */
export function buildToolDefinition(spec, pluginId, invoke) {
  const where = `plugin "${pluginId}" tool "${spec?.name}"`

  if (typeof spec?.name !== 'string' || !/^[A-Za-z0-9_-]{1,64}$/.test(spec.name)) {
    throw new Error(`${where}: name must match ^[A-Za-z0-9_-]{1,64}$`)
  }
  if (typeof spec.description !== 'string' || spec.description.length === 0) {
    throw new Error(`${where}: description is required`)
  }

  const parameters = spec.parameters ?? { type: 'object', properties: {}, additionalProperties: false }
  const violations = validateToolSchema(parameters, where)
  if (violations.length > 0) throw new Error(violations.join('; '))

  const outputSchema = spec.output ?? { type: 'object', additionalProperties: true }
  const outputViolations = validateToolSchema(outputSchema, `${where} output`)
  if (outputViolations.length > 0) throw new Error(outputViolations.join('; '))

  return {
    name: spec.name,
    description: spec.description,
    parameters,
    output: {
      schema: outputSchema,
      render(_args, value) {
        return [{ type: 'text', text: renderValueAsText(value) }]
      },
    },
    ...(Number.isFinite(spec.timeoutMs) && spec.timeoutMs > 0 ? { timeoutMs: spec.timeoutMs } : {}),
    async execute(args) {
      return await invoke(spec.name, args)
    },
  }
}

function renderValueAsText(value) {
  if (value === undefined || value === null) return 'null'
  if (typeof value === 'string') return value
  try {
    return JSON.stringify(value, null, 2)
  } catch {
    return String(value)
  }
}

function safeStringify(value) {
  try {
    return JSON.stringify(value)
  } catch {
    return '[unserializable]'
  }
}
