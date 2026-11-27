import { auditText } from './scene-check.js';

const key = 'fairDiceAudit';

export function stringHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}

export function saveAudit(message, turn, verdict, disputed = '') {
    const text = verdict ? auditText(verdict) : disputed || '候选 d100=' + turn.die + '，成功阈值未确认。';
    message.extra ??= {};
    if (text) message.extra[key] = {text, body:stringHash(message.mes ?? '')};
    else delete message.extra[key];
    const swipe = message.swipe_info?.[message.swipe_id];
    if (swipe) {
        swipe.extra ??= {};
        if (text) swipe.extra[key] = message.extra[key];
        else delete swipe.extra[key];
    }
}

export function renderAudits(ctx, enabled, id) {
    if (!ctx?.chat || !document.querySelectorAll) return;
    const selector = Number.isInteger(id) ? '#chat .mes[mesid="' + id + '"]' : '#chat .mes[mesid]';
    for (const row of document.querySelectorAll(selector)) {
        const msg = ctx.chat[Number(row.getAttribute('mesid'))];
        const audit = enabled && !msg?.is_user && msg?.extra?.[key];
        const text = audit && audit.body === stringHash(msg.mes ?? '') && audit.text;
        const old = row.querySelector('.fd-reply-audit');
        if (typeof text !== 'string' || !text) { old?.remove(); continue; }
        const note = old || document.createElement('small');
        note.className = 'fd-reply-audit';
        note.textContent = '公平骰 · ' + text;
        if (!old) row.querySelector('.mes_text')?.after(note);
    }
}
