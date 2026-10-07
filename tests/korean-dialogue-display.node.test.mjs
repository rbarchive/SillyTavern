import test from 'node:test';
import assert from 'node:assert/strict';
import { correctKoreanDialogueDisplay as correct } from '../public/scripts/korean-dialogue-display.js';

test('confirmed expression preserves the scene and only corrects display', () => {
    const source = '등대 입구에 도착하자, 민아가 이미在那里 있었다.';
    assert.equal(correct(source), '등대 입구에 도착하자, 민아가 이미 그곳에 있었다.');
    assert.equal(source, '등대 입구에 도착하자, 민아가 이미在那里 있었다.');
    assert.equal(correct(correct(source)), correct(source));
});

test('every streaming chunk boundary hides the observed expression, without delaying Korean', () => {
    const source = '민아가 이미在那里 있었다.';
    for (let end = 1; end <= source.length; end++) {
        const output = correct(source.slice(0, end), { streaming: true });
        assert.doesNotMatch(output, /[在那里]/u);
        if (end <= '민아가 이미'.length) assert.equal(output, source.slice(0, end));
    }
    assert.equal(correct(source, { streaming: true }), correct(source));
});

test('does not alter user/system/reasoning, unknown text, names or incomplete final output', () => {
    const mixed = '민아가 이미在那里 있었다.';
    for (const scope of [{ isUser: true }, { isSystem: true }, { isReasoning: true }]) assert.equal(correct(mixed, scope), mixed);
    for (const text of ['한국어만 있는 대사.', '金民秀를 만났다.', '민아가 이미在那里 있었다. 未知', '민아가 이미在', '민아가 이미在那', '在那里라는 고유명사', '在日이라는 이름']) {
        if (text.includes('이미在那里')) assert.ok(correct(text).endsWith('未知'));
        else assert.equal(correct(text), text);
    }
});
