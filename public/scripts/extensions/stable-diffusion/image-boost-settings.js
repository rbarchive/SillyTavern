export function imageBoostEnabled(settings) {
    return settings.comfy_boost !== false;
}

/** The saved preference and actual process mode are displayed separately. */
export function mountImageBoostSettings({ container, settings, save, request, schedule = setTimeout }) {
    const doc = container.ownerDocument;
    if (typeof settings.comfy_boost !== 'boolean') { settings.comfy_boost = true; save(); }
    const button = doc.createElement('button');
    button.type = 'button'; button.id = 'sd_comfy_boost'; button.className = 'menu_button';
    const status = doc.createElement('small'); status.id = 'sd_comfy_boost_status'; status.setAttribute('aria-live', 'polite');
    const hint = doc.createElement('small'); hint.textContent = '기본 켜짐. 이미지 품질 설정을 유지하면서 생성 속도를 높입니다. 전환은 생성 완료 후 적용됩니다.';
    container.append(button, hint, status);
    let busy = false;
    let refreshing = false;
    let revision = 0;
    const render = () => {
        const enabled = imageBoostEnabled(settings);
        button.textContent = `부스트 모드: ${enabled ? '켜짐' : '꺼짐'}`;
        button.setAttribute('aria-pressed', String(enabled)); button.disabled = busy;
    };
    const show = result => {
        if (!result.supported) { status.textContent = result.reason || '현재 연결에서는 부스트 모드를 지원하지 않습니다.'; return; }
        if (result.error) { status.textContent = `적용 실패: ${result.error}`; return; }
        if (result.active || result.pending) { status.textContent = '생성 또는 모드 적용 중입니다. 완료 후 다시 확인합니다.'; return; }
        if (!result.ready) { status.textContent = '다음 이미지 생성부터 적용됩니다.'; return; }
        status.textContent = result.applied === imageBoostEnabled(settings) ? '설정이 적용되었습니다.' : '다음 이미지 생성부터 선택한 모드가 적용됩니다.';
    };
    const refresh = async () => {
        if (busy || refreshing) return;
        refreshing = true;
        const token = ++revision;
        try { const result = await request('/api/sd/comfy/boost/status', { url: settings.comfy_url }); if (token === revision) show(result); }
        catch (error) { if (token === revision) status.textContent = `상태 확인 실패: ${error.message}`; }
        finally { refreshing = false; }
    };
    button.addEventListener('click', async () => {
        if (busy) return;
        settings.comfy_boost = !imageBoostEnabled(settings); save();
        const token = ++revision;
        busy = true; render(); status.textContent = '적용 중입니다. 생성 중인 이미지는 먼저 완료합니다.';
        try {
            const result = await request('/api/sd/comfy/boost/apply', { url: settings.comfy_url, boost: settings.comfy_boost });
            if (token === revision) show(result);
        } catch (error) { if (token === revision) status.textContent = `적용되지 않았습니다: ${error.message}`; }
        finally { busy = false; render(); }
    });
    doc.getElementById('sd_comfy_url')?.addEventListener('change', refresh);
    const tick = async () => {
        if (!container.isConnected) return;
        if (container.getClientRects().length) await refresh();
        schedule(tick, 5000);
    };
    render(); void refresh(); schedule(tick, 5000);
    return { refresh };
}
