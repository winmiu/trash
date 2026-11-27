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
        '以下只约束本次尝试是否成功。成功与失败的具体后果、严重程度和后续情节全部由主预设结合角色卡和当前剧情决定。保持主预设原有的正文格式，骰点和表格仅供内部使用。',
        '已发生的事实、闲聊、意图或结果已确定的事直接叙述。已实际交锋时判本次局部目标，其他已尝试且有不确定性的事走行动检定。同一件事只判一次。续写承接已经发生的结果。',
        checkInstructions(turn.die),
    ];
    if (turn.events.items.length || turn.reactions.items.length) {
        lines.push('事件和反应是独立的叙事倾向，仅在自然转场或 NPC 确有未决选择时参考。行动或交锋的后果直接交给主预设，不再抽事件或反应。',
            '按当前人设、既有承诺和局势定各项系数：适合用 +（两倍），不适合用 -（半倍），其余无符号（原权重）。从相应候选顺序中取第一项与所选符号相符的编号。',
            describe(turn.events,'事件'), describe(turn.reactions,'NPC 反应'));
    }
    return lines.filter(Boolean).concat('[/公平骰]').join('\n');
}
