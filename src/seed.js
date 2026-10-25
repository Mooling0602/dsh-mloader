/**
 * dsh-mloader — 内置示例插件的落地（seed）
 *
 * 码头安装到某个 profile 后，第一次启动时把包内自带的示例插件复制到
 * `<profile>/mloader/plugins/`，供用户直接看代码、改代码、照着写。
 *
 * 三条硬约束（都来自真实踩坑）：
 *
 * 1. **绝不覆盖用户改动**
 *    用户很可能已经把示例改成自己的插件了。只要目标目录里存在任意同名的
 *    manifest，就整体跳过这个示例 —— 不合并、不增量覆盖、不"顺便更新一下"。
 *
 * 2. **绝不因为 seed 失败而拖垮码头**
 *    示例只是参考资料，不是功能。磁盘满、权限不足、profile 只读……
 *    任何异常都只记一条 warn，正常继续启动。
 *
 * 3. **可关闭**
 *    配置 `seedExamples: false` 就完全不动磁盘。CI、测试、只想干净环境的人需要这个。
 */

import { cp, mkdir, readdir, stat } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

/** 包内示例所在目录（相对本文件：src/seed.js → ../seed）。 */
const SEED_DIR = join(dirname(fileURLToPath(import.meta.url)), '..', 'seed')

/** 判断路径是否存在。 */
async function exists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}

/**
 * 把内置示例复制到目标插件目录。
 *
 * @param targetDir - `<profile>/mloader/plugins`。
 * @param logger - 只用于 warn/info，允许为空。
 * @returns `{ installed: string[], skipped: string[] }`，便于测试断言。
 */
export async function installSeedExamples(targetDir, logger) {
  const installed = []
  const skipped = []

  if (typeof targetDir !== 'string' || targetDir.length === 0) {
    return { installed, skipped }
  }

  let entries
  try {
    entries = await readdir(SEED_DIR, { withFileTypes: true })
  } catch (error) {
    // 包发布时漏带 seed/ 目录属于打包问题，值得说出来，但不影响启动。
    logger?.warn?.(`dsh-mloader: 内置示例目录不可读（${SEED_DIR}）：${error.message}`)
    return { installed, skipped }
  }

  for (const entry of entries) {
    if (!entry.isDirectory()) continue
    const source = join(SEED_DIR, entry.name)
    const target = join(targetDir, entry.name)

    // ★ 存在即跳过。不做任何合并 —— 用户改过的文件一个字节都不能碰。
    if (await exists(target)) {
      skipped.push(entry.name)
      continue
    }

    try {
      await mkdir(dirname(target), { recursive: true })
      await cp(source, target, { recursive: true, force: false, errorOnExist: false })
      installed.push(entry.name)
    } catch (error) {
      // 单个示例失败不影响其余示例，更不影响码头。
      logger?.warn?.(`dsh-mloader: 示例 ${entry.name} 落地失败：${error.message}`)
    }
  }

  if (installed.length > 0) {
    logger?.info?.(
      `dsh-mloader: 已释放 ${installed.length} 个内置示例到 ${targetDir}（${installed.join(', ')}）—— ` +
      '可直接修改，码头不会覆盖你的改动',
    )
  }
  return { installed, skipped }
}

/** 供测试断言用。 */
export { SEED_DIR }
