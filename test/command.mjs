/**
 * 斜杠命令测试：/mloader-status
 *
 * 用**真实的** dsh `CommandRuntime`（`@deepseek-ai/dsh-commands`），不自造 mock，
 * 这样注册、名称校验、descriptor 解析、handler 调用全是真实行为。
 *
 * 覆盖：
 *   1. 命令真的注册进了 commands 服务（能被 find/list 看到）
 *   2. 命令名用连字符 `mloader-status`
 *   3. handler 返回 success + 正确的插件列表文本
 *   4. 带参数（插件 id）时能定位单个插件
 *   5. 不存在的插件 id 返回 error（而不是抛异常）
 *   6. commands 服务缺失时码头仍然正常启动（可选依赖）
 *   7. 非法命令名被跳过且不抛错
 *   8. 卸载后命令被撤销
 */

import { Context } from '@deepseek-ai/cordis'
import CommandRuntime from '@deepseek-ai/dsh-commands'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import { apply as loaderApply } from '../src/index.js'
import { COMMAND_NAME_PATTERN, DEFAULT_COMMAND_NAME } from '../src/commands/status.js'

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

/**
 * 构造一个测试用 agent。
 *
 * `CommandRuntime.execute` 会给 session 追加 `command/run` 和 `command/done`
 * 生命周期事件（见 dsh-commands/lib/index.js 的 appendLifecycle），
 * 所以 agent 必须带一个能 `append` 的 session，否则会 TypeError。
 */
function makeAgent(id = 'test-agent') {
  const events = []
  return {
    id,
    session: {
      append(type, data) {
        events.push({ type, data })
        return undefined
      },
      events,
    },
  }
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
  root.plugin(CommandRuntime, {})
  await new Promise((resolve) => setTimeout(resolve, 300))

  const tools = root.get('tools')
  const commands = root.get('commands')

  section('① 真实 commands 服务已就绪')
  check('tools 服务可用', tools !== undefined)
  check('commands 服务可用', commands !== undefined, typeof commands)
  check('commands.register 是函数', typeof commands?.register === 'function')

  section('② 码头启动并注册命令')
  const roots = [new URL('./plugins', import.meta.url).pathname]
  const loaderFiber = root.plugin(
    { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
    { roots, pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
  )
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const mloader = root.get('mloader')
  check('码头已挂载', mloader !== undefined)
  // test/plugins 有 3 个插件目录，但 wasm 默认关闭 → 只有 2 个真正 applied
  check('托管了 3 个插件（含 1 个被跳过的 wasm）', mloader?.list().length === 3, JSON.stringify(mloader?.list().map((p) => p.id)))
  check('其中 2 个 applied', mloader?.list().filter((p) => p.state === 'applied').length === 2, JSON.stringify(mloader?.list().map((p) => `${p.id}:${p.state}`)))

  section('③ 命令名合法且用连字符')
  check('默认命令名含连字符', DEFAULT_COMMAND_NAME.includes('-'), DEFAULT_COMMAND_NAME)
  check('默认命令名是 mloader-status', DEFAULT_COMMAND_NAME === 'mloader-status', DEFAULT_COMMAND_NAME)
  check('命令名匹配 dsh 规则', COMMAND_NAME_PATTERN.test(DEFAULT_COMMAND_NAME), DEFAULT_COMMAND_NAME)
  check('下划线也合法但默认不用', COMMAND_NAME_PATTERN.test('mloader_status'))

  section('④ 命令真的在服务里（不靠猜）')
  const agent = makeAgent()
  const found = commands.find(agent, DEFAULT_COMMAND_NAME)
  check('commands.find 能解析到命令', found !== undefined, typeof found)
  check('命令 description 非空', typeof found?.description === 'string' && found.description.length > 0, found?.description)

  const listed = commands.list(agent)
  const descriptor = listed.find((c) => c.name === DEFAULT_COMMAND_NAME)
  check('commands.list 里有该命令', descriptor !== undefined, JSON.stringify(listed.map((c) => c.name)))
  check('descriptor 带 input hint', typeof descriptor?.input?.hint === 'string', descriptor?.input?.hint)

  section('⑤ handler 返回正确的插件列表')
  const result = await commands.execute(agent, `/${DEFAULT_COMMAND_NAME}`, [], new AbortController().signal)
  check('execute 返回了结果', result !== undefined)
  check('结果是 success', result?.result?.kind === 'success', JSON.stringify(result?.result))
  const text = result?.result?.text ?? ''
  check('文本含 py-hello', text.includes('py-hello'), text.slice(0, 120))
  check('文本含 py-decl', text.includes('py-decl'), text.slice(0, 120))
  check('文本含插件数量', /\d+ 个外部插件/.test(text), text.slice(0, 80))

  section('⑥ 带参数：定位单个插件')
  const one = await commands.execute(agent, `/${DEFAULT_COMMAND_NAME} py-hello`, [], new AbortController().signal)
  check('单插件查询 success', one?.result?.kind === 'success', JSON.stringify(one?.result))
  const oneText = one?.result?.text ?? ''
  check('只列 py-hello', oneText.includes('py-hello') && !oneText.includes('py-decl'), oneText.slice(0, 120))

  section('⑦ 不存在的插件 id → error 而非崩溃')
  const bad = await commands.execute(agent, `/${DEFAULT_COMMAND_NAME} no-such-plugin`, [], new AbortController().signal)
  check('返回 error 结果', bad?.result?.kind === 'error', JSON.stringify(bad?.result))
  check('错误信息提到 unknown plugin', (bad?.result?.text ?? '').includes('unknown plugin'), bad?.result?.text)

  section('⑧ 工具和命令读同一份数据（不漂移）')
  const toolResult = await tools.get('mloader_status').execute({})
  check('工具报告的插件数与命令一致', toolResult?.count === mloader.list().length, JSON.stringify(toolResult?.count))
  check('工具与命令的插件 id 一致', JSON.stringify(toolResult?.plugins?.map((p) => p.id)) === JSON.stringify(mloader.list().map((p) => p.id)))

  section('⑨ 卸载后命令被撤销')
  await loaderFiber.dispose()
  await new Promise((resolve) => setTimeout(resolve, 600))
  const afterDispose = commands.find(makeAgent(), DEFAULT_COMMAND_NAME)
  check('命令已被撤销', afterDispose === undefined, typeof afterDispose)
  const afterNames = commands.list(makeAgent()).map((c) => c.name)
  check('list 里也没有了', !afterNames.includes(DEFAULT_COMMAND_NAME), JSON.stringify(afterNames))

  section('⑩ commands 缺失时码头仍能启动（可选依赖）')
  const root2 = new Context()
  const logger2 = makeLogger()
  root2.provide('logger', logger2)
  root2.provide('systemPrompt', {
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
  root2.plugin(ToolRuntime, {})
  // ★ 故意不挂 CommandRuntime
  await new Promise((resolve) => setTimeout(resolve, 200))
  let bootError = null
  let fiber2
  try {
    fiber2 = root2.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { roots, pythonBin: 'python3', profilePlugins: false, seedExamples: false, console: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))
  } catch (error) {
    bootError = error
  }
  check('没有 commands 也能启动', bootError === null, bootError?.message)
  const mloader2 = root2.get('mloader')
  check('插件照常挂载', mloader2?.list().filter((p) => p.state === 'applied').length === 2, JSON.stringify(mloader2?.list()?.map((p) => `${p.id}:${p.state}`)))
  const skipLog = logger2.lines.filter((l) => l.includes('commands 服务不可用'))
  check('记录了跳过原因（不静默）', skipLog.length > 0, `条数=${skipLog.length}`)
  await fiber2?.dispose()

  section('⑪ 非法命令名被跳过，不抛错')
  const root3 = new Context()
  const logger3 = makeLogger()
  root3.provide('logger', logger3)
  root3.provide('systemPrompt', {
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
  root3.plugin(ToolRuntime, {})
  root3.plugin(CommandRuntime, {})
  await new Promise((resolve) => setTimeout(resolve, 300))
  let badNameError = null
  let fiber3
  try {
    fiber3 = root3.plugin(
      { name: 'dsh-mloader', inject: ['tools'], apply: loaderApply },
      { roots, pythonBin: 'python3', statusCommand: 'Bad_Name!', profilePlugins: false, seedExamples: false, console: false },
    )
    await new Promise((resolve) => setTimeout(resolve, 3000))
  } catch (error) {
    badNameError = error
  }
  check('非法名不导致崩溃', badNameError === null, badNameError?.message)
  const warnLog = logger3.lines.filter((l) => l.includes('斜杠命令名'))
  check('记录了非法名警告', warnLog.length > 0, `条数=${warnLog.length}`)
  const cmds3 = root3.get('commands')
  check('非法名未被注册', cmds3?.find(makeAgent(), 'Bad_Name!') === undefined)
  await fiber3?.dispose()

  console.log(`\n${'─'.repeat(60)}`)
  if (failures.length === 0) {
    console.log(`✅ 全部通过：${passed} 项断言`)
    process.exit(0)
  } else {
    console.log(`❌ ${failures.length} 项失败 / 共 ${passed + failures.length} 项`)
    for (const failure of failures) console.log(`   - ${failure}`)
    console.log('\n--- 日志 ---')
    for (const line of logger.lines.slice(-30)) console.log(`   ${line}`)
    process.exit(1)
  }
}

main().catch((error) => {
  console.error('\n❌ 测试脚本崩溃:', error)
  process.exit(1)
})
