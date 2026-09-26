/** Hide reasoning, including a trailing partial opening tag, from live previews. */
export function visibleGenerationText(content) {
    return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/g, '').trim();
}

/** Consume the provider stream on the server, independently of any observer. */
export async function readGenerationResponse(response, onProgress = () => {}) {
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
    const decoder = new TextDecoder();
    let finishReason;
    let pending = '', content = '', reasoning = '', model, usage, lastPreview = 0, first = true, firstVisible = true, done = false;
    const frame = value => {
        const raw = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!raw) return;
        if (raw.trim() === '[DONE]') { done = true; return; }
        const data = JSON.parse(raw);
        if (data.error) throw new Error(data.error.message || 'Chat model stream failed.');
        model = data.model || model;
        usage = data.usage || usage;
        finishReason = data.choices?.[0]?.finish_reason || finishReason;
        const delta = data.choices?.[0]?.delta;
        if (delta?.tool_calls?.length) throw new Error('Background generation does not support tool calls.');
        content += typeof delta?.content === 'string' ? delta.content : '';
        reasoning += delta?.reasoning_content || delta?.reasoning || '';
        const preview = visibleGenerationText(content).slice(-32000);
        if (firstVisible && preview) {
            onProgress({ preview, received: content.length, event: 'firstVisible' });
            firstVisible = false;
        }
        if (delta && (first || Date.now() - lastPreview >= 200)) {
            onProgress({ preview, received: content.length, ...(first ? { event: 'firstToken' } : {}) });
            first = false; lastPreview = Date.now();
        }
    };
    for await (const chunk of response.body) {
        pending += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
            frame(pending.slice(0, match.index));
            pending = pending.slice(match.index + match[0].length);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) frame(pending);
    if (!done) throw new Error('Chat model stream ended before completion.');
    onProgress({ preview: visibleGenerationText(content).slice(-32000), received: content.length });
    return { model, usage, choices: [{ finish_reason: finishReason, message: { content, reasoning_content: reasoning } }] };
}


export function extractGenerationReply(data, fallbackModel) {
    if (data.error) throw new Error(data.error.message || 'Chat model failed.');
    const reply = data.choices?.[0]?.message;
    if (!reply || reply.tool_calls?.length) throw new Error('The chat model returned no usable reply.');
    let text = typeof reply.content === 'string' ? reply.content : '';
    let reasoning = reply.reasoning_content || reply.reasoning || '';
    text = text.replace(/<think>([\s\S]*?)(?:<\/think>|$)/g, (_, thought) => { reasoning += thought; return ''; });
    text = visibleGenerationText(text);
    if (!text) throw new Error('The chat model returned an empty reply.');
    return { text, reasoning, model: data.model || fallbackModel };
}
