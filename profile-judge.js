import { confirmVerdict, judgePrompt } from './story-turn.js';
import { customJudge, mainJudge, judgeText, JudgeConfigError, JUDGE_TOKEN_LIMIT } from './judge-api.js';

export function supportedProfiles(ctx) {
    try { return (ctx.ConnectionManagerRequestService?.getSupportedProfiles() ?? []).filter(p => p.mode === 'cc'); }
    catch { return []; }
}

async function profileRequest(ctx, profileId, messages, signal) {
    const profile = supportedProfiles(ctx).find(p => p.id === profileId);
    if (!profile) throw Error('所选酒馆连接不可用');
    // Older hosts use the active Custom credential, even for a different profile URL.
    const endpoint = value => String(value || '').trim().replace(/\/+$/, '');
    const provider = ctx.CONNECT_API_MAP?.[profile.api]?.source || profile.api;
    if (provider === 'custom' && (!endpoint(profile['api-url']) || endpoint(profile['api-url']) !== endpoint(ctx.chatCompletionSettings?.custom_url))) {
        throw Error('此自定义地址与酒馆当前自定义地址不同；请使用自带凭据的 OpenAI 反向代理连接');
    }
    return ctx.ConnectionManagerRequestService.sendRequest(profileId, messages, JUDGE_TOKEN_LIMIT, {signal, stream:false, includePreset:false, extractData:true});
}

export async function judgeFloor(ctx, cfg, turn, omittedNotes, signal) {
    const c = ctx.getCharacterCardFields?.() ?? {};
    const data = ctx.characters?.[ctx.characterId]?.data ?? {};
    const fields = [['玩家',c.persona],['角色',c.description || data.description],['性格',c.personality || data.personality],['场景',c.scenario || data.scenario]];
    const text = value => String(value ?? '').replace(/<think\b[^>]*>[\s\S]*?(?:<\/think>|$)/gi, '').trim();
    const card = fields.map(([name, value]) => [name, text(value).slice(0, 1800)]).filter(([,value]) => value).map(pair => pair.join('：'));
    const lastUser = ctx.chat.findLastIndex(m => m.is_user);
    const recent = (lastUser < 0 ? ctx.chat : ctx.chat.slice(0,lastUser + 1)).filter(m => !m.is_system && typeof m.mes === 'string').slice(-5);
    const history = recent.map(m => (m.name || (m.is_user ? '玩家' : '角色')) + '：' + text(m.mes).slice(-1200));
    const messages = [{role:'system', content:judgePrompt(turn, omittedNotes)}, {role:'user', content:[...card, ...history].join('\n')}];
    let result;
    if (cfg.judgeRoute === 'main') result = await mainJudge(ctx,messages,signal);
    else if (cfg.judgeRoute === 'custom') result = await customJudge(ctx,cfg,messages,signal);
    else if (cfg.judgeRoute === 'profile') result = await profileRequest(ctx,cfg.judgeProfileId,messages,signal);
    else throw Error('所选酒馆连接不可用');
    let record = judgeText(typeof result === 'string' ? result : result?.content).trim();
    record = record.replace(/^(?:<think\b[^>]*>[\s\S]*?<\/think>\s*)+/i, '').trim();
    if (!record || /^<think\b/i.test(record)) throw new JudgeConfigError('接口已返回，但没有最终裁定文本');
    const fence = /^`{3}[^\r\n`]*\r?\n([\s\S]*?)\r?\n`{3}$/.exec(record);
    const verdict = confirmVerdict(turn, (fence?.[1] ?? record).trim(), true);
    if (!verdict) throw new JudgeConfigError('已收到裁判文本，但裁定行的分支、条件或栏位未通过校验');
    return verdict;
}
