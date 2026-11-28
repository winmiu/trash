export class JudgeConfigError extends Error {}
export const JUDGE_TOKEN_LIMIT = 1024;

export function judgeText(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(part => ['text','output_text'].includes(part?.type) && typeof part.text === 'string')
        .map(part => part.text).join('');
}

function checkCompletion(data) {
    if (data?.error) {
        // A SillyTavern relay can return HTTP 200 for upstream errors. Only log known categories.
        const description = [data.error.status, data.error.code, data.error.type, data.error.message].join(' ');
        let reason = '服务端拒绝了请求，请检查连接和模型';
        if (/unauthorized|forbidden|authentication|invalid.api.key|\b40[13]\b/i.test(description)) reason = '鉴权失败，请检查此接口的密钥和模型权限';
        else if (data.quota_error || /quota|rate.limit|too many requests|\b429\b/i.test(description)) reason = '接口限流或额度不足';
        else if (/not found|model_not_found|\b404\b/i.test(description)) reason = '接口路径或模型不存在';
        throw new JudgeConfigError(reason);
    }
    const choice = data?.choices?.[0];
    if (choice?.finish_reason === 'length') throw new JudgeConfigError('裁判输出达到长度上限，未取得完整记录');
    if (choice?.finish_reason === 'content_filter' || choice?.message?.refusal) throw new JudgeConfigError('裁判接口未提供裁定（拒答或内容过滤）');
}

export function normalizeAddress(value) {
    let url;
    try { url = new URL(String(value).trim()); } catch { /* Checked below. */ }
    const local = url && ['localhost','127.0.0.1','[::1]'].includes(url.hostname);
    if (!url || !(url.protocol === 'https:' || (local && url.protocol === 'http:')) ||
        url.username || url.password || url.search || url.hash) throw new JudgeConfigError('请填写 HTTPS 接口地址，本机服务也可使用 HTTP');
    const path = url.pathname.replace(/\/+$/, '').replace(/\/chat\/completions$/, '');
    return url.origin + (path || '/v1');
}

// The secret is bound to one account, tab and normalized endpoint. Never put it in extensionSettings.
const keys = new WeakMap();
export function customKey(ctx, address, value) {
    const account = ctx.extensionSettings;
    let record = keys.get(account);
    try {
        const storage = ctx.accountStorage;
        let id = storage?.getItem('fairDice.judgeTabId');
        if (!id && value && storage) {
            id = Array.from(crypto.getRandomValues(new Uint8Array(16)), n => n.toString(16).padStart(2, '0')).join('');
            storage.setItem('fairDice.judgeTabId',id);
        }
        if (id) {
            const slot = 'fairDice.judgeKey.' + id;
            if (value === undefined) record ??= JSON.parse(sessionStorage.getItem(slot) || 'null');
            else if (value) sessionStorage.setItem(slot,JSON.stringify({address,value}));
            else sessionStorage.removeItem(slot);
        }
    } catch { /* Restricted tabs can still use page memory. */ }
    if (value !== undefined) {
        record = {address,value};
        keys.set(account,record);
    }
    return record?.address === address ? record.value : '';
}

export async function customJudge(ctx, settings, messages, signal) {
    const address = normalizeAddress(settings.judgeAddress);
    const model = String(settings.judgeModel ?? '').trim();
    if (!model) throw new JudgeConfigError('请填写独立 API 的模型名');
    if (typeof ctx.getRequestHeaders !== 'function') throw new JudgeConfigError('当前酒馆未提供裁判请求所需的请求头接口');
    const tokenField = /^(?:openai\/)?(?:gpt-5|o[134])(?:[-./]|$)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
    const response = await fetch('/api/backends/chat-completions/generate',{
        method:'POST', headers:ctx.getRequestHeaders(), signal, redirect:'error',
        body:JSON.stringify({chat_completion_source:'openai', reverse_proxy:address,
            proxy_password:customKey(ctx,address), model, messages, stream:false, [tokenField]:JUDGE_TOKEN_LIMIT}),
    });
    if (!response.ok) throw new JudgeConfigError('独立 API 返回 HTTP ' + response.status);
    let data;
    try { data = await response.json(); }
    catch { throw new JudgeConfigError('接口未返回 JSON，请核对 OpenAI 兼容接口地址'); }
    checkCompletion(data);
    const choice = data?.choices?.[0];
    return judgeText(choice?.message?.content ?? choice?.text);
}

export async function mainJudge(ctx, messages, signal) {
    if (ctx.mainApi === 'openai') {
        // Use the host's current model, provider, credentials and transformations, with our own cancellation signal.
        const {sendOpenAIRequest} = await import(new URL('scripts/openai.js', document.baseURI).href);
        if (signal.aborted) throw new Error('cancelled');
        const event = (ctx.eventTypes || ctx.event_types)?.CHAT_COMPLETION_SETTINGS_READY;
        function limit(data) {
            if (data.type !== 'quiet' || data.messages !== messages) return;
            const key = 'max_completion_tokens' in data ? 'max_completion_tokens' : 'max_tokens';
            data[key] = JUDGE_TOKEN_LIMIT;
        }
        if (event) ctx.eventSource.on(event,limit);
        try {
            const response = await sendOpenAIRequest('quiet',messages,signal);
            checkCompletion(response);
            return ctx.extractMessageFromData(response,'openai');
        } finally { if (event) ctx.eventSource.removeListener(event,limit); }
    }
    if (signal.aborted) throw new Error('cancelled');
    // Some older text-completion hosts ignore an external signal; discard a late result.
    let cancel;
    const stopped = new Promise((_, reject) => {
        cancel = () => reject(new Error('cancelled'));
        signal.addEventListener('abort',cancel,{once:true});
    });
    try { return await Promise.race([stopped, ctx.generateRaw({prompt:messages, trimNames:false, signal})]); }
    finally { signal.removeEventListener('abort',cancel); }
}
