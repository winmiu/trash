import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { beginRun } from '../run-log.js';

const ctx = {
    chatId: 'A', characterId: 0, characters: [{ avatar: 'test.png' }], chat: [],
    eventSource: new EventEmitter(), eventTypes: { GENERATION_STARTED: 'start', GENERATION_ENDED: 'end', GENERATION_STOPPED: 'stop' },
    extensionSettings: {}, setExtensionPrompt() {}, saveSettingsDebounced() {},
};
globalThis.SillyTavern = { getContext: () => ctx };
const entry = new URL('../index.js', import.meta.url);
globalThis.document = Object.assign(new EventTarget(), { readyState: 'loading', scripts: [{ src: entry.href }] });
await import(entry);
const keyA = 'char:test.png:A', keyB = 'char:test.png:B';
const cfg = ctx.extensionSettings.fair_dice_winmiu_v1 ||= {};
cfg.enabledChats = { [keyA]: true, [keyB]: true };
const log = (key = keyA) => cfg.runLogs[key][0].steps;
const lines = (key = keyA) => log(key).map(step => step.text).join('\n');
const start = (type = 'normal', dry = false) => ctx.eventSource.emit('start', type, {}, dry);
const intercept = (type = 'normal') => globalThis.FairDiceIndependentInterceptor([], 1024, () => {}, type);

start('quiet'); start('impersonate'); start('normal', true);
assert.equal(cfg.runLogs, undefined, 'silent and preview requests do not create misleading entries');
start(); ctx.eventSource.emit('stop');
assert.match(lines(), /没有进入公平骰子/);

let requests = 0;
ctx.generateQuietPrompt = async () => {
    requests++;
    await intercept('quiet');
    return JSON.stringify({ kind:'action', shouldRoll:true, difficulty:'hard', evidence:'对方坚持原价', stakes:'谈判可能失败' });
};
ctx.chat.push({ is_user:true, mes:'我和店主谈价钱' });
start(); await intercept(); ctx.eventSource.emit('end');
assert.equal(cfg.runLogs[keyA].length, 2, 'the host start and interceptor produce one trace');
assert.match(lines(), /等待答复/);
assert.match(lines(), /对方坚持原价/);
assert.match(lines(), /风险：谈判可能失败/);
assert.match(lines(), /d100=\d+ \/ 成功阈值30%/);
assert.match(lines(), /供主模型生成回复/);
start('regenerate'); await intercept('regenerate');
assert.equal(requests, 1);
assert.match(lines(), /沿用同一回合/);

ctx.chat.push({ is_user:true, mes:'下一回合' });
ctx.generateQuietPrompt = async () => 'unstructured response with PRIVATE_SAMPLE';
await intercept();
assert.ok(log().some(s => s.level === 'error' && /没有 JSON/.test(s.text)));
assert.doesNotMatch(lines(), /本轮无须掷骰|PRIVATE_SAMPLE|d100=/);
await intercept('regenerate');
assert.ok(log().some(s => s.level === 'error'), 'cached failure stays distinguishable from a no-roll decision');

ctx.chat.push({ is_user:true, mes:'下雨了吗' });
ctx.generateQuietPrompt = async () => JSON.stringify({ kind:'none', shouldRoll:false, evidence:'已有天气设定' });
await intercept();
assert.match(lines(), /本轮无须掷骰/);
assert.ok(log().every(s => s.level !== 'error'));

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
console.log('Fair Dice run log tests PASSED');
