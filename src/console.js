/**
 * 终端输出（console 通道）
 *
 * 为什么需要这个文件
 * ------------------
 * dsh 的 `ctx.logger` **不会打印到终端**：Cordis 的 LoggerService 只是把消息
 * push 进一个内存环形缓冲区（bufferSize 1000），供启动失败时做诊断回放。
 * dsh-app-boot 额外注册的 exporter 也只收集 warn/error 到 `startupLogs`，
 * 同样不输出。
 *
 * 实测（裸 cordis）：
 *   root.logger.info('x')   → 终端无输出
 *   root.logger.warn('x')   → 终端无输出
 *   console.log('x')        → 有输出
 *
 * 所以想在 `dsh web` 的命令行里看到码头的加载/卸载，必须走 console。
 * 这不是绕开框架，而是这个框架里唯一的出口 —— 本机其它插件也这么做
 * （例如 `@tencent-connect/dsh-qqbot` 用 `console.log('[im-qqbot] ...')`）。
 *
 * 于是这里分成两条通道
 * --------------------
 *   logger  → 内存缓冲区：详细诊断，供事后排查，不打扰终端
 *   out     → 终端：只报生命周期节点，一眼看清"装了什么、卸了什么"
 *
 * 两者不重复：终端只放关键节点，细节仍然只进 logger。
 */

/** 终端输出的前缀，与 dsh 其它插件的 `[name]` 风格一致。 */
const PREFIX = '[mloader]'

/**
 * 判断是否应该输出到终端。
 *
 * 关闭条件（任一成立即静默）：
 *   - 显式配置 `console: false`
 *   - 测试环境（NODE_ENV=test），避免污染断言输出
 *   - 没有可用的 console
 *
 * @param {object} settings
 * @returns {boolean}
 */
function shouldEmit(settings) {
  if (settings?.console === false) return false
  if (process.env.NODE_ENV === 'test') return false
  return typeof console !== 'undefined'
}

/**
 * 创建一个终端输出器。
 *
 * 返回的对象所有方法都是**安全**的：内部 try/catch 兜住，
 * 终端写失败（EPIPE、管道关闭）绝不能反过来影响插件加载。
 *
 * @param {object} settings 码头配置
 * @returns {{ lifecycle: Function, detail: Function, warn: Function, error: Function, enabled: boolean }}
 */
export function createConsole(settings) {
  const enabled = shouldEmit(settings)

  /**
   * 底层写入口。
   *
   * 用 `console.log` 而非 `process.stdout.write`：前者在 stdout 不可用时
   * 由 Node 自己兜底（不会抛），后者会抛 EPIPE。这正是之前踩过的坑。
   */
  const write = (args) => {
    if (!enabled) return
    try {
      console.log(...args)
    } catch {
      // 终端不可写（管道被关等）：静默放弃，绝不冒泡。
    }
  }

  return {
    enabled,

    /**
     * 生命周期节点：加载 / 卸载 / 崩溃。
     *
     * 这类消息**始终**输出（除非关掉了 console），因为它们是用户最关心的
     * "发生了什么"，频率低（每个插件一两条），不会刷屏。
     *
     * @param {string} message
     */
    lifecycle(message) {
      write([`${PREFIX} ${message}`])
    },

    /**
     * 细节信息：发现过程、路径解析等。
     *
     * 只有开了 `console: 'verbose'` 才输出。默认静默 —— 这些内容对
     * 排障有用，但正常情况下会淹没生命周期消息。
     *
     * @param {string} message
     */
    detail(message) {
      if (settings?.console !== 'verbose') return
      write([`${PREFIX} ${message}`])
    },

    /**
     * 警告：不影响主流程，但用户应该知道。
     *
     * @param {string} message
     */
    warn(message) {
      write([`${PREFIX} warn: ${message}`])
    },

    /**
     * 错误：插件加载失败等。
     *
     * @param {string} message
     */
    error(message) {
      write([`${PREFIX} error: ${message}`])
    },
  }
}
