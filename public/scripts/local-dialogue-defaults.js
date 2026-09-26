/** Upgrade existing custom connections once; later explicit OFF choices remain OFF. */
export function migrateLocalDialogueDefaults(settings) {
    if (settings.chat_completion_source !== 'custom' || settings.rp_dialogue_defaults_version >= 1) return;
    settings.stream_openai = true;
    settings.lmstudio_skip_reasoning ??= true;
    settings.rp_dialogue_defaults_version = 1;
}

/** Request-local Qwen prefill; never changes model load settings or source messages. */
export function prepareLocalDialogueParams(params, settings) {
    let local = Boolean(settings.lmstudio_match_context);
    try {
        const url = new URL(settings.custom_url);
        local ||= ['127.0.0.1', 'localhost', '[::1]'].includes(url.hostname);
    } catch { /* Invalid URLs are handled by the existing request path. */ }
    if (!local || settings.lmstudio_skip_reasoning === false || !/qwen3/i.test(String(params.model))
        || !Array.isArray(params.messages) || settings.json_schema) return params;
    const result = structuredClone(params);
    const tail = result.messages.at(-1);
    const prefix = '<think>\n\n</think>\n\n';
    // Preserve an existing assistant continuation (including RP continue/swipe prefixes).
    if (tail?.role === 'assistant' && !tail.tool_calls?.length) {
        if (typeof tail.content !== 'string' || /<think>|<\/think>/.test(tail.content)) return params;
        tail.content = prefix + tail.content;
    } else {
        result.messages.push({ role: 'assistant', content: prefix });
    }
    return result;
}
