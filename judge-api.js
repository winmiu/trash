export class JudgeConfigError extends Error {}

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
            id = crypto.randomUUID();
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
    const tokenField = /^(?:openai\/)?(?:gpt-5|o[134])(?:[-./]|$)/i.test(model) ? 'max_completion_tokens' : 'max_tokens';
    const response = await fetch('/api/backends/chat-completions/generate',{
        method:'POST', headers:ctx.getRequestHeaders(), signal, redirect:'error',
        body:JSON.stringify({chat_completion_source:'openai', reverse_proxy:address,
            proxy_password:customKey(ctx,address), model, messages, stream:false, [tokenField]:256}),
    });
    if (!response.ok) throw new JudgeConfigError('独立 API 返回 HTTP ' + response.status);
    const data = await response.json();
    if (data.error) throw new JudgeConfigError('独立 API 返回错误，请检查地址、模型和密钥');
    return data.choices?.[0]?.message?.content;
}

export async function mainJudge(ctx, messages, signal) {
    if (ctx.mainApi === 'openai') {
        // Use the host's current model, provider, credentials and transformations, with our own cancellation signal.
        const {sendOpenAIRequest} = await import(new URL('scripts/openai.js', document.baseURI).href);
        signal.throwIfAborted();
        const event = (ctx.eventTypes || ctx.event_types)?.CHAT_COMPLETION_SETTINGS_READY;
        function limit(data) {
            if (data.type !== 'quiet' || data.messages !== messages) return;
            const key = 'max_completion_tokens' in data ? 'max_completion_tokens' : 'max_tokens';
            data[key] = 256;
        }
        if (event) ctx.eventSource.on(event,limit);
        try {
            const response = await sendOpenAIRequest('quiet',messages,signal);
            return ctx.extractMessageFromData(response,'openai');
        } finally { if (event) ctx.eventSource.removeListener(event,limit); }
    }
    signal.throwIfAborted();
    // Some older text-completion hosts ignore an external signal; discard a late result.
    let cancel;
    const stopped = new Promise((_, reject) => {
        cancel = () => reject(new Error('cancelled'));
        signal.addEventListener('abort',cancel,{once:true});
    });
    try { return await Promise.race([stopped, ctx.generateRaw({prompt:messages, trimNames:false, signal})]); }
    finally { signal.removeEventListener('abort',cancel); }
}
