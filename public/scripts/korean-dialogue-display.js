/**
 * Display-only correction of a confirmed mixed-language RP expression.
 * No inference, network request, timer, or sentence buffer. Source text stays intact.
 * Han characters alone do not identify Chinese (names/Japanese/Hanja are valid).
 */
export function correctKoreanDialogueDisplay(text, { isUser = false, isSystem = false, isReasoning = false, streaming = false } = {}) {
    if (!text || isUser || isSystem || isReasoning || !text.includes('在')) return text;
    // Deliberately narrow: the observed ordinary expression glued to Korean prose.
    // Do not translate unknown Han text or standalone names/quotations speculatively.
    const corrected = text.replace(/([가-힣])在那里(?=\s|$)/gu, '$1 그곳에');
    // Streaming renders the accumulated text already. Hide only the 1–2 Chinese
    // characters of this unfinished expression; Korean text is never delayed.
    // On completion/reload retain unmatched source, rather than silently delete it.
    return streaming ? corrected.replace(/([가-힣])在(?:那)?$/u, '$1') : corrected;
}
