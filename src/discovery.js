/**
 * dsh-mloader — 插件发现
 *
 * 扫描 roots 下的 `mloader.plugin.json`，构造 PluginSpec。发现阶段绝不抛错：
 * 一个坏 manifest 只让那个插件失败，不拖垮整个 loader。
 */

import { readdir, readFile, stat } from 'node:fs/promises'
import { join, resolve, dirname } from 'node:path'
import { isValidPluginId } from './contract.js'

/** 元数据文件名。带前缀，避免和别的工具的 `plugin.json` 撞名。 */
export const MANIFEST_NAME = 'mloader.plugin.json'

/**
 * 读取并规范化一个 manifest。
 * @param path - manifest 的绝对路径。
 * @returns 规范化后的 PluginSpec。
 */
async function readManifest(path) {
  const raw = await readFile(path, 'utf8')
  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch (error) {
    throw new Error(`${path} is not valid JSON: ${error.message}`)
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error(`${path} must contain a JSON object`)
  }

  const baseDir = dirname(path)
  const id = parsed.id
  if (!isValidPluginId(id)) {
    throw new Error(`${path}: id ${JSON.stringify(id)} must match ^[a-z0-9][a-z0-9_-]{0,31}$`)
  }
  const backend = parsed.backend
  if (backend !== 'python' && backend !== 'wasm') {
    throw new Error(`${path}: backend must be "python" or "wasm", got ${JSON.stringify(backend)}`)
  }
  if (typeof parsed.entry !== 'string' || parsed.entry.length === 0) {
    throw new Error(`${path}: entry is required and must be a non-empty string`)
  }

  const timeouts = parsed.timeouts ?? {}
  return {
    id,
    name: typeof parsed.name === 'string' && parsed.name ? parsed.name : id,
    version: typeof parsed.version === 'string' ? parsed.version : '0.0.0',
    backend,
    entry: resolve(baseDir, parsed.entry),
    baseDir,
    manifestPath: path,
    enabled: parsed.enabled !== false,
    inject: Array.isArray(parsed.inject) ? parsed.inject.map(String) : [],
    capabilities: {
      tools: parsed.capabilities?.tools !== false,
      events: parsed.capabilities?.events !== false,
      logger: parsed.capabilities?.logger !== false,
      effect: parsed.capabilities?.effect !== false,
    },
    timeouts: {
      startupMs: Number.isFinite(timeouts.startupMs) ? timeouts.startupMs : 10_000,
      callMs: Number.isFinite(timeouts.callMs) ? timeouts.callMs : 30_000,
    },
    env: parsed.env && typeof parsed.env === 'object' ? { ...parsed.env } : {},
    // 声明式风格（风格 B）从这里读；apply 风格在插件侧自己注册。
    declared: parsed,
  }
}

/**
 * 发现一个 root 下的全部插件。
 *
 * 目录结构：`<root>/<dir>/mloader.plugin.json`。也允许 root 直接就是一个插件目录。
 *
 * @param roots - 插件根目录列表（绝对路径）。
 * @param logger - 用于报告坏 manifest。
 * @returns `{ specs, errors }`，errors 不阻断其余插件的加载。
 */
export async function discover(roots, logger) {
  const specs = []
  const errors = []
  const seenIds = new Map()

  for (const root of roots) {
    let entries
    try {
      const info = await stat(root)
      if (info.isDirectory()) {
        entries = await readdir(root, { withFileTypes: true })
      } else {
        entries = []
      }
    } catch (error) {
      errors.push({ root, message: `cannot read plugin root: ${error.message}` })
      continue
    }

    // root 本身就是一个插件目录的情形
    const candidates = []
    if (await pathExists(join(root, MANIFEST_NAME))) {
      candidates.push(join(root, MANIFEST_NAME))
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      const manifestPath = join(root, entry.name, MANIFEST_NAME)
      if (await pathExists(manifestPath)) candidates.push(manifestPath)
    }

    for (const manifestPath of candidates) {
      try {
        const spec = await readManifest(manifestPath)
        const previous = seenIds.get(spec.id)
        if (previous) {
          errors.push({
            manifest: manifestPath,
            message: `duplicate plugin id "${spec.id}" (already at ${previous})`,
          })
          continue
        }
        seenIds.set(spec.id, manifestPath)
        specs.push(spec)
      } catch (error) {
        errors.push({ manifest: manifestPath, message: error.message })
        logger?.warn?.(`skip ${manifestPath}: ${error.message}`)
      }
    }
  }

  // 稳定顺序，便于测试复现
  specs.sort((a, b) => a.id.localeCompare(b.id))
  return { specs, errors }
}

async function pathExists(path) {
  try {
    await stat(path)
    return true
  } catch {
    return false
  }
}
