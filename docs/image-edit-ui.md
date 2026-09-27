# Generated image corrections and chat media responsiveness

Accepted scope: add a natural-language correction to a selected generated image, use that image's pixels, preserve the original and append/select a new result; improve touch responsiveness and investigate chat image freezes. The earlier counterpart-description change (last dialogue summarized as a visual scene) remains in place.

Each generated image has an **이미지에 추가 요청** action beside its enlarge/caption/delete controls. The dialog shows the clicked source and a correction field. Change strength defaults to 0.55, range 0.1–0.85. Higher values can change more of the image. The action uses standard local ComfyUI with Juggernaut XL or SDXL Turbo; other models/providers fail explicitly. This is ordinary img2img, not masked regional editing or a dedicated instruction-edit model.

The selected attachment URL, current chat origin and generation settings are captured before awaiting input. A scene-aware revised description goes through the configured description-model path. The reference URL is explicitly selected, not inferred from historical anchors. Workflow/model/strength/dimensions remain request-local; originals and global settings are unchanged. Target deletion/change, chat change, cancellation and failure prevent attachment of a result. The result records source URL, correction and strength in `image_edit`.

The bundled reference graph has an inline base64 image node. The server uploads those explicitly supplied bytes to the actual selected Comfy process and replaces that node with the core `LoadImage` equivalent before submission. Managed and direct paths both do this. No custom-node installation is required. Uploads use content-derived names without overwriting existing input artifacts; Comfy input files are retained. Ordinary workflows make no additional upload. Cancellation in the direct path deletes only its own queued job and never interrupts another running request.

Chat media now inserts synchronously rather than waiting for image load/decode; images request asynchronous decoding and lazy loading. Navigation renders before immediate persistence; further navigation remains available during saving and late loads cannot replace a newer selection. At the bottom, delayed loads keep the bottom in view; reading or manual scrolling is respected with per-render guards. Coarse-pointer controls remain visible and have 44px targets. Stale enlargement indices are guarded, and image descriptions skip syntax highlighting. Image-button abort controllers are released after each attempt; the wand dropdown uses a single click event rather than toggling twice for touchend/click. Full base64 workflows are no longer logged in the browser.

## Verification matrix

| Requirement | Implementation | Observable completion check |
| --- | --- | --- |
| Correct selected image | image-edit.js, editGeneratedImage, applyReferenceImage | middle/list-view clicked URL supplies sampler pixels |
| Scene correction | editGeneratedImage, generatePrompt | correction, captured scene and quoted source description in model request |
| Pixel edit, no redraw fallback | prepareComfyWorkflow, assertImageEditGraph, comfy-inline-images.js | VAEEncode path, selected bytes, denoise <1; invalid graph/model rejected |
| Original preserved | editGeneratedImage | unchanged existing attachments/settings; one appended selected result |
| Cancel/retry/state safety | editGeneratedImage, sdMessageButton | no result on cancel/failure/chat switch/deletion; retry and duplicate rejection |
| Touch responsiveness | appendMediaToMessage, onImageSwiped, style.css | visible 44px controls; immediate selection before save; no stale late render |
| Native service compatibility | stable-diffusion.js, comfy-inline-images.js | managed and direct HTTP multipart uploads reach the same process as prompt |

Reproducible tests: `tests/image-edit.node.test.mjs`, `tests/comfy-inline-images.node.test.mjs`, `tests/comfy-inline-images-http.node.test.mjs`, `tests/image-ui.browser.test.mjs` plus existing continuity, reference-workflow, image-description, local-model/preset and local-runtime suites. Browser tests use the actual media/popup/edit handlers with synthetic description/generation services; they do not represent a full installed ST session. See the workspace integration verification artifact for executed commands, timing and actual-model results.

Installed sandbox verification also found attached image base64 entering text-description prompts. Text-description requests now use request-local `omitMedia` through quiet generation and group dispatch; ordinary dialogue retains media. `tests/image-description-media.node.test.mjs` covers group option forwarding. A real installed mobile session with the dedicated description model and local Comfy completed an edit, preserved originals and retained the selected result after reload. Expression fidelity remains limited by ordinary img2img.


User feedback follow-up: inline image actions are hidden; selecting the image opens the existing enlarged view with its actions. The selected view closes before forwarding one click to the original chat attachment, with chat/attachment/DOM guards. Image status now displays elapsed seconds across stages and removes its interval when the final request ends. Explicit edits may override canonical appearance for that image without changing saved Story profiles; edited results are excluded from ordinary automatic canonical pixel references, but remain explicitly editable. Higher .55 default and correction priority improve visible changes, but a live vivid-red robe request produced dark purple fabric and accessory/background drift. Exact instruction fidelity remains unresolved with the installed img2img models; a dedicated editing-model decision is pending.

Left/right navigation keeps the same enlarged popup open and updates its image, title, counter and action targets. It cycles existing image attachments and immediately saves the selected index; after closing/reloading, chat displays the last choice. Arrows and counter share one non-wrapping row. Navigation renders before saving so repeated taps remain responsive; single-image navigation is hidden. Editing and other actions still close the viewer before forwarding to the current attachment.

Corrections now open a review of the revised English generation prompt before drawing. Users can edit that final text and inspect the original prompt in collapsed details. No pixel generation begins until confirmation; cancellation or chat/target changes prevent submission. The final reviewed text is used for generation and the new image's stored prompt; original prompts remain unchanged.
