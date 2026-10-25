/**
 * profile 插件目录测试
 *
 * 目标：验证「插件安装到 `<profile>/mloader/plugins/<plugin-id>`」这套约定。
 *
 * 覆盖：
 *   1. `profilePluginsDir()` 拼出正确路径（用 DSH_PROFILE_DIR 与显式参数两种方式）
 *   2. `resolveRoots()` 自动追加 profile 插件目录，且去重
 *   3. `includeProfileDir: false` 时不追加（测试场景）
 *   4. `~` 展开、相对路径以 profile 为基准
 *   5. **真的**在 profile 插件目录里放一个插件，能被 discover 发现并启动
 *   6. 显式 roots 与 profile 目录同时存在时，两边插件都被加载
 *   7. profile 目录不存在时不报错（首次使用是正常状态）
 *   8. 配置 `profilePlugins: false` 时码头不去扫 profile（端到端）
 */

import { mkdir, mkdtemp, rm, writeFile, cp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { discover } from '../src/discovery.js'
import { expandHome, profilePluginsDir, resolveProfileDir, resolveRoots } from '../src/contract.js'

const failures = []
let passed = 0

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    console.log(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    console.log(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const section = (title) => console.log(`\n${title}`)

function makeLogger() {
  const lines = []
  const push = (level) => (message) => lines.push(`${level}: ${message}`)
  const logger = (..._a) => logger
  logger.debug = push('debug')
  logger.info = push('info')
  logger.warn = push('warn')
  logger.error = push('error')
  logger.lines = lines
  return logger
}

function systemPromptStub() {
  return {
    section: () => () => {},
    context: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    suppressRuntimeContext: () => () => {},
    refreshContext: (a) => a,
    assemble: async () => ({ sections: [] }),
  }
}

/**
 * 造一个最小可用的 python 插件目录。
 *
 * 写法必须和真实插件一致（风格 A）：`from dsh_runtime import plugin` +
 * `@plugin def apply(ctx)` + `ctx.tools.register(...)`。
 * 早期这里臆造了一个 `dsh.register_tool` API，导致子进程 startup 直接 exit(1)。
 */
async function makePythonPlugin(root, id, toolName) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, backend: 'python', entry: 'plugin.py', version: '1.0.0' }, null, 2),
  )
  await writeFile(
    join(dir, 'plugin.py'),
    `"""测试插件：最小可用形状。"""

from dsh_runtime import plugin

NAME = "${id}"


@plugin
def apply(ctx):
    @ctx.tools.register(
        name="${toolName}",
        description="test tool ${toolName}",
        parameters={"type": "object", "properties": {}, "additionalProperties": False},
    )
    def _impl(args):
        return {"ok": True, "tool": "${toolName}"}
`,
  )
  return dir
}

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-profile-'))

    section('① profilePluginsDir 路径拼装')
    check(
      '显式 profileDir → <profile>/mloader/plugins',
      profilePluginsDir('/home/u/.dsh/profiles/web') === '/home/u/.dsh/profiles/web/mloader/plugins',
      profilePluginsDir('/home/u/.dsh/profiles/web'),
    )
    // 三个变量都可能是 profile 目录的来源，逐个测。
    const saved = {
      DSH_PROFILE_DIR: process.env.DSH_PROFILE_DIR,
      DSH_HOME: process.env.DSH_HOME,
      DSH_PROFILE: process.env.DSH_PROFILE,
    }
    const restore = () => {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
    }

    process.env.DSH_PROFILE_DIR = '/env/profile'
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
    check(
      '优先读 DSH_PROFILE_DIR',
      profilePluginsDir() === '/env/profile/mloader/plugins',
      String(profilePluginsDir()),
    )

    // ★ 关键回归：dsh 主进程里 DSH_PROFILE_DIR 可能不存在，
    // 必须回退到 DSH_HOME + DSH_PROFILE 推导。
    delete process.env.DSH_PROFILE_DIR
    process.env.DSH_HOME = '/env/home'
    process.env.DSH_PROFILE = 'web'
    check(
      '无 DSH_PROFILE_DIR 时用 DSH_HOME+DSH_PROFILE 推导',
      profilePluginsDir() === '/env/home/profiles/web/mloader/plugins',
      String(profilePluginsDir()),
    )
    check(
      '推导出的是 profiles（复数）',
      String(profilePluginsDir()).includes('/profiles/'),
      String(profilePluginsDir()),
    )

    // 三者都没有 → 放弃探测
    delete process.env.DSH_PROFILE_DIR
    delete process.env.DSH_HOME
    delete process.env.DSH_PROFILE
    check('全都不可用时返回 undefined', profilePluginsDir() === undefined, String(profilePluginsDir()))

    restore()

    section('①b resolveProfileDir 优先级')
    check('显式参数优先于环境变量', resolveProfileDir('/explicit') === '/explicit', String(resolveProfileDir('/explicit')))

    // ★ ctx.baseUrl 是"装完即用"的地基：真实 dsh 进程里没有任何 DSH_* 环境变量，
    //   只有 dsh-app-boot 设置的 ctx.baseUrl（= profile 目录的 file URL）。
    //   详见 docs/ABI.md §9.3。
    section('①c ctx.baseUrl 探测（开箱即用的关键路径）')
    const realProfile = join(tempRoot, 'realprof')
    await mkdir(join(realProfile, 'mloader'), { recursive: true })
    await writeFile(join(realProfile, 'package.json'), '{"name":"prof"}\n')
    await writeFile(join(realProfile, 'cordis.yml'), '- id: root\n')
    const profileUrl = pathToFileURL(realProfile).href + '/'

    check('从 baseUrl 认出 profile', resolveProfileDir(undefined, profileUrl) === realProfile,
      String(resolveProfileDir(undefined, profileUrl)))
    check('baseUrl 无结尾斜杠也行',
      resolveProfileDir(undefined, profileUrl.slice(0, -1)) === realProfile,
      String(resolveProfileDir(undefined, profileUrl.slice(0, -1))))

    // baseUrl 必须优先于环境变量：真实 dsh 里环境变量可能缺失，
    // 而 shell 工具里又可能存在且指向别的 profile，不能让它盖掉 baseUrl。
    const envBackup = process.env.DSH_PROFILE_DIR
    process.env.DSH_PROFILE_DIR = '/bogus/profile'
    check('baseUrl 优先于 DSH_PROFILE_DIR',
      resolveProfileDir(undefined, profileUrl) === realProfile,
      String(resolveProfileDir(undefined, profileUrl)))
    if (envBackup === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = envBackup

    // 不像 profile 的目录必须拒绝 —— 这里只断言"没被当成 profileUrl 那个目录"，
    // 因为环境变量/唯一 profile 兜底仍可能给出别的答案（那是预期行为）。
    const plainDir = join(tempRoot, 'not-a-profile')
    await mkdir(plainDir, { recursive: true })
    await writeFile(join(plainDir, 'package.json'), '{"name":"x"}\n') // 缺 cordis.yml
    const plainUrl = pathToFileURL(plainDir).href + '/'
    check('缺 cordis.yml 的目录不算 profile', resolveProfileDir(undefined, plainUrl) !== plainDir,
      String(resolveProfileDir(undefined, plainUrl)))
    check('非 file: 协议的 baseUrl 被拒', resolveProfileDir(undefined, 'https://example.com/') !== plainDir,
      String(resolveProfileDir(undefined, 'https://example.com/')))
    check('非法 baseUrl 不抛异常', (() => {
      try { resolveProfileDir(undefined, 'not-a-url'); return true } catch { return false }
    })())
    check('baseUrl 为 undefined 不抛异常', (() => {
      try { resolveProfileDir(undefined, undefined); return true } catch { return false }
    })())

    section('①d baseUrl 也能喂给 resolveRoots / profilePluginsDir')
    const rootsViaBase = resolveRoots([], { baseUrl: profileUrl })
    check('roots 从 baseUrl 推出插件目录',
      rootsViaBase.length === 1 && rootsViaBase[0] === join(realProfile, 'mloader', 'plugins'),
      JSON.stringify(rootsViaBase))
    check('profilePluginsDir 接受 baseUrl',
      profilePluginsDir(undefined, profileUrl) === join(realProfile, 'mloader', 'plugins'),
      String(profilePluginsDir(undefined, profileUrl)))

    section('② resolveRoots 自动追加 profile 目录')
    const r1 = resolveRoots(['/abs/one'], { profileDir: '/p/web' })
    check('显式 root 保留', r1[0] === '/abs/one', JSON.stringify(r1))
    check('末尾追加 profile 插件目录', r1.includes('/p/web/mloader/plugins'), JSON.stringify(r1))
    check('共 2 个 root', r1.length === 2, JSON.stringify(r1))

    const r2 = resolveRoots(['/p/web/mloader/plugins'], { profileDir: '/p/web' })
    check('重复的 profile 目录被去重', r2.length === 1, JSON.stringify(r2))

    const r3 = resolveRoots([], { profileDir: '/p/web' })
    check('roots 为空也能得到 profile 目录', r3.length === 1 && r3[0] === '/p/web/mloader/plugins', JSON.stringify(r3))

    section('③ 相对路径以 profile 为基准，~ 会展开')
    const r4 = resolveRoots(['./mine'], { profileDir: '/p/web', includeProfileDir: false })
    check('相对路径基于 profileDir', r4[0] === '/p/web/mine', JSON.stringify(r4))
    check('expandHome(~/) 展开到 home', expandHome('~/x') === join(process.env.HOME ?? '', 'x'), expandHome('~/x'))
    check('expandHome(/abs) 不变', expandHome('/abs/x') === '/abs/x', expandHome('/abs/x'))

    section('④ includeProfileDir:false 时不追加')
    const r5 = resolveRoots(['/abs/one'], { profileDir: '/p/web', includeProfileDir: false })
    check('只有显式 root', r5.length === 1 && r5[0] === '/abs/one', JSON.stringify(r5))

    section('⑤ 真的在 profile 插件目录里放插件，能被发现')
    const fakeProfile = join(tempRoot, 'profile')
    const profilePlugins = join(fakeProfile, 'mloader', 'plugins')
    await makePythonPlugin(profilePlugins, 'from-profile', 'tool_from_profile')
    await makePythonPlugin(join(tempRoot, 'extra'), 'from-extra', 'tool_from_extra')

    const roots = resolveRoots([join(tempRoot, 'extra')], { profileDir: fakeProfile })
    check('roots 含 2 个目录', roots.length === 2, JSON.stringify(roots))

    const found = await discover(roots, null)
    const ids = found.specs.map((s) => s.id).sort()
    check('两个来源的插件都被发现', ids.join(',') === 'from-extra,from-profile', JSON.stringify(ids))
    check('发现阶段无错误', found.errors.length === 0, JSON.stringify(found.errors))

    section('⑥ 端到端：码头从 profile 目录加载插件')
    const root = new Context()
    const logger = makeLogger()
    root.provide('logger', logger)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { roots: [join(tempRoot, 'extra')], profileDir: fakeProfile, pythonBin: 'python3', seedExamples: false, console: false },
    )
    await new Promise((r) => setTimeout(r, 3500))

    const mloader = root.get('mloader')
    const loadedIds = (mloader?.list() ?? []).map((p) => p.id).sort()
    check('码头加载了 profile 里的插件', loadedIds.includes('from-profile'), JSON.stringify(loadedIds))
    check('也加载了显式 roots 里的插件', loadedIds.includes('from-extra'), JSON.stringify(loadedIds))
    const states = (mloader?.list() ?? []).map((p) => `${p.id}:${p.state}${p.error ? ' err=' + p.error : ''}`)
    check('两个插件都 applied', (mloader?.list() ?? []).filter((p) => p.state === 'applied').length === 2, JSON.stringify(states))

    const tools = root.get('tools')
    check('profile 插件的工具可调用', (await tools.get('tool_from_profile').execute({}))?.ok === true)
    check('显式 roots 插件的工具可调用', (await tools.get('tool_from_extra').execute({}))?.ok === true)

    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 500))

    section('⑦ profile 插件目录不存在时不报错')
    const emptyProfile = join(tempRoot, 'empty-profile')
    const roots2 = resolveRoots([], { profileDir: emptyProfile })
    check('仍然返回路径', roots2.length === 1, JSON.stringify(roots2))
    const found2 = await discover(roots2, null)
    check('发现结果为 0 个插件', found2.specs.length === 0, JSON.stringify(found2.specs))
    check('有 1 条"目录不存在"错误（不抛异常）', found2.errors.length === 1, JSON.stringify(found2.errors))

    section('⑧ profilePlugins:false 时不去扫 profile（端到端）')
    const root3 = new Context()
    const logger3 = makeLogger()
    root3.provide('logger', logger3)
    root3.provide('systemPrompt', systemPromptStub())
    root3.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiber3 = root3.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [join(tempRoot, 'extra')],
        profileDir: fakeProfile,
        profilePlugins: false,
        seedExamples: false, console: false,
        pythonBin: 'python3',
      },
    )
    await new Promise((r) => setTimeout(r, 3500))
    const ids3 = (root3.get('mloader')?.list() ?? []).map((p) => p.id).sort()
    check('只加载显式 roots', ids3.join(',') === 'from-extra', JSON.stringify(ids3))
    check('没有 from-profile', !ids3.includes('from-profile'), JSON.stringify(ids3))
    await fiber3.dispose()
    await new Promise((r) => setTimeout(r, 400))

    console.log(`\n${'─'.repeat(60)}`)
    if (failures.length === 0) {
      console.log(`✅ 全部通过：${passed} 项断言`)
      process.exitCode = 0
    } else {
      console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
      for (const f of failures) console.log(`   - ${f}`)
      console.log('\n--- 日志 ---')
      for (const line of logger.lines.slice(-20)) console.log(`   ${line}`)
      process.exitCode = 1
    }
  } finally {
    if (tempRoot) await rm(tempRoot, { recursive: true, force: true }).catch(() => {})
  }
}

main().catch((error) => {
  console.error('\n❌ 测试脚本崩溃:', error)
  process.exit(1)
})
