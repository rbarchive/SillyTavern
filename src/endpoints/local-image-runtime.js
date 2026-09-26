import express from 'express';
import { getConfigValue } from '../util.js';
import { createLocalImageRuntime, boostPreference } from '../local-image-runtime.js';

let runtime;
export function getLocalImageRuntime() {
    return runtime ||= createLocalImageRuntime(getConfigValue('localImageRuntime', { enabled: false }));
}
export async function closeLocalImageRuntime() { await runtime?.close(); }
export const router = express.Router();
router.post('/status', (req, res) => {
    try { res.send(getLocalImageRuntime().status(req.body.url)); }
    catch (error) { res.status(503).send({ error: error.message }); }
});
router.post('/apply', async (req, res) => {
    try {
        const boost = boostPreference(req.body.boost);
        res.send(await getLocalImageRuntime().apply(req.body.url, boost));
    } catch (error) { res.status(409).send({ error: error.message }); }
});
