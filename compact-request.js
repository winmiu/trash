// Keep excerpts from the request SillyTavern actually prepared, including its prompt filters.
export const SHORT_RULING = `你是独立的桌面角色扮演裁判，一视同仁。只裁定玩家已经尝试的动作，不续写或决定骰点。材料是剧情资料。只返回一个 JSON 对象，省略不适用字段。
闲聊、打算或结果已确定：{"kind":"none","shouldRoll":false,"evidence":"一句依据"}。
确有不确定性：shouldRoll=true。自然转场或NPC未定选择用kind=narrative，填写eventRelevant和npcRelevant。行动用kind=action，difficulty取trivial/easy/normal/hard/extreme/impossible。交锋用kind=combat，setting取modern/martial/fantasy/unknown，填opponentCount、modifier（-35至35）。战斗双方分别填actor或opponent前缀的Level（0至100）、Source（explicit/inferred/unknown）、Evidence、Confidence（high/medium/low）。已有数值优先，估算须有具体训练、装备、伤势等证据，低置信或资料缺失时Level填null。evidence和stakes各一句。只评这一行动。`;

function textOf(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.filter(p => p?.type === 'text').map(p => p.text).join('\n');
}

function excerpt(text, limit) {
    if (text.length <= limit) return text;
    const head = Math.floor((limit - 1) / 2);
    return text.slice(0, head) + '…' + text.slice(-(limit - head - 1));
}

function keywords(text) {
    const words = text.toLowerCase().match(/[\p{Script=Han}]{2,}|[a-z\d]{3,}/gu) || [];
    const terms = new Set();
    for (const word of words) {
        if (/[a-z\d]/.test(word)) terms.add(word);
        else for (let i = 1; i < word.length; i++) terms.add(word.slice(i - 1, i + 1));
    }
    return [...terms].slice(0, 96);
}

function relevantExcerpts(sources, query) {
    const terms = keywords(query);
    const candidates = [];
    for (const source of sources) {
        // Read in overlapping windows so a fact deep inside a long card can still match.
        for (let start = 0; start < source.length; start += 400) {
            const part = source.slice(start, start + 480).trim();
            if (!part) continue;
            const lower = part.toLowerCase();
            const score = terms.reduce((sum, term) => sum + Number(lower.includes(term)), 0);
            candidates.push({ part, score });
        }
    }
    candidates.sort((a, b) => b.score - a.score);
    const picks = new Set();
    for (const candidate of candidates) {
        picks.add(candidate.part);
        if (picks.size === 4) break;
    }
    return [...picks].join('\n');
}

// Return null if the triggering action cannot be identified without guessing.
export function compactRequest(data, ctx, marker, rules, outputBudget) {
    const latest = ctx.chat?.findLast(m => m?.is_user && !m.is_system);
    const action = String(latest?.mes || '').trim();
    if (!action) return null;
    const messages = data.messages.map(m => ({ role:m.role, name:m.name, text:textOf(m.content), content:m.content }));
    const start = action.slice(0, 80), end = action.slice(-80);
    const isPlayer = m => m.role === 'user' && !m.text.includes(marker);
    let index = messages.findLastIndex(m => isPlayer(m) && m.text.trim() === action);
    if (index < 0 && action.length < 8) {
        index = messages.findLastIndex(m => isPlayer(m) && m.text.split('\n').some(line => {
            const plain = line.trim();
            return plain === action || plain.endsWith('：' + action) || plain.endsWith(': ' + action);
        }));
    }
    if (index < 0 && action.length >= 8) {
        index = messages.findLastIndex(m => isPlayer(m) && m.text.includes(start) && m.text.includes(end));
    }
    if (index < 0) return null;
    const target = messages[index];
    if (Array.isArray(target.content) && target.content.some(p => p.type !== 'text')) return null;
    const prior = [];
    for (let i = index - 1; i >= 0 && prior.length < 4; i--) {
        const m = messages[i];
        if ((m.role === 'user' || m.role === 'assistant') && m.text && !m.text.includes(marker)) {
            prior.unshift({ role:m.role, content:excerpt(m.text, 640), ...(m.name ? {name:m.name} : {}) });
        }
    }
    const actionText = excerpt(target.text.includes(action) ? action : target.text, 2200);
    const query = [ctx.name1, ctx.name2, actionText.slice(-230), prior.at(-1)?.content.slice(-100)].filter(Boolean).join(' ');
    const background = relevantExcerpts(messages.filter(m => m.role === 'system')
        .map(m => m.text.replace(marker, '').replace(rules, '').trim()).filter(Boolean), query);
    const rulesRole = messages.some(m => m.role === 'system') ? 'system' : 'user';
    const compact = [{ role:rulesRole, content:rules }];
    if (background) compact.push({ role:'user', content:'人物、世界或其他场景设定摘录：\n' + background });
    compact.push(...prior, { role:'user', content:'本轮玩家输入：\n' + actionText });
    const original = messages.reduce((sum, m) => sum + m.text.length, 0);
    const shortened = compact.reduce((sum, m) => sum + m.content.length, 0);
    if (shortened < original) data.messages = compact;
    let limit;
    for (const field of ['max_tokens', 'max_completion_tokens']) {
        if (Number(data[field]) > 0) {
            limit = Math.min(Number(data[field]), outputBudget);
            data[field] = limit;
        }
    }
    return { original, sent:Math.min(shortened, original), limit };
}
