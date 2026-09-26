/**
 * Configure the locally installed image service once, preserving later user choices.
 * @param {object} settings Image generation settings.
 * @returns {boolean} Whether the installation preset was applied.
 */
export function applyLocalImagePreset(settings) {
    if (settings.local_image_preset_version >= 1) return false;
    Object.assign(settings, {
        source: 'comfy',
        comfy_type: 'standard',
        comfy_url: 'http://127.0.0.1:8188',
        comfy_workflow: 'Local_SDXL_Turbo_Selectable.json',
        model: 'sd_xl_turbo_1.0_fp16.safetensors',
        sampler: 'euler_ancestral',
        width: 1280,
        height: 720,
        dimension_step: 8,
        steps: 4,
        scale: 1,
        local_image_preset_version: 1,
    });
    return true;
}
