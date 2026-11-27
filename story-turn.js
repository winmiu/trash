import { DIFFICULTY } from './engine.js';
import { checkInstructions, confirmCheck } from './scene-check.js';

// In an exponential race the smallest clock wins with probability w_i / sum(w).
// Scaling a clock by 1/factor implements the new weight using the same random draw.
export function storyPool(rows, prefix, random) {
    const items = rows.filter(r => r.enabled && r.weight > 0 && r.name.trim()).map((r, i) => ({
        code:prefix + (i + 1), id:r.id, name:r.name, note:r.note, weight:r.weight,
    }));
    const ranks = [];
    for (const row of items) {
        const u = Math.max(Number.EPSILON, 1 - random());
        const clock = -Math.log(u) / row.weight;
        for (const [sign, factor] of [['+', 2], ['', 1], ['-', 0.5]]) {
            ranks.push({ code:sign + row.code, score:clock / factor });
        }
    }
    return { items, order:ranks.sort((a,b) => a.score - b.score).map(r=>r.code) };
}

export function poolResult(pool, up, down) {
    const rows = pool.items.map(item => {
        const factor = up.includes(item.code) ? 2 : down.includes(item.code) ? 0.5 : 1;
        return { ...item, factor, ticket:(factor === 2 ? '+' : factor === 0.5 ? '-' : '') + item.code };
    });
    const total = rows.reduce((sum, row) => sum + row.weight * row.factor, 0);
    for (const row of rows) row.pct = row.weight * row.factor / total * 100;
    const active = new Map(rows.map(row => [row.ticket, row]));
    const first = pool.order.find(code => active.has(code));
    return { rows, winner:active.get(first) };
}

function describePool(pool, title) {
    if (!pool.items.length) return '';
    const labels = pool.items.map(r => `${r.code}=${r.name}（${r.note}）`).join('，');
    return `${title}条目：${labels}\n${title}本机抽签顺序：${pool.order.join(' ')}`;
}

export function storyPrompt(t, fixed) {
    const lines = [
        '[公平骰·正文内判定]',
        '直接按当前角色卡和世界设定写本轮正文。先判断本轮有没有未定且有后果的事情：闲聊、打算、结局已定都选 none。已有实际交锋走交锋树；其他具体尝试走行动树。没有待判行动时，再看是否有自然转场或 NPC 未决选择。同一件事只判一次。类别关闭就跳过。勿展示步骤、数字或分析。',
        t.fairness && '按双方能力、代价和动机公平叙事，勿替玩家做后续决定。',
        t.mode !== 'auto' && '当前手动指定类别为 ' + t.mode + '，只允许相关类别或 none。',
        '续写时承接已经发生的结果，不重复触发同一事件。',
    ];
    if (fixed) {
        lines.push('本回合已确认。沿用这一裁定，直接写正文：' + fixed.summary,
            fixed.event && fixed.event.note, fixed.reaction && fixed.reaction.note);
    } else {
        lines.push(checkInstructions(t.checks));
        lines.push('事件树：自然转场 → 当前时间、地点与未完的事务允许什么变化 → 再调事件权重，选 event。NPC 树：确有未决选择 → 人设、关系、既有承诺与眼前代价 → 再调反应权重，选 npc。两项分别成立才选 both。行为已由承诺或行动检定决定时不再抽一次反应。只可采用列出的类别和条目。');
        if (t.events.items.length || t.reactions.items.length) {
            lines.push('依据本张卡的人设、关系和当前局势给各条目选系数。合适的调至两倍（+），不合适的减半（-），其余保持原值。先定系数，勿为挑选结局改系数。每组从左往右，采用第一个与该条目所选符号相符的编号（原值无符号）。只在需要抽该组时把结果写入正文。');
            lines.push(describePool(t.events, '事件'), describePool(t.reactions, 'NPC'));
        }
        lines.push('正文最后单独附一行 HTML 注释。use 填实际采用的类别，up/down 填调高/调低的编号，picks 按事件、NPC 顺序填实际采用的编号，未抽则为空。why 只填一句可观察的剧情依据。格式如下，按本轮实际填写：',
            `<!--FD-${t.token} {"use":"none","up":[],"down":[],"picks":[],"why":"双方只是在问候"}-->`);
    }
    lines.push('[/公平骰]');
    return lines.filter(Boolean).join('\n');
}

// Strip only this turn's own trailing comment. Never parse the model's reasoning.
export function readReceipt(text, token) {
    if (typeof text !== 'string') return null;
    const marker = '<!--FD-' + token;
    const start = text.lastIndexOf(marker);
    if (start < 0 || !/^\s/.test(text.slice(start + marker.length, start + marker.length + 1))) return null;
    const tail = text.slice(start + marker.length).trim();
    const end = tail.indexOf('-->');
    if (end >= 0 && tail.slice(end + 3).trim()) return null;
    if (end < 0 && (!tail.startsWith('{') || tail.includes('\n') || tail.length > 2048)) return null;
    let value = null;
    const json = end >= 0 ? tail.slice(0, end) : tail;
    // The host's trim-to-sentence option may stop at the final JSON brace.
    if (json.length <= 2048) {
        try { value = JSON.parse(json); } catch { /* Unconfirmed. */ }
    }
    return { body:text.slice(0, start).trimEnd(), value };
}

export function confirmStory(t, value) {
    if (!value || typeof value.use !== 'string') return null;
    const { use, up = [], down = [], picks = [] } = value;
    const all = new Set([...t.events.items, ...t.reactions.items].map(x=>x.code));
    if (![up, down, picks].every(a => Array.isArray(a) && a.length <= all.size && a.every(c => all.has(c)))) return null;
    if (new Set([...up,...down]).size !== up.length + down.length) return null;
    const events = poolResult(t.events, up, down), reactions = poolResult(t.reactions, up, down);
    const event = ['event','both'].includes(use) ? events.winner : null;
    const reaction = ['npc','both'].includes(use) ? reactions.winner : null;
    const isCheck = use.startsWith('a-') || use.startsWith('c-');
    const check = t.checks && isCheck ? confirmCheck(t.checks, value) : null;
    if (check && !check.pending && value.result !== check.outcome) return null;
    // A saved 1.7 turn can still have unread alternative completions.
    const action = !t.checks && t.actions?.find(a => 'a-' + a.key === use);
    const combat = !t.checks && use === 'combat' && t.combat;
    if (!(use === 'none' || check || action || combat || (use === 'event' && event) ||
        (use === 'npc' && reaction) || (use === 'both' && event && reaction))) return null;
    const expected = [event, reaction].filter(Boolean).map(x=>x.code);
    if (JSON.stringify(expected) !== JSON.stringify(picks)) return null;
    const details = [];
    if (check) details.push(check.summary);
    if (action) details.push(`行动「${DIFFICULTY[action.key].name}」d100=${action.roll} / ${action.chance}%，${action.degree}`);
    if (combat) details.push(combat.pending ? '战力依据不足，暂缓判定' : `交锋 d100=${combat.roll} / ${combat.chance}%，${combat.degree}`);
    for (const row of [event, reaction].filter(Boolean)) details.push(row.name + '（' + row.pct.toFixed(1) + '%）');
    if (use === 'none') details.push('本轮无须掷骰');
    const why = typeof value.why === 'string' ? value.why.replace(/[<>\r\n]/g, ' ').trim().slice(0, 72) : '';
    if (t.checks && (event || reaction) && !why) return null;
    return { use, up, down, event, reaction, ...(check ? {check} : {}), summary:details.join(' / ') + (why && !check ? '。依据：' + why : '') };
}
