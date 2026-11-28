import { rollD100 } from './engine.js';
import { beginRun } from './run-log.js';
import { confirmVerdict, disputedCheck, readRecord, storyPool, storyPrompt } from './story-turn.js';
import { placeInChat, presentIn } from './delivery.js';
import { judgeFloor, supportedProfiles } from './profile-judge.js';
import { customKey, normalizeAddress, JudgeConfigError } from './judge-api.js';
import { saveAudit, stringHash } from './reply-audit.js';
import { createFloatingEntry, launcherVisible, saveLauncherVisible } from './floating-entry.js';

const MODULE_KEY = 'fair_dice_winmiu_v1';
const PROMPT_KEY = 'fair_dice_winmiu_injection_v1';
const FLOOR_FIELD = 'fairDiceFloorV2';
const EVENT_DEPTH = 0;
const IN_CHAT = 1; // SillyTavern release extension_prompt_types.IN_CHAT
const SYSTEM_ROLE = 0;
const MAX_ROWS = 20;

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


let root = null;
let entry = null;
let extensionActive = true;
let activationRegistered = false;
let normalizedReference = null;
let injectedChat = null;
let pendingVerdict = null;
let delivery = null;
let judgeJob = null;
const standardNotes = new Set(Object.values(BUILT_INS).flatMap(p => [...p.events, ...p.reactions].map(row => row[2])));
const generationNames = { normal:'正常生成', regenerate:'重新生成', swipe:'切换候选回复', continue:'继续生成' };

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
    let cfg = ctx.extensionSettings[MODULE_KEY];
    if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
        cfg = {};
        ctx.extensionSettings[MODULE_KEY] = cfg;
    }
    if (cfg === normalizedReference) return cfg;
    normalizedReference = cfg;
    if (typeof cfg.judgeEnabled !== 'boolean') cfg.judgeEnabled = Boolean(cfg.judgeProfileId);
    cfg.judgeRoute ??= cfg.judgeProfileId ? 'profile' : 'main';
    for (const name of ['enabledChats', 'chatProfiles', 'inputTurns']) {
        if (!cfg[name] || typeof cfg[name] !== 'object' || Array.isArray(cfg[name])) cfg[name] = {};
    }
    cfg.events = normalizeRows(cfg.events, rowsFromPreset(BUILT_INS.balanced.events));
    cfg.reactions = normalizeRows(cfg.reactions, rowsFromPreset(BUILT_INS.balanced.reactions));
    // Retire network routing on upgrade. No generation path consults old settings or cached verdicts.
    for (const name of ['autoJudge','compactJudge','storyMode','refereeApi','refereeAddress','refereeModel']) {
        delete cfg[name];
    }
    if (cfg.inputVersion !== 1) {
        // Discard this account's discontinued, tab-local credential without reading it.
        try {
            const id = ctx.accountStorage?.getItem('fairDice.keyNamespace');
            if (id) globalThis.sessionStorage?.removeItem('fairDice.referee.' + id);
        } catch { /* Tab storage may be unavailable. */ }
        cfg.inputVersion = 1;
        persist();
    }
    return cfg;
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
    delivery = null;
    const ctx = context();
    if (!ctx) return;
    if (injectedChat === null && !Object.hasOwn(ctx.extensionPrompts || {}, PROMPT_KEY)) return;
    injectedChat = null;
    ctx.setExtensionPrompt?.(PROMPT_KEY, '', IN_CHAT, EVENT_DEPTH, false, SYSTEM_ROLE);
    if (ctx.extensionPrompts) delete ctx.extensionPrompts[PROMPT_KEY];
    updateRerollButton();
}

function chatChanged() {
    judgeJob?.abort();
    finishPending();
    clearInjection();
    renderRows();
    updateScope();
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

function roundKey() {
    const chat = context()?.chat;
    if (!Array.isArray(chat)) return 'empty';
    for (let i = chat.length - 1; i >= 0; i--) {
        const m = chat[i];
        if (m?.is_user) return `user:${i}:${stringHash(String(m.mes ?? ''))}`;
    }
    return `intro:${chat.length}`;
}


function migratedCandidates(ctx, cfg, key, profile) {
    const card = ctx.characters?.[ctx.characterId];
    const player = ctx.chat.findLastIndex(m => m?.is_user);
    const prior = ctx.chat.slice(0, player < 0 ? 0 : player).findLast(m => m && !m.is_user && !m.is_system);
    const round = roundKey();
    const signature = stringHash(JSON.stringify([round, prior?.mes, card?.avatar, card?.data?.description ?? card?.description,
        card?.data?.personality ?? card?.personality, card?.data?.scenario ?? card?.scenario, profile.events, profile.reactions]));
    const previous = cfg.inputTurns[key];
    if (previous?.signature === signature && validTurn(previous)) return previous;
    // Same-round existing d100s survive the upgrade; old assessment text never enters the input.
    const legacy = cfg.storyTurns?.[key];
    const roll = cfg.rolls?.[key];
    const legacyDie = (legacy?.round === round ? legacy?.checks?.die : null) ??
        (roll?.round === round ? roll?.bundle?.check?.roll : null);
    if (Number.isInteger(legacyDie) && legacyDie >= 1 && legacyDie <= 100) return drawTurn(profile, legacyDie);
    return null;
}

function drawTurn(profile, die = rollD100(rand01)) {
    return {die, events:storyPool(profile.events, 'E', rand01), reactions:storyPool(profile.reactions, 'N', rand01)};
}

function validTurn(turn) {
    return Number.isInteger(turn?.die) && turn.die >= 1 && turn.die <= 100 &&
        [turn.events, turn.reactions].every(pool => Array.isArray(pool?.order) && Array.isArray(pool?.items));
}

// Bind the draw to the surviving player message, even when replies are deleted or regenerated.
function currentFloor(ctx, cfg, key) {
    const index = ctx.chat.findLastIndex(message => message?.is_user);
    if (index >= 0) {
        const player = ctx.chat[index];
        player.extra ??= {};
        return {owner:player.extra, label:'玩家消息 #' + (index + 1)};
    }
    if (ctx.chatMetadata) return {owner:ctx.chatMetadata, label:'开场'};
    cfg.openings ??= {};
    return {owner:cfg.openings[key] ??= {}, label:'开场'};
}

function floorTurn(ctx, cfg, key, reroll = false) {
    const {owner, label} = currentFloor(ctx, cfg, key);
    const previous = owner[FLOOR_FIELD];
    if (validTurn(previous) && !reroll) return {turn:previous, label, source:'沿用本楼'};
    const profile = profileFor(cfg, key);
    const migrated = !reroll && migratedCandidates(ctx, cfg, key, profile);
    const turn = migrated || drawTurn(profile);
    turn.token = Array.from({length:2}, () => Math.floor(rand01() * 4294967296).toString(16).padStart(8, '0')).join('');
    turn.revision = (Number(previous?.revision) || 0) + 1;
    owner[FLOOR_FIELD] = turn;
    delete cfg.inputTurns[key];
    if (!reroll || typeof ctx.saveChat !== 'function') ctx.saveMetadataDebounced?.();
    return {turn, label, source:reroll ? '手动重掷' : migrated ? '沿用升级前的骰点' : '首次准备'};
}

function updateRerollButton() {
    const button = root?.querySelector('#fd-reroll');
    if (button) button.disabled = !isEnabledHere() || injectedChat !== null || Boolean(pendingVerdict && !pendingVerdict.fixed) || !!judgeJob;
}

async function rerollFloor() {
    if (!isEnabledHere() || injectedChat !== null || (pendingVerdict && !pendingVerdict.fixed) || judgeJob) return;
    const ctx = context(), cfg = initSettings(), key = chatKey();
    const log = beginRun(cfg, key, '手动重掷', () => { persist(); renderRunLog(); });
    try {
        const {turn, label} = floorTurn(ctx, cfg, key, true);
        if (ctx.saveChat) await ctx.saveChat();
        log(label + ' · 第 ' + turn.revision + ' 组 · d100=' + turn.die + '。下次生成采用这组骰点和候选。');
    } catch {
        log('未能保存本楼重掷，请检查当前聊天。', 'error');
    }
}

function finishPending() {
    if (pendingVerdict?.timer) clearTimeout(pendingVerdict.timer);
    pendingVerdict = null;
    updateRerollButton();
}

function generationEnded() {
    clearInjection();
    const pending = pendingVerdict;
    // Streaming can announce the end just before delivery of the completed message.
    if (!pending || pending.timer) return;
    pending.timer = setTimeout(() => {
        if (pendingVerdict !== pending) return;
        if (!pending.fixed) pending.log('未收到可确认的正文裁定。本楼保留原骰点。', 'notice');
        finishPending();
    }, 3000);
}

function receiveVerdict(id, type) {
    const pending = pendingVerdict, ctx = context();
    if (!pending || !isEnabledHere() || pending.key !== chatKey() || ['quiet','impersonate','first_message'].includes(type)) return;
    const msg = ctx.chat?.[id];
    if (!msg || msg.is_user || msg.is_system || Number(id) !== ctx.chat.length - 1) return;
    const {owner} = currentFloor(ctx, initSettings(), pending.key);
    if (owner[FLOOR_FIELD] !== pending.turn) return;
    if (pending.fixed) {
        finishPending();
        saveAudit(msg,pending.turn,pending.turn.verdict);
        ctx.saveMetadataDebounced?.();
        return;
    }
    const token = pending.turn.token;
    const item = readRecord(msg.mes, token);
    if (!item && /<!--FD-[a-f0-9]{16}\s/.test(msg.mes ?? '')) return;
    finishPending();
    if (item) {
        msg.mes = item.body;
        if (Array.isArray(msg.swipes)) {
            for (let i = 0; i < msg.swipes.length; i++) {
                const swipe = readRecord(msg.swipes[i], token);
                if (!swipe) continue;
                msg.swipes[i] = swipe.body;
                const info = msg.swipe_info?.[i];
                if (info && i !== msg.swipe_id) {
                    info.extra ??= {};
                    const alternate = confirmVerdict(pending.turn,swipe.record);
                    saveAudit({mes:swipe.body,extra:info.extra},pending.turn,alternate,alternate ? '' : disputedCheck(pending.turn,swipe.record));
                }
            }
        }
        const display = readRecord(msg.extra?.display_text, token);
        if (display) msg.extra.display_text = display.body;
    }
    const verdict = item?.body.trim() && confirmVerdict(pending.turn, item.record);
    const disputed = !verdict && disputedCheck(pending.turn,item?.record);
    saveAudit(msg,pending.turn,verdict,disputed);
    if (verdict) {
        pending.turn.verdict = verdict;
        for (const line of verdict) pending.log(line);
    } else {
        if (disputed) pending.log(disputed, 'notice');
        pending.log(item ? '裁定条件或成败未通过本机校验，保留正文和本楼骰点。' : '本次回复未附可识别的裁定，保留正文和本楼骰点。', 'notice');
    }
    ctx.saveMetadataDebounced?.();
    if (item) ctx.updateMessageBlock?.(id, msg);
}

// SillyTavern reads this one named prompt while assembling its own generation request.
globalThis.FairDiceIndependentInterceptor = async function (_chat, _contextSize, abort, type = 'normal') {
    if (!Object.hasOwn(generationNames, type) || !isEnabledHere()) { clearInjection(); return; }
    if (judgeJob) { abort(true); return; }
    finishPending();
    clearInjection();
    const ctx = context(), cfg = initSettings(), key = chatKey();
    const log = beginRun(cfg, key, generationNames[type] + ' · 一次性注入', () => { persist(); renderRunLog(); });
    try {
        if (typeof ctx.setExtensionPrompt !== 'function') {
            log('未注入：当前酒馆没有提供提示词接口。', 'error');
            return;
        }
        const {turn, label, source} = floorTurn(ctx, cfg, key);
        let judged = false;
        let judgeCancelled = false;
        if (cfg.judgeEnabled && !turn.verdict) {
            const controller = new AbortController();
            judgeJob = controller;
            updateRerollButton();
            const timeout = setTimeout(() => controller.abort('timeout'), 60000);
            try {
                const verdict = await judgeFloor(ctx, cfg, turn, standardNotes, controller.signal);
                controller.signal.throwIfAborted();
                if (key !== chatKey() || !isEnabledHere() || currentFloor(ctx,cfg,key).owner[FLOOR_FIELD] !== turn) { abort(true); return; }
                turn.verdict = verdict;
                ctx.saveMetadataDebounced?.();
                judged = true;
            } catch (error) {
                if (controller.signal.reason === 'judge-off' && !cfg.judgeEnabled && key === chatKey() && isEnabledHere() && currentFloor(ctx,cfg,key).owner[FLOOR_FIELD] === turn) {
                    judgeCancelled = true;
                    log('已关闭独立裁判，本轮由正文同次判定。');
                } else {
                    if (controller.signal.aborted && controller.signal.reason !== 'timeout') { abort(true); return; }
                    const detail = error instanceof JudgeConfigError || ['所选酒馆连接不可用','独立裁判的记录未通过骰表校验'].includes(error?.message) || error?.message?.startsWith('此自定义地址') ? error.message : '请检查所选连接和模型';
                    log('独立裁判' + (controller.signal.reason === 'timeout' ? '超时' : '未完成') + '，本轮正文照常生成，本楼骰点保留。' + detail, 'error');
                    return;
                }
            } finally {
                clearTimeout(timeout);
                if (judgeJob === controller) judgeJob = null;
                updateRerollButton();
            }
        }
        const prompt = storyPrompt(turn, standardNotes);
        finishPending();
        pendingVerdict = {turn, key, log, fixed:Boolean(turn.verdict)};
        injectedChat = key;
        const nativeChat = ctx.mainApi === 'openai' && !!(ctx.eventTypes ?? ctx.event_types)?.GENERATE_AFTER_DATA;
        delivery = {prompt, token:turn.token, key, type, log, nativeChat};
        const slot = nativeChat ? '[fd:' + turn.token + ']' + prompt + '[/fd:' + turn.token + ']' : prompt;
        ctx.setExtensionPrompt(PROMPT_KEY, slot, IN_CHAT, EVENT_DEPTH, false, SYSTEM_ROLE,
            () => injectedChat === key && chatKey() === key && isEnabledHere());
        updateRerollButton();
        log(label + ' · ' + source + '第 ' + turn.revision + ' 组 · d100=' + turn.die + '。');
        const via = judged ? ({main:'跟随主 API',custom:'独立 API',profile:'酒馆连接'})[cfg.judgeRoute] + ' · ' : '';
        const requests = judgeCancelled ? '之前启动的裁判已取消。' : via + '公平骰模型请求 ' + (judged ? 1 : 0) + ' 次。';
        log((turn.verdict ? '已准备本楼已确认裁定。' : '已准备同次裁定。') + prompt.length + ' 字符，' + requests, 'info', prompt);
        if (turn.verdict) for (const line of turn.verdict) log(line);
    } catch {
        finishPending();
        clearInjection();
        log('准备或写入正文输入失败，请检查酒馆版本。', 'error');
    }
};

function afterData(data, dryRun) {
    const d = delivery;
    if (!d || dryRun || d.assembled || d.key !== chatKey() || !isEnabledHere()) return;
    if (d.nativeChat && Array.isArray(data?.prompt)) {
        try { data.prompt = placeInChat(data.prompt, d.prompt, d.token); }
        catch { d.log('酒馆组装时改变了公平骰文本，沿用原请求并检查发送内容。', 'notice'); }
        d.messages = data.prompt;
    } else if (typeof data?.prompt === 'string' || typeof data?.input === 'string') {
        const text = typeof data.prompt === 'string' ? data.prompt : data.input;
        d.log(text.includes(d.prompt) ? '已在组装好的文本请求中核对到公平骰。' : '已组装文本请求，未找到完整的公平骰提示。', text.includes(d.prompt) ? 'info' : 'notice');
    } else return;
    d.assembled = true;
}

function checkOutgoing(data) {
    const d = delivery;
    if (!d?.messages || d.checked || data?.type !== d.type || d.key !== chatKey()) return;
    const present = presentIn(data.messages, d.prompt);
    if (!present && data.messages !== d.messages) return;
    d.checked = true;
    d.log(present ? '已在酒馆发往接口的正文请求中核对到公平骰。' : '正文请求发出前未找到完整的公平骰提示。', present ? 'info' : 'notice');
}

function customize(cfg) {
    const profile = profileFor(cfg);
    profile.customProfile = { events: clone(profile.events), reactions: clone(profile.reactions) };
    profile.activePreset = 'custom';
    const sel = root?.querySelector('#fd-preset');
    if (sel) sel.value = 'custom';
    persist();
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
    persist();
    renderRows();
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
    const weight = el('input', 'fd-weight');
    weight.type = 'number'; weight.min = '0'; weight.max = '200'; weight.step = '1'; weight.value = row.weight;
    weight.setAttribute('aria-label', '权重值');
    weight.addEventListener('change', () => { row.weight = digits(weight.value, 0); weight.value = row.weight; customize(cfg); updatePercentages(); });
    const pct = el('span', 'fd-percent', '0%');
    pct.dataset.rowId = row.id;
    const remove = makeButton('×', '删除这一条', () => {
        const profile = profileFor(cfg);
        profile[kind] = profile[kind].filter(r => r !== row);
        customize(cfg);
        renderRows();
    }, 'fd-remove');
    controls.append(weight, pct, remove);
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
            p.textContent = item.enabled && cleanText(item.name) && total > 0 ? `${Math.round(item.weight / total * 1000) / 10}%` : '0%';
            p.title = '基础概率';
            node.classList.toggle('fd-muted', !item.enabled || item.weight === 0);
        });
    }
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
    status.textContent = enabled ? '当前聊天已启用 · 仅注入正文输入' : '当前聊天已关闭';
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
        const input = cfg.runInputs?.[key]?.[run.inputId];
        if (typeof input === 'string') {
            const details = el('details', 'fd-log-input');
            details.append(el('summary', '', '查看本楼准备的提示'), el('pre', '', input));
            row.append(details);
        }
        list.append(row);
    }
}


function updateScope() {
    if (!root) return;
    const visible = launcherVisible(initSettings());
    root.querySelector('#fd-show-launcher').checked = visible;
    if (entry) entry.button.hidden = !extensionActive || !visible;
    const key = chatKey();
    const toggle = root.querySelector('#fd-enabled');
    toggle.disabled = !key;
    toggle.checked = isEnabledHere();
    updateRerollButton();
    renderJudgeControls();
    root.querySelector('#fd-scope').textContent = key ? '随角色卡和当前剧情判定 · 一次注入正文输入' : '请先打开一个聊天。';
    renderRunLog();
}

function renderJudgeControls() {
    const cfg = initSettings();
    if (!root || !cfg) return;
    root.querySelector('#fd-judge-on').checked = cfg.judgeEnabled;
    root.querySelector('#fd-judge-options').hidden = !cfg.judgeEnabled;
    const select = root.querySelector('#fd-judge-profile');
    const saved = cfg.judgeRoute === 'profile' ? 'profile:' + cfg.judgeProfileId : cfg.judgeRoute;
    const options = [new Option('跟随主 API','main'),new Option('独立 API','custom')];
    for (const p of supportedProfiles(context())) options.push(new Option('酒馆连接 · ' + p.name, 'profile:' + p.id));
    if (!options.some(o => o.value === saved)) options.push(new Option('已选连接不可用', saved));
    select.replaceChildren(...options);
    select.value = saved;
    const custom = cfg.judgeEnabled && cfg.judgeRoute === 'custom';
    root.querySelector('#fd-judge-fields').hidden = !custom;
    const address = root.querySelector('#fd-judge-address'), model = root.querySelector('#fd-judge-model'), key = root.querySelector('#fd-judge-key');
    if (document.activeElement !== address) address.value = cfg.judgeAddress || '';
    if (document.activeElement !== model) model.value = cfg.judgeModel || '';
    if (document.activeElement !== key) {
        key.value = '';
        if (custom) {
            try { key.value = customKey(context(),normalizeAddress(cfg.judgeAddress)); }
            catch { /* An address may still be incomplete. */ }
        }
    }
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

function buildUI() {
    if (document.getElementById('fair-dice-root')) {
        root = document.getElementById('fair-dice-root');
        return;
    }
    root = el('section', 'fd-root'); root.id = 'fair-dice-root';
    root.innerHTML = `
      <details class="fd-shell">
        <summary class="fd-title"><span aria-hidden="true">🎲</span> 公平骰 <span class="fd-fold" aria-hidden="true">⌄</span></summary>
        <div class="fd-content">
          <div class="fd-onbar">
            <div><b id="fd-enable-label">当前聊天启用</b><div id="fd-scope" class="fd-sub"></div></div>
            <label class="fd-switch"><input id="fd-enabled" type="checkbox" aria-labelledby="fd-enable-label" /><span></span></label>
          </div>

          <label class="fd-launcher-choice"><input id="fd-show-launcher" type="checkbox"> 显示 Miku 悬浮球</label>
          <details class="fd-drawer" id="fd-log"><summary>运行日志</summary><div class="fd-log-status"></div><button id="fd-reroll" class="fd-btn" type="button">重新摇骰子</button><p class="fd-help">只重掷本楼。可先删除 AI 回复，保留玩家消息，再重掷并生成。</p><div class="fd-log-list"></div></details>

          <details class="fd-drawer" id="fd-connection"><summary>独立裁判</summary>
            <div class="fd-onbar"><label for="fd-judge-on">启用独立裁判</label><label class="fd-switch"><input id="fd-judge-on" type="checkbox" aria-label="启用独立裁判"><span></span></label></div>
            <p class="fd-help">关闭时判定随正文一次完成。开启后新楼额外请求一次裁判，已确认的同楼裁定直接复用。此设置用于所有已启用公平骰的聊天。</p>
            <div id="fd-judge-options" hidden><div class="fd-presets"><label for="fd-judge-profile">裁判 API</label><select id="fd-judge-profile"></select></div>
              <div id="fd-judge-fields" hidden>
                <label>接口地址<input type="url" id="fd-judge-address" placeholder="https://example.com/v1" spellcheck="false"></label>
                <label>模型名<input type="text" id="fd-judge-model" spellcheck="false"></label>
                <label>API 密钥<input type="password" id="fd-judge-key" autocomplete="off" placeholder="仅保存在当前标签页"></label>
                <small id="fd-key-status" role="status"></small>
              </div>
            </div>
          </details>

          <details class="fd-drawer"><summary>事件与反应权重</summary>
            <div class="fd-presets"><label for="fd-preset">本聊天预设</label><select id="fd-preset"><option value="balanced">公平中立</option><option value="slice">生活日常</option><option value="dynamic">变化较多</option><option value="custom">自定义</option></select></div>
            <p class="fd-help">基础权重的修改在新楼或手动重掷时生效。正文生成时按剧情调整。</p>
            <details class="fd-list"><summary>事件走向</summary><div id="fd-events-rows" class="fd-rows"></div><button id="fd-add-events" class="fd-btn" type="button">添加事件</button></details>
            <details class="fd-list"><summary>NPC 反应</summary><div id="fd-reactions-rows" class="fd-rows"></div><button id="fd-add-reactions" class="fd-btn" type="button">添加反应</button></details>
          </details>
          <footer class="fd-foot">
            <small>借鉴名单 · <a href="https://github.com/khangdh0202/SillyTavern-DiceWeaver" target="_blank" rel="noopener noreferrer">DiceWeaver</a>、<a href="https://github.com/brucestarkallen/SillyTavern-Arbiter-Fight-and-Battle" target="_blank" rel="noopener noreferrer">SillyTavern Arbiter</a></small>
            <small class="fd-signature"><span>v2.3.0</span> winmiu</small>
          </footer>
        </div>
      </details>`;

    entry = createFloatingEntry(root, updateScope);
    root.querySelector('#fd-show-launcher').addEventListener('change', e => {
        saveLauncherVisible(initSettings(), e.target.checked);
        persist();
        updateScope();
    });
    root.querySelector('#fd-log').addEventListener('toggle', renderRunLog);
    root.querySelector('#fd-reroll').addEventListener('click', rerollFloor);
    root.querySelector('#fd-connection').addEventListener('toggle', e => { if (e.target.open) updateScope(); });
    root.querySelector('#fd-judge-on').addEventListener('change', e => {
        initSettings().judgeEnabled = e.target.checked;
        if (!e.target.checked) judgeJob?.abort('judge-off');
        persist(); renderJudgeControls();
    });
    root.querySelector('#fd-judge-profile').addEventListener('change', e => {
        judgeJob?.abort();
        const cfg = initSettings(), value = e.target.value;
        cfg.judgeRoute = value.startsWith('profile:') ? 'profile' : value;
        if (cfg.judgeRoute === 'profile') cfg.judgeProfileId = value.slice(8);
        persist(); renderJudgeControls();
    });
    for (const [id, field] of [['#fd-judge-address','judgeAddress'],['#fd-judge-model','judgeModel']]) {
        root.querySelector(id).addEventListener('change', e => {
            initSettings()[field] = e.target.value.trim();
            if (field === 'judgeAddress') root.querySelector('#fd-judge-key').value = '';
            root.querySelector('#fd-key-status').textContent = '';
            persist(); renderJudgeControls();
        });
    }
    root.querySelector('#fd-judge-key').addEventListener('change', e => {
        const status = root.querySelector('#fd-key-status');
        try {
            customKey(context(),normalizeAddress(initSettings().judgeAddress),e.target.value.trim());
            status.textContent = e.target.value.trim() ? '当前标签页已保存。' : '已清除。';
        } catch { status.textContent = '请先填写有效的接口地址，再输入密钥。'; e.target.value = ''; }
    });
    root.querySelector('#fd-enabled').addEventListener('change', e => {
        const cfg = initSettings(), key = chatKey();
        if (!cfg || !key) return;
        cfg.enabledChats[key] = e.target.checked;
        if (!e.target.checked) { judgeJob?.abort(); finishPending(); clearInjection(); }
        persist(); updateScope();
    });
    root.querySelector('#fd-preset').addEventListener('change', e => applyPreset(e.target.value));
    root.querySelector('#fd-add-events').addEventListener('click', () => addRow('events'));
    root.querySelector('#fd-add-reactions').addEventListener('click', () => addRow('reactions'));
    renderRows(); updateScope();
}

function init() {
    if (!extensionActive || !document.body || !initSettings()) return;
    if (!root) buildUI();
    updateScope();
}

export function onActivate() {
    const ctx = context();
    if (activationRegistered || !ctx?.eventSource?.on) return;
    activationRegistered = true;
    const types = ctx.eventTypes || ctx.event_types || {};
    const openSettings = () => {
        if (extensionActive) { init(); entry?.open(); }
        return '';
    };
    if (ctx.SlashCommandParser?.addCommandObject && ctx.SlashCommand?.fromProps) {
        ctx.SlashCommandParser.addCommandObject(ctx.SlashCommand.fromProps({
            name:'fairdice', callback:openSettings, helpString:'打开公平骰功能面板，可恢复 Miku 悬浮球。',
        }));
    } else if (ctx.registerSlashCommand) {
        ctx.registerSlashCommand('fairdice', openSettings, [], '打开公平骰设置', true, true);
    }
    if (types.GENERATE_AFTER_DATA) ctx.eventSource.on(types.GENERATE_AFTER_DATA, afterData);
    if (types.CHAT_COMPLETION_SETTINGS_READY) ctx.eventSource.on(types.CHAT_COMPLETION_SETTINGS_READY, checkOutgoing);
    if (types.MESSAGE_RECEIVED) ctx.eventSource.on(types.MESSAGE_RECEIVED, receiveVerdict);
    if (types.GENERATION_ENDED) ctx.eventSource.on(types.GENERATION_ENDED, generationEnded);
    if (types.GENERATION_STOPPED) ctx.eventSource.on(types.GENERATION_STOPPED, () => {
        judgeJob?.abort();
        pendingVerdict?.log('生成已停止，本楼保留当前骰点。', 'notice');
        finishPending(); clearInjection();
    });
    if (types.CHAT_CHANGED) ctx.eventSource.on(types.CHAT_CHANGED,chatChanged);
    if (types.CHAT_CREATED) ctx.eventSource.on(types.CHAT_CREATED,chatChanged);
    if (types.SETTINGS_UPDATED) ctx.eventSource.on(types.SETTINGS_UPDATED,() => { init(); renderRows(); });
    if (types.APP_READY) ctx.eventSource.on(types.APP_READY,init);
    if (document.readyState !== 'loading') init();
    else document.addEventListener('DOMContentLoaded', init, {once:true});
}
export function onEnable() { extensionActive = true; onActivate(); init(); }
export function onDisable() {
    extensionActive = false;
    if (entry?.dialog.open) entry.dialog.close();
    judgeJob?.abort(); finishPending(); clearInjection(); updateScope();
}

if (typeof document !== 'undefined') {
    const modulePath = import.meta.url.split(/[?#]/)[0];
    const installed = new URL(modulePath).pathname.match(/\/scripts\/extensions\/(third-party\/[^/]+)\/[^/]+$/);
    const scriptLoaded = Array.from(document.scripts).some(script => script.src.split(/[?#]/)[0] === modulePath);
    if (scriptLoaded || installed) {
        // A direct module import has no corresponding script element. Respect the host's disable list.
        const start = () => {
            if (!extensionActive || (installed && context()?.extensionSettings?.disabledExtensions?.includes(decodeURIComponent(installed[1])))) return;
            onActivate();
        };
        start();
        if (!activationRegistered && document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start, {once:true});
        if (!activationRegistered && document.readyState !== 'complete') globalThis.addEventListener('load', start, {once:true});
    }
}
