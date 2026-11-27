import { COMBAT_PROFILES, DIFFICULTY, actionOdds, combatOdds, parseLevel, resolveCheck } from './engine.js';

const RELATIVE = {
    farBelow: { label:'明显劣势', base:15 }, below: { label:'劣势', base:35 },
    even: { label:'相当', base:50 }, above: { label:'优势', base:65 },
    farAbove: { label:'明显优势', base:85 },
};
const SITUATION = { bad:-15, flat:0, good:15 };
const DEGREES = { '成功':'成', '失败':'败', '显著成功':'大成', '严重失利':'大败' };
const WORLDS = { urban:'现代现实', neutral:'一般', strict:'阶位压制', cinematic:'戏剧波动' };

export function sceneChecks(input, die, {action, combat, profile, allowUnknown}) {
    const actorLevel = parseLevel(input.actorLevel), opponentLevel = parseLevel(input.opponentLevel);
    const rated = actorLevel !== null && opponentLevel !== null;
    const count = Math.min(100, Math.max(1, Math.round(Number(input.opponentCount) || 1)));
    const modifier = Math.max(-35, Math.min(35, Math.round(Number(input.modifier) || 0)));
    return {
        die, actorLevel, opponentLevel, modifier,
        foes:count > 1 ? count : null,
        worlds:Object.hasOwn(COMBAT_PROFILES, profile) ? [profile] : ['urban','neutral','strict'],
        action:action ? Object.keys(DIFFICULTY).filter(k=>input.difficulty === 'normal' || input.difficulty === k) : [],
        combat:combat ? (rated ? ['rated'] : [...Object.keys(RELATIVE), ...(allowUnknown ? ['unknown'] : [])]) : [],
    };
}

function combatResult(s, base, state, foes, world) {
    const odds = combatOdds({ actorLevel:s.actorLevel, opponentLevel:s.opponentLevel, opponentCount:foes,
        profile:COMBAT_PROFILES[world], modifier:s.modifier || SITUATION[state], relativeBase:RELATIVE[base]?.base });
    return resolveCheck(odds.probability, s.die);
}

function actionResult(s, base, state) {
    return resolveCheck(actionOdds({difficulty:base, modifier:s.modifier || SITUATION[state]}).probability, s.die);
}

function statesFor(s, base) {
    return s.modifier || base === 'unknown' || base === 'impossible' ? ['flat'] : Object.keys(SITUATION);
}

// List only counts where the result for this die changes. The model does no arithmetic.
function countBands(s, base, state, world) {
    if (s.foes) return DEGREES[combatResult(s, base, state, s.foes, world).degree];
    let start = 1, last = '';
    const bands = [];
    for (let n = 1; n <= 101; n++) {
        const degree = n <= 100 ? DEGREES[combatResult(s, base, state, n, world).degree] : '';
        if (n === 1) last = degree;
        if (degree === last) continue;
        const count = start === 1 && n === 101 ? '' : start === n - 1 ? String(start) : n === 101 ? start + '+' : start + '–' + (n - 1);
        bands.push(count + last);
        start = n;
        last = degree;
    }
    return bands.join(',');
}

export function checkInstructions(s) {
    const lines = [];
    if (!s.action.length && !s.combat.length) return '';
    lines.push('先用角色卡、世界书和已发生的剧情确定分支，再查本机结果。只给最终标签和简短事实。');
    lines.push(s.modifier ? `手动修正 ${s.modifier} 已计入，只填 state=flat。` :
        'state 按不重复的现场条件定：bad 不利、flat 无净影响、good 有利。表中三格按 bad/flat/good 排列，单格只用 flat。成/败/大成/大败指本次行动或交锋结果。');
    if (s.action.length) {
        lines.push('行动树：已尝试且结果有代价 → 按任务门槛选 a-难度 → 以人物相关专长、准备、疲劳等对照门槛选 state。障碍与临场修正分开，同一事实只用一次。前提明确缺失选 none 并遵守既定限制，关键条件不明选 a-hold。');
        lines.push(s.action.map(base => `a-${base}(${DIFFICULTY[base].name})=${statesFor(s,base).map(state=>DEGREES[actionResult(s,base,state).degree]).join('/')}`).join('；'));
    }
    if (s.combat.length) {
        const rated = s.combat.includes('rated');
        lines.push('交锋树：确有对抗 → 界定本次局部目标 → 查世界规则 → 比较双方与该目标有关的能力 → 单算伤势等临场因素与实际参与的对手人数。只判这一合，结果不自动决定整场胜负。');
        if (s.actorLevel !== null || s.opponentLevel !== null) lines.push(`已知手动/本轮数值：行动方 ${s.actorLevel ?? '未知'}，对手 ${s.opponentLevel ?? '未知'}。只把未知一侧当未知。`);
        lines.push(rated ? '双方数值齐全用 c-rated，现场仍可影响结果。' :
            '优先比较可比数值或已写明的阶位。没有可比数值时，用双方具体表现、训练或明确能力选择相对优势档。优势属于本次目标，禁止编造永久战力。无数字本身不构成暂缓理由。有证据能看出接近才选 even。');
        lines.push('确实缺少比较依据或人数不明且会决定结果，选 c-hold，写当前可确定的进展。' +
            (s.combat.includes('unknown') ? '用户也允许 c-unknown 中性估算，此项须标明缺失事实。' : ''));
        lines.push(s.foes ? `实际采用的手动对手人数 foes=${s.foes}。` : 'foes 填本次实际参与的对手人数，独自一人填 1，百人以上统一填 100。人数只计一次。');
        lines.push('world 取 ' + s.worlds.map(w=>w+'='+WORLDS[w]).join('、') + '。同一行各格内按对手人数查结果，例如 1成,2+败。');
        // Collapse identical lookup tables across world rules for this particular roll.
        const tables = new Map();
        for (const w of s.worlds) {
            const table = s.combat.map(base => {
                const label = RELATIVE[base]?.label ?? (base === 'rated' ? '按数值' : '中性估算');
                return `c-${base}(${label})=${statesFor(s,base).map(state=>countBands(s,base,state,w)).join('/')}`;
            }).join('；');
            tables.set(table, [...(tables.get(table) || []), w]);
        }
        for (const [table, worlds] of tables) lines.push(worlds.join('/') + '：' + table);
    }
    lines.push('行动或交锋记录另填 actor（行动方可观察事实）、opposition（障碍或对手事实）、state、result（照抄所用格的成/败/大成/大败）。交锋另填 world、foes。why 简述临场条件。暂缓只需 why 说明缺什么。');
    if (s.combat.length) lines.push('交锋记录字段示意：{"use":"c-档位","actor":"行动方事实","opposition":"对手事实","state":"flat","world":"' + s.worlds[0] + '","foes":1,"result":"成","why":"现场事实"}。替换为本轮真实类别和内容。');
    return lines.join('\n');
}

function fact(value) {
    return typeof value === 'string' ? value.replace(/[<>\x00-\x1f\x7f]/g, ' ').trim().slice(0, 90) : '';
}

export function confirmCheck(s, v) {
    const combat = v.use.startsWith('c-');
    const bases = combat ? s.combat : s.action;
    const base = v.use.slice(2);
    if (!bases.length) return null;
    const kind = combat ? '交锋' : '行动';
    const why = fact(v.why);
    if (base === 'hold') return why ? {kind, pending:true, summary:kind+'暂缓，未掷胜负。依据：'+why} : null;
    const actor = fact(v.actor), opposition = fact(v.opposition);
    if (!bases.includes(base) || !statesFor(s,base).includes(v.state) || !actor || !opposition || !why) return null;
    if (combat && (!s.worlds.includes(v.world) || !Number.isInteger(v.foes) || v.foes < 1 || v.foes > 100 || (s.foes && s.foes !== v.foes))) return null;
    const result = combat ? combatResult(s, base, v.state, v.foes, v.world) : actionResult(s,base,v.state);
    const label = combat ? (RELATIVE[base]?.label ?? (base === 'rated' ? '已知数值' : '低置信中性估算')) : DIFFICULTY[base].name;
    const modifier = s.modifier || SITUATION[v.state];
    const conditions = (combat ? WORLDS[v.world] + '，对手 ' + v.foes + ' 人，' : '') + '修正 ' + (modifier > 0 ? '+' : '') + modifier;
    const summary = `${kind}「${label}」${conditions}。d100=${result.roll} / ${result.chance}%，${result.degree}。行动方：${actor}。${combat ? '对手' : '障碍'}：${opposition}。现场：${why}`;
    return { kind, base, state:v.state, modifier, actor, opposition, why, ...(combat ? {world:v.world, foes:v.foes} : {}), ...result, outcome:DEGREES[result.degree], summary };
}
