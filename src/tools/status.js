/**
 * dsh-mloader — 状态查询工具
 *
 * 外部插件对模型不可见（它们不是 dsh 插件），但模型需要能问一句
 * "现在挂了哪些插件、各自什么状态"。这个工具就是那个窗口。
 */

/**
 * @param listPlugins - `() => Array<object>`，返回当前插件快照。
 */
export function createStatusTool(listPlugins) {
  return {
    name: 'mloader_status',
    description:
      '列出由 dsh-mloader 管理的全部外部插件（Python/WASM）及其状态、' +
      '已注册的工具与事件订阅。这些插件不是 dsh 插件，只通过本加载器接入。',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: '只看某一个插件；省略则列出全部。',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args, value) {
        return [{ type: 'text', text: format(value) }]
      },
    },
    async execute(args) {
      return buildStatus(listPlugins, args)
    },
  }
}

/**
 * 构造状态快照。
 *
 * 工具（模型调用）和斜杠命令（用户调用）共用这一份，避免两条路径漂移。
 *
 * @param listPlugins - `() => Array<object>`
 * @param args - `{ id?: string }`
 */
export function buildStatus(listPlugins, args) {
  const plugins = listPlugins()
  if (args?.id) {
    const found = plugins.find((plugin) => plugin.id === args.id)
    if (!found) throw new Error(`unknown plugin "${args.id}"`)
    return { plugin: found }
  }
  return {
    count: plugins.length,
    plugins,
    byBackend: plugins.reduce((acc, plugin) => {
      acc[plugin.backend] = (acc[plugin.backend] ?? 0) + 1
      return acc
    }, {}),
    byState: plugins.reduce((acc, plugin) => {
      acc[plugin.state] = (acc[plugin.state] ?? 0) + 1
      return acc
    }, {}),
  }
}

/** 把状态渲染成人读的表格文本。 */
export function format(value) {
  // 单插件查询：buildStatus(id) 返回的是 `{ plugin }` 而不是 `{ plugins }`。
  // 早期只处理了 `plugins`，导致 `/mloader-status <id>` 永远显示"没有插件"。
  const plugins = Array.isArray(value?.plugins)
    ? value.plugins
    : value?.plugin ? [value.plugin] : []

  if (plugins.length === 0) {
    return '当前没有由 dsh-mloader 管理的外部插件。'
  }
  const lines = plugins.length === 1 && value?.plugin
    ? [`插件 ${plugins[0].id}：`, '']
    : [`共 ${plugins.length} 个外部插件：`, '']
  for (const plugin of plugins) {
    lines.push(
      `- ${plugin.id} (${plugin.backend}, ${plugin.state})` +
      `${plugin.tools?.length ? ` tools=[${plugin.tools.join(', ')}]` : ''}` +
      `${plugin.events?.length ? ` events=[${plugin.events.join(', ')}]` : ''}`,
    )
    if (plugin.error) lines.push(`  ⚠️  ${plugin.error}`)
  }
  return lines.join('\n')
}
