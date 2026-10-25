/**
 * dsh-mloader — 核心（Cordis 插件入口）
 *
 * 定位（这是整个项目的根本约束）：
 *
 *   1. 本文件就是一个**普通 Cordis 插件**。dsh 用 cordis.patch.yml 挂它，
 *      它不修改 dsh 的 Loader / bundle / import()，也不替换任何既有插件。
 *   2. 外部（Python / WASM）插件**不是 Cordis 插件**，不产生 Cordis 插件实体，
 *      不会出现在 dsh 的任何插件列表里。它们只是"一组注册意图"，
 *      由 loader 在自己的 ctx 上落成真实 dsh 能力。
 *   3. 外部插件的生命周期完全由 loader 独立管理（disposer 账本，按插件记账）。
 *
 *   所以架构是：
 *
 *     dsh 主进程
 *     └─ Cordis 容器
 *          └─ dsh-mloader          ← 唯一的 Cordis 插件（本文件）
 *               ├─ py-hello   (子进程)   ← 不是 Cordis 插件
 *               └─ wasm-demo  (实例)     ← 不是 Cordis 插件
 */

import { discover } from './discovery.js'
import { PluginRegistrar } from './registrar.js'
import { PythonBackendInstance } from './backends/python.js'
import { PLUGIN_STATE, profilePluginsDir, resolveProfileDir, resolveRoots } from './contract.js'
import { WasmBackendInstance } from './backends/wasm.js'
import { createStatusTool } from './tools/status.js'
import { DEFAULT_COMMAND_NAME, registerStatusCommand } from './commands/status.js'
import { installSeedExamples } from './seed.js'
import { createConsole } from './console.js'

export const name = 'dsh-mloader'

/** 我们只用公开的 tools 注册能力。 */
export const inject = ['tools']

const DEFAULTS = {
  roots: [],
  /**
   * 是否自动把 `<profile>/mloader/plugins` 也当作插件根（默认 true）。
   *
   * 打开后，"把插件装进 profile"就是开箱即用的，配置里不需要写绝对路径 ——
   * 写绝对路径正是让同一份配置无法在另一台机器上复用的原因。
   * 测试等场景需要**只**用显式 roots 时设为 false。
   */
  profilePlugins: true,
  /**
   * 覆盖 profile 目录。默认 undefined → 依次从 `ctx.baseUrl`、环境变量、
   * 唯一 profile 兜底探测推导（见 contract.js 的 resolveProfileDir）。
   *
   * 生产环境不要设置；仅供测试注入一个临时 profile。
   */
  profileDir: undefined,
  autoEnable: true,
  restartOnCrash: false,
  pythonBin: 'python3',
  statusTool: true,
  /**
   * 斜杠命令。
   *   false          → 不注册
   *   'some-name'    → 用自定义命令名（不含 `/`）
   *   默认/true      → 注册 `/mloader-status`
   *
   * 命令名必须匹配 dsh 的规则 `/^[a-z][a-z0-9_-]*$/`。
   * 另外 `commands` 服务缺失时会自动跳过（不报错），因此这项配置永远安全。
   */
  statusCommand: true,
  /**
   * 首次启动时把包内置的示例插件释放到 `<profile>/mloader/plugins/`。
   *
   * 目标目录已存在就整体跳过，**绝不覆盖用户改动**。
   * CI / 测试 / 想要干净环境时设为 false。
   */
  seedExamples: true,
  /**
   * 终端输出开关。
   *
   *   true       → 只输出生命周期节点（加载 / 卸载 / 崩溃），默认
   *   'verbose'  → 额外输出发现、路径解析等细节
   *   false      → 完全静默（连生命周期也不打）
   *
   * 为什么需要它：dsh 的 `ctx.logger` 不打印到终端（只进内存缓冲区），
   * 所以想在 `dsh web` 的命令行里看到码头动静，必须显式写 console。
   * 详见 src/console.js 的说明。
   */
  console: true,
  /**
   * WASM 后端**默认关闭**。
   *
   * 理由：wasm 代码现在跑在独立 worker 线程里，超时靠 worker.terminate() 兜底，
   * 但这条路径的故障注入覆盖还不够（尤其 Go wasip1 的 command 模型）。
   * 在实测通过之前，必须显式 `wasm: { enabled: true }` 才会加载 wasm 插件。
   */
  wasm: { enabled: false },
}

/**
 * 由 loader 统一管理的插件集合。
 *
 * 这个类就是"独立管理"的载体：dsh 不知道它的存在，它自己管自己的插件。
 */
class PluginManager {
  constructor(ctx, logger, config) {
    this.ctx = ctx
    this.logger = logger
    this.config = config
    /** 终端输出通道（与 logger 是两条路：logger 进内存，out 进终端）。 */
    this.out = config.out ?? createConsole(config)
    /** @type {Map<string, PluginRegistrar>} */
    this.records = new Map()
    this.disposed = false
    /** 卸载/中止信号：boot() 看到它就停止启动剩余插件。 */
    this.aborted = false
  }

  /** 发现 + 启动全部插件。单个失败不影响其余。 */
  async boot() {
    // roots 由 apply() 解析好传进来，避免这里再算一遍导致两处不一致。
    const roots = this.config.resolvedRoots ?? resolveRoots(this.config.roots)
    const { specs, errors } = await discover(roots, this.logger)
    for (const error of errors) this.logger?.warn?.(`discovery: ${error.message}`)
    this.logger?.info?.(
      `dsh-mloader: discovered ${specs.length} plugin(s) in ${roots.length} root(s)`,
    )
    // 细节只进 verbose；终端默认只报结果。
    this.out.detail(`扫描 ${roots.length} 个根目录，发现 ${specs.length} 个插件`) 

    for (const spec of specs) {
      // 已被要求中止（用户在启动途中重启 dsh）：不再启动后续插件。
      if (this.aborted) break
      const record = new PluginRegistrar(
        spec,
        this.ctx,
        this.logger,
        async (tool, args) => {
          if (record.state !== PLUGIN_STATE.APPLIED) {
            throw new Error(`plugin ${spec.id} is not active (state=${record.state})`)
          }
          return await record.instance.callTool(tool, args)
        },
        async (event, args) => await record.instance.dispatchEvent(event, args),
      )
      this.records.set(spec.id, record)

      if (!spec.enabled) {
        record.state = PLUGIN_STATE.DISABLED
        this.logger?.info?.(`[${spec.id}] disabled by manifest`)
        this.out.lifecycle(`跳过 ${spec.id}（manifest 里 enabled=false）`)
        continue
      }
      if (this.config.autoEnable === false) {
        record.state = PLUGIN_STATE.DISCOVERED
        continue
      }
      // WASM 默认关闭：未显式开启时跳过，避免未验证的 wasm 路径进入 live profile。
      if (spec.backend === 'wasm' && this.config.wasm?.enabled !== true) {
        record.state = PLUGIN_STATE.DISABLED
        record.error = 'wasm backend disabled (set config.wasm.enabled = true to opt in)'
        this.logger?.warn?.(`[${spec.id}] skipped: ${record.error}`)
        this.out.lifecycle(`跳过 ${spec.id}（WASM 后端未开启）`)
        continue
      }

      try {
        await this.#start(record)
      } catch (error) {
        record.error = error.message
        record.state = PLUGIN_STATE.FAILED
        this.logger?.error?.(`[${spec.id}] failed: ${error.message}`)
        this.out.error(`插件 ${spec.id} 加载失败：${error.message}`)
        // 失败的插件也清掉半途产生的注册，避免悬挂。
        record.dispose()
        // 再兜一次进程回收：start() 内部已尝试强杀，这里防它没走到那一步。
        try {
          await record.instance?.stop('startup failed')
        } catch {
          // 已经不在了
        }
        record.instance = null
        record.state = PLUGIN_STATE.FAILED
      }
    }

    // 一行总结，让终端一眼看清结果；细节（谁失败、为什么）已在上面逐条打过。
    if (this.aborted) {
      this.out.detail('启动被中止')
      return
    }
    const applied = [...this.records.values()].filter((r) => r.state === PLUGIN_STATE.APPLIED)
    const failed = [...this.records.values()].filter((r) => r.state === PLUGIN_STATE.FAILED)
    const summary = `码头就绪：${applied.length} 个插件已挂载`
    const tail = failed.length ? `，${failed.length} 个失败` : ''
    this.out.lifecycle(summary + tail)
    if (applied.length === 0 && this.records.size > 0) {
      this.out.warn('没有任何插件挂载成功')
    }
  }

  async #start(record) {
    const spec = record.spec
    record.state = PLUGIN_STATE.LOADED

    // ★ 先把实例挂到 record 上，再 await 启动。
    //
    // 踩过的坑：插件在 apply 里卡死（time.sleep(600)）时，boot 会阻塞到
    // startupMs 超时（10 秒）。如果等 `await start()` 之后才赋值 record.instance，
    // 这段时间里 teardown() 看到的 instance 是 undefined —— 卸载既不能打断
    // 卡住的启动，也回收不了已经 spawn 出来的子进程，最终留下孤儿进程。
    //
    // 所以：构造 → 挂载 → 启动，让 stop() 在任何时刻都能找到它。
    const instance = spec.backend === 'python'
      ? new PythonBackendInstance(spec, {
        logger: this.logger,
        pythonBin: this.config.pythonBin,
        onCrash: (pluginId, info) => this.#onPythonCrash(record, pluginId, info),
      })
      : new WasmBackendInstance(spec, { logger: this.logger })
    record.instance = instance
    await instance.start()

    // 注入注册通道：插件在 apply 期间发来的注册意图经此落到 loader 的 ctx 上。
    instance.setInboundHandler?.(
      async (op, payload) => await record.handle(op, payload),
    )

    const result = await instance.apply(record)
    // apply 期间可能已被要求中止（用户重启 dsh）：此时不再标记为可用，
    // 由 teardown 统一回收进程。
    if (this.aborted) {
      try {
        await instance.stop('aborted during apply')
      } catch {
        // 已经不在
      }
      record.instance = null
      return undefined
    }
    record.state = PLUGIN_STATE.APPLIED
    this.logger?.info?.(
      `[${spec.id}] ready (${spec.backend}); ` +
      `tools=[${(result?.tools ?? []).join(',')}] events=[${(result?.events ?? []).join(',')}]`,
    )
    // 终端只报一行最有信息量的：谁、什么后端、提供哪些工具。
    const tools = result?.tools ?? []
    const detail = tools.length ? `工具 ${tools.join(', ')}` : '无工具'
    this.out.lifecycle(`挂载 ${spec.id}（${spec.backend}，${detail}）`)
    return result
  }

  /** Python 子进程崩溃：撤销该插件的全部注册，宿主照常运行。 */
  #onPythonCrash(record, pluginId, info) {
    this.logger?.warn?.(`[${pluginId}] python process died (code=${info.code} signal=${info.signal})`)
    this.out.warn(`插件 ${pluginId} 的进程退出（code=${info.code} signal=${info.signal}），已撤销其注册`)
    record.dispose()
    record.state = PLUGIN_STATE.FAILED
    record.error = `process exited (code=${info.code}, signal=${info.signal})`
  }

  /** 状态快照，供 mloader_status 工具使用。 */
  list() {
    return [...this.records.values()].map((record) => record.snapshot())
  }

  /** 重新加载单个插件。 */
  async reload(id) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown plugin "${id}"`)
    const spec = record.spec
    this.out.lifecycle(`重新加载 ${id}…`)
    await this.#stop(record, 'reload')

    const fresh = new PluginRegistrar(
      spec,
      this.ctx,
      this.logger,
      async (tool, args) => await fresh.instance.callTool(tool, args),
      async (event, args) => await fresh.instance.dispatchEvent(event, args),
    )
    this.records.set(id, fresh)
    await this.#start(fresh)
    return fresh.snapshot()
  }

  /** 卸载单个插件。 */
  async unload(id) {
    const record = this.records.get(id)
    if (!record) throw new Error(`unknown plugin "${id}"`)
    await this.#stop(record, 'unload')
    this.records.delete(id)
    return { id, state: PLUGIN_STATE.DISPOSED }
  }

  /**
   * 停掉一个插件。
   *
   * @param {PluginRegistrar} record
   * @param {string} reason 触发原因（unload / reload / teardown），仅用于输出措辞
   */
  async #stop(record, reason = 'unload') {
    // 顺序：先撤销宿主注册（立即可见效果），再关后端实例。
    record.dispose()
    try {
      await record.instance?.stop('loader unload')
    } catch (error) {
      this.logger?.warn?.(`[${record.spec.id}] backend stop failed: ${error.message}`)
      this.out.warn(`插件 ${record.spec.id} 的后端未能正常停止：${error.message}`)
    }
    record.instance = null
    // reload 会紧接着重新挂载，不必先报一次"卸载"——那句话会误导。
    if (reason !== 'reload') {
      this.out.lifecycle(`卸载 ${record.spec.id}`)
    }
  }

  /** loader 自身卸载时调用。 */
  async teardown() {
    if (this.disposed) return
    this.disposed = true
    this.aborted = true
    this.logger?.info?.('dsh-mloader: unloading all external plugins')
    const count = this.records.size
    if (count > 0) this.out.lifecycle(`码头卸载中，回收 ${count} 个插件…`)

    // ★ 先让后台 boot 停下来，再回收。
    //
    // boot() 现在是后台跑的（不阻塞 apply），所以卸载时它可能正卡在
    // 某个慢插件的 startupMs 上。abortStartup 会让在途请求立刻失败返回。
    this.abortStartup()

    // 等后台 boot 收尾（它自己会处理失败，这里只等它别再创建新实例）。
    if (this.bootTask !== undefined) {
      try {
        await this.bootTask
      } catch {
        // boot 内部已 catch，这里只是防御
      }
    }

    // 回收所有实例。boot 可能刚创建了新 record，所以重新遍历。
    for (const record of this.records.values()) {
      await this.#stop(record, 'teardown')
    }
    this.records.clear()
    if (count > 0) this.out.lifecycle('码头已卸载')
  }

  /**
   * 中止启动流程。
   *
   * 场景：插件在 apply 里卡死（time.sleep(600)），boot() 会阻塞到 startupMs
   * 超时（默认 10 秒）。此时如果用户重启 dsh，Cordis 会等 apply() 返回才继续，
   * 卸载就被一个坏插件拖住十秒。
   *
   * 这里直接对所有在途实例调用 stop()，让 boot() 的 await 立刻失败返回。
   */
  abortStartup() {
    this.aborted = true
    for (const record of this.records.values()) {
      try {
        record.instance?.stop('loader aborting')
      } catch {
        // 忽略：正在中止
      }
    }
  }
}

/**
 * Cordis 插件入口。
 *
 * @param ctx - loader 自己的 Cordis 上下文。
 * @param config - 来自 cordis.patch.yml 的 config。
 */
export async function apply(ctx, config = {}) {
  const settings = { ...DEFAULTS, ...config }
  // 注意：ctx.logger 是 Cordis 内置的 LoggerService，`provide('logger')` 覆盖不了它。
  // 优先用可注入的 logger 服务（便于宿主替换/测试捕获），否则退回内置 logger。
  const injected = typeof ctx.get === 'function' ? ctx.get('logger') : undefined
  const logger = injected ?? ctx.logger?.('mloader') ?? ctx.logger
  // ★ 终端输出通道（与 logger 分开）。ctx.logger 只进内存缓冲区，不打印到终端，
  //   详见 src/console.js 开头对这条实测结论的说明。
  const out = createConsole(settings)

  // roots 现在总是包含 `<profile>/mloader/plugins`（除非显式关掉），
  // 所以这里的"空"只可能出现在既没配 roots、又探测不到 profile 的场景。
  //
  // ★ ctx.baseUrl 是 dsh 设置的 profile 目录 file URL，是最可靠的来源：
  //   它不依赖环境变量（真实 dsh 进程里没有 DSH_*），也不依赖符号链接反推。
  //   有了它，"装完什么都不用配"才成立。
  const baseUrl = typeof ctx.baseUrl === 'string' ? ctx.baseUrl : undefined
  const wantProfileDir = settings.profilePlugins !== false
  const roots = resolveRoots(settings.roots, {
    includeProfileDir: wantProfileDir,
    profileDir: settings.profileDir,
    baseUrl,
  })
  const detectedProfile = resolveProfileDir(settings.profileDir, baseUrl)

  // ★ 探测失败必须说出来。
  // 这个静默失败踩过一次：dsh 主进程里读不到 DSH_PROFILE_DIR（它是 shell-env 注入的），
  // 而配置里 roots 又是空的 —— 结果码头正常启动、0 个插件、工具消失，
  // 但日志里一个字都没有，只能靠翻进程列表才发现。
  if (wantProfileDir && detectedProfile === undefined) {
    logger?.warn?.(
      'dsh-mloader: 检测不到 profile 目录（DSH_PROFILE_DIR / DSH_HOME+DSH_PROFILE 都不可用），' +
      '已跳过 <profile>/mloader/plugins。如果插件装在 profile 里，请显式设置 config.roots。',
    )
    out.warn('检测不到 profile 目录，已跳过 <profile>/mloader/plugins（插件可能因此全部消失）')
  }

  if (roots.length === 0) {
    logger?.warn?.('dsh-mloader: no roots configured; set config.roots to a plugin directory')
    out.warn('没有可用的插件根目录，码头什么都没做')
    return
  }
  logger?.debug?.(`dsh-mloader: plugin roots = ${roots.join(', ')}`)
  out.detail(`插件根：${roots.join(', ')}`)

  // 释放内置示例插件到 `<profile>/mloader/plugins/`，供用户参考代码。
  //
  // ★ 必须在 manager.boot() 之前：这样第一次启动就能在同一轮里发现这些示例，
  //   用户装完码头立刻能看到 hello_mloader 工具可用，而不用再重启一次。
  //
  // 只在能确定 profile 目录时做。装到 profile 外（纯 roots 模式）时不该
  // 往别人的目录里塞东西。
  const pluginDir = profilePluginsDir(settings.profileDir, baseUrl)
  if (settings.seedExamples !== false && pluginDir !== undefined) {
    const seeded = await installSeedExamples(pluginDir, logger)
    if (seeded?.installed?.length) {
      out.lifecycle(`释放内置示例：${seeded.installed.join(', ')}`)
    }
  }

  const manager = new PluginManager(ctx, logger, { ...settings, resolvedRoots: roots, out })

  // ★ 卸载信号必须**在 boot() 之前**接上，而且不能只靠 ctx.effect 的清理函数。
  //
  // Cordis 的语义（见 cordis/lib/index.js 的 disposeAfter/waitForSetup）：
  // fiber 还在执行 apply 时调用 dispose，它会先 waitForSetup() —— 也就是
  // **等 apply() 返回**，然后才跑 effect 清理。所以如果 apply 里 await 一个
  // 卡住 10 秒的 boot()，卸载就要干等 10 秒，清理函数根本没机会执行。
  //
  // 实测：插件在 apply 里 time.sleep(600)，dispose 耗时 10346ms。
  //
  // 解法：监听 `internal/status`。fiber 一离开 ACTIVE(2) 就 abortStartup()，
  // 让 boot() 里的 await 立刻失败返回，apply() 得以尽早结束。
  //
  // 状态值取自 cordis 的 FiberState（未导出为运行时枚举，只能写字面量）：
  //   PENDING=0 LOADING=1 ACTIVE=2 FAILED=3 DISPOSED=4 UNLOADING=5
  const FIBER_ACTIVE = 2
  const onStatus = (fiber, oldState) => {
    if (oldState !== FIBER_ACTIVE || fiber?.state === FIBER_ACTIVE) return
    if (manager.disposed) return
    logger?.debug?.('dsh-mloader: 检测到卸载，中止启动流程')
    manager.abortStartup()
  }
  ctx.on('internal/status', onStatus)
  ctx.effect(() => () => ctx.off('internal/status', onStatus), 'dsh-mloader:status-watch')

  // teardown 清理（同样提前注册，见上）。
  ctx.effect(() => {
    return async () => {
      manager.abortStartup()
      await manager.teardown()
    }
  }, 'dsh-mloader:teardown')

  // ★ 外部插件的启动**不阻塞** apply()。
  //
  // Cordis 语义（cordis/lib/index.js 的 restart/await/_unload）：
  // fiber 还在执行 apply 时调用 dispose()，它会 `while (this.inertia) await this.inertia`
  // —— 也就是**等 apply() 返回**，之后才跑 effect 清理。
  //
  // 所以如果这里 `await manager.boot()`，那么只要有一个外部插件在 apply 里卡死
  // （例如 time.sleep(600)），卸载就必须干等满 startupMs（默认 10 秒）。
  // 实测：dispose 耗时 10346ms，且 teardown 清理函数完全没机会提前执行。
  //
  // 反过来，apply 立刻返回带来两个好处：
  //   1. 卸载永远是毫秒级 —— 这是 dsh 重启/热重载的关键路径；
  //   2. dsh 启动不被慢插件拖住，外部插件在后台陆续就绪。
  //
  // 代价：apply 返回时外部插件可能还没 ready。这不影响使用 —— 工具是调用时
  // 查表，mloader_status 会如实显示每个插件的状态（loaded/applied/failed）。
  const bootTask = manager.boot().catch((error) => {
    // boot 自身异常不该让码头挂掉，也不该变成 unhandledRejection。
    logger?.error?.(`dsh-mloader: boot failed: ${error?.message ?? error}`)
  })
  // 记录在案，便于排查"后台启动到底跑完没有"。
  manager.bootTask = bootTask

  // 状态查询工具：模型可查当前挂了哪些外部插件。
  let disposeStatusTool
  if (settings.statusTool !== false) {
    disposeStatusTool = ctx.tools.register(createStatusTool(() => manager.list()))
    ctx.effect(() => () => disposeStatusTool(), 'dsh-mloader:status-tool')
  }

  // 斜杠命令：用户可敲 /mloader-status 直接查（不必经过模型）。
  //
  // 命令和工具是两个不同的注册面：
  //   工具 → 模型调用；命令 → 用户在输入框敲 `/` 调用。
  //
  // commands 是**可选**服务（老版本 dsh 没有，或用户关掉了 dsh-commands 插件），
  // 所以不写进 inject（写了会让整个码头因缺服务而挂不起来），而是运行时探测。
  let disposeStatusCommand
  if (settings.statusCommand !== false) {
    const commandName = typeof settings.statusCommand === 'string'
      ? settings.statusCommand
      : DEFAULT_COMMAND_NAME
    disposeStatusCommand = registerStatusCommand(ctx, () => manager.list(), logger, commandName)
    if (disposeStatusCommand) {
      ctx.effect(() => () => disposeStatusCommand(), 'dsh-mloader:status-command')
    }
  }

  // loader 自身被卸载时的清理已在上方（boot 之前）注册，见 dsh-mloader:teardown。

  // 暴露管理面给其他插件/测试使用（可选能力，dsh 侧不需要知道）。
  if (typeof ctx.provide === 'function') {
    ctx.provide('mloader', {
      list: () => manager.list(),
      reload: (id) => manager.reload(id),
      unload: (id) => manager.unload(id),
    })
  }
}

export { PluginManager }
