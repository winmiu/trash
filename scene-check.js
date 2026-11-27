import { COMBAT_PROFILES, DIFFICULTY, actionOdds, combatOdds } from './engine.js';

const RELATIVE = { '明显劣势':15, '劣势':35, '相当':50, '优势':65, '明显优势':85 };
const WORLDS = { urban:'现实', neutral:'一般', strict:'严格阶位' };
export function compareRoll(die, chance) {
    return 'd100=' + die + '，成功阈值 ' + chance + '%，' + die + (die <= chance ? ' ≤ ' : ' > ') + chance + '，' + (die <= chance ? '成功' : '失败') + '。';
}

export function auditText(verdict) {
    for (const line of verdict ?? []) {
        if (typeof line !== 'string' || !/^(行动|交锋) · /.test(line)) continue;
        // v2.0 and v2.1 stored the same verified calculation using a slash separator.
        const m = /d100=(\d{1,3})(?:，成功阈值 | \/ 阈值 )(\d{1,3})%，(?:\d+ [≤>] \d+，)?(成功|失败)。$/.exec(line);
        if (!m) continue;
        const die = Number(m[1]), chance = Number(m[2]);
        if (die >= 1 && die <= 100 && chance <= 100 && (m[3] === '成功') === (die <= chance)) {
            return line.slice(0,2) + ' · ' + compareRoll(die,chance);
        }
    }
    return '';
}

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
    const label = success ? '成' : '败';
    const reported = result.replace(/成功$/, '成').replace(/失败$/, '败').replace('％','%').replace(/[\s，,]/g,'');
    if (!(resolveLocally && reported === '*') && reported !== label && reported !== chance + '%' + label) return null;
    return (combat ? '交锋' : '行动') + ' · ' + fact + '。' + conditions + '，' + state + '（' + (modifier > 0 ? '+' : '') + modifier + '）。' + compareRoll(die,chance);
}

export function checkInstructions(die) {
    const entries = Object.values(DIFFICULTY);
    return 'd100=' + die + '。行：' + entries.map(d=>d.name).join('/') + '基值' + entries.map(d=>d.base).join('/') +
        '；战：明显劣势/劣势/相当/优势/明显优势基值15/35/50/65/85，每多1人按现实/一般/严格阶位扣17/13/19，最多扣75。行、战均加临场不利/中性/有利=-15/0/+15；交锋3/5/10/50人起封顶40/22/7/1。最后限1～99%，客观不可能固定0%。骰≤阈值成功，否则失败。';
}
