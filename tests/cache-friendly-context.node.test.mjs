import assert from 'node:assert/strict';
import test from 'node:test';
import { orderRoleMetadata } from '../src/endpoints/backends/cache-friendly-context.js';
import { runContextMemoryTurn } from '../src/endpoints/backends/context-memory-runner.js';
import { nativeSession } from '../src/endpoints/backends/context-memory.js';

test('only role index data moves; instructions, raw chronology and input remain intact', () => {
    const line = '최근 사용자 발화 역할(메시지 번호: 역할): 1:director, 3:protagonist';
    const original = [
        { role: 'system', content: '세계관' },
        { role: 'system', content: `저장 상태\n연출 규칙\n주인공 ID: A\n${line}`, name: 'memory' },
        { role: 'system', content: '사건 기억' },
        { role: 'user', content: '옛 질문' }, { role: 'assistant', content: '옛 답변' },
        { role: 'user', content: '최종 상태\n현재 입력' }, { role: 'assistant', content: '</think>\n\n' },
    ];
    const frozen = structuredClone(original);
    const next = orderRoleMetadata(original);
    assert.deepEqual(original, frozen);
    assert.deepEqual(next.map(row => row.role), original.map(row => row.role));
    assert.deepEqual(next[1], { ...original[1], content: original[1].content.slice(0, -(line.length + 1)) });
    assert.deepEqual(next.slice(2, 5), original.slice(2, 5));
    assert.deepEqual(next[5], { ...original[5], content: line + '\n\n' + original[5].content });
    assert.deepEqual(next.slice(0, 1), original.slice(0, 1));
    assert.deepEqual(next.slice(6), original.slice(6));
    assert.equal(next[1].content + '\n' + line, original[1].content);
    assert.deepEqual(orderRoleMetadata(next), next);
});

test('no matching metadata, duplicate metadata and user quotations remain unchanged', () => {
    const meta = '최근 사용자 발화 역할(메시지 번호: 역할): 없음';
    for (const input of [
        [{ role: 'system', content: '규칙' }, { role: 'user', content: meta }],
        [{ role: 'system', content: `규칙\n${meta}` }],
        [{ role: 'system', content: `규칙\n${meta}` }, { role: 'user', content: [{ type: 'text', text: '질문' }] }],
        [{ role: 'system', content: `\n${meta}` }, { role: 'user', content: '질문' }],
        [{ role: 'system', content: `규칙\n${meta}` }, { role: 'system', content: `다른 규칙\n${meta}` }, { role: 'user', content: '질문' }],
    ]) assert.strictEqual(orderRoleMetadata(input), input);
});

test('actual context runner sends the reordered data once without changing archived source', async () => {
    const line = '최근 사용자 발화 역할(메시지 번호: 역할): 1:director';
    const stored = [{ chat_metadata: {} }, { is_user: true, mes: '새 장면으로 진행', extra: { rp_memory: { role: 'director' } } }];
    const original = structuredClone(stored);
    let calls = 0;
    await runContextMemoryTurn({
        request: { messages: [{ role: 'system', content: `세계 규칙\n연출 지침\n${line}` }, { role: 'user', content: stored[1].mes }] },
        session: nativeSession(stored), scope: { world: 'synthetic', story: 'order', branch: 'main' }, fixedContext: '세계 규칙', rawBudget: 4096,
        countMessages: async rows => rows.length * 10,
        generate: async request => {
            calls++;
            assert.ok(request.messages[0].content.includes('연출 지침'));
            assert.ok(!request.messages[0].content.includes(line));
            assert.ok(request.messages.at(-1).content.startsWith(line + '\n\n'));
            assert.ok(request.messages.at(-1).content.endsWith(original[1].mes));
            assert.equal(request.messages.filter(row => row.content.includes(line)).length, 1);
            assert.equal(request.max_tokens, 8192);
            return { text: '장면 진행' };
        },
        saveDialogue: async reply => stored.push({ is_user: false, mes: reply.text }),
        readSession: () => nativeSession(stored), update: () => {},
    });
    assert.equal(calls, 1);
    assert.deepEqual(stored.slice(0, 2), original);
});
