import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

test('text-only quiet generation retains its request-local media option through group dispatch', async () => {
    const source = fs.readFileSync(new URL('../public/script.js', import.meta.url), 'utf8');
    const extract = name => source.match(new RegExp(`export async function ${name}\\([\\s\\S]*?^\\}`, 'm'))[0].replace('export ', '');
    const dispatched = [];
    const context = vm.createContext({
        console: { log() {} }, AbortController, Date,
        setGenerationProgress() {}, unshallowCharacter: async () => {}, this_chid: 0,
        eventSource: { emit: async () => {} }, event_types: {}, abortController: null,
        power_user: { instruct: { enabled: false } }, main_api: 'openai',
        isHordeGenerationNotAllowed: () => false, pingServer: async () => true,
        hideSwipeButtons() {}, chat_metadata: {}, selected_group: 'synthetic', is_group_generating: false,
        generateGroupWrapper: async (_auto, _type, params) => { dispatched.push(params); return { request: {} }; },
        TempResponseLength: { isCustomized: () => false },
    });
    vm.runInContext(`${extract('Generate')}\n${extract('generateQuietPrompt')}`, context);
    await context.generateQuietPrompt({ quietPrompt: 'Keep the current scene', prepareRequest: true, omitMedia: true });
    await context.generateQuietPrompt({ quietPrompt: 'Ordinary request', prepareRequest: true });
    assert.equal(dispatched[0].omitMedia, true);
    assert.equal(dispatched[0].quiet_prompt, 'Keep the current scene');
    assert.equal(dispatched[1].omitMedia, false);
});
