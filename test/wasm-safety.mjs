/**
 * ★ 关键安全测试：WASM 死循环不能阻塞宿主主线程。
 *
 * 这是上一轮把 live dsh 卡死的那个场景。现在的期望行为：
 *   1. 死循环调用 → 超时 → worker.terminate()
 *   2. **主线程全程有空**（用心跳定时器证明）
 *   3. 宿主可以继续做别的事，dsh 不会卡死
 *   4. Python 插件完全不受影响
 *
 * ⚠️ 需要 wasm 二进制。`.wasm` 文件不进版本库（见 .gitignore），
 * 所以从 git clone 出来默认是**没有**这些二进制的 —— 本测试会自动跳过。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

// 缺 wasm 二进制就跳过，而不是失败 —— 那是环境问题，不是代码问题。
const WASM_BIN = fileURLToPath(new URL('./fixtures/wasm-loop/loop.wasm', import.meta.url))
if (!existsSync(WASM_BIN)) {
  console.log('⏭  跳过 wasm-safety：缺少 wasm 二进制（未提交到版本库）')
  console.log(`   期望位置：${WASM_BIN}`)
  console.log('   本测试覆盖「wasm 死循环不能阻塞宿主」这一关键安全性质，')
  console.log('   无法在纯 Python 环境验证 —— 请勿因此认为该项已被覆盖。')
  process.exit(0)
}

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
  const logger = (..._args) => logger
  logger.debug = push('debug')
  logger.info = push('info')
  logger.warn = push('warn')
  logger.error = push('error')
  logger.lines = lines
  return logger
}

async function main() {
  const root = new Context()
  const logger = makeLogger()
  root.provide('logger', logger)
  root.provide('systemPrompt', {
    section: () => () => {},
    context: () => () => {},
    tools: () => () => {},
    variable: () => () => {},
    getSectionOrder: () => 0,
    getContextOrder: () => 0,
    suppressRuntimeContext: () => () => {},
    refreshContext: (assembly) => assembly,
    assemble: async () => ({ sections: [] }),
  })
  root.plugin(ToolRuntime, {})
  await new Promise((resolve) => setTimeout(resolve, 200))
  const tools = root.get('tools')

  section('① 前置：确认 wasm 默认关闭')
  // 先不开启 wasm，验证开关确实生效
  const fixtures = new URL('./fixtures', import.meta.url).pathname
  const offFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots: [fixtures], pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 2500))
  const offLoader = root.get('mloader')
  const wasmOff = offLoader.list().find((p) => p.id === 'wasm-loop')
  check('wasm 默认不加载', wasmOff?.state === 'disabled', `state=${wasmOff?.state} err=${wasmOff?.error}`)
  check('wasm_loop_forever 未注册', tools.get('wasm_loop_forever') === undefined)
  await offFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 600))

  section('② 显式开启 wasm 后加载')
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots: [fixtures], pythonBin: 'python3', wasm: { enabled: true }, profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3500))
  const loader = root.get('mloader')
  const wasmRec = loader.list().find((p) => p.id === 'wasm-loop')
  check('wasm-loop applied', wasmRec?.state === 'applied', JSON.stringify(wasmRec))
  check('正常 wasm 工具可用', (await tools.get('wasm_fine').execute({}))?.fine === true)

  section('③ ★ 死循环不阻塞主线程（核心断言）')
  // 心跳：如果主线程被阻塞，这个计数器就不会增长
  let beats = 0
  const heartbeat = setInterval(() => { beats += 1 }, 50)

  const startedAt = Date.now()
  let loopErr = null
  try {
    await tools.get('wasm_loop_forever').execute({})
  } catch (error) {
    loopErr = error
  }
  const elapsed = Date.now() - startedAt
  clearInterval(heartbeat)

  check('死循环调用以超时错误返回', loopErr !== null, String(loopErr?.message ?? 'no error'))
  check('错误里指明了超时', /timed out/i.test(loopErr?.message ?? ''), loopErr?.message)
  check('错误里提示可能是死循环', /infinite loop|worker terminated/i.test(loopErr?.message ?? ''), loopErr?.message)
  check('超时时间符合 callMs=1200（<3s）', elapsed < 3000, `${elapsed}ms`)
  // 1200ms 内，50ms 心跳应至少跳 ~20 次；主线程若被阻塞则接近 0
  check('主线程全程有空（心跳 ≥ 10 次）', beats >= 10, `beats=${beats}, elapsed=${elapsed}ms`)

  section('④ 宿主继续正常工作')
  // fixtures 下还有 guarded 这个 Python 插件，用它证明 Python 后端不受 wasm 故障影响
  const pyTool = tools.get('legal_tool')
  check('同 loader 下的 Python 插件仍在', pyTool !== undefined)
  if (pyTool) {
    const pyResult = await pyTool.execute({})
    check('Python 工具可正常调用', pyResult?.ok === true, JSON.stringify(pyResult))
  }
  const stillAlive = await new Promise((resolve) => {
    setTimeout(() => resolve('alive'), 100)
  })
  check('主线程可调度定时器', stillAlive === 'alive')

  section('⑤ 全部卸载干净')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const finalNames = tools.schemas().map((s) => s.name)
  check('无残留工具', finalNames.filter((n) => n.startsWith('py_') || n.startsWith('wasm_')).length === 0, finalNames.join(','))

  console.log(`\n${'─'.repeat(60)}`)
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`)
    process.exit(0)
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\n--- 相关日志 ---')
    for (const line of logger.lines.slice(-40)) console.log(`   ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n❌ 测试脚本崩溃:', error)
  process.exit(1)
})
