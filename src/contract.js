/**
 * dsh-mloader — 能力白名单与常量
 *
 * 这里定义的所有内容都是 ABI 契约的一部分，见 docs/ABI.md §3。
 */

/** v1 允许插件订阅的事件（docs/ABI.md §3.1）。 */
import { join, resolve } from 'node:path'
import { homedir } from 'node:os'
import { readdirSync, statSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export const EVENT_WHITELIST = new Set([
  'tools/execute',
  'tools/pre-execute',
  'tools/post-execute',
  'tools/result',
  'tools/change',
  'agent/status',
  'agent/created',
  'agent/disposed',
  'session/created',
  'session/disposed',
])

/** dsh 工具 schema 接受的受限 JSON Schema 子集（docs/ABI.md §3.2）。 */
const CONSTRAINT_KEYWORDS = new Set([
  'type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const',
])
const ANNOTATION_KEYWORDS = new Set(['description', 'title', 'default', 'examples'])
const SUPPORTED_TYPES = new Set(['object', 'array', 'string', 'number', 'integer', 'boolean', 'null'])

/**
 * 校验一个 JSON Schema 是否落在 dsh 支持的子集内。
 *
 * 为什么要自己校验：dsh 的 `assertSupportedJsonSchema` 报错时只给关键词名，
 * 不告诉你是哪个插件的哪个工具，排查成本高。这里提前拦截并带上上下文。
 *
 * @param schema - 待校验的 schema 节点。
 * @param where - 诊断用的位置前缀，例如 `tool "py_greet"`。
 * @returns 违规描述数组；空数组表示合法。
 */
export function validateToolSchema(schema, where) {
  const violations = []
  const seen = new Set()

  const walk = (node, path) => {
    if (node === null || typeof node !== 'object' || Array.isArray(node)) {
      violations.push(`${where}: ${path} must be a schema object`)
      return
    }
    if (seen.has(node)) {
      violations.push(`${where}: ${path} is circular`)
      return
    }
    seen.add(node)

    for (const key of Object.keys(node)) {
      if (CONSTRAINT_KEYWORDS.has(key) || ANNOTATION_KEYWORDS.has(key)) continue
      violations.push(
        `${where}: ${path}.${key} is not supported ` +
        '(subset: type/oneOf/properties/required/additionalProperties/items/enum/const + annotations)',
      )
    }

    if (node.type !== undefined && !SUPPORTED_TYPES.has(node.type)) {
      violations.push(`${where}: ${path}.type "${node.type}" is not a supported type`)
    }
    if (node.type !== undefined && node.oneOf !== undefined) {
      violations.push(`${where}: ${path} cannot declare both type and oneOf`)
    }

    if (node.properties !== undefined) {
      for (const [key, child] of Object.entries(node.properties)) {
        walk(child, `${path}.properties.${key}`)
      }
    }
    if (node.items !== undefined) walk(node.items, `${path}.items`)
    if (Array.isArray(node.oneOf)) {
      node.oneOf.forEach((child, index) => walk(child, `${path}.oneOf[${index}]`))
    }

    seen.delete(node)
  }

  walk(schema, 'schema')
  return violations
}

/** 校验插件 id 是否符合 manifest 约束（docs/ABI.md §2.3）。 */
export function isValidPluginId(id) {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9_-]{0,31}$/.test(id)
}

/** 生命周期状态机（docs/ABI.md §5）。 */
export const PLUGIN_STATE = Object.freeze({
  DISCOVERED: 'discovered',
  LOADED: 'loaded',
  APPLIED: 'applied',
  DISABLED: 'disabled',
  FAILED: 'failed',
  DISPOSED: 'disposed',
})

export const PROTOCOL_VERSION = 1

/**
 * 解析 profile 目录。
 *
 * ⚠️ 这里有个坑（踩过两次）：
 *
 * 第一次：`DSH_PROFILE_DIR` 由 `dsh-shell-env` 包**注入给 bash 工具**，不是宿主
 * 进程持有的。实测真实 dsh 主进程（`/proc/<pid>/environ`）里**一个 `DSH_*`
 * 变量都没有**，cwd 是 `$HOME`。所以只认环境变量的探测在真实 dsh 里 100% 失败。
 *
 * 第二次：`import.meta.url` 反推也不可靠 —— `link:` 安装时 Node 解析到的是
 * 符号链接的**真实路径**（workspace 里），根本不含 profile。
 *
 * 真正可靠的来源是 `ctx.baseUrl`：dsh-app-boot 在 boot() 里做
 *   `ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/"`
 * 也就是**当前 profile 目录的 file URL**。它是 dsh 主动设置的，不依赖环境变量，
 * 也不需要反推符号链接。这是"装完即用"的地基。
 *
 * 尝试顺序（可靠性从高到低）：
 *   1. 显式传入（配置 `profileDir`，测试用）
 *   2. `ctx.baseUrl`（dsh 设置，最可靠）
 *   3. `DSH_PROFILE_DIR`（shell 工具里有；某些启动方式下宿主也有）
 *   4. `DSH_HOME` + `DSH_PROFILE` 推导 `${DSH_HOME}/profiles/${DSH_PROFILE}`
 *   5. `~/.dsh/profiles/<name>` 按单 profile 特征探测（仅当下只剩唯一候选）
 *   6. 都不行 → undefined（码头退回只在显式 roots 里找插件）
 *
 * @param {string} [explicit] - 显式指定的 profile 目录（配置 `profileDir`）。
 * @param {string} [baseUrl] - `ctx.baseUrl`，dsh 设置的 profile 目录 file URL。
 * @returns {string | undefined}
 */
export function resolveProfileDir(explicit, baseUrl) {
  if (typeof explicit === 'string' && explicit.length > 0) return explicit

  // ── 来源 2：ctx.baseUrl（dsh 设置，最可靠）──────────────────
  //
  // ★ 这是"开箱即用"的关键。dsh-app-boot 的 boot() 里有：
  //     ctx.baseUrl = pathToFileURL(dirname(absoluteConfigPath)).href + "/"
  //   absoluteConfigPath 是 profile 下的 cordis.yml 的绝对路径。
  //
  // 为什么必须校验：baseUrl 也可能指向别的目录（例如 cordis 默认的 cwd），
  // 或者 profile 尚未初始化。所以只接受"看起来确实像 profile"的目录。
  const fromBase = profileDirFromBaseUrl(baseUrl)
  if (fromBase !== undefined) return fromBase

  // ── 来源 3 / 4：环境变量 ──────────────────────────────────
  const fromEnv = process.env.DSH_PROFILE_DIR
  if (typeof fromEnv === 'string' && fromEnv.length > 0) return fromEnv
  const home = process.env.DSH_HOME
  const name = process.env.DSH_PROFILE
  if (typeof home === 'string' && home.length > 0 && typeof name === 'string' && name.length > 0) {
    return join(home, 'profiles', name)
  }

  // ── 来源 5：按目录特征探测 ────────────────────────────────
  return detectProfileDir()
}

/**
 * 从 `ctx.baseUrl` 反推 profile 目录。
 *
 * @param {string} [baseUrl]
 * @returns {string | undefined} 像 profile 的目录；否则 undefined。
 */
function profileDirFromBaseUrl(baseUrl) {
  if (typeof baseUrl !== 'string' || baseUrl.length === 0) return undefined

  let dir
  try {
    // baseUrl 形如 `file:///path/to/profile/`；URL() 会正确处理百分号转义。
    const url = new URL(baseUrl)
    if (url.protocol !== 'file:') return undefined
    dir = fileURLToPath(url)
  } catch {
    return undefined
  }

  // 去掉结尾分隔符，避免后续 join 出双斜杠。
  dir = dir.replace(/[/\\]+$/, '')
  return looksLikeProfileDir(dir) ? dir : undefined
}

/**
 * 判断一个目录是否像 dsh profile。
 *
 * 依据：profile 一定有 `package.json`（记录 `dsh.profile.bundles`）和 `cordis.yml`
 * （由 initProfile 生成）。两个都在才算，避免把随便什么目录当成 profile。
 *
 * @param {string} dir
 * @returns {boolean}
 */
function looksLikeProfileDir(dir) {
  try {
    return statSync(join(dir, 'package.json')).isFile() &&
      statSync(join(dir, 'cordis.yml')).isFile()
  } catch {
    return false
  }
}

/**
 * 兜底探测：在 `~/.dsh/profiles/` 下按特征找 profile。
 *
 * 只在**恰好只有一个**像 profile 的候选时采用 —— 多 profile 并存时猜错比
 * 返回 undefined 更糟（会把插件装进/读自错误的地方）。
 *
 * `node_modules` 等非 profile 目录会被 `looksLikeProfileDir` 自然排除。
 *
 * @returns {string | undefined}
 */
function detectProfileDir() {
  const home = process.env.HOME ?? homedir()
  const profilesRoot = join(home, '.dsh', 'profiles')
  let entries
  try {
    entries = readdirSync(profilesRoot, { withFileTypes: true })
  } catch {
    return undefined
  }

  const candidates = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => join(profilesRoot, entry.name))
    .filter((dir) => looksLikeProfileDir(dir))

  return candidates.length === 1 ? candidates[0] : undefined
}


/**
 * 插件安装目录：`<profile>/mloader/plugins`。
 *
 * 为什么放在 profile 里而不是 profile 的 `node_modules`：
 *   - `node_modules` 由包管理器（pnpm）管理，`pnpm install` / `prune` 可能删掉
 *     不是它装的东西。往里面手放插件，迟早被清掉。
 *   - 这里是一个**插件自己的领地**，dsh 和 pnpm 都不碰。
 *
 * 为什么是 `mloader/plugins` 而不是直接 `mloader`：
 *   给码头自己留出同级目录放未来可能的状态（日志、锁、清单），
 *   插件目录保持纯粹可删可重建。
 *
 * @param {string} [profileDir] - profile 目录；省略时按 resolveProfileDir 探测。
 * @param {string} [baseUrl] - `ctx.baseUrl`，dsh 设置的 profile 目录 file URL。
 * @returns {string | undefined} 绝对路径；无法确定 profile 时返回 undefined。
 */
export function profilePluginsDir(profileDir, baseUrl) {
  const dir = resolveProfileDir(profileDir, baseUrl)
  if (dir === undefined) return undefined
  return join(dir, 'mloader', 'plugins')
}

/**
 * 把配置里的 roots 解析成绝对路径。
 *
 * 支持三种写法：
 *   1. `"~/..."`             → 展开到 home
 *   2. `"./x"` / `"x"`       → 相对 `DSH_PROFILE_DIR`（无 profile 时用 cwd）
 *   3. `"/abs"`              → 原样
 *
 * 另外，**除非 `includeProfileDir === false`**，始终把 `<profile>/mloader/plugins`
 * 追加为最后一个 root（去重）。这样"安装到 profile"是开箱即用的行为，
 * 不需要用户在配置里写绝对路径 —— 而写绝对路径正是让配置绑死在某一台机器上的原因。
 *
 * @param roots - 配置里的 roots 数组。
 * @param options.includeProfileDir - 是否自动追加 profile 插件目录，默认 true。
 * @param options.profileDir - 覆盖 profile 目录（测试用）。
 * @param options.baseUrl - `ctx.baseUrl`（dsh 设置的 profile 目录 file URL）。
 */
export function resolveRoots(roots, options = {}) {
  const { includeProfileDir = true, profileDir, baseUrl } = options
  const detectedProfile = resolveProfileDir(profileDir, baseUrl)
  const base = detectedProfile ?? process.cwd()
  const resolved = []

  const push = (path) => {
    if (!resolved.includes(path)) resolved.push(path)
  }

  if (Array.isArray(roots)) {
    for (const root of roots) {
      if (typeof root !== 'string' || root.length === 0) continue
      push(resolve(base, expandHome(root)))
    }
  }

  if (includeProfileDir && detectedProfile !== undefined) {
    push(join(detectedProfile, 'mloader', 'plugins'))
  }

  return resolved
}

/** 展开开头的 `~`。Node 的 `path` 不做这件事，`os.homedir()` 才做。 */
export function expandHome(path) {
  if (path === '~') return homedir()
  if (path.startsWith('~/')) return join(homedir(), path.slice(2))
  return path
}
