/** Fair Dice rule engine (no DOM, no ST APIs). */
export const TIERS = [
    { name: '凡人', min: 0, max: 0 },
    { name: '启武', min: 1, max: 20 },
    { name: '凝劲', min: 21, max: 40 },
    { name: '化劲', min: 41, max: 60 },
    { name: '归真', min: 61, max: 80 },
    { name: '极意', min: 81, max: 100 },
];
export const COMBAT_PROFILES = {
    urban: { name: '现实/现代（不强制武侠阶位）', tierImpact: 0, statImpact: 0.6, outnumbered: 17, twoTierCap: 10, extremeCap: 3, useTierCaps: false },
    neutral: { name: '公平标准（默认）', tierImpact: 18, statImpact: 0.42, outnumbered: 13, twoTierCap: 10, extremeCap: 3 },
    strict: { name: '战力严谨（强阶位压制）', tierImpact: 24, statImpact: 0.45, outnumbered: 19, twoTierCap: 5, extremeCap: 1 },
    cinematic: { name: '戏剧波动（弱化阶位差）', tierImpact: 12, statImpact: 0.28, outnumbered: 11, twoTierCap: 17, extremeCap: 7 },
};
export const DIFFICULTY = {
    trivial: { name: '很容易', base: 90 }, easy: { name: '容易', base: 70 },
    normal: { name: '一般', base: 50 }, hard: { name: '困难', base: 30 },
    extreme: { name: '极难', base: 10 }, impossible: { name: '客观不可能', base: 0 },
};
const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));
export function parseLevel(input) {
    if (input === '' || input === null || input === undefined) return null;
    const value = Number(input);
    return Number.isFinite(value) && value >= 0 && value <= 100 ? Math.round(value) : null;
}
export function tierIndex(level) {
    if (level === null || level === undefined) return null;
    const n = parseLevel(level);
    if (n === null) return null;
    return TIERS.findIndex(x => n >= x.min && n <= x.max);
}
export function tierName(level) {
    const idx = tierIndex(level);
    return idx === null || idx < 0 ? '未知' : TIERS[idx].name;
}
export function detectKind(userText = '', assistantText = '') {
    // Most classifications use the current player's action, not random mentions in a past scene.
    const text = String(userText).slice(-1300);
    const support = String(assistantText).slice(-1000);
    const battle = /(拔剑|挥剑|出拳|出掌|挥刀|开枪|射击|闪避|格挡|冲锋|交手|对打|出手攻击|攻击(他|她|对方|敌人)|发动攻势|被(袭击|打|刺)|偷袭|fight\b|attack\b|strike\b|shoot\b|duel\b|punch\b)/i;
    const action = /(试图|尝试|能否|可否|试着|想要说服|请求(他|她|对方)|劝说|调查|潜入|偷取|撬开|开锁|追踪|逃脱|避开守卫|谈判|说服|查找线索|破解|欺骗|掩饰|寻找证据|attempt\b|persuade\b|convince\b|sneak\b|escape\b|investigate\b|pick.*lock\b)/i;
    const negated = /(没有(打架|交手|攻击)|不(攻击|动手)|只是(聊天|看着)|不想打|without fighting|no fighting)/i;
    if (battle.test(text) && !negated.test(text)) return 'combat';
    if (action.test(text)) return 'action';
    // An established ongoing battle can continue on a short next-user choice such as '继续'.
    if (/^(继续|再来一次|乘胜追击|防守|撤退|反击|继续战斗)[。.!！\s]*$/.test(text.trim()) && battle.test(support)) return 'combat';
    return 'narrative';
}
export function combatOdds({ actorLevel = null, opponentLevel = null, opponentCount = 1, modifier = 0, profile = COMBAT_PROFILES.neutral } = {}) {
    const a = parseLevel(actorLevel), b = parseLevel(opponentLevel);
    const knownA = a !== null, knownB = b !== null;
    const group = clamp(Math.round(Number(opponentCount) || 1), 1, 100);
    const mod = clamp(Number(modifier) || 0, -35, 35);
    let probability = 50 + mod;
    let diff = null;
    if (knownA && knownB) {
        diff = tierIndex(a) - tierIndex(b);
        probability += (a - b) * profile.statImpact + diff * profile.tierImpact;
        // Hard ceilings: being severely outclassed cannot be overcome by narrative favoritism.
        if (profile.useTierCaps !== false) {
            if (diff <= -3) probability = Math.min(probability, profile.extremeCap);
            else if (diff <= -2) probability = Math.min(probability, profile.twoTierCap);
            if (diff >= 3) probability = Math.max(probability, 100 - profile.extremeCap);
            else if (diff >= 2) probability = Math.max(probability, 100 - profile.twoTierCap);
        }
    }
    probability -= Math.min(75, (group - 1) * profile.outnumbered);
    // No mortal faces dozens of organized combatants with a normal win chance.
    if (group >= 50) probability = Math.min(probability, 1);
    else if (group >= 10) probability = Math.min(probability, 7);
    else if (group >= 5) probability = Math.min(probability, 22);
    else if (group >= 3) probability = Math.min(probability, 40);
    const cap = clamp(Math.round(probability), 1, 99);
    return { probability: cap, knownA, knownB, actorLevel: a, opponentLevel: b, tierGap: diff, opponentCount: group, modifier: mod, certainty: knownA && knownB ? '基于给定能力值' : '能力资料不足，临时中立基准（仅供测试）' };
}
export function actionOdds({ difficulty = 'normal', modifier = 0, impossible = false } = {}) {
    const key = Object.hasOwn(DIFFICULTY, difficulty) ? difficulty : 'normal';
    const mod = clamp(Number(modifier) || 0, -35, 35);
    const base = DIFFICULTY[key].base;
    const probability = impossible || key === 'impossible' ? 0 : clamp(base + mod, 1, 99);
    return { probability: Math.round(probability), difficulty: key, difficultyName: DIFFICULTY[key].name, modifier: mod };
}
export function rollD100(random = Math.random) {
    return clamp(Math.floor(random() * 100) + 1, 1, 100);
}
export function resolveCheck(probability, dice) {
    const chance = clamp(Math.round(Number(probability) || 0), 0, 100);
    const roll = clamp(Math.round(Number(dice) || 1), 1, 100);
    const success = roll <= chance;
    let degree = success ? '成功' : '失败';
    if (success && roll <= 5 && chance >= 5) degree = '显著成功';
    else if (!success && roll >= 96 && chance <= 95) degree = '严重失利';
    return { chance, roll, success, degree, margin: chance - roll };
}
export function isValidAssessment(obj) {
    if (!obj || typeof obj !== 'object' || Array.isArray(obj)) return false;
    return ['combat', 'action', 'narrative', 'none'].includes(obj.kind);
}
