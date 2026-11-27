import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { apiAddress, independentConnection, refereeKey } from '../referee-api.js';
import { requestReferee } from '../referee-request.js';
import { RefereeSetupError, RefereeStopped } from '../run-log.js';

const eventSource = new EventEmitter();
const accountValues = new Map();
const tabValues = new Map();
globalThis.sessionStorage = {
    getItem:key => tabValues.get(key),
    setItem:(key, value) => tabValues.set(key, value),
    removeItem:key => tabValues.delete(key),
};
const action = '我比较信封上两枚邮戳的日期。';
const ruling = '{"kind":"action","shouldRoll":true,"difficulty":"normal","evidence":"邮戳细节可能被误读"}';
const routes = [];
let promptBuilds = 0;
const ctx = {
    extensionSettings:{}, chatId:'test', characterId:0, characters:[{ avatar:'one.png' }],
    chat:[{ is_user:true, mes:action }], eventSource,
    eventTypes:{ GENERATE_AFTER_DATA:'after-data', GENERATION_STOPPED:'stop', CHAT_CHANGED:'chat-changed' },
    accountStorage:{ getItem:k=>accountValues.get(k), setItem:(k,v)=>accountValues.set(k,v) },
    getRequestHeaders:()=>({ 'Content-Type':'application/json', 'X-CSRF-Token':'fake-csrf' }),
    saveSettingsDebounced(){}, setExtensionPrompt(id, value){ this.lastInjection = value; },
    async generateQuietPrompt(){ routes.push('main'); return ruling; },
    async generate(type, options, dryRun) {
        assert.equal(type, 'quiet');
        assert.equal(dryRun, true);
        promptBuilds++;
        eventSource.emit('after-data', { prompt:[{ role:'user', content:options.quiet_prompt + ' unrelated live prompt' }] }, false);
        eventSource.emit('after-data', { prompt:[{ role:'system', content:'unrelated dry run' }] }, true);
        eventSource.emit('after-data', { prompt:[
            { role:'system', content:'当前场景是邮局。'.repeat(800) },
            { role:'user', content:action, auxiliary:'private-provider-metadata' },
            { role:'system', content:options.quiet_prompt },
        ] }, true);
    },
};
globalThis.SillyTavern = { getContext:()=>ctx };
const entry = new URL('../index.js', import.meta.url);
globalThis.document = Object.assign(new EventTarget(), { readyState:'loading', scripts:[{ src:entry.href }] });
await import(entry);
const chatKey = 'char:one.png:test';
const cfg = ctx.extensionSettings.fair_dice_winmiu_v1 = { enabledChats:{[chatKey]:true} };
const run = type => globalThis.FairDiceIndependentInterceptor([], 8192, ()=>{}, type);
await run('normal');
assert.deepEqual(routes, ['main']);
assert.equal(cfg.refereeApi, 'main');
assert.equal(independentConnection(ctx, cfg), null);

const fakeKey = 'simulated-referee-key';
const address = 'https://referee.invalid/v1';
assert.equal(apiAddress(address + '/chat/completions/'), address);
assert.equal(apiAddress('https://referee.invalid/'), address);
for (const bad of ['', 'http://example.org/v1', 'https://u:p@host/v1', 'https://test/?key=x', 'file:///v1']) {
    assert.throws(()=>apiAddress(bad), RefereeSetupError);
}
Object.assign(cfg, { refereeApi:'independent', refereeAddress:address, refereeModel:'quick-model' });
assert.throws(()=>independentConnection(ctx, cfg), RefereeSetupError);
refereeKey(ctx, address, fakeKey);
assert.equal(refereeKey(ctx, 'https://other.invalid/v1'), '');
assert.equal(refereeKey({...ctx, extensionSettings:{}}, address), fakeKey, 'same account, same tab after reload');
assert.equal(refereeKey({...ctx, extensionSettings:{}, accountStorage:{getItem:()=>null}}, address), '');
assert.ok(!JSON.stringify(cfg).includes(fakeKey));
assert.ok(!JSON.stringify([...accountValues]).includes(fakeKey));
assert.equal(independentConnection(ctx, {...cfg, refereeAddress:'http://127.0.0.1:7000/v1'}).key, '');

const bodies = [];
globalThis.fetch = async (url, options) => {
    routes.push('referee');
    assert.equal(url, '/api/backends/chat-completions/generate');
    assert.equal(options.headers['X-CSRF-Token'], 'fake-csrf');
    const body = JSON.parse(options.body);
    bodies.push(body);
    assert.equal(body.reverse_proxy, address);
    assert.equal(body.proxy_password, fakeKey);
    assert.equal(body.model, 'quick-model');
    assert.equal(body.chat_completion_source, 'openai');
    assert.ok(!options.body.includes('private-provider-metadata'));
    assert.ok(body.messages.some(m => m.content.includes(action)));
    return Response.json({ choices:[{ message:{content:ruling} }] });
};
ctx.chat.push({ is_user:true, mes:action });
await run('normal');
assert.equal(promptBuilds, 1);
assert.deepEqual(routes, ['main', 'referee']);
assert.equal(bodies[0].max_tokens, 1024);
assert.match(ctx.lastInjection, /独立d100=/);
await run('regenerate');
assert.deepEqual(routes, ['main', 'referee'], 'regeneration reused both ruling and dice');
const logText = JSON.stringify(cfg.runLogs);
assert.match(logText, /独立 API/);
assert.ok(!logText.includes(fakeKey) && !logText.includes(address));
assert.equal(eventSource.listenerCount('after-data'), 0);

const logs = [];
const args = { log:t=>logs.push(t), readAssessment:JSON.parse, isCurrent:()=>true,
    compact:false, connection:independentConnection(ctx, cfg) };
let attempts = 0;
const successfulFetch = globalThis.fetch;
globalThis.fetch = async (...params) => ++attempts === 1
    ? Response.json({ error:{message:'Bad Gateway'} }) : successfulFetch(...params);
await requestReferee(ctx, '规则', args);
assert.equal(attempts, 2);
assert.match(logs.join(' '), /502/);
assert.equal(bodies.at(-1).max_tokens, 2048);
assert.deepEqual(routes, ['main', 'referee', 'referee']);
assert.doesNotMatch(logs.join(' '), /simulated-referee-key/);

let signalFetch;
const started = new Promise(resolve => { signalFetch = resolve; });
globalThis.fetch = (_url, {signal}) => new Promise((_resolve,reject) => {
    signalFetch();
    signal.addEventListener('abort', () => reject(new Error('abort')), {once:true});
});
const waiting = requestReferee(ctx, '规则', args);
await started;
eventSource.emit('stop');
await assert.rejects(waiting, RefereeStopped);
assert.equal(eventSource.listenerCount('after-data'), 0);

globalThis.fetch = () => assert.fail('a missing marker must not trigger a provider request');
await assert.rejects(requestReferee({...ctx, async generate(){
    eventSource.emit('after-data', {prompt:'another conversation'}, true);
}}, '规则', args), RefereeSetupError);
assert.equal(eventSource.listenerCount('after-data'), 0);
refereeKey(ctx, address, '');
assert.throws(()=>independentConnection(ctx, cfg), RefereeSetupError);
assert.ok(!JSON.stringify([...tabValues]).includes(fakeKey));
console.log('Independent API routing, retry, cancellation, caching and credential isolation passed.');
