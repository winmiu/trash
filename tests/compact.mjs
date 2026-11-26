import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { requestReferee } from '../referee-request.js';

const action = '我试着说服守卫打开城门';
const rules = 'full referee instructions';
const events = new EventEmitter();
const ctx = {
    chat:[{is_user:true, mes:action}], name1:'玩家', name2:'守卫',
    eventSource:events, eventTypes:{ CHAT_COMPLETION_SETTINGS_READY:'ready' },
};
const turns = [
    {role:'system', content:'闲置说明。'.repeat(1800) + '守卫负责城门，要求出示令牌。'},
    ...Array.from({length:10}, (_, i) => ({role:i % 2 ? 'assistant':'user', content:'以往对话'.repeat(500) + i})),
    {role:'assistant', name:'Guard', content:'守卫说要令牌。'},
    {role:'user', content:action},
];
const lines = [];
const args = { log:line=>lines.push(line), readAssessment:raw=>JSON.parse(raw), isCurrent:()=>true, compact:true };
let sent;
let incoming = turns;
let limit = 70000;
let calls = 0;
let replies = [];
ctx.generateQuietPrompt = async ({quietPrompt}) => {
    calls++;
    const payload = {type:'quiet', messages:[...structuredClone(incoming),{role:'system', content:quietPrompt}], max_tokens:limit};
    const main = {...structuredClone(payload), type:'normal'};
    const unrelated = {...structuredClone(payload), messages:[{role:'user',content:'another quiet operation'}]};
    events.emit('ready', main);
    events.emit('ready', unrelated);
    assert.equal(main.max_tokens, limit);
    assert.deepEqual(main.messages, [...incoming,{role:'system', content:quietPrompt}]);
    assert.equal(unrelated.max_tokens, limit);
    events.emit('ready', payload);
    sent = payload;
    return replies.shift() ?? '{"kind":"action","shouldRoll":true}';
};
await requestReferee(ctx, rules, args);
assert.equal(sent.max_tokens, 1024);
assert.match(sent.messages.at(-1).content, new RegExp(action));
assert.ok(sent.messages.some(m => m.content.includes('出示令牌')));
assert.ok(sent.messages.some(m => m.name === 'Guard'));
assert.ok(sent.messages.length <= 7);
assert.ok(lines.some(line=>line.includes('字符')));
assert.equal(calls, 1);
replies = ['{'];
await requestReferee(ctx, rules, args);
assert.equal(sent.max_tokens, 2048);
assert.equal(calls, 3);
limit = 384;
await requestReferee(ctx, rules, args);
assert.equal(sent.max_tokens, 384);
limit = 70000;
await requestReferee(ctx, rules, {...args, compact:false});
assert.equal(sent.max_tokens, 70000);
assert.equal(sent.messages.length, turns.length + 1);
assert.ok(sent.messages.at(-1).content.includes(rules));
incoming = [...turns.slice(0,-1), {role:'user',content:[{type:'text', text:action},{type:'image_url', image_url:{url:'fixture'}}]}];
await requestReferee(ctx, rules, args);
assert.deepEqual(sent.messages.at(-2), incoming.at(-1));
assert.equal(sent.max_tokens, 70000);
console.log('Compact and full referee requests, retry limits and media fallback passed.');
