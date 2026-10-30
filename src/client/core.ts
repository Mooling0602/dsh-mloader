/**
 * Browser half of dsh-mloader.
 *
 * This module contributes the External plugins section to the detail page the
 * Plugins page draws for the dsh-mloader bundle. The section lists every
 * external plugin the loader hosts in the same row form the page uses for the
 * components a bundle contributes, and switches each one on or off at runtime
 * through the operator routes the host half serves. It registers as the
 * bundle's own configuration, which the page draws between the bundle's
 * description and its component rows, because the hosted plugins are what the
 * bundle adds to a running harness.
 *
 * scripts/build-client.mjs inlines the compiled form of this module into the
 * stand-alone client.js bundle, so the module declares no imports and no JSX.
 * React, the client primitives and the client services arrive through the
 * arguments.
 *
 * @module client/core
 */

/** Lifecycle state the host reports for one external plugin. */
type PluginState = 'discovered' | 'loaded' | 'applied' | 'disabled' | 'failed' | 'disposed'

/** Semantic state of the dot beside a row, mirroring the client primitives. */
type StateDotState = 'done' | 'warning' | 'ongoing' | 'error' | 'idle'

/** Runtime backend that hosts one external plugin. */
type PluginBackend = 'python' | 'wasm'

/** One external plugin as the host reports it. */
interface PluginSnapshot {
  readonly id: string
  readonly name: string
  readonly version: string
  readonly backend: PluginBackend
  readonly state: PluginState
  readonly tools: readonly string[]
  readonly events: readonly string[]
  readonly registrations: number
  readonly error?: string | undefined
}

/** Translate one dictionary key, interpolating any `{name}` parameters. */
type Translate = (key: string, params?: Record<string, unknown>) => string

/** One locale's dictionary. */
type Dictionary = Record<string, string>

/** Locale service face used by this module. */
interface LocaleService {
  register(namespace: string, dictionaries: { zh: Dictionary; en: Dictionary }): () => void
  bind(namespace: string): Translate
}

/** One slot registration of this module. */
interface SlotRegistrationOptions {
  readonly name: string
  readonly key: string
  readonly order?: number
  readonly locale?: string
}

/** Slots service face used by this module. */
interface SlotsService {
  inject(name: string, callback: () => unknown): unknown
  register(options: SlotRegistrationOptions, component: (props: BundleConfigProps) => unknown): unknown
}

/** Browser plugin context this module needs. */
interface ClientContext {
  readonly slots?: SlotsService | undefined
  readonly locale?: LocaleService | undefined
  readonly effect?: ((setup: () => unknown, label?: string) => unknown) | undefined
}

/** Owner props a bundle configuration entry renders with, plus the localized `t` seat. */
interface BundleConfigProps {
  readonly view?: 'page' | 'summary' | undefined
  readonly t?: Translate | undefined
}

/** React hooks used by this module. */
interface ReactLike {
  createElement(type: unknown, props?: object | null, ...children: unknown[]): unknown
  useState<S>(initial: S | (() => S)): [S, (next: S | ((previous: S) => S)) => void]
  useEffect(effect: () => void | (() => void), deps?: readonly unknown[]): void
}

/** Client primitives this module renders with; the Plugins page itself uses these. */
interface Primitives {
  readonly Button: (props: {
    readonly variant?: 'outline'
    readonly size?: 'sm'
    readonly disabled?: boolean
    readonly onClick?: () => void
  }) => unknown
  readonly SettingsForm: (props: {
    readonly labels: Record<string, string>
    readonly state: { available: boolean; writable: boolean; dirty: boolean; invalid: boolean; saving: boolean; failed: boolean }
    readonly onSave: () => void
    readonly onDiscard: () => void
  }) => unknown
  readonly SettingsValueField: (props: {
    readonly id: string
    readonly label: string
    readonly hint?: string
    readonly text: string
    readonly invalid: boolean
    readonly overridden: boolean
    readonly overriddenLabel: string
    readonly resetLabel: string
    readonly invalidLabel: string
    readonly disabled: boolean
    readonly onEdit: (text: string) => void
    readonly onReset: () => void
  }) => unknown
  readonly PluginArtworkDefault: (props: { readonly size?: number }) => unknown
  readonly StateDot: (props: { readonly state: StateDotState }) => unknown
  readonly Switch: (props: {
    readonly checked: boolean
    readonly label: string
    readonly disabled?: boolean
    readonly onChange: (next: boolean) => void
  }) => unknown
}

/** Dependencies supplied by the client.js bundle wrapper. */
interface ClientCoreDeps {
  readonly react: ReactLike
  readonly primitives: Primitives
}

/** Configuration fields displayed by the loader settings form. */
interface ConfigDraft {
  roots: string
  profilePlugins: boolean
  autoEnable: boolean
  pythonBin: string
  shellPath: string
  enablePyc: boolean
  statusTool: boolean
  command: string
  seedExamples: boolean
  console: string
  watch: boolean
  wasmEnabled: boolean
}

/** The plugin entry Cordis calls for the browser half. */
interface ClientPlugin {
  apply(ctx: ClientContext): void
}

/** Load state of the plugin list the section displays. */
type LoadStatus = 'loading' | 'ready' | 'error'

/** One failed switch request, shown under the row it belongs to. */
interface ToggleFailure {
  readonly id: string
  readonly message: string
}

/** Dictionary namespace owned by this plugin. */
const NS = 'mloader'

/** Route the host half serves the plugin list from. */
const PLUGINS_URL = '/mloader/plugins'

/** Route the host half serves a runtime switch request from. */
const TOGGLE_URL = '/mloader/plugins/toggle'

/** Route for editing the loader's profile configuration. */
const CONFIG_URL = '/mloader/config'

/** Package name of the bundle this entry is registered for, which is its slot key. */
const BUNDLE_NAME = 'dsh-mloader'

/** Dictionary key of each lifecycle state the host can report. */
const STATE_KEYS: Record<PluginState, string> = {
  applied: 'stateApplied',
  loaded: 'stateLoaded',
  disabled: 'stateDisabled',
  failed: 'stateFailed',
  discovered: 'stateDiscovered',
  disposed: 'stateDisposed',
}

/** Dot each lifecycle state shows beside its label. */
const STATE_DOTS: Record<PluginState, StateDotState> = {
  applied: 'done',
  loaded: 'ongoing',
  discovered: 'idle',
  disabled: 'idle',
  failed: 'error',
  disposed: 'idle',
}

/** Both dictionaries the locale registration installs. */
const DICTIONARIES = {
  zh: {
    title: '外部插件',
    loading: '加载中…',
    loadFailed: '加载失败',
    retry: '重试',
    empty: '没有外部插件',
    toggleFailed: '切换失败',
    switching: '切换中…',
    switchAria: '启用外部插件 {name}',
    toolsCount: '{n} 个工具',
    partsCountTotal: '共 {count} 个',
    partsCountRunning: '{count} 运行中',
    partsCountOff: '{count} 已停用',
    partsCountFailed: '{count} 异常',
    stateApplied: '运行中',
    stateLoaded: '加载中',
    stateDisabled: '已关闭',
    stateFailed: '异常',
    stateDiscovered: '未运行',
    stateDisposed: '已移除',
    configTitle: '加载器配置', configLoading: '正在读取配置…', configError: '配置读取失败',
    configSave: '保存配置', configSaving: '正在保存…', configSaved: '配置已保存。',
    configSaveError: '保存结果未确认，请重新打开页面检查配置', configConflict: '配置已变更，请重新读取后再保存',
    configReload: '重新读取', configHint: '保存会将当前完整配置写入 profile 并可能重新加载插件。每行填写一个路径，请使用绝对路径。',
    configSeedWarning: '重新加载时，如果启用了示例插件刷新，示例目录中的本地修改会被覆盖。',
    roots: '额外插件根目录', profilePlugins: '扫描 profile 插件目录', autoEnable: '启动时加载插件',
    pythonBin: 'Python 解释器', shellPath: '额外 PATH 目录', enablePyc: '保留 Python 字节码缓存',
    statusTool: '启用插件管理工具', command: '命令名称（true、false 或名称）', seedExamples: '刷新内置示例',
    console: '终端日志', consoleOn: '开启', consoleOff: '关闭', consoleVerbose: '详细',
    watch: '监听插件目录', wasmEnabled: '启用 WebAssembly 后端',
    configReadOnly: '此配置当前不可写。', configOverridden: '已覆盖', configReset: '恢复默认',
    rootsHint: '除 profile 之外扫描的目录，每行一个。', shellPathHint: 'Python 子进程额外搜索的目录，每行一个。',
    profilePluginsHint: '扫描当前 profile 的外部插件目录。', autoEnableHint: '启动加载器时自动挂载已启用的插件。',
    pythonBinHint: '用于创建共享 Python 环境的解释器。', pythonBinInvalid: '请输入解释器名称或路径。',
    enablePycHint: '保留字节码缓存可能让重新加载使用旧代码。', statusToolHint: '向模型提供插件状态、查看、加载、卸载和重载工具。',
    commandHint: 'true 使用默认名称；false 禁用；也可以输入自定义名称。', commandInvalid: '请输入 true、false 或有效的命令名称。',
    seedExamplesHint: '加载器启动时刷新内置示例，会替换示例目录。', consoleHint: '选择终端中的加载器日志级别。',
    watchHint: '自动发现新增或删除的插件目录。', wasmEnabledHint: '允许加载 WebAssembly 插件。',
  },
  en: {
    title: 'External plugins',
    loading: 'Loading…',
    loadFailed: 'Failed to load external plugins',
    retry: 'Retry',
    empty: 'No external plugins',
    toggleFailed: 'Failed to switch the plugin',
    switching: 'Switching…',
    switchAria: 'Enable external plugin {name}',
    toolsCount: '{n} tools',
    partsCountTotal: '{count} total',
    partsCountRunning: '{count} running',
    partsCountOff: '{count} off',
    partsCountFailed: '{count} failed',
    stateApplied: 'Running',
    stateLoaded: 'Loading',
    stateDisabled: 'Off',
    stateFailed: 'Problem',
    stateDiscovered: 'Not running',
    stateDisposed: 'Removed',
    configTitle: 'Loader configuration', configLoading: 'Loading configuration…', configError: 'Could not read configuration',
    configSave: 'Save configuration', configSaving: 'Saving…', configSaved: 'Configuration saved.',
    configSaveError: 'Save result could not be confirmed. Reopen the page and check the configuration',
    configConflict: 'Configuration changed. Reload it before saving', configReload: 'Reload configuration',
    configHint: 'Saving writes the current complete configuration to the profile and may reload this plugin. Enter one absolute path per line.',
    configSeedWarning: 'If bundled example refresh is enabled, reloading replaces local changes in the example directory.',
    roots: 'Additional plugin roots', profilePlugins: 'Scan the profile plugin directory', autoEnable: 'Load plugins at startup',
    pythonBin: 'Python interpreter', shellPath: 'Additional PATH directories', enablePyc: 'Keep Python bytecode caches',
    statusTool: 'Enable plugin management tools', command: 'Command name (true, false or a name)', seedExamples: 'Refresh bundled example',
    console: 'Terminal logging', consoleOn: 'On', consoleOff: 'Off', consoleVerbose: 'Verbose',
    watch: 'Watch plugin directories', wasmEnabled: 'Enable the WebAssembly backend',
    configReadOnly: 'This configuration is read-only.', configOverridden: 'Overridden', configReset: 'Reset to default',
    rootsHint: 'Directories scanned in addition to the profile, one per line.', shellPathHint: 'Additional executable search directories for Python children, one per line.',
    profilePluginsHint: 'Scan the current profile’s external plugin directory.', autoEnableHint: 'Mount enabled plugins when the loader starts.',
    pythonBinHint: 'The interpreter used to create the shared Python environment.', pythonBinInvalid: 'Enter an interpreter name or path.',
    enablePycHint: 'A bytecode cache can cause a reload to use old code.', statusToolHint: 'Expose plugin status, inspection, load, unload and reload tools to the model.',
    commandHint: 'Use true for the default name, false to disable it, or enter a custom name.', commandInvalid: 'Enter true, false or a valid command name.',
    seedExamplesHint: 'Refresh the bundled example at startup, replacing its directory.', consoleHint: 'Choose the loader’s terminal logging level.',
    watchHint: 'Discover added and removed plugin directories automatically.', wasmEnabledHint: 'Allow WebAssembly plugins to load.',
  },
}

/** Inline style of the whole section: the page's own configuration column item. */
const SECTION_STYLE = {
  display: 'flex',
  flexDirection: 'column',
  gap: '12px',
}

/** Inline style of the line carrying the title and the count summary. */
const HEAD_STYLE = { display: 'flex', alignItems: 'baseline', gap: '10px' }

/** Inline style of the section title. */
const TITLE_STYLE = { margin: 0, fontSize: '14px', lineHeight: '20px', fontWeight: 500 }

/** Inline style of the count summary beside the title. */
const COUNT_STYLE = {
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
}

/** Inline style of the plugin list. */
const LIST_STYLE = { display: 'flex', flexDirection: 'column', margin: 0, padding: 0, listStyle: 'none' }

/** Inline style of one plugin row; rows sit one hairline apart like the component rows. */
const ROW_STYLE = { padding: '12px 2px', borderBottom: '0.5px solid var(--dsw-alias-border-l2, rgba(128, 128, 128, 0.25))' }

/** Inline style of the last plugin row, which closes the list. */
const ROW_LAST_STYLE = { ...ROW_STYLE, borderBottom: 0 }

/** Inline style of the line holding the icon, the text block, the state and the switch. */
const ROW_LINE_STYLE = { display: 'flex', alignItems: 'center', gap: '16px', minWidth: 0 }

/** Inline style of the icon frame in front of a row. */
const ROW_ICON_STYLE = {
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  justifyContent: 'center',
  width: '40px',
  height: '40px',
  border: '0.5px solid var(--dsw-alias-border-l3, rgba(128, 128, 128, 0.25))',
  borderRadius: 'var(--dsw-radius-md, 8px)',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
}

/** Inline style of the name, id and metadata block of a row. */
const ROW_MAIN_STYLE = { display: 'flex', flex: '1', flexDirection: 'column', gap: '2px', minWidth: 0 }

/** Inline style of one row's display name. */
const ROW_NAME_STYLE = {
  fontSize: '13.5px',
  lineHeight: '20px',
  fontWeight: 500,
  color: 'var(--dsw-alias-label-primary, inherit)',
  overflowWrap: 'anywhere',
}

/** Inline style of one row's display name while the plugin is off. */
const ROW_NAME_OFF_STYLE = { ...ROW_NAME_STYLE, color: 'var(--dsw-alias-label-secondary, #6b7280)' }

/** Inline style of a row's monospaced secondary lines. */
const ROW_MODULE_STYLE = {
  fontFamily: 'var(--dsw-font-mono, ui-monospace, SFMono-Regular, Menlo, monospace)',
  fontSize: '11.5px',
  lineHeight: '16px',
  color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
  overflowWrap: 'anywhere',
}

/** Inline style of a row's state label and dot. */
const ROW_STATE_STYLE = {
  display: 'inline-flex',
  flex: 'none',
  alignItems: 'center',
  gap: '6px',
  fontSize: '12.5px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-label-secondary, #6b7280)',
  whiteSpace: 'nowrap',
}

/** Inline style of a row's state label when the host reported a problem. */
const ROW_STATE_FAILED_STYLE = { ...ROW_STATE_STYLE, color: 'var(--dsw-alias-state-error-primary, #c0392b)' }

/** Inline style of a row's failure or host error line, aligned under its text block. */
const ROW_FAILURE_STYLE = {
  margin: '4px 0 0 56px',
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-error-primary, #c0392b)',
  overflowWrap: 'anywhere',
}

/** Inline style of a status line such as the loading or empty state. */
const STATUS_STYLE = {
  margin: 0,
  fontSize: '13px',
  lineHeight: '20px',
  color: 'var(--dsw-alias-label-tertiary, #9ca3af)',
}

/** Inline style of an error status line. */
const ERROR_STYLE = {
  margin: 0,
  fontSize: '12px',
  lineHeight: '18px',
  color: 'var(--dsw-alias-state-error-primary, #c0392b)',
  overflowWrap: 'anywhere',
}

/** Display name of one plugin, falling back to its id. */
function displayName(plugin: PluginSnapshot): string {
  return plugin.name === '' ? plugin.id : plugin.name
}

/** Whether the runtime switch of one plugin reads as on. */
function switchOn(plugin: PluginSnapshot): boolean {
  return plugin.state === 'applied' || plugin.state === 'loaded'
}

/** The count line over the list, matching the count line over a bundle's components. */
function partsSummary(plugins: readonly PluginSnapshot[], t: Translate): string {
  const failed = plugins.filter((plugin) => plugin.state === 'failed').length
  const running = plugins.filter((plugin) => switchOn(plugin)).length
  const off = plugins.length - failed - running
  return [
    t('partsCountTotal', { count: String(plugins.length) }),
    ...running > 0 ? [t('partsCountRunning', { count: String(running) })] : [],
    ...off > 0 ? [t('partsCountOff', { count: String(off) })] : [],
    ...failed > 0 ? [t('partsCountFailed', { count: String(failed) })] : [],
  ].join(' · ')
}

/** Extract a human readable message from an unknown thrown value. */
function messageOf(reason: unknown): string {
  if (typeof reason === 'string' && reason !== '') return reason
  if (reason !== null && typeof reason === 'object' && 'message' in reason) {
    const message = (reason as { message?: unknown }).message
    if (typeof message === 'string' && message !== '') return message
  }
  if (reason === undefined || reason === null) return 'unknown error'
  return String(reason)
}

/** Read a JSON object body, treating a malformed or empty body as absent. */
async function readJson(response: { json(): Promise<unknown> }): Promise<Record<string, unknown> | null> {
  try {
    const body: unknown = await response.json()
    return body !== null && typeof body === 'object' && !Array.isArray(body) ? body as Record<string, unknown> : null
  } catch {
    return null
  }
}

/** Project a list of string values onto a plain array. */
function toStringList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item): item is string => typeof item === 'string') : []
}

/** Project one host record onto a plugin snapshot, or null when it carries no id. */
function toSnapshot(value: unknown): PluginSnapshot | null {
  if (value === null || typeof value !== 'object') return null
  const record = value as Record<string, unknown>
  if (typeof record.id !== 'string' || record.id === '') return null
  const state = typeof record.state === 'string' ? record.state as PluginState : 'discovered'
  return {
    id: record.id,
    name: typeof record.name === 'string' ? record.name : record.id,
    version: typeof record.version === 'string' ? record.version : '',
    backend: record.backend === 'wasm' ? 'wasm' : 'python',
    state,
    tools: toStringList(record.tools),
    events: toStringList(record.events),
    registrations: typeof record.registrations === 'number' ? record.registrations : 0,
    ...(typeof record.error === 'string' ? { error: record.error } : {}),
  }
}

/** Plugin list carried by a host list body. */
function readPlugins(body: Record<string, unknown> | null): PluginSnapshot[] {
  const list = body?.plugins
  if (!Array.isArray(list)) return []
  const plugins: PluginSnapshot[] = []
  for (const item of list) {
    const snapshot = toSnapshot(item)
    if (snapshot !== null) plugins.push(snapshot)
  }
  return plugins
}

/** Error message carried by a host failure body. */
function readError(body: Record<string, unknown> | null): string {
  const error = body?.error
  return typeof error === 'string' ? error : ''
}

/** Turn a host configuration into the form's text and switch values. */
function toConfigDraft(value: unknown): ConfigDraft | null {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return null
  const config = value as Record<string, unknown>
  if (!Array.isArray(config.roots) || !config.roots.every((item) => typeof item === 'string') ||
      !Array.isArray(config.shellPath) || !config.shellPath.every((item) => typeof item === 'string') ||
      typeof config.pythonBin !== 'string' ||
      (typeof config.command !== 'boolean' && typeof config.command !== 'string') ||
      (config.console !== true && config.console !== false && config.console !== 'verbose')) return null
  const bools = ['profilePlugins', 'autoEnable', 'enablePyc', 'statusTool', 'seedExamples', 'watch', 'wasmEnabled'] as const
  if (bools.some((key) => typeof config[key] !== 'boolean')) return null
  return {
    roots: config.roots.join('\n'), shellPath: config.shellPath.join('\n'), pythonBin: config.pythonBin,
    profilePlugins: config.profilePlugins as boolean, autoEnable: config.autoEnable as boolean,
    enablePyc: config.enablePyc as boolean, statusTool: config.statusTool as boolean,
    command: String(config.command), seedExamples: config.seedExamples as boolean,
    console: String(config.console), watch: config.watch as boolean, wasmEnabled: config.wasmEnabled as boolean,
  }
}

/** Project changed draft fields onto the host's configuration edit. */
function configChanges(draft: ConfigDraft, baseline: ConfigDraft): Record<string, unknown> {
  const result: Record<string, unknown> = {}
  for (const key of Object.keys(draft) as (keyof ConfigDraft)[]) {
    if (draft[key] === baseline[key]) continue
    const value = draft[key]
    if (key === 'roots' || key === 'shellPath') {
      result[key] = (value as string).split('\n').map((line) => line.trim()).filter(Boolean)
    } else if (key === 'command' || key === 'console') {
      result[key] = value === 'true' ? true : value === 'false' ? false : value
    } else result[key] = value
  }
  return result
}

/** Message of a failed HTTP response. */
function httpError(body: Record<string, unknown> | null, status: number): string {
  const message = readError(body)
  return message === '' ? `HTTP ${status}` : message
}

/**
 * Build the browser half over the supplied dependencies.
 *
 * @param deps - the React namespace and the client primitives the bundle
 * wrapper resolved.
 * @returns the plugin entry; its apply() installs the dictionaries and the
 * bundle configuration entry when the locale and slots services are present.
 */
export function createClientCore(deps: ClientCoreDeps): ClientPlugin {
  const react = deps.react
  const primitives = deps.primitives
  let boundTranslate: Translate = (key) => key

  /** Translate one lifecycle state through the dictionary. */
  function stateLabel(t: Translate, state: PluginState): string {
    const key = STATE_KEYS[state]
    return key === undefined ? state : t(key)
  }

  /** Edit profile-owned loader configuration through the host configuration editor. */
  function LoaderConfigSection(props: BundleConfigProps): unknown {
    const t = props.t ?? boundTranslate
    const [draft, setDraft] = react.useState<ConfigDraft | null>(null)
    const [baseline, setBaseline] = react.useState<ConfigDraft | null>(null)
    const [revision, setRevision] = react.useState('')
    const [status, setStatus] = react.useState<'loading' | 'ready' | 'saving' | 'error'>('loading')
    const [message, setMessage] = react.useState('')
    const [attempt, setAttempt] = react.useState(0)

    react.useEffect(() => {
      let alive = true
      const load = async (): Promise<void> => {
        setStatus('loading')
        setMessage('')
        try {
          const response = await fetch(CONFIG_URL, { credentials: 'same-origin' })
          const body = await readJson(response)
          if (!response.ok) throw new Error(httpError(body, response.status))
          const next = toConfigDraft(body?.config)
          if (next === null || typeof body?.revision !== 'string') throw new Error('invalid configuration response')
          if (!alive) return
          setDraft(next)
          setBaseline(next)
          setRevision(body.revision)
          setStatus('ready')
        } catch (error) {
          if (!alive) return
          setMessage(messageOf(error))
          setStatus('error')
        }
      }
      void load()
      return () => { alive = false }
    }, [attempt])

    const update = (key: keyof ConfigDraft, value: string | boolean): void => {
      setDraft((previous) => previous === null ? null : { ...previous, [key]: value })
    }
    const save = (): void => {
      if (draft === null || baseline === null || status !== 'ready') return
      const changes = configChanges(draft, baseline)
      if (Object.keys(changes).length === 0) return
      setStatus('saving')
      setMessage('')
      const request = async (): Promise<void> => {
        try {
          const response = await fetch(CONFIG_URL, {
            method: 'POST', credentials: 'same-origin', headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ revision, changes }),
          })
          const body = await readJson(response)
          if (!response.ok) {
            if (response.status === 409) throw new Error(t('configConflict'))
            throw new Error(httpError(body, response.status))
          }
          if (body?.saved !== true) throw new Error('invalid save response')
          const updated = await fetch(CONFIG_URL, { credentials: 'same-origin' })
          const updatedBody = await readJson(updated)
          if (!updated.ok) throw new Error(httpError(updatedBody, updated.status))
          const next = toConfigDraft(updatedBody?.config)
          if (next === null || typeof updatedBody?.revision !== 'string') throw new Error('invalid configuration response')
          setDraft(next)
          setBaseline(next)
          setRevision(updatedBody.revision)
          setMessage(t('configSaved'))
          setStatus('ready')
        } catch (error) {
          setMessage(`${t('configSaveError')}: ${messageOf(error)}`)
          setStatus('ready')
        }
      }
      void request()
    }

    if (status === 'loading') return react.createElement('p', { style: STATUS_STYLE }, t('configLoading'))
    if (draft === null || baseline === null || status === 'error') {
      return react.createElement('section', { 'data-mloader': 'configuration', style: SECTION_STYLE },
        react.createElement('p', { role: 'alert', style: ERROR_STYLE }, `${t('configError')}: ${message}`),
        react.createElement(primitives.Button, {
          variant: 'outline', size: 'sm', onClick: () => setAttempt((value) => value + 1),
        }, t('configReload')))
    }

    const dirty = Object.keys(configChanges(draft, baseline)).length > 0
    const pythonInvalid = draft.pythonBin.trim() === ''
    const commandInvalid = draft.command !== 'true' && draft.command !== 'false' && !/^[a-z][a-z0-9_-]*$/u.test(draft.command)
    const state = { available: true, writable: true, dirty, invalid: pythonInvalid || commandInvalid, saving: status === 'saving', failed: false }
    const fieldStyle = { display: 'grid', gap: '6px', padding: '12px 0', fontSize: '13px', lineHeight: '1.5' }
    const inputStyle = {
      boxSizing: 'border-box', width: '100%', padding: '8px 10px', color: 'var(--dsw-alias-label-primary, inherit)',
      background: 'var(--dsw-alias-bg-layer-3, transparent)', font: 'inherit',
      border: '0.5px solid var(--dsw-alias-border-l3, #888)', borderRadius: 'var(--dsw-radius-md, 8px)',
    }
    const textField = (key: 'pythonBin' | 'command', invalid: boolean): unknown =>
      react.createElement(primitives.SettingsValueField, {
        key, id: `mloader-config-${key}`, label: t(key), hint: t(`${key}Hint`), text: draft[key],
        invalid, overridden: false, overriddenLabel: t('configOverridden'), resetLabel: t('configReset'),
        invalidLabel: t(`${key}Invalid`), disabled: status === 'saving',
        onEdit: (value: string) => update(key, value), onReset: () => update(key, baseline[key]),
      })
    const pathField = (key: 'roots' | 'shellPath'): unknown =>
      react.createElement('label', { key, style: fieldStyle },
        react.createElement('span', null, t(key)),
        react.createElement('textarea', {
          value: draft[key], rows: 3, style: inputStyle, disabled: status === 'saving',
          onChange: (event: { target: { value: string } }) => update(key, event.target.value),
        }), react.createElement('span', { style: STATUS_STYLE }, t(`${key}Hint`)))
    const toggleField = (key: 'profilePlugins' | 'autoEnable' | 'enablePyc' | 'statusTool' | 'seedExamples' | 'watch' | 'wasmEnabled'): unknown =>
      react.createElement('div', { key, style: { ...fieldStyle, borderBottom: '0.5px solid var(--dsw-alias-border-l3, rgba(128,128,128,.25))' } },
        react.createElement('div', { style: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '16px' } },
          react.createElement('span', null, t(key)),
          react.createElement(primitives.Switch, {
            checked: draft[key], label: t(key), disabled: status === 'saving',
            onChange: (checked: boolean) => update(key, checked),
          })),
        react.createElement('p', { style: STATUS_STYLE }, t(`${key}Hint`)))
    const children = [
      react.createElement('p', { key: 'hint', style: STATUS_STYLE }, t('configHint')),
      react.createElement('p', { key: 'warning', style: STATUS_STYLE }, t('configSeedWarning')),
      pathField('roots'), toggleField('profilePlugins'), toggleField('autoEnable'),
      textField('pythonBin', pythonInvalid), pathField('shellPath'), toggleField('enablePyc'),
      toggleField('statusTool'), textField('command', commandInvalid), toggleField('seedExamples'),
      react.createElement('label', { key: 'console', style: fieldStyle }, t('console'),
        react.createElement('select', {
          value: draft.console, style: inputStyle, disabled: status === 'saving',
          onChange: (event: { target: { value: string } }) => update('console', event.target.value),
        }, react.createElement('option', { value: 'true' }, t('consoleOn')),
        react.createElement('option', { value: 'false' }, t('consoleOff')),
        react.createElement('option', { value: 'verbose' }, t('consoleVerbose'))),
        react.createElement('span', { style: STATUS_STYLE }, t('consoleHint'))),
      toggleField('watch'), toggleField('wasmEnabled'),
      ...(message === '' ? [] : [react.createElement('p', {
        key: 'message', role: message === t('configSaved') ? 'status' : 'alert',
        style: message === t('configSaved') ? STATUS_STYLE : ERROR_STYLE,
      }, message)]),
      ...(message === '' || message === t('configSaved') ? [] : [react.createElement(primitives.Button, {
        key: 'reload', variant: 'outline', size: 'sm', onClick: () => setAttempt((value) => value + 1),
      }, t('configReload'))]),
    ]
    return react.createElement('section', { 'data-mloader': 'configuration' },
      react.createElement(primitives.SettingsForm, {
        labels: { unavailable: t('configError'), readOnly: t('configReadOnly'), saveFailed: t('configSaveError'), save: t('configSave'), saving: t('configSaving') },
        state, onSave: save, onDiscard: () => { setDraft({ ...baseline }); setMessage('') },
      }, ...children))
  }

  /** The section body, mounted as the dsh-mloader bundle's configuration. */
  function ExternalPluginsSectionBody(props: BundleConfigProps): unknown {
    const t = props.t ?? boundTranslate
    const [plugins, setPlugins] = react.useState<PluginSnapshot[]>([])
    const [status, setStatus] = react.useState<LoadStatus>('loading')
    const [error, setError] = react.useState<string>('')
    const [pendingId, setPendingId] = react.useState<string>('')
    const [failure, setFailure] = react.useState<ToggleFailure | null>(null)
    const [attempt, setAttempt] = react.useState<number>(0)

    react.useEffect(() => {
      let alive = true
      const load = async (): Promise<void> => {
        if (typeof fetch !== 'function') {
          setStatus('ready')
          return
        }
        setStatus('loading')
        setError('')
        try {
          const response = await fetch(PLUGINS_URL, { credentials: 'same-origin' })
          const body = await readJson(response)
          if (!response.ok) throw new Error(httpError(body, response.status))
          if (!alive) return
          setPlugins(readPlugins(body))
          setStatus('ready')
        } catch (reason) {
          if (!alive) return
          setError(messageOf(reason))
          setStatus('error')
        }
      }
      void load()
      return () => { alive = false }
    }, [attempt])

    const toggle = (plugin: PluginSnapshot, enabled: boolean): void => {
      if (pendingId !== '') return
      setPendingId(plugin.id)
      setFailure(null)
      const request = async (): Promise<void> => {
        try {
          const response = await fetch(TOGGLE_URL, {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ id: plugin.id, enabled }),
          })
          const body = await readJson(response)
          if (!response.ok) throw new Error(httpError(body, response.status))
          const updated = toSnapshot(body?.plugin)
          if (updated === null) throw new Error('host returned no plugin snapshot')
          setPlugins((previous) => previous.map((row) => (row.id === updated.id ? updated : row)))
        } catch (reason) {
          setFailure({ id: plugin.id, message: messageOf(reason) })
        } finally {
          setPendingId('')
        }
      }
      void request()
    }

    const renderRow = (plugin: PluginSnapshot, index: number): unknown => {
      const on = switchOn(plugin)
      const pending = pendingId === plugin.id
      // One switch request is in flight at a time, so late responses cannot
      // overwrite a row with an older snapshot.
      const busy = pendingId !== ''
      const children: unknown[] = [
        react.createElement('div', { key: 'line', style: ROW_LINE_STYLE },
          react.createElement('span', { key: 'icon', style: ROW_ICON_STYLE, 'aria-hidden': true },
            react.createElement(primitives.PluginArtworkDefault, { key: 'art', size: 30 })),
          react.createElement('div', { key: 'main', style: ROW_MAIN_STYLE },
            react.createElement('span', { key: 'name', style: on ? ROW_NAME_STYLE : ROW_NAME_OFF_STYLE }, displayName(plugin)),
            react.createElement('code', { key: 'id', style: ROW_MODULE_STYLE }, plugin.id),
            react.createElement('span', { key: 'meta', style: ROW_MODULE_STYLE },
              `${plugin.backend} · ${t('toolsCount', { n: String(plugin.tools.length) })}`)),
          react.createElement('span', {
            key: 'state',
            style: plugin.state === 'failed' ? ROW_STATE_FAILED_STYLE : ROW_STATE_STYLE,
          },
          react.createElement(primitives.StateDot, { key: 'dot', state: STATE_DOTS[plugin.state] }),
          pending ? t('switching') : stateLabel(t, plugin.state)),
          react.createElement(primitives.Switch, {
            key: 'switch',
            checked: on,
            label: t('switchAria', { name: displayName(plugin) }),
            disabled: busy,
            onChange: (next: boolean) => { toggle(plugin, next) },
          })),
      ]
      if (failure !== null && failure.id === plugin.id) {
        children.push(react.createElement('p', { key: 'failure', style: ROW_FAILURE_STYLE },
          `${t('toggleFailed')}: ${failure.message}`))
      }
      if (plugin.state === 'failed' && plugin.error !== undefined) {
        children.push(react.createElement('p', { key: 'host-error', style: ROW_FAILURE_STYLE }, plugin.error))
      }
      return react.createElement('li', {
        key: plugin.id,
        style: index === plugins.length - 1 ? ROW_LAST_STYLE : ROW_STYLE,
      }, ...children)
    }

    const content: unknown[] = []
    if (status === 'loading') {
      content.push(react.createElement('p', { key: 'loading', style: STATUS_STYLE }, t('loading')))
    } else if (status === 'error') {
      content.push(react.createElement('p', { key: 'error', style: ERROR_STYLE },
        error === '' ? t('loadFailed') : `${t('loadFailed')}: ${error}`))
      content.push(react.createElement(primitives.Button, {
        key: 'retry',
        variant: 'outline',
        size: 'sm',
        onClick: () => { setAttempt((value) => value + 1) },
      }, t('retry')))
    } else if (plugins.length === 0) {
      content.push(react.createElement('p', { key: 'empty', style: STATUS_STYLE }, t('empty')))
    } else {
      content.push(react.createElement('ul', { key: 'list', style: LIST_STYLE }, plugins.map(renderRow)))
    }

    return react.createElement('section', { 'data-mloader': 'external-plugins', style: { ...SECTION_STYLE, marginTop: '24px' } },
      react.createElement('div', { style: HEAD_STYLE },
        react.createElement('h4', { style: TITLE_STYLE }, t('title')),
        plugins.length === 0 ? null : react.createElement('span', { style: COUNT_STYLE }, partsSummary(plugins, t))),
      ...content)
  }

  /** The registered entry; the page draws it as the bundle's own configuration. */
  function ExternalPluginsSection(props: BundleConfigProps): unknown {
    return react.createElement('div', null,
      react.createElement('h4', { style: TITLE_STYLE }, (props.t ?? boundTranslate)('configTitle')),
      react.createElement(LoaderConfigSection, props),
      react.createElement(ExternalPluginsSectionBody, props))
  }

  /** Install the dictionaries and the bundle configuration entry. */
  function apply(ctx: ClientContext): void {
    const slots = ctx.slots
    const locale = ctx.locale
    if (slots === undefined || locale === undefined) return
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => locale.register(NS, DICTIONARIES), 'mloader: dictionaries')
    } else {
      locale.register(NS, DICTIONARIES)
    }
    boundTranslate = locale.bind(NS)
    slots.inject('plugins.bundle.config', () => slots.register({
      name: 'plugins.bundle.config',
      key: BUNDLE_NAME,
      order: 10,
      locale: NS,
    }, ExternalPluginsSection))
  }

  return { apply }
}
