/**
 * 内置示例插件（seed）测试
 *
 * 目标：验证「安装到 profile 后自动释放示例插件供用户参考」。
 *
 * 覆盖：
 *   1. 首次释放：文件落地、内容完整
 *   2. **绝不覆盖用户改动**（最关键的一条）
 *   3. 幂等：跑多少次结果都一样
 *   4. `seedExamples: false, console: false` 时完全不碰磁盘
 *   5. 目标目录不可写时不拖垮码头（只 warn）
 *   6. 端到端：码头自动释放示例 → 发现 → applied → 工具可调用
 *   7. 释放的示例本身是合法插件（manifest 字段、工具 schema 都过校验）
 */

import { mkdir, mkdtemp, readFile, readdir, rm, writeFile, chmod } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { installSeedExamples, SEED_DIR } from '../src/seed.js'
import { discover } from '../src/discovery.js'

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

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-seed-'))

    section('① 包内示例存在且结构完整')
    const seedEntries = await readdir(SEED_DIR, { withFileTypes: true })
    const seedNames = seedEntries.filter((e) => e.isDirectory()).map((e) => e.name)
    check('seed/ 至少有一个示例', seedNames.length >= 1, JSON.stringify(seedNames))
    check('包含 hello-mloader', seedNames.includes('hello-mloader'), JSON.stringify(seedNames))

    const helloDir = join(SEED_DIR, 'hello-mloader')
    const helloFiles = await readdir(helloDir)
    check('示例有 mloader.plugin.json', helloFiles.includes('mloader.plugin.json'), JSON.stringify(helloFiles))
    check('示例有 plugin.py', helloFiles.includes('plugin.py'), JSON.stringify(helloFiles))

    // 示例必须能被 discovery 认出来，否则释放了也加载不了
    const foundSeed = await discover([SEED_DIR], null)
    check('示例通过发现校验', foundSeed.specs.length >= 1, JSON.stringify(foundSeed.errors))
    check('示例 id 为 hello-mloader', foundSeed.specs.some((s) => s.id === 'hello-mloader'),
      JSON.stringify(foundSeed.specs.map((s) => s.id)))

    section('② 首次释放')
    const profileA = join(tempRoot, 'profile-a')
    const targetA = join(profileA, 'mloader', 'plugins')
    const loggerA = makeLogger()
    const r1 = await installSeedExamples(targetA, loggerA)

    check('释放了 hello-mloader', r1.installed.includes('hello-mloader'), JSON.stringify(r1))
    check('没有跳过任何示例', r1.skipped.length === 0, JSON.stringify(r1.skipped))

    const installedDir = join(targetA, 'hello-mloader')
    const installedFiles = await readdir(installedDir)
    check('目标目录有 manifest', installedFiles.includes('mloader.plugin.json'), JSON.stringify(installedFiles))
    check('目标目录有 plugin.py', installedFiles.includes('plugin.py'), JSON.stringify(installedFiles))

    const sourcePy = await readFile(join(helloDir, 'plugin.py'), 'utf8')
    const targetPy = await readFile(join(installedDir, 'plugin.py'), 'utf8')
    check('内容与包内一致', sourcePy === targetPy)

    section('③ ★ 绝不覆盖用户改动')
    await writeFile(join(installedDir, 'plugin.py'), '# 用户改过的内容\n')
    await writeFile(join(installedDir, 'my-notes.txt'), 'my notes')

    const loggerB = makeLogger()
    const r2 = await installSeedExamples(targetA, loggerB)
    check('第二次跳过已存在的示例', r2.skipped.includes('hello-mloader'), JSON.stringify(r2))
    check('第二次没有安装任何东西', r2.installed.length === 0, JSON.stringify(r2.installed))

    const afterEdit = await readFile(join(installedDir, 'plugin.py'), 'utf8')
    check('★ 用户改动的 plugin.py 被保留', afterEdit.includes('用户改过的内容'), afterEdit.slice(0, 40))
    const afterNotes = await readFile(join(installedDir, 'my-notes.txt'), 'utf8')
    check('★ 用户新增的文件被保留', afterNotes === 'my notes')

    section('④ 幂等：重复执行无副作用')
    const snapshots = []
    for (let i = 0; i < 3; i++) {
      await installSeedExamples(targetA, makeLogger())
      const files = (await readdir(installedDir)).sort()
      snapshots.push(files.join(','))
    }
    check('连跑 3 次文件列表不变', new Set(snapshots).size === 1, JSON.stringify(snapshots))

    section('⑤ seedExamples:false 时完全不碰磁盘')
    const profileB = join(tempRoot, 'profile-b')
    const targetB = join(profileB, 'mloader', 'plugins')

    const rootB = new Context()
    const loggerB2 = makeLogger()
    rootB.provide('logger', loggerB2)
    rootB.provide('systemPrompt', systemPromptStub())
    rootB.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiberB = rootB.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: profileB, seedExamples: false, console: false, pythonBin: 'python3', statusTool: false, statusCommand: false },
    )
    await new Promise((r) => setTimeout(r, 1200))

    let bExists = true
    try {
      await readdir(targetB)
    } catch {
      bExists = false
    }
    check('目标插件目录没有被创建', bExists === false, String(bExists))
    await fiberB.dispose()
    await new Promise((r) => setTimeout(r, 300))

    section('⑥ 目标不可写时只 warn，不抛异常')
    const readOnlyBase = join(tempRoot, 'readonly')
    await mkdir(readOnlyBase, { recursive: true })
    await chmod(readOnlyBase, 0o500)
    const loggerC = makeLogger()
    let threw = false
    try {
      await installSeedExamples(join(readOnlyBase, 'mloader', 'plugins'), loggerC)
    } catch {
      threw = true
    }
    check('没有抛异常', threw === false)
    await chmod(readOnlyBase, 0o700)

    section('⑦ 端到端：码头自动释放示例 → 加载 → 工具可调用')
    const profileD = join(tempRoot, 'profile-d')
    const root = new Context()
    const loggerD = makeLogger()
    root.provide('logger', loggerD)
    root.provide('systemPrompt', systemPromptStub())
    root.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    // 只给 profileDir，不给 roots：完全依赖自动探测 + seed
    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: profileD, pythonBin: 'python3' },
    )
    await new Promise((r) => setTimeout(r, 4000))

    const mloader = root.get('mloader')
    const list = mloader?.list() ?? []
    check('示例被自动发现', list.some((p) => p.id === 'hello-mloader'), JSON.stringify(list.map((p) => p.id)))
    check('示例状态为 applied', list.find((p) => p.id === 'hello-mloader')?.state === 'applied',
      JSON.stringify(list.map((p) => `${p.id}:${p.state}`)))

    const tools = root.get('tools')
    const names = tools.schemas().map((s) => s.name)
    check('hello_mloader 工具已注册', names.includes('hello_mloader'), JSON.stringify(names))
    check('hello_add 工具已注册', names.includes('hello_add'), JSON.stringify(names))

    const greet = await tools.get('hello_mloader').execute({ who: '码头', excited: true })
    check('hello_mloader 返回问候', greet?.message === '你好，码头！', JSON.stringify(greet))
    check('返回值带插件名', greet?.plugin === 'hello-mloader', JSON.stringify(greet))

    const sum = await tools.get('hello_add').execute({ a: 2, b: 40 })
    check('hello_add 正确求和', sum?.sum === 42, JSON.stringify(sum))

    // 工具的参数校验确实生效
    let rejected = false
    try {
      await tools.get('hello_add').execute({ a: 1 })
    } catch {
      rejected = true
    }
    check('缺必填参数会被拒绝', rejected === true)

    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 600))

    section('⑧ 释放的示例在下次启动时不会被重复覆盖')
    const filesBefore = (await readdir(join(profileD, 'mloader', 'plugins', 'hello-mloader'))).sort()
    const root2 = new Context()
    root2.provide('logger', makeLogger())
    root2.provide('systemPrompt', systemPromptStub())
    root2.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))
    const fiber2 = root2.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { profileDir: profileD, pythonBin: 'python3', statusTool: false, statusCommand: false },
    )
    await new Promise((r) => setTimeout(r, 2500))
    const filesAfter = (await readdir(join(profileD, 'mloader', 'plugins', 'hello-mloader'))).sort()
    check('文件列表保持一致', filesBefore.join(',') === filesAfter.join(','),
      `${filesBefore.join(',')} vs ${filesAfter.join(',')}`)
    const stillApplied = (root2.get('mloader')?.list() ?? []).find((p) => p.id === 'hello-mloader')
    check('第二次启动仍然 applied', stillApplied?.state === 'applied', JSON.stringify(stillApplied))
    await fiber2.dispose()
    await new Promise((r) => setTimeout(r, 400))

    console.log(`\n${'─'.repeat(60)}`)
    if (failures.length === 0) {
      console.log(`✅ 全部通过：${passed} 项断言`)
      process.exitCode = 0
    } else {
      console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
      for (const f of failures) console.log(`   - ${f}`)
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
