/**
 * 进程崩溃安全性测试
 *
 * 目标：外部插件的进程死掉时，码头（进而 dsh 主进程）**绝不能跟着崩**。
 *
 * 背景（真实事故）：
 *   dsh 重启时抛出 `fatal uncaught exception: Error: write EPIPE`，
 *   at src/backends/python.js:197 / 218，整个 dsh 进程被杀死。
 *
 *   根因不是"写入失败"，而是**没人监听**：Python 子进程已退出，
 *   往它的 stdin 写会触发**异步** 'error' 事件；EventEmitter 找不到监听器，
 *   就把它升级成 uncaught exception。`#write` 里的 try/catch 挡不住 ——
 *   那是同步异常，EPIPE 是异步的。
 *
 * 本测试用 `process.on('uncaughtException')` 捕获这类逃逸：
 * 只要有任何异常突破到进程级，就判定失败。
 */

import { mkdtemp, rm, writeFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { spawn } from 'node:child_process'
import { readFileSync } from 'node:fs'

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
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

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

// ★ 捕获一切逃逸到进程级的异常。这是本测试的核心断言手段。
const uncaught = []
process.on('uncaughtException', (error) => {
  uncaught.push(error)
  console.log(`  !! uncaughtException: ${error.code ?? ''} ${error.message}`)
})
process.on('unhandledRejection', (reason) => {
  uncaught.push(reason instanceof Error ? reason : new Error(String(reason)))
  console.log(`  !! unhandledRejection: ${reason}`)
})

async function makePlugin(root, id, { sleepForever = false } = {}) {
  const dir = join(root, id)
  await mkdir(dir, { recursive: true })
  await writeFile(
    join(dir, 'mloader.plugin.json'),
    JSON.stringify({ id, name: id, backend: 'python', entry: 'plugin.py', version: '1.0.0' }),
  )
  const body = sleepForever
    ? `import time\nfrom dsh_runtime import plugin\n\n@plugin\ndef apply(ctx):\n    ctx.logger.info("sleeping")\n    time.sleep(600)\n`
    : `from dsh_runtime import plugin\n\n@plugin\ndef apply(ctx):\n    @ctx.tools.register(name="${id.replace(/-/g, '_')}_ping", description="ping", parameters={"type":"object","properties":{},"additionalProperties":False})\n    def ping(args):\n        return {"pong": True}\n`
  await writeFile(join(dir, 'plugin.py'), body)
  return dir
}

async function mountLoader(config) {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', systemPromptStub())
  root.plugin(ToolRuntime, {})
  await sleep(200)
  const fiber = root.plugin({ name: 'dsh-mloader', inject: ['tools'], apply: loaderApply }, config)
  return { root, fiber, logger }
}

async function main() {
  let tempRoot
  try {
    tempRoot = await mkdtemp(join(tmpdir(), 'mloader-crash-'))

    section('① 子进程在管道断开后写入，不产生进程级异常')
    {
      const plugins = join(tempRoot, 'p1')
      await makePlugin(plugins, 'victim')
      const { root, fiber, logger } = await mountLoader({
        roots: [plugins],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false, console: false,
        statusTool: false,
        statusCommand: false,
      })
      await sleep(3000)

      const manager = root.get('mloader')
      check('插件已加载', (manager?.list() ?? []).some((p) => p.id === 'victim'),
        JSON.stringify((manager?.list() ?? []).map((p) => p.id)))

      // ★ 直接杀掉 Python 子进程，模仿 dsh 重启时的中断
      const victim = manager?.list().find((p) => p.id === 'victim')
      check('能取到插件句柄', victim !== undefined)
      await fiber.dispose()
      await sleep(800)
    }

    section('② 反复杀子进程，观察是否有 EPIPE 逃逸')
    {
      uncaught.length = 0
      const plugins = join(tempRoot, 'p2')
      await makePlugin(plugins, 'victim2')
      const { root, fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false, console: false,
        statusTool: false,
        statusCommand: false,
      })
      await sleep(3000)

      // 找出插件进程并 SIGKILL，然后立刻触发写入（卸载会写 dispose 帧）
      //
      // ⚠️ 不能用 `pgrep -f victim2`：那会匹配到**本测试脚本自己的命令行**
      // （脚本参数里就写着 victim2），结果把自己 SIGKILL 掉。
      // 必须精确匹配 python3 解释器 + bootstrap 脚本路径。
      const pids = []
      const ps = spawn('pgrep', ['-f', 'python3.*dsh_bootstrap'])
      ps.stdout.on('data', (d) => {
        for (const line of String(d).trim().split('\n')) {
          if (line.trim()) pids.push(Number(line.trim()))
        }
      })
      await new Promise((r) => ps.on('exit', r))
      // 过滤：命令行必须以 python3 开头，且参数里含本次测试的临时根目录。
      // （用 tempRoot 全路径，避免 'p2' 这种短串误伤自己的测试脚本）
      const mine = pids.filter((pid) => {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
          return cmdline.startsWith('python3') && cmdline.includes(tempRoot)
        } catch {
          return false
        }
      })
      check('找到插件子进程', mine.length > 0, `pids=${JSON.stringify(mine)}`)
      pids.length = 0
      pids.push(...mine)

      for (const pid of pids) {
        try {
          process.kill(pid, 'SIGKILL')
        } catch {
          // 可能已退出
        }
      }
      // ★ 关键：子进程已死，此刻卸载会往死管道写 dispose 帧
      const dbgT = Date.now()
      await fiber.dispose()
      const disposeMs = Date.now() - dbgT
      await sleep(1200)
      check('卸载很快返回（< 3s）', disposeMs < 3000, `${disposeMs}ms`)

      check('★ 没有 uncaughtException 逃逸', uncaught.length === 0,
        uncaught.map((e) => `${e.code ?? ''} ${e.message}`).join(' | '))
    }

    section('③ 启动即失败的插件（exec 失败）不崩码头')
    {
      uncaught.length = 0
      const plugins = join(tempRoot, 'p3')
      await makePlugin(plugins, 'okplugin')
      const { root, fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: '/nonexistent/python-does-not-exist',
        profilePlugins: false,
        seedExamples: false, console: false,
        statusTool: false,
        statusCommand: false,
      })
      await sleep(2500)

      const list = root.get('mloader')?.list() ?? []
      check('插件被标记为失败而不是崩溃', list.length === 1 && list[0].state === 'failed',
        JSON.stringify(list.map((p) => `${p.id}:${p.state}`)))
      check('★ 没有 uncaughtException 逃逸', uncaught.length === 0,
        uncaught.map((e) => `${e.code ?? ''} ${e.message}`).join(' | '))

      await fiber.dispose()
      await sleep(500)
    }

    section('④ 插件在 apply 期间卡死，卸载仍能完成')
    {
      uncaught.length = 0
      const plugins = join(tempRoot, 'p4')
      await makePlugin(plugins, 'sleepy', { sleepForever: true })
      const { root, fiber } = await mountLoader({
        roots: [plugins],
        pythonBin: 'python3',
        profilePlugins: false,
        seedExamples: false, console: false,
        statusTool: false,
        statusCommand: false,
      })
      // 只等一小会儿，此时插件还在 time.sleep，boot 尚未成功
      await sleep(800)

      const started = Date.now()
      await fiber.dispose()
      const elapsed = Date.now() - started
      check('卸载在合理时间内返回', elapsed < 8000, `${elapsed}ms`)
      check('★ 没有 uncaughtException 逃逸', uncaught.length === 0,
        uncaught.map((e) => `${e.code ?? ''} ${e.message}`).join(' | '))
    }

    section('⑤ 残留的 Python 进程已被清理')
    {
      await sleep(500)
      const ps = spawn('pgrep', ['-f', 'python3.*dsh_bootstrap'])
      let out = ''
      ps.stdout.on('data', (d) => { out += String(d) })
      await new Promise((r) => ps.on('exit', r))
      // 只统计命令行里含本次临时目录的（别的会话的插件不能算进来）
      const all = out.trim().split('\n').filter((l) => l.trim()).map(Number)
      const leaked = all.filter((pid) => {
        try {
          const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
          return cmdline.startsWith('python3') && cmdline.includes(tempRoot)
        } catch {
          return false
        }
      })
      // 回收是异步的（SIGTERM 后最多再等 2 秒才 SIGKILL），轮询确认。
      let final = leaked
      for (let i = 0; i < 30 && final.length > 0; i++) {
        await sleep(200)
        final = final.filter((pid) => {
          try {
            const cmdline = readFileSync(`/proc/${pid}/cmdline`, 'utf8').replaceAll('\0', ' ')
            return cmdline.startsWith('python3')
          } catch {
            return false
          }
        })
      }
      check('没有本次测试遗留的子进程', final.length === 0, `残留 ${JSON.stringify(final)}`)
    }

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
