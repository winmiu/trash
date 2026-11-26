import { COMBAT_PROFILES, DIFFICULTY, detectKind, combatOdds, actionOdds, rollD100, resolveCheck, parseLevel, isValidAssessment } from './engine.js';
import { beginRun, assessmentText, resultText, errorText, RefereeStopped } from './run-log.js';
import { requestReferee } from './referee-request.js';
/**
 * Fair Dice v1.4.2 — independent SillyTavern UI extension with optional GM adjudication.
 * Native ST prompt interceptor, no remote calls and no character-card mutation.
 * Installed in data/<user>/extensions/fair-dice or public/scripts/extensions/third-party/fair-dice.
 */
const MODULE_KEY = 'fair_dice_winmiu_v1';
const PROMPT_KEY = 'fair_dice_winmiu_injection_v1';
const EVENT_DEPTH = 0;
const IN_CHAT = 1; // SillyTavern release extension_prompt_types.IN_CHAT
const SYSTEM_ROLE = 0;
const MAX_ROWS = 20;
const WEIGHT_STEP = 5;

const BUILT_INS = Object.freeze({
    balanced: {
        label: '公平中立 · 默认',
        events: [
            ['continue', '延续当前情境', '不强制添加新事件；让当前对话和事务自然继续。', 65],
            ['daily', '日常生活变化', '工作、娱乐、天气、生活细节出现自然变化。', 13],
            ['npc', 'NPC独立事务', '其他人物推进自己的生活、目标或关系，不围绕玩家。', 9],
            ['social', '社交摩擦', '产生合理误解、分歧或条件，允许无冲突解决。', 7],
            ['world', '外部世界动向', '外界势力、事业或公共事务自主变化。', 4],
            ['chance', '偶然机遇', '获得一个不保证有利于任何人的新机会。', 2],
        ],
        reactions: [
            ['observe', '维持立场／观望', 'NPC根据自己的目标判断，不急于配合。', 35],
            ['trade', '提出条件／协商', 'NPC可谈判、交换利益或要求可信的理由。', 30],
            ['decline', '合理拒绝', 'NPC可有礼或明确地拒绝，非故意刁难玩家。', 25],
            ['help', '有理由地帮助', '仅在立场、关系、代价合理时给予帮助。', 10],
        ],
    },
    slice: {
        label: '生活日常 · 低冲突',
        events: [
            ['continue', '延续当前情境', '优先完成当前事务，不频繁制造波折。', 70],
            ['daily', '日常生活变化', '日常工作、朋友聚会、散步、休闲和琐事。', 15],
            ['npc', 'NPC独立事务', '配角有自己的休息、兴趣和普通生活。', 8],
            ['social', '社交摩擦', '轻微分歧或不方便，不升级为狗血冲突。', 4],
            ['world', '外部世界动向', '新闻、工作和当地环境自然改变。', 2],
            ['chance', '偶然机遇', '偶然认识人或发现新活动。', 1],
        ],
        reactions: [
            ['observe', '维持立场／观望', '不因玩家身份改变自己的想法。', 42],
            ['trade', '提出条件／协商', '有礼而具体地沟通现实条件。', 28],
            ['decline', '合理拒绝', '可以拒绝，但不会为了戏剧性找茬。', 20],
            ['help', '有理由地帮助', '帮助必须符合NPC动机。', 10],
        ],
    },
    dynamic: {
        label: '变化较多 · 剧情向',
        events: [
            ['continue', '延续当前情境', '不打断重要的现有情节。', 40],
            ['daily', '日常生活变化', '生活与工作出现新线索。', 16],
            ['npc', 'NPC独立事务', '其他人物更积极推进个人目标。', 16],
            ['social', '社交摩擦', '可能出现社交矛盾、竞争或谈判。', 13],
            ['world', '外部世界动向', '外部事务带来变化，但不能违反既定时间线。', 10],
            ['chance', '偶然机遇', '出现合理的巧合或意外转机。', 5],
        ],
        reactions: [
            ['observe', '维持立场／观望', 'NPC有独立决定的权利。', 25],
            ['trade', '提出条件／协商', 'NPC按照自己的利益谈判。', 35],
            ['decline', '合理拒绝', 'NPC可以拒绝不合理请求。', 30],
            ['help', '有理由地帮助', '帮助需要有明确动机。', 10],
        ],
    },
});

const DEFAULTS = {
    enabledChats: {},
    chatProfiles: {}, // Per-chat event/NPC weights; no cross-character pollution.
    activePreset: 'balanced',
    events: [],
    reactions: [],
    customProfile: null,
    fairness: true,
    autoJudge: true, // Recommended: independent referee classifies before rolling; extra model call when enabled for the chat.
    eventDice: true,
    npcDice: true,
    actionDice: true,
    combatDice: true,
    allowUnknownCombat: false,
    combatProfile: 'auto',
    modeByChat: {},
    manualChecks: {},
    assessments: {},
    rolls: {},
    queued: {},
};

let initialized = false;
let activationRegistered = false;
let extensionActive = true;
let root = null;
let listenersAttached = false;
let normalizedReference = null;
let refereeBusy = false; // Guard against quiet-generation implementations invoking interceptors recursively.
const waitingForInterceptor = new Map();
const generationNames = { normal: '正常生成', regenerate: '重新生成', swipe: '切换候选回复', continue: '继续生成' };

function startLog(cfg, key, title) {
    return beginRun(cfg, key, title, () => {
        persist();
        if (key === chatKey()) renderRunLog();
    });
}

function generationStarted(type = 'normal', _options, dryRun) {
    if (dryRun || refereeBusy || ['quiet', 'impersonate'].includes(type) || !isEnabledHere()) return;
    const key = chatKey();
    const previous = waitingForInterceptor.get(key);
    if (previous) previous.log('下一次生成已开始，上一次没有进入自动判定。', 'notice');
    const log = startLog(initSettings(), key, generationNames[type] || '酒馆生成');
    waitingForInterceptor.set(key, { type, log });
    log('酒馆开始生成，等待进入公平骰子的判定步骤。');
}

function generationEnded() {
    const key = chatKey();
    const pending = waitingForInterceptor.get(key);
    if (!pending || refereeBusy) return;
    waitingForInterceptor.delete(key);
    pending.log('酒馆生成已停止或结束，本次没有进入公平骰子的判定步骤。', 'notice');
}

function chatChanged() {
    const current = chatKey();
    for (const [key, pending] of waitingForInterceptor) {
        if (key === current) continue;
        waitingForInterceptor.delete(key);
        pending.log('已切换聊天，切换前未收到判定回调。', 'notice');
    }
    clearInjection();
    renderRows();
    updateScope();
}

function clone(x) { return JSON.parse(JSON.stringify(x)); }
function context() {
    try { return globalThis.SillyTavern?.getContext?.() ?? null; }
    catch { return null; }
}
function digits(v, fallback = 0) {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(200, Math.max(0, Math.round(n))) : fallback;
}
function cleanText(v, max = 160) {
    return String(v ?? '').replace(/[\x00-\x1f\x7f<>]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, max);
}
function rowsFromPreset(tupleRows) {
    return tupleRows.map(([id, name, note, weight]) => ({ id, name, note, weight, enabled: true }));
}
function normalizeRows(rows, fallbackRows) {
    if (!Array.isArray(rows)) return clone(fallbackRows);
    return rows.slice(0, MAX_ROWS).map((r, i) => ({
        id: cleanText(r?.id, 60) || `custom_${i}`,
        name: cleanText(r?.name, 48) || `项目 ${i + 1}`,
        note: cleanText(r?.note, 160),
        weight: digits(r?.weight, 10),
        enabled: r?.enabled !== false,
    }));
}
function initSettings() {
    const ctx = context();
    if (!ctx?.extensionSettings) return null;
    let data = ctx.extensionSettings[MODULE_KEY];
    let justCreated = false;
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
        justCreated = true;
        data = clone(DEFAULTS);
        ctx.extensionSettings[MODULE_KEY] = data;
    }
    for (const [k, v] of Object.entries(DEFAULTS)) {
        if (!Object.hasOwn(data, k)) data[k] = clone(v);
    }
    if (justCreated) {
        data.events = rowsFromPreset(BUILT_INS.balanced.events);
        data.reactions = rowsFromPreset(BUILT_INS.balanced.reactions);
    }
    // Keep object identity stable: UI event handlers hold live row references.
    if (normalizedReference !== data) {
        data.events = normalizeRows(data.events, rowsFromPreset(BUILT_INS.balanced.events));
        data.reactions = normalizeRows(data.reactions, rowsFromPreset(BUILT_INS.balanced.reactions));
        // Earlier releases saved unsuccessful requests as rolls and even let them be locked.
        for (const [key, saved] of Object.entries(data.rolls || {})) {
            if (saved?.bundle?.judgeError) delete data.rolls[key];
        }
        for (const [key, bundle] of Object.entries(data.queued || {})) {
            if (bundle?.judgeError) delete data.queued[key];
        }
        normalizedReference = data;
    }
    if (!data.enabledChats || typeof data.enabledChats !== 'object') data.enabledChats = {};
    if (!data.rolls || typeof data.rolls !== 'object') data.rolls = {};
    if (!data.queued || typeof data.queued !== 'object') data.queued = {};
    for (const key of ['modeByChat','manualChecks','assessments','chatProfiles']) if (!data[key] || typeof data[key] !== 'object') data[key] = {};
    return data;
}
/** Every chat owns its own weighted story profile. Legacy settings provide the migration baseline. */
function profileFor(cfg, key = chatKey()) {
    if (!key) return cfg;
    if (!cfg.chatProfiles || typeof cfg.chatProfiles !== 'object') cfg.chatProfiles = {};
    if (!cfg.chatProfiles[key]) {
        cfg.chatProfiles[key] = {
            activePreset: cfg.activePreset || 'balanced',
            events: clone(cfg.events || rowsFromPreset(BUILT_INS.balanced.events)),
            reactions: clone(cfg.reactions || rowsFromPreset(BUILT_INS.balanced.reactions)),
            customProfile: cfg.customProfile ? clone(cfg.customProfile) : null,
        };
    }
    return cfg.chatProfiles[key];
}
function persist() { try { context()?.saveSettingsDebounced?.(); } catch (e) { console.warn('[Fair Dice] save', e); } }
function chatKey() {
    const c = context();
    if (!c?.chatId) return '';
    if (c.groupId) return `group:${c.groupId}:${c.chatId}`;
    if (c.characterId === undefined || c.characterId === null) return '';
    const filename = c.characters?.[c.characterId]?.avatar || `index_${c.characterId}`;
    return `char:${filename}:${c.chatId}`;
}
function isEnabledHere() {
    const cfg = initSettings();
    const key = chatKey();
    return Boolean(extensionActive && cfg && key && cfg.enabledChats[key]);
}
function clearInjection() {
    try {
        const c = context();
        if (!c) return;
        c.setExtensionPrompt?.(PROMPT_KEY, '', IN_CHAT, EVENT_DEPTH, false, SYSTEM_ROLE);
        // Avoid even an empty prompt record being retained on versions that support this.
        if (c.extensionPrompts && Object.hasOwn(c.extensionPrompts, PROMPT_KEY)) {
            delete c.extensionPrompts[PROMPT_KEY];
        }
    } catch (error) { console.warn('[Fair Dice] clear prompt', error); }
}
function writeInjection(value) {
    const c = context();
    if (typeof c?.setExtensionPrompt !== 'function') return false;
    c.setExtensionPrompt(
        PROMPT_KEY, value, IN_CHAT, EVENT_DEPTH, false, SYSTEM_ROLE,
        () => isEnabledHere(),
    );
    return true;
}
function rand01() {
    if (globalThis.crypto?.getRandomValues) {
        const a = new Uint32Array(1);
        globalThis.crypto.getRandomValues(a);
        return a[0] / 4294967296;
    }
    return Math.random();
}
function activeRows(rows) {
    return (rows ?? []).filter(x => x.enabled && x.weight > 0 && cleanText(x.name).length > 0);
}
function draw(rows) {
    const available = activeRows(rows);
    const total = available.reduce((acc, x) => acc + x.weight, 0);
    if (!total) return null;
    let cursor = rand01() * total;
    for (const r of available) {
        cursor -= r.weight;
        if (cursor < 0) return { id: r.id, name: r.name, note: r.note, pct: r.weight / total * 100 };
    }
    const r = available[available.length - 1];
    return { id: r.id, name: r.name, note: r.note, pct: r.weight / total * 100 };
}
function currentUserText() {
    const chat = context()?.chat;
    if (!Array.isArray(chat)) return '';
    return String([...chat].reverse().find(m => m?.is_user)?.mes || '');
}
function recentAssistantText() {
    const chat = context()?.chat;
    if (!Array.isArray(chat)) return '';
    return String([...chat].reverse().find(m => m && !m.is_user)?.mes || '');
}
function checkMode(cfg, key) {
    const forced = cfg.modeByChat?.[key] || 'auto';
    if (['narrative','action','combat'].includes(forced)) return forced;
    const assessed = cfg.assessments?.[key];
    if (assessed?.round === roundKey() && ['narrative','action','combat'].includes(assessed.kind)) return assessed.kind;
    return detectKind(currentUserText(), recentAssistantText());
}
function inputForChat(cfg, key) {
    return { actorLevel:null, opponentLevel:null, opponentCount:1, modifier:0, difficulty:'normal', ...(cfg.manualChecks?.[key]||{}) };
}
function prepareCheck(cfg, key, mode) {
    const custom = inputForChat(cfg,key);
    const assessed = cfg.assessments?.[key]?.round === roundKey() ? cfg.assessments[key] : null;
    const kind = mode === 'combat' ? 'combat' : 'action';
    const modifier = Number.isFinite(Number(custom.modifier)) ? Number(custom.modifier) : 0;
    let odds;
    if (kind === 'combat') {
        const judgeSetting = assessed?.setting || 'unknown';
        const inferredProfile = judgeSetting === 'modern' ? 'urban' : judgeSetting === 'martial' ? 'strict' : 'neutral';
        const effectiveProfile = cfg.combatProfile === 'auto' ? inferredProfile : cfg.combatProfile;
        odds = combatOdds({
            actorLevel: custom.actorLevel ?? assessed?.actorLevel ?? null,
            opponentLevel: custom.opponentLevel ?? assessed?.opponentLevel ?? null,
            opponentCount: custom.opponentCount !== 1 ? custom.opponentCount : (assessed?.opponentCount ?? 1),
            modifier: modifier || assessed?.modifier || 0,
            profile: COMBAT_PROFILES[effectiveProfile] ?? COMBAT_PROFILES.neutral,
        });
    } else {
        odds = actionOdds({
            difficulty: custom.difficulty !== 'normal' ? custom.difficulty : (assessed?.difficulty ?? 'normal'),
            modifier: modifier || assessed?.modifier || 0,
        });
    }
    const pending = kind === 'combat' && (!odds.knownA || !odds.knownB) && !cfg.allowUnknownCombat;
    return { kind, odds, ...(pending ? { chance:null, roll:null, success:null, degree:'待评估', margin:null } : resolveCheck(odds.probability, rollD100())), pending, assessment: assessed?.summary || '', evaluated: Boolean(assessed) };
}
function drawBundle(cfg, key) {
    const profile = profileFor(cfg, key);
    const mode = checkMode(cfg, key);
    // A valid independent GM assessment can veto unnecessary rolls. No AI may invent dice.
    const judgement = cfg.assessments?.[key]?.round === roundKey() ? cfg.assessments[key] : null;
    const guarded = Boolean(cfg.autoJudge && judgement);
    const skipped = Boolean(guarded && !judgement.shouldRoll);
    return {
        mode,
        skipped,
        judgeError: guarded ? judgement.error || '' : '',
        rationale: guarded ? judgement.summary : '',
        event: !skipped && mode === 'narrative' && cfg.eventDice && (!guarded || judgement.eventRelevant) ? draw(profile.events) : null,
        reaction: !skipped && mode === 'narrative' && cfg.npcDice && (!guarded || judgement.npcRelevant) ? draw(profile.reactions) : null,
        check: !skipped && ((mode === 'combat' && cfg.combatDice) || (mode === 'action' && cfg.actionDice)) ? prepareCheck(cfg, key, mode) : null,
        timestamp: Date.now(),
    };
}
function stringHash(s) {
    let h = 2166136261;
    for (let i = 0; i < s.length; i++) {
        h ^= s.charCodeAt(i);
        h = Math.imul(h, 16777619);
    }
    return (h >>> 0).toString(36);
}
function roundKey() {
    const chat = context()?.chat;
    if (!Array.isArray(chat)) return 'empty';
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.is_user) return `user:${i}:${stringHash(String(m.mes ?? ''))}`;
    }
    return `intro:${chat.length}`;
}
function useRoll(cfg, key) {
    const rk = roundKey();
    const cached = cfg.rolls[key];
    if (cached?.round === rk && cached?.bundle) return cached.bundle;
    const bundle = cfg.queued[key] || drawBundle(cfg, key);
    delete cfg.queued[key];
    if (bundle.judgeError) return bundle;
    cfg.rolls[key] = { round: rk, bundle };
    // Keep cache small; only most recent round per chat.
    const keys = Object.keys(cfg.rolls);
    if (keys.length > 60) for (const old of keys.slice(0, keys.length - 60)) delete cfg.rolls[old];
    persist();
    return bundle;
}
function buildPrompt(cfg, bundle) {
    const lines = ['[Fair Dice | 内部概率判定；不要作为正文显示]'];
    if (cfg.fairness) lines.push('通用公平原则：玩家与NPC不享有叙事特权。按能力、动机、准备、装备、阶位、人数、伤势与既定事实裁定。不得因为玩家是主角就让敌人降智、自动失败、无理由帮助；也不得恶意刁难玩家。');
    if (bundle.judgeError) lines.push('裁判评估未完成，本轮没有骰点；不要编造结果。');
    else if (bundle.skipped) lines.push(`独立裁判：本轮没有有意义的不确定行动或自然转场，不要凭空掷骰、强行插入事件或决定NPC突然转变。${cleanText(bundle.rationale,130)}`);
    if (bundle.check) {
        const c = bundle.check;
        if (c.kind === 'combat') {
            const o = c.odds;
            const a = o.knownA ? String(o.actorLevel) : '未知';
            const b = o.knownB ? String(o.opponentLevel) : '未知';
            if (c.pending) lines.push(`本轮检测到战斗，但行动方战力=${a}、对手战力=${b}，尚无足够依据进行概率裁决。暂缓硬判；不要凭主角身份认定输赢，不要暗中伪造骰子。可由玩家在插件中提供数值或点击AI评估后重新掷骰。`);
            else lines.push(`战斗交锋判定：行动方战力=${a}/100，对手战力=${b}/100，对手人数=${o.opponentCount}，临场修正=${o.modifier}；胜出概率${c.chance}%，独立d100=${c.roll}，结果=${c.degree}。`);
            if (!o.knownA || !o.knownB) lines.push('能力证据不全：此骰仅为低置信度暂定结果。请以人物已写明的真实能力和实战条件复核，不能凭此把普通人升格为高手。');
            lines.push('按单次交锋解释结果，不得自动判定整场战斗胜负或直接决定生死；高阶压制、疲劳、数量和武器差异应真实体现。即使最高战力也不得无根据地单人正面打败成建制百人。');
        } else {
            lines.push(`非战斗行动检定：${c.odds.difficultyName}，条件修正=${c.odds.modifier}；成功概率${c.chance}%，独立d100=${c.roll}，结果=${c.degree}。`);
            lines.push('将结果用于这次明确的行动尝试；失败可带来局部代价、延误、被拒或线索不足，不自动等于受伤或死亡。客观不可能的行为不能靠骰子成功。');
        }
        if (c.assessment) lines.push(`临时场景证据：${cleanText(c.assessment,180)}；该评估不是永久角色设定。`);
    }
    if (cfg.eventDice && bundle.event) lines.push(`日常事件权重抽签：${cleanText(bundle.event.name,48)}。${cleanText(bundle.event.note,160)}。仅在自然转场或合适时机采用；不是强制突然加戏。`);
    if (cfg.npcDice && bundle.reaction) lines.push(`NPC选择倾向抽签：${cleanText(bundle.reaction.name,48)}。${cleanText(bundle.reaction.note,160)}。只影响未定选择，不推翻已成立的人设和承诺。`);
    if (lines.length === 1) return '';
    lines.push('遵守角色卡、世界书、时代和用户输入的既成事实；不代替玩家发言、行动或决定内心；不要在回复中展示判定规则、数字或幕后提示。');
    lines.push('[/Fair Dice]');
    return lines.join('\n');
}

// Independent GM preflight. This is a short, auditable ruling, NOT model private chain-of-thought.
// It uses the current chat+card context through the documented SillyTavern quiet generation API.
const JUDGE_PROMPT = `你是一名独立的桌面角色扮演裁判，而非叙事者或角色扮演者。
目标：不偏袒{{user}}也不偏袒NPC；依据角色卡、世界书、当前实际动作、已发生事实、装备和人数判定是否需要一次客观检定。
必须区分：
1. 普通交流、已知必然事实、尚未执行的打算：shouldRoll=false；不能为了制造戏剧性强行摇骰。
2. 未定的自然场景转场：kind=narrative，可选择eventRelevant=true；只有确实有NPC未定选择时npcRelevant=true。
3. 具体而有不确定性的谈判、调查、尝试：kind=action，difficulty=trivial/easy/normal/hard/extreme/impossible。
4. 已开始的本次交锋：kind=combat；根据人物设定的等级/武艺、训练、武器、伤势、人数评估有效战力0-100。如卡上已有明确数值，直接采用；可以由证据合理估算但不能以玩家身份推定更强。无依据则null；不允许无根据一敌百。
5. 只裁定用户已经明确尝试的动作，不代替用户决定后续行动，不预设成功与否，不报骰点，不续写剧情。
额外判断该角色世界观是modern（现代现实）、martial（武侠有武力阶位）、fantasy（魔法/异能）、unknown（无证据），不要把武侠阶位强塞给纽约等现代社会。
对战力0-100数据逐人标记来源：actorSource/opponentSource为explicit（角色卡明确数值）、inferred（基于已写明训练、武器、伤势合理估算）、unknown（没有资料）。估算必须各自给出具体人物证据actorEvidence/opponentEvidence，并注明actorConfidence/opponentConfidence为high/medium/low；证据不足或low时，战力必须null。不可为玩家或重要NPC自动提高估算值。人物明确不存在的能力、超能力、魔法，不能凭叙事需要添加。
JSON字段：{"setting":"modern|martial|fantasy|unknown","kind":"narrative|action|combat|none","shouldRoll":false,"eventRelevant":false,"npcRelevant":false,"actorLevel":null,"actorSource":"unknown","actorEvidence":"","actorConfidence":"low","opponentLevel":null,"opponentSource":"unknown","opponentEvidence":"","opponentConfidence":"low","opponentCount":1,"modifier":0,"difficulty":"normal","evidence":"40字内客观依据","stakes":"40字内本次检定风险"}。只输出一个JSON对象；布尔值用true/false；未知战力用null；modifier范围-35到35。不要输出逐步推理。`;

async function assessScene(cfg, key, round, log, automatic) {
    clearInjection();
    refereeBusy = true;
    const isCurrent = () => extensionActive && key === chatKey() && round === roundKey() && (!automatic || (cfg.autoJudge && isEnabledHere()));
    let result;
    try { result = await requestReferee(context(), JUDGE_PROMPT, { log, readAssessment, isCurrent }); }
    finally { refereeBusy = false; }
    if (!result || !isCurrent()) return null;
    cfg.assessments[key] = result;
    delete cfg.rolls[key];
    persist();
    return result;
}

// Registered from manifest.json. This runs before prompt assembly, never edits the chat array.
globalThis.FairDiceIndependentInterceptor = async function (_chat, _contextSize, abort, type = 'normal') {
    if (['quiet', 'impersonate'].includes(type)) return;
    if (refereeBusy) {
        if (isEnabledHere()) startLog(initSettings(), chatKey(), generationNames[type] || '自动判定')('已有前置裁判请求在等待答复，本次未重复判定。', 'notice');
        return;
    }
    if (!isEnabledHere()) { clearInjection(); return; }
    const cfg = initSettings(), key = chatKey(), round = roundKey();
    const pending = waitingForInterceptor.get(key);
    waitingForInterceptor.delete(key);
    const log = pending?.type === type ? pending.log : startLog(cfg, key, generationNames[type] || '自动判定');
    let stage = '判定执行';
    try {
        log('已进入自动判定。');
        const cached = cfg.rolls[key]?.round === round && cfg.rolls[key]?.bundle;
        if (cfg.queued[key]) {
            log('使用已手动锁定的结果。');
        } else if (cached) {
            log('沿用同一回合的结果，未重新请求裁判或掷骰。');
        } else if (cfg.autoJudge) {
            const previous = cfg.assessments[key];
            if (previous?.round === round && !previous.error) {
                log('沿用本轮已有的裁判评估。');
            } else {
                log(previous?.round === round ? '上次评估失败，已重新请求前置 AI 裁判，等待答复。' : '已请求前置 AI 裁判，等待答复。');
                try {
                    if (!await assessScene(cfg, key, round, log, true)) {
                        log('聊天、回合或开关已变化，未提交本次结果。', 'notice');
                        return;
                    }
                } catch (err) {
                    const reason = errorText(err);
                    if (chatKey() === key && roundKey() === round) {
                        cfg.assessments[key] = { error: reason, round };
                        delete cfg.rolls[key];
                        persist();
                    }
                    if (err instanceof RefereeStopped) {
                        log(reason + '。本次未掷骰，下次生成会重新请求裁判。', 'notice');
                        abort?.(true);
                        if (chatKey() === key) updateScope();
                        return;
                    }
                }
            }
        } else {
            log('前置 AI 裁判已关闭，使用本聊天的模式和本地规则。');
        }
        if (chatKey() !== key || roundKey() !== round || !isEnabledHere()) {
            log('聊天、回合或开关已变化，未提交本次结果。', 'notice');
            return;
        }
        const judged = cfg.assessments[key];
        if (cfg.autoJudge && !cfg.queued[key] && judged?.round === round) {
            if (judged.error) log('裁判评估失败：' + judged.error, 'error');
            else log(assessmentText(judged));
        }
        stage = '读取或生成骰子结果';
        const bundle = useRoll(cfg, key);
        if (bundle.check) {
            const { kind, odds } = bundle.check;
            log(kind === 'combat'
                ? `战斗条件：行动方战力 ${odds.actorLevel ?? '未知'}，对手战力 ${odds.opponentLevel ?? '未知'}，对手 ${odds.opponentCount} 人，修正 ${odds.modifier}。`
                : `行动条件：难度「${odds.difficultyName}」，修正 ${odds.modifier}。`);
        }
        log(resultText(bundle), bundle.check?.pending ? 'notice' : 'info');
        stage = '向酒馆提交本轮指引';
        const prompt = buildPrompt(cfg, bundle);
        if (!writeInjection(prompt)) log('无法交给主模型：酒馆未提供提示词接口。', 'error');
        else log(prompt ? '已将本轮指引交给酒馆，供主模型生成回复。' : '本轮没有需要交给主模型的指引。');
        stage = '刷新面板';
        updateScope();
    } catch (error) {
        if (stage !== '刷新面板' && chatKey() === key) clearInjection();
        log(stage + '失败：' + errorText(error), 'error');
        console.error('[Fair Dice] interception failed', error);
    }
};

function customize(cfg) {
    const profile = profileFor(cfg);
    profile.customProfile = { events: clone(profile.events), reactions: clone(profile.reactions) };
    profile.activePreset = 'custom';
    const sel = root?.querySelector('#fd-preset');
    if (sel) sel.value = 'custom';
    invalidateRoll(cfg);
    persist();
}
function invalidateRoll(cfg) {
    const key = chatKey();
    if (key) { delete cfg.rolls[key]; delete cfg.queued[key]; }
}
function applyPreset(value) {
    const cfg = initSettings();
    if (!cfg) return;
    const profile = profileFor(cfg);
    if (value === 'custom') {
        const saved = profile.customProfile;
        if (saved) {
            profile.events = normalizeRows(saved.events, []);
            profile.reactions = normalizeRows(saved.reactions, []);
        }
    } else if (BUILT_INS[value]) {
        if (profile.activePreset === 'custom') {
            profile.customProfile = { events: clone(profile.events), reactions: clone(profile.reactions) };
        }
        profile.events = rowsFromPreset(BUILT_INS[value].events);
        profile.reactions = rowsFromPreset(BUILT_INS[value].reactions);
    } else return;
    profile.activePreset = value;
    invalidateRoll(cfg);
    persist();
    renderRows();
    updateResult();
}
function readAssessment(raw) {
    const text = String(raw ?? '').trim().replace(/^```(?:json)?\s*/i,'').replace(/```$/,'').trim();
    if (!text) throw new Error('裁判没有返回内容');
    const brace = text.indexOf('{'), close = text.lastIndexOf('}');
    if (brace < 0 || close <= brace) throw new Error('评估没有返回JSON，请手动设置双方能力。');
    const obj = JSON.parse(text.slice(brace, close+1));
    if (!isValidAssessment(obj)) throw new Error('评估类型无效。');
    // The AI may not grant a combat statistic merely because someone is the user.
    // Explicit sheet numbers are preferred; inferred values need distinct evidence
    // and medium/high confidence. Otherwise keep combat ability unknown.
    const supportedLevel = (value, source, evidence, confidence) => {
        const n = parseLevel(value);
        if (n === null) return null;
        if (source === 'explicit') return n;
        if (source === 'inferred' && ['medium','high'].includes(confidence) && cleanText(evidence, 160).length >= 8) return n;
        return null;
    };
    return {
        kind: obj.kind === 'none' ? 'narrative' : obj.kind,
        setting: ['modern','martial','fantasy','unknown'].includes(obj.setting) ? obj.setting : 'unknown',
        actorLevel: supportedLevel(obj.actorLevel, obj.actorSource, obj.actorEvidence, obj.actorConfidence),
        opponentLevel: supportedLevel(obj.opponentLevel, obj.opponentSource, obj.opponentEvidence, obj.opponentConfidence),
        opponentCount: Math.max(1, Math.min(100, Math.round(Number(obj.opponentCount)||1))),
        modifier: Math.max(-35,Math.min(35,Math.round(Number(obj.modifier)||0))),
        difficulty: Object.hasOwn(DIFFICULTY, obj.difficulty) ? obj.difficulty : 'normal',
        summary: cleanText([obj.evidence, obj.actorEvidence, obj.opponentEvidence].filter(Boolean).join('；'), 180),
        stakes: cleanText(obj.stakes, 120),
        shouldRoll: obj.shouldRoll === true && obj.kind !== 'none',
        eventRelevant: obj.eventRelevant === true,
        npcRelevant: obj.npcRelevant === true,
        round: roundKey(),
    };
}
async function analyzeNow() {
    const cfg=initSettings(), key=chatKey();
    const button=root?.querySelector('#fd-analyze');
    const label=root?.querySelector('#fd-assessment');
    if (!cfg || !key) return;
    const log = startLog(cfg, key, '手动评估');
    if (refereeBusy) {
        log('已有裁判请求在等待答复，本次未重复评估。', 'notice');
        return;
    }
    const round = roundKey();
    log('已手动请求 AI 评估，等待答复。');
    if (button) button.disabled=true;
    if (label) label.textContent='正在评估当前场景。首次失败后最多自动重试 3 次，进度见运行日志。';
    try {
        const evaluated=await assessScene(cfg, key, round, log, false);
        if (!evaluated) {
            log('聊天或回合已变化，本次评估未采用。', 'notice');
            return;
        }
        invalidateRoll(cfg);
        persist();
        updateScope();
        if (label) label.textContent=`已评估：${evaluated.kind==='combat'?'战斗':evaluated.kind==='action'?'事件检定':'普通叙事'}。${evaluated.summary || '证据不足'}`;
        log(assessmentText(evaluated));
        log('手动评估已保存，尚未掷骰。');
    } catch(e) {
        const reason = '评估未完成：' + errorText(e);
        log(reason, e instanceof RefereeStopped ? 'notice' : 'error');
        if (label && chatKey() === key && roundKey() === round) label.textContent=reason;
    } finally { if (button) button.disabled=false; }
}
function saveManual() {
    const cfg=initSettings(), key=chatKey();
    if(!cfg||!key||!root) return;
    const value=id=>root.querySelector('#'+id)?.value;
    cfg.manualChecks[key]={
        actorLevel:parseLevel(value('fd-actor')),
        opponentLevel:parseLevel(value('fd-opponent')),
        opponentCount:Math.max(1,Math.min(100,Math.round(Number(value('fd-enemies'))||1))),
        modifier:Math.max(-35,Math.min(35,Math.round(Number(value('fd-modifier'))||0))),
        difficulty:Object.hasOwn(DIFFICULTY,value('fd-difficulty'))?value('fd-difficulty'):'normal',
    };
    invalidateRoll(cfg); persist(); updateResult();
}
function saveMode() {
    const cfg=initSettings(), key=chatKey();
    if(!cfg||!key) return;
    cfg.modeByChat[key]=root?.querySelector('#fd-mode')?.value||'auto';
    invalidateRoll(cfg); persist(); updateScope();
}
function el(tag, className, textValue) {
    const node = document.createElement(tag);
    if (className) node.className = className;
    if (textValue !== undefined) node.textContent = textValue;
    return node;
}
function makeButton(label, title, handler, className = '') {
    const button = el('button', `fd-btn ${className}`, label);
    button.type = 'button';
    if (title) button.title = title;
    button.addEventListener('click', handler);
    return button;
}
function rowDom(kind, row, cfg) {
    const node = el('div', 'fd-row');
    const checkbox = el('input', 'fd-check');
    checkbox.type = 'checkbox'; checkbox.checked = row.enabled;
    checkbox.title = '是否参加抽签';
    checkbox.setAttribute('aria-label', '启用此项');
    checkbox.addEventListener('change', () => { row.enabled = checkbox.checked; customize(cfg); updatePercentages(); });
    const textBox = el('div', 'fd-rowtext');
    const name = el('input', 'fd-itemname');
    name.type = 'text'; name.maxLength = 48; name.value = row.name;
    name.setAttribute('aria-label', '名称');
    name.addEventListener('change', () => { row.name = cleanText(name.value, 48); customize(cfg); updatePercentages(); });
    const note = el('input', 'fd-itemnote');
    note.type = 'text'; note.maxLength = 160; note.value = row.note;
    note.placeholder = '给AI的简短事件说明';
    note.setAttribute('aria-label', '情境说明');
    note.addEventListener('change', () => { row.note = cleanText(note.value, 160); customize(cfg); });
    textBox.append(name, note);
    const controls = el('div', 'fd-rowcontrols');
    const minus = makeButton('−', '降低权重5', () => { row.weight = Math.max(0, row.weight - WEIGHT_STEP); weight.value = row.weight; customize(cfg); updatePercentages(); }, 'fd-step');
    const weight = el('input', 'fd-weight');
    weight.type = 'number'; weight.min = '0'; weight.max = '200'; weight.step = '1'; weight.value = row.weight;
    weight.setAttribute('aria-label', '权重值');
    weight.addEventListener('change', () => { row.weight = digits(weight.value, 0); weight.value = row.weight; customize(cfg); updatePercentages(); });
    const plus = makeButton('+', '提高权重5', () => { row.weight = Math.min(200, row.weight + WEIGHT_STEP); weight.value = row.weight; customize(cfg); updatePercentages(); }, 'fd-step');
    const pct = el('span', 'fd-percent', '0%');
    pct.dataset.rowId = row.id;
    const remove = makeButton('×', '删除这一条', () => {
        const profile = profileFor(cfg);
        profile[kind] = profile[kind].filter(r => r !== row);
        customize(cfg);
        renderRows();
    }, 'fd-remove');
    controls.append(minus, weight, plus, pct, remove);
    node.append(checkbox, textBox, controls);
    return node;
}
function renderRows() {
    const cfg = initSettings();
    if (!root || !cfg) return;
    const profile = profileFor(cfg);
    for (const kind of ['events', 'reactions']) {
        const target = root.querySelector(`#fd-${kind}-rows`);
        if (!target) continue;
        target.replaceChildren(...profile[kind].map(row => rowDom(kind, row, cfg)));
    }
    const sel = root.querySelector('#fd-preset');
    if (sel) sel.value = profile.activePreset;
    updatePercentages();
}
function updatePercentages() {
    const cfg = initSettings();
    if (!cfg || !root) return;
    const profile = profileFor(cfg);
    for (const kind of ['events', 'reactions']) {
        const rows = profile[kind];
        const total = activeRows(rows).reduce((a, r) => a + r.weight, 0);
        const parent = root.querySelector(`#fd-${kind}-rows`);
        if (!parent) continue;
        // DOM row ordering is the same as the configuration ordering.
        Array.from(parent.children).forEach((node, i) => {
            const item = rows[i];
            const p = node.querySelector('.fd-percent');
            if (!p || !item) return;
            p.textContent = item.enabled && total > 0 ? `${Math.round(item.weight / total * 1000) / 10}%` : '0%';
            node.classList.toggle('fd-muted', !item.enabled || item.weight === 0);
        });
        const totalEl = root.querySelector(`#fd-${kind}-total`);
        if (totalEl) totalEl.textContent = total ? `权重合计 ${total} · 自动换算概率` : '未启用有效项目';
    }
}
function updateResult() {
    if (!root) return;
    const cfg = initSettings();
    const key = chatKey();
    const c = root.querySelector('#fd-last-result');
    if (!c || !cfg) return;
    const queued = key && cfg.queued[key];
    const drawn = queued || (key && cfg.rolls[key]?.bundle);
    c.replaceChildren();
    if (!key) { c.textContent = '请选择角色并打开聊天后使用。'; return; }
    if (!drawn && cfg.assessments[key]?.round === roundKey() && cfg.assessments[key]?.error) {
        c.textContent = '裁判评估未完成。下次生成会重新请求裁判。';
        return;
    }
    if (!drawn) { c.textContent = '尚无抽签。开启后将在下一次正常生成时自动抽取。'; return; }
    const type = queued ? '已锁定下一次回复' : '最近一轮抽签';
    c.append(el('span', 'fd-result-tag', type));
    c.append(el('div', 'fd-result-lines', resultText(drawn)));
}
function renderRunLog() {
    const drawer = root?.querySelector('#fd-log');
    if (!drawer?.open) return;
    const key = chatKey(), cfg = initSettings();
    const status = drawer.querySelector('.fd-log-status');
    const list = drawer.querySelector('.fd-log-list');
    list.replaceChildren();
    if (!key || !cfg) { status.textContent = '扩展已加载。打开角色聊天后可查看该聊天的记录。'; return; }
    const history = cfg.runLogs?.[key];
    const enabled = extensionActive && cfg.enabledChats[key];
    status.textContent = '扩展已加载 · ' + (enabled ? '当前聊天已启用' : '当前聊天已关闭') +
        ' · 前置 AI 裁判' + (cfg.autoJudge ? '已开启' : '已关闭');
    if (!Array.isArray(history) || !history.length) {
        list.append(el('p', '', enabled ? '尚无运行记录，等待下一次酒馆生成。' : '尚无运行记录。启用当前聊天后开始记录自动判定。'));
        return;
    }
    for (const run of history) {
        if (!Array.isArray(run?.steps)) continue;
        const row = el('section', 'fd-log-run');
        const stamp = new Date(run.at).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
        row.append(el('strong', '', stamp + ' · ' + run.title));
        for (const step of run.steps) {
            const prefix = step.level === 'error' ? '错误 · ' : step.level === 'notice' ? '提示 · ' : '';
            const seconds = Math.max(0, (step.at - run.at) / 1000).toFixed(1);
            row.append(el('div', step.level === 'error' ? 'fd-log-error' : '', '+' + seconds + 's　' + prefix + step.text));
        }
        list.append(row);
    }
}
function updateScope() {
    if (!root) return;
    const cfg = initSettings();
    if (!cfg) return;
    const key = chatKey();
    const label = root.querySelector('#fd-scope');
    const toggle = root.querySelector('#fd-enabled');
    const chatName = context()?.name2 || '当前聊天';
    if (label) label.textContent = key ? `作用于当前聊天：${chatName}` : '尚未选择聊天';
    if (toggle) {
        toggle.disabled = !key;
        toggle.checked = key ? Boolean(cfg.enabledChats[key]) : false;
    }
    const mode=root.querySelector('#fd-mode');
    if (mode) mode.value=key?(cfg.modeByChat?.[key]||'auto'):'auto';
    const identified=root.querySelector('#fd-kind-result');
    if (identified) identified.textContent=key?`识别：${checkMode(cfg,key)==='combat'?'战斗检定':checkMode(cfg,key)==='action'?'事件检定':'事件方向'}`:'尚未打开聊天';
    const input=inputForChat(cfg,key);
    for(const [id,val] of Object.entries({'fd-actor':input.actorLevel??'', 'fd-opponent':input.opponentLevel??'', 'fd-enemies':input.opponentCount, 'fd-modifier':input.modifier, 'fd-difficulty':input.difficulty})) {
        const el=root.querySelector('#'+id); if (el) el.value=val;
    }
    const combat=root.querySelector('#fd-combat-profile'); if(combat) combat.value=cfg.combatProfile;
    const evaluated=cfg.assessments?.[key];
    const assessmentLabel=root.querySelector('#fd-assessment');
    if(assessmentLabel) assessmentLabel.textContent=evaluated?.round===roundKey() ? (evaluated.error ? '裁判评估失败：'+evaluated.error : assessmentText(evaluated)) : '本轮尚未评估。未定等级允许依据可靠事实估算，证据不足时暂缓硬判。';
    for (const id of ['fairness', 'autoJudge', 'eventDice', 'npcDice', 'actionDice', 'combatDice', 'allowUnknownCombat']) {
        const inp = root.querySelector(`#fd-${id}`);
        if (inp) inp.checked = Boolean(cfg[id]);
    }
    updateResult();
    renderRunLog();
}
function addRow(kind) {
    const cfg = initSettings();
    if (!cfg) return;
    const profile = profileFor(cfg);
    if (profile[kind].length >= MAX_ROWS) {
        alert(`每组最多 ${MAX_ROWS} 条，请先删掉不需要的条目。`);
        return;
    }
    const suffix = Math.floor(rand01() * 1e9).toString(36);
    const prefix = kind === 'events' ? '新事件' : '新反应';
    profile[kind].push({ id: `item_${Date.now()}_${suffix}`, name: prefix, note: '', weight: 10, enabled: true });
    customize(cfg);
    renderRows();
    const newInput = root?.querySelector(`#fd-${kind}-rows .fd-row:last-child .fd-itemname`);
    newInput?.focus(); newInput?.select();
}
function changeSetting(key, bool) {
    const cfg = initSettings();
    if (!cfg) return;
    cfg[key] = Boolean(bool);
    invalidateRoll(cfg);
    if (key === 'autoJudge') { const chat = chatKey(); if (chat) delete cfg.assessments[chat]; }
    if (!cfg.fairness && !cfg.eventDice && !cfg.npcDice && !cfg.actionDice && !cfg.combatDice) clearInjection();
    persist();
    updateResult();
    renderRunLog();
}
function queueDice() {
    const cfg = initSettings();
    const key = chatKey();
    if (!cfg || !key) return;
    const roll = drawBundle(cfg, key);
    if (roll.judgeError) {
        startLog(cfg, key, '手动锁定')('裁判评估失败，本轮没有可锁定的骰点。下次生成会重新请求裁判。', 'notice');
        return;
    }
    cfg.queued[key] = roll;
    delete cfg.rolls[key];
    startLog(cfg, key, '手动锁定')('已为下一次回复锁定结果。' + resultText(roll));
    persist(); updateResult();
}
function removeQueued() {
    const cfg = initSettings(); const key = chatKey();
    if (!cfg || !key) return;
    if (cfg.queued[key]) startLog(cfg, key, '取消锁定')('已撤销为下一次回复锁定的结果。');
    delete cfg.queued[key]; persist(); updateResult();
}
function buildUI() {
    if (document.getElementById('fair-dice-root')) {
        root = document.getElementById('fair-dice-root');
        return;
    }
    const host = document.querySelector('#extensions_settings2') || document.querySelector('#extensions_settings');
    if (!host) { console.warn('[Fair Dice] Extensions settings host missing'); return; }
    root = el('section', 'fd-root'); root.id = 'fair-dice-root';
    root.innerHTML = `
      <details class="fd-shell">
        <summary class="fd-title"><span class="fd-symbol">🎲</span><span>公平骰子 <small>Fair Dice · v1.4.2</small></span><span class="fd-fold">⌄</span></summary>
        <div class="fd-content">
          <div class="fd-intro">独立作用于<strong>当前聊天</strong>，不改角色卡／世界书／MVU。可选前置AI裁判：先给出简短裁定→程序掷骰→主模型叙事。</div>
          <div class="fd-onbar"><div><b>当前聊天启用</b><div id="fd-scope" class="fd-sub">尚未选择聊天</div></div><label class="fd-switch"><input id="fd-enabled" type="checkbox" /><span></span></label></div>
          <details id="fd-log"><summary>运行日志</summary><div class="fd-log-status"></div><div class="fd-log-list"></div></details>
          <div class="fd-options">
            <label><input id="fd-fairness" type="checkbox" /> 公平判定：不无理由偏袒玩家</label>
            <label><input id="fd-autoJudge" type="checkbox" /> 前置 AI 裁判：先决定是否需要骰子。首次评估失败后最多自动重试 3 次</label>
            <label><input id="fd-eventDice" type="checkbox" /> 抽取事件方向</label>
            <label><input id="fd-npcDice" type="checkbox" /> 抽取NPC反馈倾向</label>
            <label><input id="fd-actionDice" type="checkbox" /> 事件行动检定</label>
            <label><input id="fd-combatDice" type="checkbox" /> 战斗交锋检定</label>
          </div>
          <div class="fd-modebar"><label for="fd-mode">本聊天判定模式</label><select id="fd-mode"><option value="auto">自动识别（默认）</option><option value="narrative">事件方向</option><option value="action">事件检定</option><option value="combat">战斗检定</option></select><span id="fd-kind-result" class="fd-kind">自动</span></div>
          <details class="fd-judge"><summary>⚖ 战斗／事件条件设置（可选）</summary>
            <div class="fd-fields">
              <label>行动方战力 0–100<input id="fd-actor" type="number" min="0" max="100" placeholder="空=未知" /></label>
              <label>对手战力 0–100<input id="fd-opponent" type="number" min="0" max="100" placeholder="空=未知" /></label>
              <label>对手人数<input id="fd-enemies" type="number" min="1" max="100" value="1" /></label>
              <label>态势修正 −35～35<input id="fd-modifier" type="number" min="-35" max="35" value="0" /></label>
              <label>事件难度<select id="fd-difficulty"><option value="trivial">很容易</option><option value="easy">容易</option><option value="normal" selected>一般</option><option value="hard">困难</option><option value="extreme">极难</option><option value="impossible">客观不可能</option></select></label>
              <label>战斗预设<select id="fd-combat-profile"><option value="auto">自动适配世界观（推荐）</option><option value="urban">现实／现代（不按武侠阶位）</option><option value="neutral">公平标准</option><option value="strict">阶位严谨</option><option value="cinematic">戏剧波动</option></select></label>
            </div>
            <div class="fd-roll-actions"><button class="fd-btn" id="fd-analyze" type="button">AI评估当前场景</button><span class="fd-sub">会额外调用一次当前模型；没有等级时使用，结果只供本轮参考。</span></div>
            <div id="fd-assessment" class="fd-assessment">尚未评估</div>
            <label class="fd-unknown"><input id="fd-allowUnknownCombat" type="checkbox" /> 允许等级未知时以50%暂定基准掷骰（默认关闭，不推荐严谨战斗）</label>
            <div class="fd-help">战力0–100仅作为临时内部数值；现代现实不强套武侠阶位，武侠卡才使用五阶差；双方实力、人数劣势、武器与伤势影响胜算。未知等级默认暂缓硬判，需要先评估或填数值；人数极端悬殊有硬上限。</div>
          </details>
          <div class="fd-presets"><label for="fd-preset">加权预设</label><select id="fd-preset"><option value="balanced">公平中立 · 默认</option><option value="slice">生活日常 · 低冲突</option><option value="dynamic">变化较多 · 剧情向</option><option value="custom">自定义 · 我的权重</option></select></div>
          <div class="fd-help">权重、事件与NPC反应<b>按当前聊天独立保存</b>。任意修改自动切换「自定义」，无需凑满100；换角色不会沿用本聊天的自定义权重。</div>
          <div class="fd-section-head"><h4>事件方向</h4><button id="fd-add-events" class="fd-btn fd-add" type="button">+ 添加事件</button></div>
          <div id="fd-events-rows" class="fd-rows"></div><div id="fd-events-total" class="fd-total"></div>
          <div class="fd-section-head"><h4>NPC反馈</h4><button id="fd-add-reactions" class="fd-btn fd-add" type="button">+ 添加反应</button></div>
          <div id="fd-reactions-rows" class="fd-rows"></div><div id="fd-reactions-total" class="fd-total"></div>
          <div class="fd-roll-actions"><button id="fd-roll" class="fd-btn fd-primary" type="button">🎲 抽签并锁定下一回复</button><button id="fd-unqueue" class="fd-btn" type="button">取消锁定</button></div>
          <div id="fd-last-result" class="fd-result" aria-live="polite"></div>
          <div class="fd-foot">前置裁判只输出可核对的简短事实依据，不收集或展示模型内部思维链。掷骰只判本次事件／行动／一次交锋；同一回合重生成复用骰点。关闭后撤销注入，角色卡和MVU不变。</div>
        </div>
      </details>`;
    host.append(root);
    root.querySelector('#fd-log').addEventListener('toggle', renderRunLog);
    root.querySelector('#fd-enabled')?.addEventListener('change', e => {
        const cfg = initSettings(), key = chatKey();
        if (!cfg || !key) return;
        cfg.enabledChats[key] = e.target.checked;
        startLog(cfg, key, '聊天开关')(e.target.checked ? '已启用，等待下一次正常生成。' : '已关闭本聊天的自动判定。');
        delete cfg.rolls[key];
        if (!e.target.checked) { delete cfg.queued[key]; clearInjection(); }
        persist(); updateScope();
    });
    for (const id of ['fairness', 'autoJudge', 'eventDice', 'npcDice', 'actionDice', 'combatDice', 'allowUnknownCombat']) {
        root.querySelector(`#fd-${id}`)?.addEventListener('change', e => changeSetting(id, e.target.checked));
    }
    root.querySelector('#fd-preset')?.addEventListener('change', e => applyPreset(e.target.value));
    root.querySelector('#fd-mode')?.addEventListener('change', saveMode);
    root.querySelector('#fd-combat-profile')?.addEventListener('change', e => {
        const cfg=initSettings();if(!cfg)return;
        cfg.combatProfile=e.target.value==='auto'||Object.hasOwn(COMBAT_PROFILES,e.target.value)?e.target.value:'auto';
        invalidateRoll(cfg);persist();updateResult();
    });
    for(const id of ['fd-actor','fd-opponent','fd-enemies','fd-modifier','fd-difficulty']) root.querySelector('#'+id)?.addEventListener('change', saveManual);
    root.querySelector('#fd-analyze')?.addEventListener('click', analyzeNow);
    root.querySelector('#fd-add-events')?.addEventListener('click', () => addRow('events'));
    root.querySelector('#fd-add-reactions')?.addEventListener('click', () => addRow('reactions'));
    root.querySelector('#fd-roll')?.addEventListener('click', queueDice);
    root.querySelector('#fd-unqueue')?.addEventListener('click', removeQueued);
    renderRows(); updateScope();
}
function init() {
    if (initialized) return;
    const c = context();
    if (!c) return;
    initSettings();
    buildUI();
    if (!root) return;
    initialized = true;
    if (!listenersAttached && c.eventSource?.on) {
        listenersAttached = true;
        const types = c.eventTypes || c.event_types || {};
        if (types.CHAT_CHANGED) c.eventSource.on(types.CHAT_CHANGED, chatChanged);
        if (types.CHAT_CREATED) c.eventSource.on(types.CHAT_CREATED, () => { renderRows(); updateScope(); });
        if (types.SETTINGS_UPDATED) c.eventSource.on(types.SETTINGS_UPDATED, () => { updateScope(); updatePercentages(); });
    }
}

export function onActivate() {
    const c = context();
    if (activationRegistered || !c?.eventSource?.on) return;
    activationRegistered = true;
    const types = c.eventTypes || c.event_types || {};
    if (types.GENERATION_STARTED) c.eventSource.on(types.GENERATION_STARTED, generationStarted);
    if (types.GENERATION_STOPPED) c.eventSource.on(types.GENERATION_STOPPED, generationEnded);
    if (types.GENERATION_ENDED) c.eventSource.on(types.GENERATION_ENDED, generationEnded);
    const ready = types.APP_READY;
    if (ready) c.eventSource.on(ready, init);
    // APP_READY might already have fired when an extension is enabled later.
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init, { once: true });
}
export function onEnable() { extensionActive = true; init(); updateScope(); }
export function onDisable() { extensionActive = false; clearInjection(); updateScope(); }

// SillyTavern 1.16.0 activates the extension by inserting its module script.
// A dynamic import for a lifecycle hook can occur independently of activation.
if (typeof document !== 'undefined' && Array.from(document.scripts).some(script => script.src === import.meta.url)) {
    onActivate();
}
