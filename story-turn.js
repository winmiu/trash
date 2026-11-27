import { checkInstructions, checkVerdict } from './scene-check.js';

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


function describe(pool, title) {
    if (!pool.items.length) return '';
    const names = pool.items.map(row => row.code + '=' + row.name + '×' + row.weight + (row.note ? '（' + row.note + '）' : ''));
    return title + '：' + names.join('、') + '\n候选顺序：' + pool.order.join(' ');
}

export function storyPrompt(turn) {
    if (turn.verdict?.length) {
        return ['[公平骰 · 本楼已确认裁定]', ...turn.verdict, '沿用本楼裁定。由主预设决定具体后果，只写正文。续写时承接已发生的事。', '[/公平骰]'].join('\n');
    }
    const lines = [
        '[公平骰 · 当前正文输入]',
        '结合角色卡、世界设定、本轮输入和最新剧情，先找出仍未确定的问题。闲聊、意图和既定事实直接承接。实际对抗走交锋，其他已尝试的未决目标走行动。公平对待各方，同一问题只判一次，保留玩家选择。',
        '行动与交锋只定本次成败。具体后果、严重程度和后续情节全部由主预设决定。',
        checkInstructions(turn.die),
    ];
    if (turn.events.items.length) {
        lines.push('事件走向：自然转场且走向未定时，按时间、地点及未完事务选；合宜时直接延续。', describe(turn.events, '事件'));
    }
    if (turn.reactions.items.length) {
        lines.push('NPC 反应：人物有未决选择时，按动机、关系、承诺及眼前代价选。', describe(turn.reactions, 'NPC 反应'));
    }
    if (turn.events.items.length || turn.reactions.items.length) {
        lines.push('各组每轮重评：矛盾项 ! 排除，合适 + 权重×2，较不合适 - ×0.5，其余无符号×1。取顺序中首个符号匹配的编号，全排除则跳过。同一成败的后果不再抽签。');
    }
    lines.push('先写一行 <!--FD-' + turn.token + ' 裁定 --> 再按主预设写正文。用下列适用格式替换“裁定”，独立事项用分号分开。依据仅一句已知事实，可引用双方已知能力、状态，不写后果或推演。');
    lines.push('行|难度|不利/中性/有利|成/败|依据 或 战|现实/一般/严格阶位|强弱档|不利/中性/有利|人数|成/败|依据；无需判定用 略|依据，资料不足用 缓|依据。各字段只选一项。');
    if (turn.events.items.length || turn.reactions.items.length) {
        lines.push('事件用 事|调整|选中编号|依据，NPC 用 人|调整|选中编号|依据。调整仅列变化编号，如 +E1 -E2 !E3（! 排除），空变化填 0。全排除时选中编号填 0。');
    }
    return lines.filter(Boolean).concat('[/公平骰]').join('\n');
}

function poolVerdict(pool, fields) {
    const [kind, changes, pick, fact] = fields;
    if (!pool.items.length || fields.length !== 4) return null;
    const factors = new Map(pool.items.map(item => [item.code, '']));
    const seen = new Set();
    for (const change of changes === '0' ? [] : changes.split(/\s+/)) {
        const code = change.slice(1), sign = change[0];
        if (!'+-!'.includes(sign) || !factors.has(code) || seen.has(code)) return null;
        seen.add(code);
        factors.set(code, sign);
    }
    const eligible = new Map();
    const adjusted = [];
    for (const item of pool.items) {
        const sign = factors.get(item.code);
        if (sign !== '!') eligible.set(sign + item.code, item);
        if (sign) adjusted.push(item.name + ({'+':'×2','-':'×0.5','!':'排除'})[sign]);
    }
    const chosen = eligible.get(pool.order.find(ticket => eligible.has(ticket)));
    if (pick !== (chosen?.code ?? '0')) return null;
    return (kind === '事' ? '事件' : 'NPC 反应') + ' · ' + fact + '。' + (chosen?.name ?? '全部排除，跳过') + '。' + (adjusted.join('、') || '沿用基础权重') + '。';
}

export function confirmVerdict(turn, record) {
    if (!record || record.length > 1400) return null;
    const rows = record.split(/[；;\n]+/).map(row => row.trim()).filter(Boolean);
    if (!rows.length || rows.length > 4) return null;
    const used = new Set(), summaries = [];
    for (const row of rows) {
        const fields = row.split(/[|｜]/).map(s => s.trim());
        const kind = fields[0];
        const fact = fields.at(-1).replace(/[。.!！]+$/u, '').trim();
        if (!fact || fact.length > 140 || /[<>]|风险[：:]|(?:成功|失败)(?:则|的话会|后将)/u.test(fact)) return null;
        fields[fields.length - 1] = fact;
        const branch = ['行', '战'].includes(kind) ? '检定' : kind;
        if (used.has(branch)) return null;
        used.add(branch);
        let summary;
        if (branch === '检定') summary = checkVerdict(fields, turn.die);
        if (kind === '事' || kind === '人') summary = poolVerdict(kind === '事' ? turn.events : turn.reactions, fields);
        if (fields.length === 2 && (kind === '缓' || (kind === '略' && rows.length === 1))) {
            summary = (kind === '略' ? '本轮无需判定' : '暂缓判定') + ' · ' + fact + '。';
        }
        if (!summary) return null;
        summaries.push(summary);
    }
    return summaries;
}

export function readRecord(text, token) {
    if (typeof text !== 'string' || !token) return null;
    const marker = '<!--FD-' + token;
    const start = text.indexOf(marker);
    if (start < 0 || !/\s/.test(text.charAt(start + marker.length))) return null;
    const end = text.indexOf('-->', start + marker.length);
    if (end < 0 || text.slice(start + marker.length, end).includes('<!--')) return null;
    const before = text.slice(0, start);
    const after = text.slice(end + 3).replace(/^[ \t]*\r?\n/, '');
    return {body:before + after, record:text.slice(start + marker.length, end).trim()};
}
