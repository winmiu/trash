import { confirmVerdict, storyPrompt } from './story-turn.js';
import { customJudge, mainJudge } from './judge-api.js';

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
    return ctx.ConnectionManagerRequestService.sendRequest(profileId, messages, 256, {signal, stream:false, includePreset:false, extractData:true});
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
    const messages = [{role:'system', content:storyPrompt(turn, omittedNotes, true)}, {role:'user', content:[...card, ...history].join('\n')}];
    let result;
    if (cfg.judgeRoute === 'main') result = await mainJudge(ctx,messages,signal);
    else if (cfg.judgeRoute === 'custom') result = await customJudge(ctx,cfg,messages,signal);
    else if (cfg.judgeRoute === 'profile') result = await profileRequest(ctx,cfg.judgeProfileId,messages,signal);
    else throw Error('所选酒馆连接不可用');
    const record = typeof result === 'string' ? result : result?.content;
    const verdict = typeof record === 'string' && confirmVerdict(turn, record.trim(), true);
    if (!verdict) throw Error('独立裁判的记录未通过骰表校验');
    return verdict;
}
