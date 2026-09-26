/** Keep RP-Memory context before its changing role-history instructions.
 * Only RP slots move; other extensions and explicit prompt-manager markers keep their order.
 */
export function orderedExtensionPromptKeys(prompts) {
    const keys = Object.keys(prompts);
    const preferred = ['rp_memory_context', 'rp_memory_mode', 'rp_memory_story_role'];
    const present = preferred.filter(key => keys.includes(key));
    let index = 0;
    return keys.map(key => preferred.includes(key) ? present[index++] : key);
}
