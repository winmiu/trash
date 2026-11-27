import { compactRequest } from './compact-request.js';
import { RefereeSetupError } from './run-log.js';

export function apiAddress(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { /* validated below */ }
    const local = url && ['localhost', '127.0.0.1', '[::1]'].includes(url.hostname);
    if (!url || !(url.protocol === 'https:' || (local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash) {
        throw new RefereeSetupError('请填写不含密钥的 HTTPS 接口地址，本机服务也可使用 HTTP');
    }
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return url.origin + (path || '/v1');
}

// Only the random namespace goes in SillyTavern's per-account settings.
const memoryKeys = new WeakMap();
export function refereeKey(ctx, address, value) {
    const account = ctx.extensionSettings;
    if (!account) return '';
    const store = ctx.accountStorage;
    let record = memoryKeys.get(account);
    try {
        let id = store?.getItem('fairDice.keyNamespace');
        if (!id && value) {
            id = globalThis.crypto.randomUUID();
            store?.setItem('fairDice.keyNamespace', id);
        }
        if (id) {
            const slot = 'fairDice.referee.' + id;
            if (value === undefined) record ??= JSON.parse(sessionStorage.getItem(slot) || 'null');
            else if (value) sessionStorage.setItem(slot, JSON.stringify({ address, value }));
            else sessionStorage.removeItem(slot);
        }
    } catch { /* Use page memory if tab storage is unavailable. */ }
    if (value !== undefined) {
        record = { address, value };
        memoryKeys.set(account, record);
    }
    return record && record.address === address ? record.value : '';
}

export function independentConnection(ctx, cfg) {
    if (cfg.refereeApi !== 'independent') return null;
    const address = apiAddress(cfg.refereeAddress);
    const model = String(cfg.refereeModel || '').trim();
    if (!model) throw new RefereeSetupError('请在判定设置里填写独立裁判的模型名');
    const key = refereeKey(ctx, address);
    if (!key && !['localhost', '127.0.0.1', '[::1]'].includes(new URL(address).hostname)) {
        throw new RefereeSetupError('请在当前标签页填写独立裁判的 API 密钥');
    }
    return { address, model, key };
}

function hasMarker(content, marker) {
    return typeof content === 'string' ? content.includes(marker) :
        Array.isArray(content) && content.some(p => typeof p?.text === 'string' && p.text.includes(marker));
}

// Only forward conversation content, never another provider's settings or metadata.
function refereeMessage(message) {
    let content = message.content;
    if (Array.isArray(content)) {
        content = content.map(p => {
            if (p.type === 'text') return { type:'text', text:p.text };
            if (p.type === 'image_url' && typeof p.image_url?.url === 'string') {
                return { type:'image_url', image_url:{ url:p.image_url.url } };
            }
            throw new RefereeSetupError('独立裁判无法读取这条消息的附件类型');
        });
    }
    if (typeof content !== 'string' && !Array.isArray(content)) return null;
    if (!['user', 'assistant', 'system', 'developer'].includes(message.role)) return null;
    return { role:message.role, content, ...(message.name ? { name:message.name } : {}) };
}

export async function separateRuling(ctx, connection, { marker, rules, compact, budget, signal, isCurrent, ready }) {
    const event = (ctx.eventTypes || ctx.event_types)?.GENERATE_AFTER_DATA;
    if (!event || !ctx.eventSource?.on || !ctx.eventSource?.removeListener ||
        typeof ctx.generate !== 'function' || typeof ctx.getRequestHeaders !== 'function') {
        throw new RefereeSetupError('当前酒馆版本缺少独立裁判需要的上下文接口');
    }
    let prepared;
    const capture = (data, dryRun) => {
        if (dryRun !== true) return;
        const prompt = data?.prompt ?? data?.input;
        if (typeof prompt === 'string' && prompt.includes(marker)) prepared = prompt;
        if (Array.isArray(prompt) && prompt.some(m => hasMarker(m?.content, marker))) prepared = prompt;
    };
    ctx.eventSource.on(event, capture);
    try {
        // SillyTavern builds the active card, world info and chat, then returns before generation.
        await ctx.generate('quiet', { quiet_prompt:marker + '\n' + rules, force_name2:true, signal }, true);
    } finally { ctx.eventSource.removeListener(event, capture); }
    if (signal.aborted || !isCurrent()) return null;
    if (!prepared) throw new RefereeSetupError('酒馆没有提供本轮裁判上下文，请检查当前角色和提示词设置');
    const data = { messages:typeof prepared === 'string' ? [{ role:'user', content:prepared }] : prepared,
        max_tokens:compact ? budget : 2048 };
    const size = compact && Array.isArray(prepared) && compactRequest(data, ctx, marker, rules, budget);
    const messages = data.messages.map(refereeMessage).filter(Boolean);
    const limitField = /^(?:openai\/)?(?:gpt-5|o[134])(?:[-./]|$)/i.test(connection.model)
        ? 'max_completion_tokens' : 'max_tokens';
    ready(size);
    // An explicit reverse_proxy selects ONLY proxy_password on the ST OpenAI backend.
    // Keep CSRF headers on the same origin and leave the main connection/profile untouched.
    const response = await fetch('/api/backends/chat-completions/generate', {
        method:'POST', headers:ctx.getRequestHeaders(), signal, redirect:'error',
        body:JSON.stringify({ chat_completion_source:'openai', reverse_proxy:connection.address,
            proxy_password:connection.key, model:connection.model, messages, stream:false, [limitField]:data.max_tokens }),
    });
    if (!response.ok) throw Object.assign(new Error('HTTP ' + response.status), { status:response.status });
    const result = await response.json();
    if (result?.error) {
        // ST can return HTTP 200 with only the upstream status text. Never log the raw body.
        const statuses = { Unauthorized:401, Forbidden:403, 'Not Found':404, 'Too Many Requests':429,
            'Bad Request':400, 'Bad Gateway':502, 'Service Unavailable':503, 'Gateway Timeout':504 };
        const status = Object.hasOwn(statuses, result.error.message) ? statuses[result.error.message] : undefined;
        throw Object.assign(new Error('独立裁判接口请求失败'), { status:result.quota_error ? 429 : status });
    }
    return result.choices?.[0]?.message?.content;
}
