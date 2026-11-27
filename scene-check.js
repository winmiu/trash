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
        '本轮预掷 d100=' + die + '。先按已知事实选条件，再查表。每项三格依次为临场不利／中性／有利，同一事实只计算一次。',
        '行动：对照任务门槛、人物专长和现场限制选择难度与临场条件。成＝本次尝试成功，败＝本次尝试失败。' + action.join('，'),
        '交锋：先界定本次目标。按世界规则比较双方能力，优先参考已知的可比数值或阶位。没有数值时依据训练、已展示的表现和明确限制作相对判断，再考虑临场状态和实际对手人数。缺少可比较的事实时暂缓判胜负。',
        '交锋表中的数是该格仍可成功的最多对手人数。实际人数在上限以内成功，超过上限失败；0 始终失败，100 表示达到表的上限（百人以上按 100 计）。',
        ...[...tables].map(([table, labels])=>labels.join('/') + '：' + table),
    ].join('\n');
}
