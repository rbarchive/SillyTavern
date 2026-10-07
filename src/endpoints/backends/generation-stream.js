/** Hide reasoning, including a trailing partial opening tag, from live previews. */
export function visibleGenerationText(content) {
    return content.replace(/<think>[\s\S]*?(?:<\/think>|$)/g, '').replace(/<(?:t(?:h(?:i(?:n(?:k)?)?)?)?)?$/g, '').trim();
}

/** Consume the provider stream on the server, independently of any observer. */
export async function readGenerationResponse(response, onProgress = () => {}, { visibleText = visibleGenerationText, onContent = () => {}, requestedAt, now = Date.now, allowToolCalls = false } = {}) {
    const metrics = { responseReceivedAt: now() };
    if (Number.isFinite(requestedAt)) metrics.requestedAt = requestedAt;
    if (!response.headers.get('content-type')?.includes('text/event-stream')) return response.json();
    const decoder = new TextDecoder();
    let finishReason;
    const toolCalls = new Map();
    let pending = '', content = '', reasoning = '', model, usage, lastPreview = 0, lastVisiblePreview = '', first = true, firstVisible = true, done = false;
    onProgress({ event: 'streamMetrics', streamMetrics: { ...metrics }, preview: '' });
    const frame = async (value, receivedAt) => {
        const raw = value.split(/\r?\n/).filter(line => line.startsWith('data:')).map(line => line.slice(5).trimStart()).join('\n');
        if (!raw) return;
        if (raw.trim() === '[DONE]') { done = true; return; }
        const data = JSON.parse(raw);
        if (data.error) throw new Error(data.error.message || 'Chat model stream failed.');
        model = data.model || model;
        usage = data.usage || usage;
        finishReason = data.choices?.[0]?.finish_reason || finishReason;
        const delta = data.choices?.[0]?.delta;
        if (delta?.tool_calls?.length) {
            if (!allowToolCalls) throw new Error('Background generation does not support tool calls.');
            for (const part of delta.tool_calls) {
                if (!Number.isSafeInteger(part.index) || part.index < 0 || part.index >= 8) throw new Error('Invalid tool stream index.');
                const call = toolCalls.get(part.index) || { id: '', type: 'function', function: { name: '', arguments: '' } };
                if (part.id && part.id !== call.id) call.id += part.id;
                call.type = part.type || call.type;
                if (part.function?.name && part.function.name !== call.function.name) call.function.name += part.function.name;
                call.function.arguments += part.function?.arguments || '';
                if (call.function.arguments.length > 32000 || call.id.length > 200 || call.function.name.length > 200) throw new Error('Tool stream is too large.');
                toolCalls.set(part.index, call);
            }
        }
        // Receipt times precede callbacks: persisting dialogue must not inflate TTFT.
        for (const [key, event, present] of [
            ['firstContentAt', 'firstContent', typeof delta?.content === 'string' && delta.content.length > 0],
            ['firstReasoningAt', 'firstReasoning', Boolean(delta?.reasoning_content || delta?.reasoning)],
        ]) {
            if (present && metrics[key] === undefined) {
                metrics[key] = receivedAt;
                onProgress({ event, receivedAt, streamMetrics: { ...metrics }, preview: lastVisiblePreview });
            }
        }
        content += typeof delta?.content === 'string' ? delta.content : '';
        reasoning += delta?.reasoning_content || delta?.reasoning || '';
        const preview = visibleText(content).slice(-32000);
        if (preview && metrics.serverFirstVisibleAt === undefined) {
            metrics.serverFirstVisibleAt = receivedAt;
            onProgress({ event: 'serverFirstVisible', receivedAt, streamMetrics: { ...metrics }, preview });
        }
        await onContent(content);
        if (preview !== lastVisiblePreview && preview) {
            onProgress({ preview, lastVisibleAt: Date.now() });
            lastVisiblePreview = preview;
        }
        if (firstVisible && preview) {
            onProgress({ preview, received: content.length, event: 'firstVisible' });
            firstVisible = false;
        }
        if (delta && (first || Date.now() - lastPreview >= 200)) {
            onProgress({ preview, received: content.length, ...(first ? { event: 'firstToken' } : {}) });
            first = false; lastPreview = Date.now();
        }
    };
    let lastChunkAt;
    for await (const chunk of response.body) {
        // All frames completed by this chunk share its application receipt time.
        // Awaiting one frame's persistence callback cannot shift a later frame in it.
        lastChunkAt = now();
        pending += decoder.decode(chunk, { stream: true });
        let match;
        while ((match = /\r?\n\r?\n/.exec(pending))) {
            await frame(pending.slice(0, match.index), lastChunkAt);
            pending = pending.slice(match.index + match[0].length);
        }
    }
    pending += decoder.decode();
    if (pending.trim()) await frame(pending, lastChunkAt ?? now());
    if (!done) throw new Error('Chat model stream ended before completion.');
    metrics.completedAt = now();
    onProgress({ event: 'streamMetrics', streamMetrics: metrics, preview: visibleText(content).slice(-32000) });
    onProgress({ preview: visibleText(content).slice(-32000), received: content.length });
    return { model, usage, streamMetrics: metrics, choices: [{ finish_reason: finishReason, message: { content, reasoning_content: reasoning, ...(toolCalls.size ? { tool_calls: [...toolCalls.values()] } : {}) } }] };
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
