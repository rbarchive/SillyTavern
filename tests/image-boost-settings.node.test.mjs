import test from 'node:test';
import assert from 'node:assert/strict';
import { mountImageBoostSettings } from '../public/scripts/extensions/stable-diffusion/image-boost-settings.js';

function fixture(settings = {}) {
    const elements = {}; const scheduled = []; let visible = true;
    const doc = { createElement(tag) { return { tag, attributes: {}, setAttribute(name, value) { this.attributes[name] = value; },
        listeners: {}, addEventListener(name, callback) { this.listeners[name] = callback; } }; }, getElementById() { return null; } };
    const container = { ownerDocument: doc, isConnected: true, getClientRects: () => visible ? [{}] : [],
        append(...nodes) { nodes.forEach(node => { if (node.id) elements[node.id] = node; }); } };
    let response = { supported: true, ready: true, applied: true, active: true, pending: 0 };
    let calls = 0; let saves = 0;
    mountImageBoostSettings({ container, settings, save() { saves++; }, async request() { calls++; return response; }, schedule(fn) { scheduled.push(fn); } });
    return { elements, container, scheduled, settings, set(value) { response = value; }, visible(value) { visible = value; }, calls: () => calls, saves: () => saves };
}
test('default ON and persisted OFF render and save without resetting explicit preference', async () => {
    const fresh = fixture(); await Promise.resolve(); assert.equal(fresh.settings.comfy_boost, true); assert.equal(fresh.saves(), 1);
    assert.equal(fresh.elements.sd_comfy_boost.attributes['aria-pressed'], 'true');
    const off = fixture({ comfy_boost: false }); assert.equal(off.saves(), 0); assert.equal(off.elements.sd_comfy_boost.attributes['aria-pressed'], 'false');
});
test('visible active status refreshes after completion, hidden views stop requests and detached views stop timers', async () => {
    const f = fixture(); await Promise.resolve(); assert.match(f.elements.sd_comfy_boost_status.textContent, /완료 후/);
    f.set({ supported: true, ready: true, applied: true, active: false, pending: 0 });
    await f.scheduled.shift()(); assert.equal(f.elements.sd_comfy_boost_status.textContent, '설정이 적용되었습니다.');
    assert.equal(f.calls(), 2);
    f.visible(false); await f.scheduled.shift()(); assert.equal(f.calls(), 2);
    f.container.isConnected = false; await f.scheduled.shift()(); assert.equal(f.scheduled.length, 0);
});
