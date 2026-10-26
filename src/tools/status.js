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
export function createStatusTool(listPlugins) {
    return {
        name: 'mloader_status',
        description: 'List the external plugins hosted by dsh-mloader (Python/WASM) with their state, ' +
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
            render(_args, value) {
                return [{ type: 'text', text: format(value) }];
            },
        },
        async execute(args) {
            return buildStatus(listPlugins, args);
        },
    };
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
export function buildStatus(listPlugins, args) {
    const plugins = listPlugins();
    const id = isRecord(args) ? args.id : undefined;
    if (id) {
        const found = plugins.find((plugin) => plugin.id === id);
        if (found === undefined)
            throw new Error(`unknown plugin "${String(id)}"`);
        return { plugin: found };
    }
    return {
        count: plugins.length,
        plugins,
        byBackend: countBy(plugins, (plugin) => plugin.backend),
        byState: countBy(plugins, (plugin) => plugin.state),
    };
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
export function format(value) {
    const { plugins, single } = unpack(value);
    if (plugins.length === 0) {
        return 'No external plugins are managed by dsh-mloader.';
    }
    const lines = single
        ? [`Plugin ${plugins[0]?.id}:`, '']
        : [`${plugins.length} external plugin(s):`, ''];
    for (const plugin of plugins) {
        lines.push(`- ${plugin.id} (${plugin.backend}, ${plugin.state})` +
            `${plugin.tools?.length ? ` tools=[${plugin.tools.join(', ')}]` : ''}` +
            `${plugin.events?.length ? ` events=[${plugin.events.join(', ')}]` : ''}`);
        if (plugin.error)
            lines.push(`  error: ${plugin.error}`);
    }
    return lines.join('\n');
}
/** Read the plugin list out of either accepted snapshot shape. */
function unpack(value) {
    if (isRecord(value) && Array.isArray(value.plugins)) {
        return { plugins: value.plugins, single: false };
    }
    if (isRecord(value) && isRecord(value.plugin)) {
        return { plugins: [value.plugin], single: true };
    }
    return { plugins: [], single: false };
}
/** Count plugins by one string field. */
function countBy(plugins, key) {
    const counts = {};
    for (const plugin of plugins) {
        const name = key(plugin);
        counts[name] = (counts[name] ?? 0) + 1;
    }
    return counts;
}
/** Return true when a value is a non-array object. */
function isRecord(value) {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}
