import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import express from 'express';
import { router } from '../src/endpoints/image-description.js';

const root = new URL('../', import.meta.url);
const listen = app => new Promise((resolve, reject) => {
    const server = app.listen(0, '127.0.0.1', () => resolve(server)); server.on('error', reject);
});
const close = server => new Promise(resolve => server.close(resolve));

test('mobile description UI applies context through HTTP and retains the main model', async t => {
    const provider = express(); provider.use(express.json());
    const state = new Map([['main', 208384], ['gemma', 8192]]);
    const mutations = []; let rejectLoad = false;
    provider.get('/api/v1/models', (req, res) => res.json({ models: ['main', 'gemma'].map(key => ({
        key, display_name: key, type: 'llm', max_context_length: 262144,
        loaded_instances: state.has(key) ? [{ id: key, config: { context_length: state.get(key) } }] : [],
    })) }));
    provider.post('/api/v1/models/unload', (req, res) => {
        mutations.push({ action: 'unload', ...req.body }); state.delete(req.body.instance_id); res.json({});
    });
    provider.post('/api/v1/models/load', (req, res) => {
        mutations.push({ action: 'load', ...req.body });
        if (rejectLoad) { rejectLoad = false; res.status(500).json({ error: { message: 'synthetic load failure' } }); return; }
        state.set(req.body.model, req.body.context_length);
        res.json({ status: 'loaded', load_config: { context_length: req.body.context_length } });
    });
    const modelServer = await listen(provider);
    let uiServer, browser;
    try {
        const url = `http://127.0.0.1:${modelServer.address().port}/v1`;
        const app = express(); app.use(express.json()); app.use('/api/image-description', router);
        app.get('/module.js', (req, res) => res.type('js').send(fs.readFileSync(new URL('public/scripts/extensions/stable-diffusion/image-description-settings.js', root), 'utf8')));
        app.get('/style.css', (req, res) => res.type('css').send(fs.readFileSync(new URL('public/scripts/extensions/stable-diffusion/style.css', root), 'utf8')));
        app.get('/', (req, res) => res.type('html').send(`<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
            <link rel="stylesheet" href="/style.css"><style>body{font:16px sans-serif;background:#202028;color:#eee;margin:10px}.text_pole{padding:6px;background:#30303a;color:#eee}.menu_button{background:#30303a;color:#eee;border:1px solid #888}small{display:block}fieldset{border-color:#888!important}</style><div id="settings"></div>
            <script type="module">
            import { mountImageDescriptionSettings } from '/module.js';
            window.settings={image_description:{mode:'dedicated',url:${JSON.stringify(url)},model:'gemma',context_length:8192,max_tokens:512}};
            window.saves=0;window.requests=[];
            mountImageDescriptionSettings({container:document.querySelector('#settings'),settings:window.settings,save:()=>window.saves++,request:async(path,payload)=>{
                window.requests.push({path,payload});
                const response=await fetch(path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(payload)});
                const data=await response.json();if(!response.ok)throw Error(data.error);return data;
            }});window.ready=true;
            </script>`));
        uiServer = await listen(app);
        if (process.env.DESCRIPTION_UI_MANUAL === '1') {
            console.log(`Synthetic description UI: http://127.0.0.1:${uiServer.address().port}`);
            await new Promise(resolve => { process.once('SIGTERM', resolve); process.once('SIGINT', resolve); });
            t.skip('Manual browser harness; verification is recorded separately.');
            return;
        }
        const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
        browser = await chromium.launch({ headless: true, ...(process.env.PLAYWRIGHT_CHANNEL ? { channel: process.env.PLAYWRIGHT_CHANNEL } : {}) });
        const page = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
        const errors = []; page.on('pageerror', error => errors.push(error.message));
        await page.goto(`http://127.0.0.1:${uiServer.address().port}`); await page.waitForFunction(() => window.ready);
        assert.equal(await page.locator('details').getAttribute('open'), null);
        assert.equal(await page.locator('#sd_description_context').isVisible(), true);
        assert.equal(await page.locator('#sd_description_context').inputValue(), '8192'); // Existing settings survive.
        await page.locator('#sd_description_context').fill('32768');
        await page.locator('#sd_description_load').click();
        await page.waitForFunction(() => document.querySelector('#sd_description_status').textContent.includes('로드 완료'));
        assert.match(await page.locator('#sd_description_status').textContent(), /32,768토큰/);
        assert.equal(await page.evaluate(() => window.settings.image_description.context_length), 32768);
        assert.equal(state.get('gemma'), 32768); assert.equal(state.get('main'), 208384);
        assert.deepEqual(mutations.map(m => [m.action, m.instance_id || m.model]), [['unload', 'gemma'], ['load', 'gemma']]);
        const count = mutations.length;
        await page.locator('#sd_description_load').click();
        await page.waitForFunction(() => !document.querySelector('#sd_description_load').disabled);
        assert.equal(mutations.length, count); // Ready models are reused.
        await page.locator('#sd_description_context').fill('100'); await page.locator('#sd_description_load').click();
        assert.match(await page.locator('#sd_description_status').textContent(), /1024/); assert.equal(mutations.length, count);
        rejectLoad = true;
        await page.locator('#sd_description_context').fill('65536'); await page.locator('#sd_description_load').click();
        await page.waitForFunction(() => document.querySelector('#sd_description_status').textContent.includes('로드하지 못했습니다'));
        assert.equal(state.get('gemma'), 32768); assert.equal(state.get('main'), 208384);
        assert.equal(await page.locator('#sd_description_load').isEnabled(), true);
        await page.locator('#sd_description_context').fill('32768'); await page.locator('#sd_description_load').click();
        await page.waitForFunction(() => document.querySelector('#sd_description_status').textContent.includes('로드 완료'));
        if (process.env.DESCRIPTION_UI_SCREENSHOT) await page.screenshot({ path: process.env.DESCRIPTION_UI_SCREENSHOT, fullPage: true });
        assert.equal(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
        await page.locator('#sd_description_mode').selectOption('main');
        assert.equal(await page.locator('#sd_description_context').isVisible(), false);
        assert.equal(await page.locator('#sd_description_load').isEnabled(), false);
        assert.deepEqual(errors, []);
    } finally {
        await browser?.close(); if (uiServer) await close(uiServer); await close(modelServer);
    }
});
