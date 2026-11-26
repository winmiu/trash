// The marker identifies this extension's quiet request in the host's shared event.
export const REFEREE_MARKER = '[Fair Dice GM]';
const MAX_REFEREE_TOKENS = 4096;

export class RefereeStopped extends Error {
    constructor() {
        super('等待裁判期间，酒馆发出了停止生成信号');
    }
}

function containsRefereePrompt(message) {
    const content = message?.content;
    if (typeof content === 'string') return content.includes(REFEREE_MARKER);
    return Array.isArray(content) && content.some(part => typeof part?.text === 'string' && part.text.includes(REFEREE_MARKER));
}

export async function requestReferee(ctx, prompt, log) {
    if (typeof ctx?.generateQuietPrompt !== 'function') throw new Error('当前酒馆不支持静默裁判');
    const events = ctx.eventSource;
    const types = ctx.eventTypes || ctx.event_types || {};
    const watch = typeof events?.on === 'function' && typeof events.removeListener === 'function';
    let stopped = false;
    const onStop = () => { stopped = true; };
    const onPrepared = data => {
        if (data?.type !== 'quiet' || !Array.isArray(data.messages) || !data.messages.some(containsRefereePrompt)) return;
        let limit;
        for (const field of ['max_tokens', 'max_completion_tokens']) {
            const requested = Number(data[field]);
            if (Number.isSafeInteger(requested) && requested > 0) {
                limit = Math.min(requested, MAX_REFEREE_TOKENS);
                data[field] = limit;
            }
        }
        log(limit ? `酒馆已准备好裁判请求，输出上限 ${limit} tokens，等待模型回复。` : '酒馆已准备好裁判请求，等待模型回复。');
    };
    if (watch && types.GENERATION_STOPPED) events.on(types.GENERATION_STOPPED, onStop);
    if (watch && types.CHAT_COMPLETION_SETTINGS_READY) events.on(types.CHAT_COMPLETION_SETTINGS_READY, onPrepared);
    let reply;
    try {
        reply = await ctx.generateQuietPrompt({ quietPrompt: REFEREE_MARKER + '\n' + prompt });
    } catch (error) {
        if (!stopped) throw error;
    } finally {
        if (watch && types.GENERATION_STOPPED) events.removeListener(types.GENERATION_STOPPED, onStop);
        if (watch && types.CHAT_COMPLETION_SETTINGS_READY) events.removeListener(types.CHAT_COMPLETION_SETTINGS_READY, onPrepared);
    }
    if (stopped) throw new RefereeStopped();
    return reply;
}
