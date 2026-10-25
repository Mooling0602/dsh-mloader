/**
 * dsh-mloader — 斜杠命令
 *
 * 命令和工具是两个不同的注册面：
 *   - 工具（`ctx.tools.register`）→ **模型**调用
 *   - 命令（`ctx.commands.register`）→ **用户**在输入框敲 `/` 调用
 *
 * 这里注册 `/mloader-status`，让用户不必借模型的口就能看到码头状态。
 *
 * 注意 `commands` 服务是**可选**依赖：老版本 dsh 没有它，或者用户手动关掉了
 * `dsh-commands` 插件。因此 `inject` 里不含 `commands`（否则整个码头会因缺服务
 * 而挂不起来），而是运行时 `ctx.get('commands')` 探测；拿不到就跳过注册并记一条 warn。
 */

import { buildStatus, format } from '../tools/status.js'

/** 命令名校验：dsh 的规则是 `/^[a-z][a-z0-9_-]*$/`（见 dsh-commands/lib/index.js）。 */
export const COMMAND_NAME_PATTERN = /^[a-z][a-z0-9_-]*$/u

/** 默认命令名。用连字符，和 dsh 现有命令风格一致。 */
export const DEFAULT_COMMAND_NAME = 'mloader-status'

/**
 * 注册状态命令。
 *
 * @param ctx - 码头的 Cordis ctx
 * @param listPlugins - `() => Array<object>` 插件快照
 * @param logger - 可选 logger
 * @param commandName - 命令名（不含 `/`）
 * @returns disposer；未注册时返回 `undefined`
 */
export function registerStatusCommand(ctx, listPlugins, logger, commandName = DEFAULT_COMMAND_NAME) {
  if (!COMMAND_NAME_PATTERN.test(commandName)) {
    logger?.warn?.(
      `[mloader] 斜杠命令名 "${commandName}" 不合法（需匹配 ${String(COMMAND_NAME_PATTERN)}），已跳过注册`,
    )
    return undefined
  }

  // commands 是可选服务：不 inject，运行时探测。
  const commands = typeof ctx.get === 'function' ? ctx.get('commands') : undefined
  if (commands === undefined || commands === null) {
    logger?.debug?.('[mloader] commands 服务不可用，跳过斜杠命令注册')
    return undefined
  }
  if (typeof commands.register !== 'function') {
    logger?.warn?.('[mloader] commands 服务没有 register 方法，跳过斜杠命令注册')
    return undefined
  }

  const dispose = commands.register({
    name: commandName,
    description: '查看 dsh-mloader 托管的外部插件（Python/WASM）及其状态',
    input: {
      // 提示用户可选参数：插件 id
      hint: '[<插件id>]',
    },
    handler(invocation) {
      const raw = (invocation?.rawInput ?? '').trim()
      try {
        const snapshot = buildStatus(listPlugins, raw ? { id: raw } : undefined)
        return { kind: 'success', text: format(snapshot) }
      } catch (error) {
        // 插件 id 不存在等用户输入错误 → error 结果，不是抛异常
        return { kind: 'error', text: error?.message ?? String(error) }
      }
    },
  })

  logger?.debug?.(`[mloader] 已注册斜杠命令 /${commandName}`)
  return typeof dispose === 'function' ? dispose : undefined
}
