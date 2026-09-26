const DESCRIPTION_DEFAULTS = Object.freeze({
    mode: 'main',
    url: 'http://127.0.0.1:9998/v1',
    model: 'gemma-4-e4b-uncensored-hauhaucs-aggressive',
    context_length: 8192,
    max_tokens: 512,
});

export function defaultImageDescriptionSettings() {
    return { ...DESCRIPTION_DEFAULTS };
}

function clone(value) {
    return typeof structuredClone === 'function' ? structuredClone(value) : JSON.parse(JSON.stringify(value));
}

function assertValidUrl(value) {
    if (typeof value !== 'string' || !value.trim()) throw new Error('이미지 묘사 URL을 입력하세요.');
    let parsed;
    try { parsed = new URL(value.trim()); } catch { throw new Error('이미지 묘사 URL 형식이 올바르지 않습니다.'); }
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash || !/^\/v1\/?$/.test(parsed.pathname)) {
        throw new Error('URL은 인증·쿼리 없이 http(s)://호스트/v1 형식이어야 합니다.');
    }
    return value.trim().replace(/\/$/, '');
}

function validatedConfig(value) {
    if (!value || value.mode !== 'dedicated') throw new Error('전용 이미지 묘사 모드를 선택하세요.');
    const url = assertValidUrl(value.url);
    if (typeof value.model !== 'string' || !value.model.trim()) throw new Error('이미지 묘사 모델을 입력하세요.');
    if (!Number.isInteger(value.context_length) || value.context_length < 1024 || value.context_length > 131072) throw new Error('컨텍스트 길이는 1024~131072 사이의 정수여야 합니다.');
    if (!Number.isInteger(value.max_tokens) || value.max_tokens < 128 || value.max_tokens > 1024) throw new Error('최대 출력 토큰은 128~1024 사이의 정수여야 합니다.');
    return { mode: 'dedicated', url, model: value.model.trim(), context_length: value.context_length, max_tokens: value.max_tokens };
}

export function imageDescriptionSnapshot(sd) {
    const config = sd?.image_description;
    if (!config || config.mode === 'main') return null;
    return clone(validatedConfig(config));
}

function field(doc, label, input) {
    const wrapper = doc.createElement('label');
    wrapper.className = 'image-description-field';
    const text = doc.createElement('span');
    text.textContent = label;
    wrapper.append(text, input);
    return wrapper;
}

export function mountImageDescriptionSettings({ container, settings, save, request }) {
    if (!container || !settings) throw new Error('이미지 묘사 설정을 표시할 대상이 없습니다.');
    const doc = container.ownerDocument || document;
    const hadConfig = settings.image_description && typeof settings.image_description === 'object';
    if (!hadConfig) {
        settings.image_description = defaultImageDescriptionSettings();
        save();
    }
    const current = { ...defaultImageDescriptionSettings(), ...settings.image_description };
    const root = doc.createElement('fieldset');
    root.className = 'image-description-settings';
    const legend = doc.createElement('legend');
    legend.textContent = '텍스트 기반 이미지 묘사에 사용';
    root.append(legend);

    const mode = doc.createElement('select');
    mode.id = 'sd_description_mode'; mode.className = 'text_pole';
    [['main', '현재 대화 모델'], ['dedicated', '전용 LM Studio 모델']].forEach(([value, label]) => {
        const option = doc.createElement('option'); option.value = value; option.textContent = label; mode.append(option);
    });
    mode.value = current.mode === 'dedicated' ? 'dedicated' : 'main';
    root.append(field(doc, '이미지 묘사 모델', mode));

    const model = doc.createElement('select'); model.id = 'sd_description_model'; model.className = 'text_pole';
    const initialModel = doc.createElement('option'); initialModel.value = current.model || DESCRIPTION_DEFAULTS.model; initialModel.textContent = current.model || DESCRIPTION_DEFAULTS.model; model.append(initialModel);
    // A select gives catalog entries while retaining a manually configured model when absent.
    const modelSelect = model;
    modelSelect.value = current.model || DESCRIPTION_DEFAULTS.model;
    root.append(field(doc, '전용 모델', modelSelect));

    const advanced = doc.createElement('details'); advanced.open = false;
    const summary = doc.createElement('summary'); summary.textContent = '고급 연결 설정'; advanced.append(summary);
    const url = doc.createElement('input'); url.type = 'url'; url.id = 'sd_description_url'; url.className = 'text_pole'; url.value = current.url;
    const context = doc.createElement('input'); context.type = 'number'; context.id = 'sd_description_context'; context.className = 'text_pole'; context.value = String(current.context_length);
    const output = doc.createElement('input'); output.type = 'number'; output.id = 'sd_description_output'; output.className = 'text_pole'; output.value = String(current.max_tokens);
    advanced.append(field(doc, 'LM Studio URL', url), field(doc, '컨텍스트 길이', context), field(doc, '최대 출력 토큰', output)); root.append(advanced);

    const actions = doc.createElement('div'); actions.className = 'image-description-actions';
    const refresh = doc.createElement('button'); refresh.type = 'button'; refresh.id = 'sd_description_refresh'; refresh.className = 'menu_button'; refresh.textContent = '모델 새로고침';
    const test = doc.createElement('button'); test.type = 'button'; test.id = 'sd_description_test'; test.className = 'menu_button'; test.textContent = '연결 및 추론 테스트';
    actions.append(refresh, test); root.append(actions);
    const status = doc.createElement('div'); status.id = 'sd_description_status'; status.setAttribute('aria-live', 'polite'); root.append(status);
    container.append(root);

    let revision = 0;
    let busy = false;
    const readConfig = () => ({ mode: mode.value, url: url.value, model: modelSelect.value, context_length: Number(context.value), max_tokens: Number(output.value) });
    const persist = () => { settings.image_description = readConfig(); save(); revision += 1; status.textContent = '설정이 변경되었습니다.'; };
    [mode, modelSelect, url, context, output].forEach(element => element.addEventListener('change', persist));
    const dedicatedPayload = () => validatedConfig({ ...readConfig(), mode: 'dedicated' });
    const setBusy = value => { busy = value; refresh.disabled = value; test.disabled = value || mode.value === 'main'; };

    refresh.addEventListener('click', async () => {
        if (busy) return;
        const token = ++revision;
        let config;
        try { config = dedicatedPayload(); } catch (error) { status.textContent = error.message; return; }
        setBusy(true); status.textContent = '모델 목록을 불러오는 중입니다.';
        try {
            const result = await request('/api/image-description/models', { settings: config });
            if (token !== revision) return;
            const models = Array.isArray(result?.models) ? result.models : [];
            const selected = modelSelect.value;
            modelSelect.replaceChildren();
            models.forEach(item => { const option = doc.createElement('option'); option.value = item.key; option.textContent = item.display_name || item.key; modelSelect.append(option); });
            if (selected && !models.some(item => item.key === selected)) { const option = doc.createElement('option'); option.value = selected; option.textContent = selected; modelSelect.append(option); }
            modelSelect.value = selected;
            status.textContent = `${models.length}개 모델을 확인했습니다.`;
        } catch (error) { if (token === revision) status.textContent = `모델 목록을 불러오지 못했습니다: ${error.message}`; }
        finally { setBusy(false); }
    });

    test.addEventListener('click', async () => {
        if (busy || mode.value !== 'dedicated') { if (mode.value !== 'dedicated') status.textContent = '전용 LM Studio 모드에서만 테스트할 수 있습니다.'; return; }
        const token = ++revision;
        let config;
        try { config = imageDescriptionSnapshot({ image_description: readConfig() }); } catch (error) { status.textContent = error.message; return; }
        setBusy(true); status.textContent = '연결 및 실제 추론을 테스트하는 중입니다.';
        try {
            const result = await request('/api/image-description/test', { settings: config });
            if (token !== revision) return;
            status.textContent = `연결됨 · ${Number(result?.totalMs) || 0}ms${result?.text ? ` · ${result.text}` : ''}`;
        } catch (error) { if (token === revision) status.textContent = `테스트에 실패했습니다: ${error.message}`; }
        finally { setBusy(false); }
    });

    const updateVisibility = () => { modelSelect.disabled = mode.value === 'main'; advanced.hidden = mode.value === 'main'; test.disabled = mode.value === 'main'; };
    mode.addEventListener('change', updateVisibility); updateVisibility();
    return { root, getSnapshot: () => imageDescriptionSnapshot(settings), destroy: () => root.remove() };
}

export default { defaultImageDescriptionSettings, imageDescriptionSnapshot, mountImageDescriptionSettings };
