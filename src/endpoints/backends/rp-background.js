/** Enforce constraints after custom YAML and prompt processing. */
export function prepareRpBackground(body, source) {
    if (source.chat_completion_source !== 'custom' || !/qwen.*27b/i.test(String(body.model))) {
        if (source.rp_memory_background) throw new Error('Unsupported RP background model');
        return;
    }
    const world = source.rp_memory_prefix_world;
    let boundary = -1;
    if (typeof world === 'string' && world && Array.isArray(body.messages)) {
        const hits = body.messages.filter(m => m.role === 'system' && typeof m.content === 'string' && m.content.includes(world));
        if (hits.length === 1 && hits[0].content.split(world).length === 2) {
            const index = body.messages.indexOf(hits[0]);
            const cut = hits[0].content.indexOf(world) + world.length;
            const suffix = hits[0].content.slice(cut);
            body.messages = [...body.messages.slice(0, index), { ...hits[0], content: hits[0].content.slice(0, cut) },
                ...(suffix ? [{ ...hits[0], content: suffix }] : []), ...body.messages.slice(index + 1)];
            boundary = index;
        }
    }
    if (!source.rp_memory_background) return;
    if (!['warm', 'curator'].includes(source.rp_memory_background)) throw new Error('Unknown RP background stage');
    if (source.rp_memory_background === 'warm') {
        if (boundary < 0) throw new Error('RP warm prefix is missing or ambiguous');
        const firstNonSystem = body.messages.findIndex(m => m.role !== 'system');
        if (firstNonSystem >= 0 && boundary >= firstNonSystem) throw new Error('RP world is outside the leading system prefix');
        body.messages = body.messages.slice(0, firstNonSystem < 0 ? body.messages.length : firstNonSystem);
        body.messages.push({ role: 'user', content: 'Continue.' });
    } else {
        body.messages = structuredClone(source.messages);
        delete body.tools;
        delete body.tool_choice;
        delete body.response_format;
    }
    const limit = source.rp_memory_background === 'warm' ? 1 : 1600;
    body.max_tokens = limit;
    body.max_completion_tokens = limit;
    body.stream = false;
    body.n = 1;
    delete body.stop;
    body.chat_template_kwargs = { ...body.chat_template_kwargs, enable_thinking: false };
}
