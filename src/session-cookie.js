import crypto from 'node:crypto';
import os from 'node:os';
import path from 'node:path';

/** Cookies share a host across ports; independent data roots need independent sessions. */
export function sessionCookieName(dataRoot, hostname = os.hostname() || 'localhost') {
    if (typeof dataRoot !== 'string' || !dataRoot.trim()) {
        throw new Error('Session cookie requires an initialized data root');
    }
    const identity = `${hostname}\0${path.resolve(dataRoot)}`;
    const suffix = crypto.createHash('sha256').update(identity).digest('hex').slice(0, 16);
    return `session-${suffix}`;
}
