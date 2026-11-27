import { COMBAT_PROFILES, DIFFICULTY, actionOdds, combatOdds } from './engine.js';

const RELATIVE = { '明显劣势':15, '劣势':35, '相当':50, '优势':65, '明显优势':85 };
const WORLDS = { urban:'现实', neutral:'一般', strict:'严格阶位' };
const ADJUSTMENTS = [-15, 0, 15];

// With fixed abilities and conditions, facing more opponents cannot improve the odds.
function maxWinningCount(die, relativeBase, modifier, profile) {
    let low = 0, high = 100;
    while (low < high) {
        const count = Math.ceil((low + high) / 2);
        const { probability } = combatOdds({relativeBase, modifier, profile, opponentCount:count});
        if (die <= probability) low = count;
        else high = count - 1;
    }
    return low;
}

export function checkInstructions(die) {
    const action = Object.entries(DIFFICULTY).map(([difficulty, entry]) => {
        const cells = ADJUSTMENTS.map(modifier => die <= actionOdds({difficulty, modifier}).probability ? '成' : '败');
        return entry.name + '=' + cells.join('/');
    });
    const tables = new Map();
    for (const [world, label] of Object.entries(WORLDS)) {
        const table = Object.entries(RELATIVE).map(([band, base]) => {
            const counts = ADJUSTMENTS.map(mod => maxWinningCount(die, base, mod, COMBAT_PROFILES[world]));
            return band + '=' + counts.join('/');
        }).join('，');
        tables.set(table, [...(tables.get(table) || []), label]);
    }
    return [
        '本轮预掷 d100=' + die + '。先依事实选档再查表，不能按想要的结果倒选。每项三格依次为临场不利／中性／有利，同一事实只计算一次。',
        '行动：先按任务本身的门槛选难度，再用此人的相关专长、准备、工具及疲劳选临场格。必需前提明确缺失时遵守限制；关键事实未知且会改变结论时，只写眼下可确定的进展。成＝本次尝试成功，败＝本次尝试失败。' + action.join('，'),
        '交锋：先定这一合争什么，按世界规则选表。比较与该目标有关的双方能力：有可比数值或阶位就用；没有数值就用人设、训练和已展示的表现选相对强弱档。按伤势、地利等选临场格，只计实际参与的对手。实力相当须有依据；关键信息不足时暂缓胜负，不编造战力。',
        '交锋表中的数是该格仍可成功的最多对手人数。实际人数在上限以内成功，超过上限失败；0 始终失败，100 表示达到表的上限（百人以上按 100 计）。',
        ...[...tables].map(([table, labels])=>labels.join('/') + '：' + table),
    ].join('\n');
}
