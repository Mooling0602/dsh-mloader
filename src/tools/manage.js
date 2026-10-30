/** Model-facing tools for inspecting and managing hosted plugins. */
import { runMloaderAction } from '../commands/mloader.js';
/** Descriptions of the plugin management tools. */
const DESCRIPTIONS = {
    info: 'Show detailed information about one external plugin hosted by dsh-mloader.',
    load: 'Load one external plugin hosted by dsh-mloader. The change lasts until the loader restarts.',
    unload: 'Unload one external plugin hosted by dsh-mloader. The change lasts until the loader restarts.',
    reload: 'Reload one external plugin hosted by dsh-mloader, or load it if it is not loaded.',
};
/**
 * Build model-facing plugin management tools.
 *
 * Each tool uses the same lifecycle operation and text as the slash command.
 * Failed operations reject so the tool runtime reports an error.
 *
 * @param target - Plugin snapshots and lifecycle operations.
 * @returns Tool definitions ready for registration on the loader context.
 */
export function createManagementTools(target) {
    const actions = ['info', 'load', 'unload', 'reload'];
    return actions.map((action) => ({
        name: `mloader_${action}`,
        description: DESCRIPTIONS[action],
        parameters: {
            type: 'object',
            properties: {
                id: { type: 'string', description: 'Exact identifier of the external plugin.' },
            },
            required: ['id'],
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: { text: { type: 'string' } },
                required: ['text'],
                additionalProperties: false,
            },
            render(_args, value) {
                const text = value !== null && typeof value === 'object' && 'text' in value
                    ? String(value.text)
                    : '';
                return [{ type: 'text', text }];
            },
        },
        async execute(args) {
            if (args === null || typeof args !== 'object' || !('id' in args) ||
                typeof args.id !== 'string' || args.id.length === 0) {
                throw new Error('id must be a non-empty plugin identifier');
            }
            const result = await runMloaderAction(target, action, args.id);
            if (result.kind === 'error')
                throw new Error(result.text);
            return { text: result.text };
        },
    }));
}
