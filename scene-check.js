import { COMBAT_PROFILES, DIFFICULTY, actionOdds, combatOdds } from './engine.js';

const RELATIVE = { '明显劣势':15, '劣势':35, '相当':50, '优势':65, '明显优势':85 };
const WORLDS = { urban:'现实', neutral:'一般', strict:'严格阶位' };
const ADJUSTMENTS = [-15, 0, 15];

export function checkVerdict(fields, die, resolveLocally = false) {
    const [kind, ...args] = fields;
    const combat = kind === '战';
    if (args.length !== (combat ? 6 : 4)) return null;
    const [base, state, result, fact] = combat ? [args[1], args[2], args[4], args[5]] : args;
    const modifier = new Map([['不利', -15], ['中性', 0], ['有利', 15]]).get(state);
    if (modifier === undefined) return null;
    let chance, conditions;
    if (combat) {
        const world = Object.keys(WORLDS).find(key => WORLDS[key] === args[0]);
        if (!world || !Object.hasOwn(RELATIVE, base) || !/^(?:[1-9]\d?|100)$/.test(args[3])) return null;
        chance = combatOdds({relativeBase:RELATIVE[base], modifier, profile:COMBAT_PROFILES[world], opponentCount:Number(args[3])}).probability;
        conditions = [args[0], base, '对手 ' + args[3] + ' 人'].join('，');
    } else {
        const difficulty = Object.keys(DIFFICULTY).find(key => DIFFICULTY[key].name === base);
        if (!difficulty) return null;
        chance = actionOdds({difficulty, modifier}).probability;
        conditions = base;
    }
    const success = die <= chance;
    if (!(resolveLocally && result === '*') && result !== (success ? '成' : '败')) return null;
    return (combat ? '交锋' : '行动') + ' · ' + fact + '。' + conditions + '，' + state + '（' + (modifier > 0 ? '+' : '') + modifier + '）。d100=' + die + ' / 阈值 ' + chance + '%，' + (success ? '成功' : '失败') + '。';
}

export function checkInstructions(die) {
    // Collapse the entire action table into the hardest success for each situation.
    const difficulties = Object.entries(DIFFICULTY);
    const limits = ADJUSTMENTS.map(modifier => {
        const last = difficulties.filter(([difficulty]) => die <= actionOdds({difficulty, modifier}).probability).at(-1);
        return last?.[1].name ?? '无';
    });
    return 'd100=' + die + '。行：很容易/容易/一般/困难/极难，不利/中性/有利下最多成功到' + limits.join('/') +
        '；客观不可能必败。战：明显劣势/劣势/相当/优势/明显优势基值15/35/50/65/85，加临场-15/0/15。每多1人按现实/一般/严格阶位扣17/13/19，最多扣75。3/5/10/50人起封顶40/22/7/1，最后限1～99，骰≤阈值成。';
}
