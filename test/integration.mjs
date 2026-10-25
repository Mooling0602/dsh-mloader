/**
 * 验证脚本：把 loader 挂到**真实 Cordis** 上，用**真实 dsh Tools 服务**跑完整链路。
 *
 * 不碰 dsh 的 Loader / profile，只验证：
 *   发现 → 启动 Python 子进程 → 翻译成注册 → 真实 ctx.tools.register → 工具可调 → 卸载干净
 */

import { Context } from '@deepseek-ai/cordis'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'

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

function section(title) {
  console.log(`\n${title}`)
}

/** 收集日志，便于断言。 */
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

  // 在根上下文提供 logger 与真实 Tools 服务 —— 与 dsh 内部一致。
  root.provide('logger', logger)
  // ToolRuntime 是真实的 dsh 工具注册服务；它 inject systemPrompt。
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

  section('① 挂载 loader（作为普通 Cordis 插件）')
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    {
      roots: [new URL('./plugins', import.meta.url).pathname],
      // 测试不该碰真实 profile：显式关掉自动探测与示例释放
      profilePlugins: false,
      seedExamples: false, console: false,
      pythonBin: 'python3',
    },
  )
  await new Promise((resolve) => setTimeout(resolve, 2500))

  const loader = root.get('mloader')
  check('loader 提供管理面', typeof loader?.list === 'function')

  const plugins = loader?.list?.() ?? []
  // test/plugins 下同时有 Python 与 WASM 插件；这里只关心 Python 那两个。
  const pythonPlugins = plugins.filter((plugin) => plugin.backend === 'python')
  check('发现 2 个 Python 插件', pythonPlugins.length === 2, `实际 ${pythonPlugins.map((p) => p.id).join(',')}`)

  const hello = plugins.find((plugin) => plugin.id === 'py-hello')
  const decl = plugins.find((plugin) => plugin.id === 'py-decl')
  check('py-hello 已 applied', hello?.state === 'applied', `state=${hello?.state} error=${hello?.error}`)
  check('py-decl 已 applied', decl?.state === 'applied', `state=${decl?.state} error=${decl?.error}`)

  section('② 外部插件不是 Cordis 插件')
  check('外部插件未注册为 Cordis 插件', typeof root.get('py-hello') === 'undefined')
  // loader 是唯一的 Corids 插件节点；外部插件只在注册账本里
  check('py-hello 有独立的注册账本', (hello?.registrations ?? 0) > 0, `registrations=${hello?.registrations}`)

  section('③ 工具已注册到真实 Tools 服务')
  const schemas = tools.schemas()
  const names = schemas.map((schema) => schema.name)
  check('py_greet 已注册', names.includes('py_greet'), `现有: ${names.join(',')}`)
  check('py_echo 已注册', names.includes('py_echo'))
  check('py_add 已注册（声明式风格）', names.includes('py_add'))
  check('py_stats 已注册（声明式风格）', names.includes('py_stats'))
  check('mloader_status 已注册', names.includes('mloader_status'))

  section('④ 调用 Python 工具（真实 execute 链路）')
  const greetDef = tools.get('py_greet')
  const greetResult = await greetDef.execute({ who: '世界' })
  check('py_greet 返回正确', greetResult?.text === '你好，世界！', JSON.stringify(greetResult))

  const addDef = tools.get('py_add')
  const addResult = await addDef.execute({ a: 19, b: 23 })
  check('py_add 返回 42', addResult?.sum === 42, JSON.stringify(addResult))

  const statsDef = tools.get('py_stats')
  const statsResult = await statsDef.execute({ values: [1, 2, 3, 4] })
  check('py_stats 计算正确', statsResult?.mean === 2.5 && statsResult?.max === 4, JSON.stringify(statsResult))

  // 工具抛错必须变成调用错误，而不是杀死进程
  section('⑤ 错误隔离')
  let threw = false
  try {
    await tools.get('py_stats').execute({ values: 'not-an-array' })
  } catch {
    threw = true
  }
  check('插件侧异常变成工具错误', threw)
  check('出错后插件仍然存活', loader.list().find((p) => p.id === 'py-decl')?.state === 'applied')

  section('⑥ 输出渲染')
  const greetSchema = schemas.find((schema) => schema.name === 'py_greet')
  check('工具声明了 parameters', greetSchema?.parameters?.type === 'object')
  const rendered = greetDef.output.render({ who: 'x' }, greetResult)
  check('render 返回 ContentBlock[]', Array.isArray(rendered) && rendered[0]?.type === 'text')

  section('⑦ 状态工具')
  const statusResult = await tools.get('mloader_status').execute({})
  check('mloader_status 报告全部插件', statusResult?.count === loader.list().length, JSON.stringify(statusResult).slice(0, 200))

  section('⑧ 卸载单个插件（不影响其他）')
  await loader.unload('py-decl')
  const afterUnload = loader.list()
  check('py-decl 已移除', !afterUnload.some((plugin) => plugin.id === 'py-decl'))
  const namesAfter = tools.schemas().map((schema) => schema.name)
  check('py_add 已撤销', !namesAfter.includes('py_add'), `现有: ${namesAfter.join(',')}`)
  check('py_greet 仍在', namesAfter.includes('py_greet'))

  section('⑨ 卸载 loader（全部撤销 + 子进程退出）')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 800))
  const finalNames = tools.schemas().map((schema) => schema.name)
  check('所有外部工具已撤销', !finalNames.some((n) => n.startsWith('py_')), `遗留: ${finalNames.join(',')}`)

  // 总结
  console.log(`\n${'─'.repeat(60)}`)
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`)
    process.exit(0)
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\n--- loader 日志 ---')
    for (const line of logger.lines.slice(-40)) console.log(`   ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n❌ 验证脚本本身崩溃:', error)
  process.exit(1)
})
