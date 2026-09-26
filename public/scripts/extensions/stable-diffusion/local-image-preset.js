/**
 * Configure the locally installed image service once, preserving later user choices.
 * @param {object} settings Image generation settings.
 * @returns {boolean} Whether the installation preset was applied.
 */
export function applyLocalImagePreset(settings) {
    if (settings.local_image_preset_version >= 6) return false;
    if (settings.local_image_preset_version === 5) {
        if (settings.source === 'comfy' && settings.comfy_workflow === 'Local_Juggernaut_XL_Quality.json') settings.denoising_strength = 1.0;
        settings.local_image_preset_version = 6;
        return true;
    }
    Object.assign(settings, {
        source: 'comfy',
        comfy_type: 'standard',
        comfy_url: 'http://127.0.0.1:8188',
        comfy_workflow: 'Local_Juggernaut_XL_Quality.json',
        model: 'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',
        sampler: 'dpmpp_2m',
        scheduler: 'karras',
        width: 1152,
        height: 648,
        dimension_step: 8,
        steps: 24,
        scale: 5,
        clip_skip: 1,
        denoising_strength: 1.0,
        prompt_prefix: '',
        negative_prompt: '',
        local_image_preset_version: 6,
    });
    return true;
}
