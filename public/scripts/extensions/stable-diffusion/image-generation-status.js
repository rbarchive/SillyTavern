import { t } from '../../i18n.js';

const activeJobs = new Map();
let statusElement;

function renderStatus() {
    if (!activeJobs.size) {
        statusElement?.remove();
        statusElement = null;
        return;
    }
    if (!statusElement) {
        statusElement = document.createElement('div');
        statusElement.id = 'sd_generation_status';
        statusElement.setAttribute('role', 'status');
        statusElement.setAttribute('aria-live', 'polite');
        const spinner = document.createElement('i');
        spinner.className = 'fa-solid fa-spinner fa-spin';
        spinner.setAttribute('aria-hidden', 'true');
        statusElement.append(spinner, document.createElement('span'));
        document.getElementById('send_form')?.append(statusElement);
    }
    const stage = Array.from(activeJobs.values()).at(-1);
    statusElement.querySelector('span').textContent = activeJobs.size > 1
        ? `${stage} (${activeJobs.size})` : stage;
}

/** Keep a visible status beside the composer for the entire image request. */
export function beginImageGenerationStatus(message = t`Image generation: preparing description…`) {
    const job = Symbol('image-generation');
    activeJobs.set(job, message);
    renderStatus();
    return {
        update(message) {
            if (!activeJobs.has(job)) return;
            activeJobs.set(job, message);
            renderStatus();
        },
        hide() {
            activeJobs.delete(job);
            renderStatus();
        },
    };
}
