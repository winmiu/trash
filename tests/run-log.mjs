import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beginRun, errorText } from '../run-log.js';

const scheduledDelays = [];
const realSetTimeout = globalThis.setTimeout;
let duringBackoff;
globalThis.setTimeout = (callback, delay) => {
    scheduledDelays.push(delay);
    const interrupt = duringBackoff;
    duringBackoff = null;
    return realSetTimeout(() => { interrupt?.(); callback(); }, 0);
};

const ctx = {
    chatId: 'A', characterId: 0, characters: [{ avatar: 'test.png' }], chat: [],
    eventSource: new EventEmitter(), eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop', CHAT_CHANGED: 'changed', CHAT_COMPLETION_SETTINGS_READY: 'prepared' },
    extensionSettings: {}, setExtensionPrompt() {}, saveSettingsDebounced() {},
};
globalThis.SillyTavern = { getContext: () => ctx };
const entry = new URL('../index.js', import.meta.url);
globalThis.document = Object.assign(new EventTarget(), { readyState: 'loading', scripts: [{ src: entry.href }] });
await import(entry);
const keyA = 'char:test.png:A', keyB = 'char:test.png:B';
let cfg = ctx.extensionSettings.fair_dice_winmiu_v1 ||= {};
cfg.enabledChats = { [keyA]: true, [keyB]: true };
const log = (key = keyA) => cfg.runLogs[key][0].steps;
const lines = (key = keyA) => log(key).map(step => step.text).join('\n');
const start = (type = 'normal', dry = false) => ctx.eventSource.emit('start', type, {}, dry);
const intercept = (type = 'normal') => globalThis.FairDiceIndependentInterceptor([], 1024, () => {}, type);

start('quiet'); start('impersonate'); start('normal', true);
assert.equal(cfg.runLogs, undefined, 'silent and preview requests do not create misleading entries');
start(); ctx.eventSource.emit('stop');
assert.match(lines(), /没有进入公平骰/);

let requests = 0;
ctx.generateQuietPrompt = async ({ quietPrompt }) => {
    requests++;
    const makePayload = (type, content, limit) => ({ type, messages: [{ content }], max_tokens: limit });
    const own = makePayload('quiet', [{ type:'text', text:quietPrompt }], 70000);
    const smaller = { type:'quiet', messages:[{ content: quietPrompt }], max_completion_tokens: 768 };
    const story = makePayload('normal', quietPrompt, 70000);
    const other = makePayload('quiet', 'another extension', 70000);
    for (const data of [own, smaller, story, other]) ctx.eventSource.emit('prepared', data);
    assert.equal(own.max_tokens, 70000);
    assert.equal(smaller.max_completion_tokens, 768);
    assert.equal(story.max_tokens, 70000);
    assert.equal(other.max_tokens, 70000);
    await intercept('quiet');
    return JSON.stringify({ kind:'action', shouldRoll:true, difficulty:'hard', evidence:'对方坚持原价', stakes:'谈判可能失败' });
};
ctx.chat.push({ is_user:true, mes:'我和店主谈价钱' });
start(); await intercept(); ctx.eventSource.emit('end');
assert.equal(cfg.runLogs[keyA].length, 2, 'the host start and interceptor produce one trace');
assert.match(lines(), /等待答复/);
assert.match(lines(), /准备好本次裁判请求/);
assert.match(lines(), /对方坚持原价/);
assert.match(lines(), /风险：谈判可能失败/);
assert.match(lines(), /d100=\d+ \/ 成功阈值30%/);
assert.match(lines(), /供主模型生成回复/);
start('regenerate'); await intercept('regenerate');
assert.equal(requests, 1);
assert.match(lines(), /沿用同一回合/);

ctx.chat.push({ is_user:true, mes:'下一回合' });
let attempts = 0;
ctx.generateQuietPrompt = async () => { attempts++; return 'unstructured response with PRIVATE_SAMPLE'; };
await intercept();
assert.ok(log().some(s => s.level === 'error' && /没有 JSON/.test(s.text)));
assert.doesNotMatch(lines(), /本轮无须掷骰|PRIVATE_SAMPLE|d100=/);
assert.equal(attempts, 4, 'first attempt plus exactly three automatic retries');
assert.deepEqual(scheduledDelays, [1000, 2000, 4000]);
assert.match(lines(), /第 3\/3 次重试/);
assert.match(lines(), /已用完 3 次重试/);
assert.equal(cfg.rolls[keyA], undefined, 'a failure cannot become a cached roll');

// Reload with the exact two layers of failed state written by 1.4.0, plus an old manual lock.
cfg = JSON.parse(JSON.stringify(cfg));
const failed = { skipped:true, judgeError:'请求已中止', check:null, event:null, reaction:null };
cfg.rolls[keyA] = { round:cfg.assessments[keyA].round, bundle:failed };
cfg.queued[keyA] = failed;
ctx.extensionSettings.fair_dice_winmiu_v1 = cfg;
ctx.generateQuietPrompt = async () => { attempts++; return JSON.stringify({ kind:'action', shouldRoll:true, difficulty:'hard' }); };
await intercept('regenerate');
assert.equal(attempts, 5, 'one genuine request for the same round after reloading old settings');
assert.match(lines(), /上次评估失败，已重新请求/);
assert.match(lines(), /d100=\d+/);
assert.equal(cfg.queued[keyA], undefined);
const recoveredRoll = cfg.rolls[keyA].bundle.check.roll;
await intercept('regenerate');
assert.equal(attempts, 5);
assert.equal(cfg.rolls[keyA].bundle.check.roll, recoveredRoll);
assert.match(lines(), /沿用同一回合/);

ctx.chat.push({ is_user:true, mes:'两次暂时故障后恢复' });
let recoveryRequests = 0;
ctx.generateQuietPrompt = async () => {
    recoveryRequests++;
    assert.ok(log().every(step => !step.text.includes('d100=')));
    if (recoveryRequests === 1) throw Object.assign(new Error('temporary'), {status:503});
    if (recoveryRequests === 2) return 'not json';
    return JSON.stringify({kind:'action', shouldRoll:true, difficulty:'normal'});
};
await intercept();
assert.equal(recoveryRequests, 3);
assert.match(lines(), /第 2\/3 次重试/);
assert.doesNotMatch(lines(), /第 3\/3 次重试/);
assert.equal(log().filter(s => s.text.includes('d100=')).length, 1);
await intercept('regenerate');
assert.equal(recoveryRequests, 3);

ctx.chat.push({ is_user:true, mes:'下雨了吗' });
ctx.generateQuietPrompt = async () => JSON.stringify({ kind:'none', shouldRoll:false, evidence:'已有天气设定' });
await intercept();
assert.match(lines(), /本轮无须掷骰/);
assert.ok(log().every(s => s.level !== 'error'));
ctx.generateQuietPrompt = () => assert.fail('a successful no-roll decision must be reusable');
await intercept('regenerate');
assert.match(lines(), /本轮无须掷骰/);
assert.match(lines(), /沿用同一回合/);

ctx.chat.push({ is_user:true, mes:'重试间隔内停止' });
let interruptedAttempts = 0;
ctx.generateQuietPrompt = async () => { interruptedAttempts++; throw new Error('request aborted'); };
duringBackoff = () => ctx.eventSource.emit('stop');
await intercept();
assert.equal(interruptedAttempts, 1);
assert.match(lines(), /酒馆发出了停止生成信号/);
assert.doesNotMatch(lines(), /第 1\/3 次重试|d100=/);

ctx.chat.push({ is_user:true, mes:'重试间隔内切换聊天再返回' });
interruptedAttempts = 0;
duringBackoff = () => {
    ctx.chatId = 'B'; ctx.eventSource.emit('changed');
    ctx.chatId = 'A'; ctx.eventSource.emit('changed');
};
await intercept();
assert.equal(interruptedAttempts, 1);
assert.match(lines(), /未提交本次结果/);
assert.doesNotMatch(lines(), /第 1\/3 次重试|d100=/);

ctx.chat.push({ is_user:true, mes:'酒馆停止' });
const beforeStop = ctx.eventSource.listenerCount('stop');
ctx.generateQuietPrompt = async () => {
    ctx.eventSource.emit('stop');
    return JSON.stringify({ kind:'action', shouldRoll:true });
};
let mainAborted = false;
await globalThis.FairDiceIndependentInterceptor([], 1024, immediate => { mainAborted = immediate; });
assert.ok(mainAborted, 'honour an observed host stop even if a late answer arrives');
assert.match(lines(), /酒馆发出了停止生成信号/);
assert.doesNotMatch(lines(), /d100=|已将本轮指引交给酒馆/);
assert.equal(ctx.eventSource.listenerCount('stop'), beforeStop);
assert.equal(ctx.eventSource.listenerCount('prepared'), 0);
ctx.generateQuietPrompt = async () => { throw new DOMException('PRIVATE_SAMPLE', 'AbortError'); };
await intercept('regenerate');
assert.match(lines(), /已重新请求/);
assert.match(lines(), /请求已中止，接口没有说明中止来源/);
assert.equal(cfg.rolls[keyA], undefined);
ctx.generateQuietPrompt = async () => '';
await intercept('regenerate');
assert.match(lines(), /酒馆返回了空回复/);
assert.doesNotMatch(lines(), /PRIVATE_SAMPLE/);
assert.match(errorText(new Error('504 Gateway Timeout PRIVATE_SAMPLE')), /HTTP 504/);
assert.match(errorText(new Error('read ECONNRESET PRIVATE_SAMPLE')), /连接.*重置/);
assert.match(errorText(new DOMException('PRIVATE_SAMPLE', 'TimeoutError')), /请求超时/);

let completeModel;
ctx.chat.push({ is_user:true, mes:'又一回合' });
ctx.generateQuietPrompt = () => new Promise(resolve => { completeModel = resolve; });
const inFlight = intercept();
assert.match(lines(), /等待答复/);
ctx.chatId = 'B';
completeModel('{}'); await inFlight;
assert.match(lines(), /未提交本次结果/);
assert.equal(cfg.runLogs[keyB], undefined);
ctx.generateQuietPrompt = async () => { throw Object.assign(new Error('PRIVATE_SAMPLE'), { status: 429 }); };
await intercept();
assert.match(lines(keyB), /HTTP 429/);
assert.doesNotMatch(lines(keyB), /PRIVATE_SAMPLE|对方坚持原价/);
const restored = JSON.parse(JSON.stringify(cfg.runLogs));
assert.deepEqual(restored, cfg.runLogs, 'history can be displayed after a settings reload');

for (let i = 0; i < 25; i++) beginRun(cfg, keyB, String(i), () => {})('test');
assert.equal(cfg.runLogs[keyB].length, 20);
assert.equal(cfg.runLogs[keyB][0].title, '24');
assert.equal(cfg.runLogs[keyB].at(-1).title, '5');

// Drive the manual action through the same button handler the real panel registers.
let clickAnalyze;
const analyze = { addEventListener(type, handler) { if (type === 'click') clickAnalyze = handler; } };
const logDrawer = { open:false, addEventListener() {} };
const label = {};
const controls = { '#fd-analyze':analyze, '#fd-log':logDrawer, '#fd-assessment':label };
document.getElementById = () => null;
document.querySelector = () => ({ append() {} });
document.createElement = () => ({ querySelector:selector => controls[selector] ?? null });
document.dispatchEvent(new Event('DOMContentLoaded'));
let manualCalls = 0;
ctx.generateQuietPrompt = async () => ++manualCalls < 4 ? '' : JSON.stringify({kind:'none', shouldRoll:false});
await clickAnalyze();
assert.equal(manualCalls, 4);
assert.equal(cfg.runLogs[keyB][0].title, '手动评估');
assert.match(lines(keyB), /第 3\/3 次重试/);
assert.match(lines(keyB), /手动评估已保存/);
assert.equal(cfg.rolls[keyB], undefined);
assert.equal(analyze.disabled, false);
await intercept();
assert.equal(manualCalls, 4, 'automatic generation reuses the valid manual decision');
globalThis.setTimeout = realSetTimeout;
console.log('Fair Dice run log tests PASSED');
