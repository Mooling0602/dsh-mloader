/**
 * 双后端集成测试：Python + WASM 在同一个 loader 下共存。
 *
 * 用真实 Cordis + 真实 dsh ToolRuntime，跑完整链路。
 *
 * ⚠️ 需要 wasm 二进制。`.wasm` 文件不进版本库（见 .gitignore），
 * 所以从 git clone 出来默认是**没有**这些二进制的 —— 本测试会自动跳过。
 * 想跑完整测试，先编译出 hello.wasm（源码见 test/plugins/wasm-hello/main.go）。
 */

import { existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

// 缺 wasm 二进制就跳过，而不是失败 —— 那是环境问题，不是代码问题。
const WASM_BIN = fileURLToPath(new URL('./plugins/wasm-hello/hello.wasm', import.meta.url))
if (!existsSync(WASM_BIN)) {
  console.log('⏭  跳过 dual-backend：缺少 wasm 二进制（未提交到版本库）')
  console.log(`   期望位置：${WASM_BIN}`)
  console.log('   本测试覆盖 Python + WASM 双后端共存，无法在纯 Python 环境验证。')
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

  // 用专用测试目录：Python 与 WASM 插件都在 test/plugins 下，不依赖任何示例目录
  const roots = [new URL('./plugins', import.meta.url).pathname]
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    // wasm 默认关闭，这是显式开启（详见 docs/ABI.md 的安全说明）
    { roots, pythonBin: 'python3', wasm: { enabled: true }, profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3500))

  const loader = root.get('mloader')
  const stateOf = (id) => loader.list().find((plugin) => plugin.id === id)

  section('① 三个插件全部挂载（2 Python + 1 WASM）')
  check('发现 3 个插件', loader.list().length === 3, loader.list().map((p) => `${p.id}:${p.state}`).join(','))
  check('py-hello applied', stateOf('py-hello')?.state === 'applied', JSON.stringify(stateOf('py-hello')))
  check('py-decl applied', stateOf('py-decl')?.state === 'applied', JSON.stringify(stateOf('py-decl')))
  check('wasm-hello applied', stateOf('wasm-hello')?.state === 'applied', JSON.stringify(stateOf('wasm-hello')))

  section('② WASM 后端标识正确')
  check('wasm-hello backend=wasm', stateOf('wasm-hello')?.backend === 'wasm')
  check('py-hello backend=python', stateOf('py-hello')?.backend === 'python')

  section('③ Python 工具走真实 execute')
  check('py_greet', (await tools.get('py_greet').execute({ who: '世界' }))?.text === '你好，世界！')
  check('py_add', (await tools.get('py_add').execute({ a: 19, b: 23 }))?.sum === 42)
  check('py_stats', (await tools.get('py_stats').execute({ values: [1, 2, 3, 4] }))?.mean === 2.5)

  section('④ WASM 工具走真实 execute（独立 worker 线程）')
  check('wasm_add', (await tools.get('wasm_add').execute({ a: 19, b: 23 }))?.sum === 42)
  check('wasm_upper', (await tools.get('wasm_upper').execute({ s: 'hello wasm' }))?.upper === 'HELLO WASM')

  section('⑤ 两种后端互不干扰')
  const mixed = await Promise.all([
    tools.get('py_add').execute({ a: 1, b: 2 }),
    tools.get('wasm_add').execute({ a: 3, b: 4 }),
    tools.get('py_stats').execute({ values: [9] }),
  ])
  check('并发调用结果正确', mixed[0]?.sum === 3 && mixed[1]?.sum === 7 && mixed[2]?.mean === 9)

  section('⑥ 卸载 WASM 插件不影响 Python')
  await loader.unload('wasm-hello')
  const namesAfter = tools.schemas().map((schema) => schema.name)
  check('wasm_add 已撤销', !namesAfter.includes('wasm_add'), namesAfter.join(','))
  check('wasm_upper 已撤销', !namesAfter.includes('wasm_upper'))
  check('py_greet 仍在', namesAfter.includes('py_greet'))
  check('py_add 仍在', namesAfter.includes('py_add'))

  section('⑦ 卸载 Python 插件')
  await loader.unload('py-decl')
  const afterPy = tools.schemas().map((schema) => schema.name)
  check('py_add 已撤销', !afterPy.includes('py_add'))
  check('py_greet 仍在', afterPy.includes('py_greet'))

  section('⑧ 全部卸载干净')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const final = tools.schemas().map((schema) => schema.name)
  check('无残留工具', final.filter((n) => n.startsWith('py_') || n.startsWith('wasm_')).length === 0, final.join(','))

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
  console.error('\n❌ 双后端测试崩溃:', error)
  process.exit(1)
})
