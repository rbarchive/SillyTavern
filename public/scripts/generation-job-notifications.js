const storageKey = 'generation-job-failure-notices';

/** Keep only receipt IDs; never put prompts, errors, or chat contents in storage. */
export function failureNotices(storage) {
    let receipts;
    try { receipts = JSON.parse(storage?.getItem(storageKey) || '[]'); } catch { receipts = []; }
    const ids = new Set(Array.isArray(receipts) ? receipts.filter(id => typeof id === 'string').slice(-2000) : []);
    return {
        has: id => ids.has(id),
        add(id) {
            ids.add(id);
            if (ids.size > 2000) ids.delete(ids.values().next().value);
            try { storage?.setItem(storageKey, JSON.stringify([...ids])); } catch { /* In-memory deduplication still works. */ }
        },
    };
}

export function generationFailureMessage(error) {
    const text = String(error || '생성 작업이 완료되지 않았습니다.');
    const counts = text.match(/request\s*\((\d+)\s*tokens\).*?context size\s*\((\d+)\s*tokens\)/is);
    if (counts) return `요청 ${Number(counts[1]).toLocaleString('ko-KR')}토큰이 모델의 ${Number(counts[2]).toLocaleString('ko-KR')}토큰 한도를 초과했습니다. 대화 컨텍스트와 모델 로딩 컨텍스트를 맞춘 뒤 다시 생성해 주세요. LM Studio 연결이면 “Load LM Studio model with ST Context length” 설정을 확인해 주세요.`;
    return text.length > 350 ? text.slice(0, 350) + '…' : text;
}
