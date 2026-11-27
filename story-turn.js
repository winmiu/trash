import { checkInstructions } from './scene-check.js';

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
    const names = pool.items.map(row => row.code + '=' + row.name + (row.note ? '（' + row.note + '）' : ''));
    return title + '：' + names.join('、') + '\n候选顺序：' + pool.order.join(' ');
}

export function storyPrompt(turn) {
    const lines = [
        '[公平骰 · 当前正文输入]',
        '结合本轮输入、角色卡、世界设定和最新剧情，先找出仍未确定的问题。闲聊、打算和已确定的结果直接承接。角色能力、关系、承诺或处境改变时，按眼下事实重新判断。',
        '实际对抗走交锋，其他已经尝试且有不确定性的目标走行动。同一问题只判一次，续写承接已发生的结果。对各方采用相同标准，保留玩家的下一步选择。',
        '行动与交锋只定本次目标的成败。具体后果、严重程度和后续情节全部由主预设决定。按主预设原有格式生成正文，判定过程、骰点、编号和结果记录均不输出。',
        checkInstructions(turn.die),
    ];
    if (turn.events.items.length) {
        lines.push('事件走向：只在自然转场且走向未定时使用。按时间、地点、世界规则及未完事务衡量各项，有充分理由延续当前情境时直接延续。', describe(turn.events, '事件'));
    }
    if (turn.reactions.items.length) {
        lines.push('NPC 反应：只在人物面临未决选择时使用。按其动机、与对方的关系、既有承诺及眼前代价衡量各项。已确定的回应直接承接。', describe(turn.reactions, 'NPC 反应'));
    }
    if (turn.events.items.length || turn.reactions.items.length) {
        lines.push('逐项根据当前事实定系数：矛盾或不可能的排除，较合适用 +（基础权重×2），较不合适用 -（×0.5），其余无符号（×1）。每组从候选顺序中取首个编号与其所定符号吻合的条目；全排除则跳过。每轮重评。',
            '各组只处理各自独立的未决问题。行动或交锋的后果由主预设写，不为同一个结果再抽一次。');
    }
    return lines.filter(Boolean).concat('[/公平骰]').join('\n');
}
