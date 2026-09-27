import { createHash } from 'node:crypto';

function imageType(bytes) {
    if (bytes.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) return ['png', 'image/png'];
    if (bytes[0] === 255 && bytes[1] === 216 && bytes[2] === 255) return ['jpg', 'image/jpeg'];
    if (bytes.toString('ascii', 0, 4) === 'RIFF' && bytes.toString('ascii', 8, 12) === 'WEBP') return ['webp', 'image/webp'];
    if (/^GIF8[79]a$/.test(bytes.toString('ascii', 0, 6))) return ['gif', 'image/gif'];
    if (bytes.toString('ascii', 4, 8) === 'ftyp' && /avif|avis/.test(bytes.toString('ascii', 8, 32))) return ['avif', 'image/avif'];
    throw new Error('Selected reference bytes are not a supported image.');
}

/** Load explicitly supplied pixels using core nodes, without requiring custom Comfy nodes. */
export async function prepareInlineComfyImages(prompt, url, signal, fetchImpl = globalThis.fetch) {
    if (!prompt.includes('ETN_LoadImageBase64')) return prompt;
    const payload = JSON.parse(prompt);
    const graph = payload.prompt;
    const uploaded = new Map();
    for (const node of Object.values(graph || {})) {
        if (node.class_type !== 'ETN_LoadImageBase64') continue;
        signal?.throwIfAborted();
        const encoded = node.inputs?.image;
        if (typeof encoded !== 'string' || encoded.length > 48 * 1024 * 1024 || encoded.length % 4
            || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) throw new Error('Invalid inline reference image data.');
        const bytes = Buffer.from(encoded, 'base64');
        if (bytes.length > 32 * 1024 * 1024 || bytes.toString('base64') !== encoded) throw new Error('Invalid inline reference image data.');
        const [extension, mime] = imageType(bytes);
        const digest = createHash('sha256').update(bytes).digest('hex');
        let imageName = uploaded.get(digest);
        if (!imageName) {
            const form = new FormData();
            form.append('image', new Blob([bytes], { type: mime }), `st-reference-${digest}.${extension}`);
            form.append('type', 'input');
            form.append('overwrite', 'false'); // Never replace an existing Comfy input artifact.
            const target = new URL(url);
            target.pathname = target.pathname.replace(/\/$/, '') + '/upload/image';
            target.search = ''; target.hash = '';
            const response = await fetchImpl(target, { method: 'POST', body: form, signal });
            if (!response.ok) throw new Error(`ComfyUI reference upload failed (HTTP ${response.status}).`);
            const result = await response.json();
            const safeSegment = value => typeof value === 'string' && value.length > 0 && !/[\\/%?#:\[\]\u0000-\u001f]/.test(value) && value !== '.' && value !== '..';
            if (!safeSegment(result.name) || (result.subfolder && !result.subfolder.split('/').every(safeSegment)) || result.type !== 'input') {
                throw new Error('ComfyUI reference upload returned an unsafe image path.');
            }
            imageName = result.subfolder ? `${result.subfolder}/${result.name}` : result.name;
            uploaded.set(digest, imageName);
        }
        node.class_type = 'LoadImage';
        node.inputs = { image: imageName };
    }
    signal?.throwIfAborted();
    return JSON.stringify(payload);
}
