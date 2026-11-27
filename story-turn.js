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


function describe(pool, omittedNotes, judge) {
    const rank = new Map(pool.order.map((code, i) => [code, i + 1]));
    return pool.items.map(row => {
        const note = row.note && !omittedNotes?.has(row.note) ? '（' + row.note + '）' : '';
        return row.code + '=' + row.name + note + (judge ? '' : '[' + ['+', '', '-'].map(s => rank.get(s + row.code)).join('/') + ']');
    }).join(' ');
}

export function storyPrompt(turn, omittedNotes, judge = false) {
    if (turn.verdict?.length && !judge) return '【公平骰·本楼裁定】' + turn.verdict.join(' ') + ' 依此接写，后果与格式由主预设决定。';
    const lines = [
        '【公平骰】按人设、设定与当前情境判一次：闲聊/既定事实略过；行动看任务门槛及专长工具，交锋按目标比较双方能力、状态和实际人数，无数值用已知表现，依据不足暂缓。只判成败，后果交主预设。',
        judge ? '行难度：很容易/容易/一般/困难/极难/客观不可能。战世界：现实/一般/严格阶位；强弱：明显劣势/劣势/相当/优势/明显优势。临场：不利/中性/有利。' : checkInstructions(turn.die),
    ];
    if (turn.events.items.length) lines.push('事：自然转场按时地、未完事务。' + describe(turn.events, omittedNotes, judge));
    if (turn.reactions.items.length) lines.push('人：未决NPC选择按动机、关系和代价。' + describe(turn.reactions, omittedNotes, judge));
    if (turn.events.items.length || turn.reactions.items.length) {
        lines.push((judge ? '事或人|调整|*|事实。' : '每项取[合适/平常/不合适]名次，各组选名次最小者；事或人|调整|选中编号(全排除填0)|事实。') + '调整写+编号/-编号/!编号（加倍/减半/排除），其余原权重，空填0。');
    }
    const result = judge ? '*' : '成/败';
    lines.push('行|难度|不利/中性/有利|' + result + '|事实；战|世界|强弱|临场|对手人数|' + result + '|事实；略或缓|事实。只填适用项，依据一句。');
    lines.push(judge ? '只交裁定行，独立项用分号。不要故事。' :
        '依预设写正文，附一行 <!--FD-' + turn.token + ' 裁定行 -->，可放末尾。');
    return lines.join('\n');
}

function poolVerdict(pool, fields, resolveLocally) {
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
    if (!(resolveLocally && pick === '*') && pick !== (chosen?.code ?? '0')) return null;
    return (kind === '事' ? '事件' : 'NPC 反应') + ' · ' + fact + '。' + (chosen?.name ?? '全部排除，跳过') + '。' + (adjusted.join('、') || '沿用基础权重') + '。';
}

export function confirmVerdict(turn, record, resolveLocally = false) {
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
        if (branch === '检定') summary = checkVerdict(fields, turn.die, resolveLocally);
        if (kind === '事' || kind === '人') summary = poolVerdict(kind === '事' ? turn.events : turn.reactions, fields, resolveLocally);
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
