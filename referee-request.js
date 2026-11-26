import { errorText, RefereeStopped } from './run-log.js';
import { compactRequest, SHORT_RULING } from './compact-request.js';

// The marker identifies only this extension's quiet request in the host's shared event.
const REFEREE_MARKER = '[Fair Dice GM]';
const RETRY_DELAYS = [1000, 2000, 4000];

function containsRefereePrompt(message, marker) {
    const content = message?.content;
    if (typeof content === 'string') return content.includes(marker);
    return Array.isArray(content) && content.some(part => typeof part?.text === 'string' && part.text.includes(marker));
}

export async function requestReferee(ctx, prompt, { log, readAssessment, isCurrent, compact }) {
    if (typeof ctx?.generateQuietPrompt !== 'function') throw new Error('当前酒馆不支持静默裁判');
    const events = ctx.eventSource;
    const types = ctx.eventTypes || ctx.event_types || {};
    const watch = typeof events?.on === 'function' && typeof events.removeListener === 'function';
    let stopped = false;
    let leftChat = false;
    let finishPause;
    const marker = REFEREE_MARKER + ':' + (globalThis.crypto?.randomUUID?.() ?? Math.random().toString(36).slice(2));
    const rules = compact ? SHORT_RULING : prompt;
    let budget = 1024;
    let preparedAt;
    const onStop = () => { stopped = true; finishPause?.(); };
    const onChatChanged = () => {
        if (isCurrent()) return;
        leftChat = true;
        finishPause?.();
    };
    const onPrepared = data => {
        if (data?.type !== 'quiet' || !Array.isArray(data.messages) || !data.messages.some(m => containsRefereePrompt(m, marker))) return;
        preparedAt = Date.now();
        if (compact) {
            const size = compactRequest(data, ctx, marker, rules, budget);
            if (size) {
                log(`酒馆已准备好本次裁判请求。精简模式：输入 ${size.original} → ${size.sent} 字符${size.limit ? '，输出上限 ' + size.limit + ' tokens' : ''}。等待模型回复。`);
                return;
            }
            log('本轮含媒体或未能定位原始玩家输入，本次保留完整上下文。', 'notice');
        }
        log('酒馆已准备好本次裁判请求，等待模型回复。');
    };
    if (watch && types.GENERATION_STOPPED) events.on(types.GENERATION_STOPPED, onStop);
    if (watch && types.CHAT_CHANGED) events.on(types.CHAT_CHANGED, onChatChanged);
    if (watch && types.CHAT_COMPLETION_SETTINGS_READY) events.on(types.CHAT_COMPLETION_SETTINGS_READY, onPrepared);
    try {
        for (let attempt = 0; ; attempt++) {
            if (stopped) throw new RefereeStopped();
            if (leftChat || !isCurrent()) return null;
            if (attempt > 0) log(`第 ${attempt}/${RETRY_DELAYS.length} 次重试，已重新请求前置 AI 裁判。`);
            preparedAt = undefined;
            try {
                const raw = await ctx.generateQuietPrompt({ quietPrompt: marker + '\n' + rules });
                if (stopped) throw new RefereeStopped();
                if (leftChat || !isCurrent()) return null;
                if (String(raw ?? '').trim()) {
                    const wait = preparedAt === undefined ? '' : `从请求准备好到收到回复用时 ${((Date.now() - preparedAt) / 1000).toFixed(1)} 秒。`;
                    log('已收到回复，正在读取裁判结果。' + wait);
                }
                return readAssessment(raw);
            } catch (error) {
                if (stopped) throw new RefereeStopped();
                if (leftChat || !isCurrent()) return null;
                if (attempt === RETRY_DELAYS.length) {
                    log(`已用完 ${RETRY_DELAYS.length} 次重试。`, 'notice');
                    throw error;
                }
                const delay = RETRY_DELAYS[attempt];
                if (/空回复|JSON|判定类型/.test(errorText(error))) budget = 2048;
                const label = attempt === 0 ? '首次评估' : `第 ${attempt} 次重试`;
                log(`${label}失败：${errorText(error)}。${delay / 1000} 秒后重试。`, 'error');
                await new Promise(resolve => {
                    const timer = setTimeout(resolve, delay);
                    finishPause = () => { clearTimeout(timer); resolve(); };
                });
                finishPause = null;
            }
        }
    } finally {
        if (watch && types.GENERATION_STOPPED) events.removeListener(types.GENERATION_STOPPED, onStop);
        if (watch && types.CHAT_CHANGED) events.removeListener(types.CHAT_CHANGED, onChatChanged);
        if (watch && types.CHAT_COMPLETION_SETTINGS_READY) events.removeListener(types.CHAT_COMPLETION_SETTINGS_READY, onPrepared);
    }
}
