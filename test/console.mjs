/**
 * 终端输出测试
 *
 * 验证 src/console.js 的契约：
 *   1. 默认输出生命周期节点
 *   2. 'verbose' 额外输出扫描细节
 *   3. false 完全静默
 *   4. 输出写失败（EPIPE 等）不能反过来打挂码头
 *
 * 为什么需要这组测试：终端输出是用户唯一的观测手段，静默失败过一次
 * （插件全消失但日志里一个字都没有），所以它本身必须有测试兜着。
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { createConsole } from '../src/console.js'

const failures = []
let passed = 0

/**
 * 真实 stdout 的引用。
 *
 * ★ 必须在 captureConsole() 之前抓住。
 *
 * 踩过的坑：captureConsole() 会把 console.log 换成收集器，而 check() 也用
 * console.log 打印结果 —— 于是捕获区里的 ✓/✗ 全被自己的收集器吃掉，
 * 断言失败了也看不见。这里留一份原始引用，报告的打印永远走真实 stdout。
 */
const report = console.log.bind(console)

function check(name, condition, detail = '') {
  if (condition) {
    passed++
    report(`  ✓ ${name}`)
  } else {
    failures.push(`${name}${detail ? ` — ${detail}` : ''}`)
    report(`  ✗ ${name}${detail ? ` — ${detail}` : ''}`)
  }
}

const section = (title) => report(`\n${title}`)

/**
 * 拦截 console.log，收集输出而不真的打印。
 * @returns {{ lines: string[], restore: Function }}
 */
function captureConsole() {
  const lines = []
  const original = console.log
  console.log = (...args) => {
    lines.push(args.map((a) => (typeof a === 'string' ? a : String(a))).join(' '))
  }
  return {
    lines,
    restore() {
      console.log = original
    },
  }
}

async function main() {
  // ── 纯单元部分：不依赖 Cordis ────────────────────────────────
  section('① 生命周期输出（默认档）')
  {
    const cap = captureConsole()
    const out = createConsole({})
    out.lifecycle('挂载 py-hello')
    out.lifecycle('卸载 py-hello')
    cap.restore()

    check('lifecycle 有输出', cap.lines.length === 2, `实际 ${cap.lines.length}`)
    check('带 [mloader] 前缀', cap.lines[0]?.startsWith('[mloader] '), cap.lines[0])
    check('内容完整', cap.lines[0]?.includes('挂载 py-hello'), cap.lines[0])
  }

  section('② detail 在默认档静默、verbose 档输出')
  {
    const capDefault = captureConsole()
    const outDefault = createConsole({})
    outDefault.detail('扫描 1 个根目录')
    capDefault.restore()
    check('默认档 detail 不输出', capDefault.lines.length === 0, `实际 ${capDefault.lines.length}`)

    const capVerbose = captureConsole()
    const outVerbose = createConsole({ console: 'verbose' })
    outVerbose.detail('扫描 1 个根目录')
    capVerbose.restore()
    check('verbose 档 detail 有输出', capVerbose.lines.length === 1, `实际 ${capVerbose.lines.length}`)
    check('verbose 内容正确', capVerbose.lines[0]?.includes('扫描 1 个根目录'), capVerbose.lines[0])
  }

  section('③ console: false 完全静默')
  {
    const cap = captureConsole()
    const out = createConsole({ console: false })
    out.lifecycle('挂载 x')
    out.detail('细节')
    out.warn('警告')
    out.error('错误')
    cap.restore()
    check('所有档位都无输出', cap.lines.length === 0, `实际 ${cap.lines.length}`)
    check('enabled 标记为 false', out.enabled === false)
  }

  section('④ warn / error 带层级标注')
  {
    const cap = captureConsole()
    const out = createConsole({})
    out.warn('检测不到 profile 目录')
    out.error('加载失败：entry 不存在')
    cap.restore()

    check('warn 有 warn 标注', cap.lines[0]?.includes('warn:'), cap.lines[0])
    check('error 有 error 标注', cap.lines[1]?.includes('error:'), cap.lines[1])
    check('warn 内容保留', cap.lines[0]?.includes('检测不到 profile 目录'))
    check('error 内容保留', cap.lines[1]?.includes('entry 不存在'))
  }

  section('⑤ 输出失败不能抛出（EPIPE 防护）')
  {
    const out = createConsole({})
    const original = console.log
    console.log = () => {
      throw new Error('EPIPE')
    }
    let threw = false
    try {
      out.lifecycle('挂载 x')
      out.warn('警告')
      out.error('错误')
    } catch {
      threw = true
    }
    console.log = original
    check('console 抛错被吞掉', threw === false)
  }

  // ── 集成部分：真实 loader 的输出 ────────────────────────────
  section('⑥ 真实 loader：挂载时输出，卸载时输出')
  {
    const cap = captureConsole()
    const root = new Context()
    const logger = (..._args) => logger
    Object.assign(logger, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
    root.provide('logger', logger)
    root.provide('systemPrompt', {
      section: () => () => {},
      context: () => () => {},
      tools: () => () => {},
      variable: () => () => {},
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      suppressRuntimeContext: () => () => {},
      refreshContext: (a) => a,
      assemble: async () => ({ sections: [] }),
    })
    root.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [new URL('./plugins', import.meta.url).pathname],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
        // 注意：不带 console: false —— 本测试就是要看输出
      },
    )
    await new Promise((r) => setTimeout(r, 3000))

    const mountLines = cap.lines.filter((l) => l.includes('[mloader]'))
    check('挂载时有终端输出', mountLines.length > 0, `实际 ${mountLines.length}`)
    check(
      '输出里含 py-hello',
      mountLines.some((l) => l.includes('py-hello')),
      mountLines.join(' | '),
    )
    check(
      '有「码头就绪」总结行',
      mountLines.some((l) => l.includes('码头就绪')),
      mountLines.join(' | '),
    )

    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 300))

    const unloadLines = cap.lines.filter((l) => l.includes('卸载'))
    check('卸载时有终端输出', unloadLines.length > 0, `实际 ${unloadLines.length}`)
    check(
      '有「码头已卸载」结尾行',
      cap.lines.some((l) => l.includes('码头已卸载')),
      cap.lines.slice(-3).join(' | '),
    )
    cap.restore()
  }

  section('⑦ 真实 loader：console:false 静默')
  {
    const cap = captureConsole()
    const root = new Context()
    const logger = (..._args) => logger
    Object.assign(logger, { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} })
    root.provide('logger', logger)
    root.provide('systemPrompt', {
      section: () => () => {},
      context: () => () => {},
      tools: () => () => {},
      variable: () => () => {},
      getSectionOrder: () => 0,
      getContextOrder: () => 0,
      suppressRuntimeContext: () => () => {},
      refreshContext: (a) => a,
      assemble: async () => ({ sections: [] }),
    })
    root.plugin(ToolRuntime, {})
    await new Promise((r) => setTimeout(r, 200))

    const fiber = root.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      {
        roots: [new URL('./plugins', import.meta.url).pathname],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false,
        console: false,
      },
    )
    await new Promise((r) => setTimeout(r, 3000))
    await fiber.dispose()
    await new Promise((r) => setTimeout(r, 300))
    cap.restore()

    const mloaderLines = cap.lines.filter((l) => l.includes('[mloader]'))
    check('console:false 时零输出', mloaderLines.length === 0, `实际 ${mloaderLines.length}`)
  }

  console.log('\n' + '─'.repeat(60))
  if (failures.length === 0) {
    report(`✅ 全部通过：${passed} 项断言`)
    process.exit(0)
  } else {
    report(`❌ ${failures.length} 项失败：`)
    for (const f of failures) report(`   - ${f}`)
    process.exit(1)
  }
}

main().catch((error) => {
  report(`❌ 测试脚本本身崩溃: ${error?.stack ?? error}`)
  process.exit(1)
})
