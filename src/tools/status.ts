/**
 * The `mloader_status` tool and the shared status formatter.
 *
 * External plugins are invisible to the model because they are not dsh
 * plugins. This tool is the window: it reports the plugins the loader hosts
 * together with their state and registrations. The slash command renders the
 * same snapshots through the same formatter, so both surfaces stay in step.
 *
 * @module tools/status
 */

import type { PluginSnapshot, ToolDefinition, ToolTextBlock } from '../types.js'

/** Plugin count keyed by backend name or lifecycle state. */
type StatusCounts = Record<string, number>

/** Snapshot returned when no plugin id is requested. */
export interface PluginListStatus {
  count: number
  plugins: PluginSnapshot[]
  byBackend: StatusCounts
  byState: StatusCounts
}

/** Snapshot returned when one plugin id is requested. */
export interface PluginStatus {
  plugin: PluginSnapshot
}

/** Either status shape. The formatter accepts both. */
export type StatusSnapshot = PluginListStatus | PluginStatus

/**
 * Build the `mloader_status` tool definition.
 *
 * Every invocation rebuilds the snapshot from the manager, so the answer
 * reflects live plugin state. The tool is registered on the loader's context and
 * its renderer turns the result value into the text the model reads.
 *
 * @param listPlugins - Reads the current plugin snapshots. Called once per invocation.
 * @returns A tool definition ready for `ctx.tools.register`.
 */
export function createStatusTool(listPlugins: () => PluginSnapshot[]): ToolDefinition {
  return {
    name: 'mloader_status',
    description:
      'List the external plugins hosted by dsh-mloader (Python/WASM) with their state, ' +
      'registered tools and event subscriptions.',
    parameters: {
      type: 'object',
      properties: {
        id: {
          type: 'string',
          description: 'Show only this plugin; omit to list every plugin.',
        },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: 'object', additionalProperties: true },
      render(_args: unknown, value: unknown): ToolTextBlock[] {
        return [{ type: 'text', text: format(value) }]
      },
    },
    async execute(args: unknown): Promise<unknown> {
      return buildStatus(listPlugins, args)
    },
  }
}

/**
 * Build a status snapshot from the current plugin list.
 *
 * An `id` selects one plugin and returns the single plugin shape; any other
 * argument returns the full list with per-backend and per-state counts. The
 * status tool and the slash command both call this function, which is what keeps
 * their answers identical.
 *
 * @param listPlugins - Reads the current plugin snapshots.
 * @param args - Optional tool arguments; `{ id }` selects one plugin.
 * @returns The list shape, or the single plugin shape when an id was given.
 * @throws {Error} When the requested plugin id is unknown.
 */
export function buildStatus(
  listPlugins: () => PluginSnapshot[],
  args?: unknown,
): StatusSnapshot {
  const plugins = listPlugins()
  const id = isRecord(args) ? args.id : undefined
  if (id) {
    const found = plugins.find((plugin) => plugin.id === id)
    if (found === undefined) throw new Error(`unknown plugin "${String(id)}"`)
    return { plugin: found }
  }
  return {
    count: plugins.length,
    plugins,
    byBackend: countBy(plugins, (plugin) => plugin.backend),
    byState: countBy(plugins, (plugin) => plugin.state),
  }
}

/**
 * Render a status snapshot as human readable text.
 *
 * Both shapes are accepted, so the caller may pass the result of
 * {@link buildStatus} directly. This text is what the model and the user see, so
 * it stays free of transport detail.
 *
 * @param value - A snapshot, or anything else; an unknown shape renders as empty.
 * @returns One text block body, with a blank line after the header.
 */
export function format(value: unknown): string {
  const { plugins, single } = unpack(value)
  if (plugins.length === 0) {
    return 'No external plugins are managed by dsh-mloader.'
  }

  const lines = single
    ? [`Plugin ${plugins[0]?.id}:`, '']
    : [`${plugins.length} external plugin(s):`, '']
  for (const plugin of plugins) {
    lines.push(
      `- ${plugin.id} (${plugin.backend}, ${plugin.state})` +
      `${plugin.tools?.length ? ` tools=[${plugin.tools.join(', ')}]` : ''}` +
      `${plugin.events?.length ? ` events=[${plugin.events.join(', ')}]` : ''}`,
    )
    if (plugin.error) lines.push(`  error: ${plugin.error}`)
  }
  return lines.join('\n')
}

/** Read the plugin list out of either accepted snapshot shape. */
function unpack(value: unknown): { plugins: PluginSnapshot[]; single: boolean } {
  if (isRecord(value) && Array.isArray(value.plugins)) {
    return { plugins: value.plugins as PluginSnapshot[], single: false }
  }
  if (isRecord(value) && isRecord(value.plugin)) {
    return { plugins: [value.plugin as unknown as PluginSnapshot], single: true }
  }
  return { plugins: [], single: false }
}

/** Count plugins by one string field. */
function countBy(
  plugins: PluginSnapshot[],
  key: (plugin: PluginSnapshot) => string,
): StatusCounts {
  const counts: StatusCounts = {}
  for (const plugin of plugins) {
    const name = key(plugin)
    counts[name] = (counts[name] ?? 0) + 1
  }
  return counts
}

/** Return true when a value is a non-array object. */
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}
