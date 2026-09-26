/** Compatible workflows and generation defaults for the installed local models. */
const localImageModels = {
    'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors': {
        comfy_workflow: 'Local_Juggernaut_XL_Quality.json', steps: 35, scale: 5,
        sampler: 'dpmpp_2m', scheduler: 'karras',
    },
    'z_image_bf16.safetensors': {
        comfy_workflow: 'Local_ZImage_Base.json', steps: 40, scale: 4,
        sampler: 'res_multistep', scheduler: 'simple',
    },
    'sd_xl_turbo_1.0_fp16.safetensors': {
        comfy_workflow: 'Local_SDXL_Turbo_Selectable.json', steps: 4, scale: 1,
        sampler: 'euler_ancestral', scheduler: 'sgm_uniform',
    },
};

/** Apply compatibility settings on an explicit local ComfyUI model selection. */
export function applyLocalImageModel(settings) {
    const preset = settings.source === 'comfy' && localImageModels[settings.model];
    if (!preset) return false;
    Object.assign(settings, preset);
    return true;
}
