import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { storyPool, poolResult, confirmStory, readReceipt } from '../story-turn.js';

const rows = [
    {id:'trade',name:'协商',note:'按条件交换',enabled:true,weight:10},
    {id:'decline',name:'拒绝',note:'拒绝交易',enabled:true,weight:10},
    {id:'zero',name:'零',enabled:true,weight:0}, {id:'off',name:'关',enabled:false,weight:200},
];
let seed = 17;
const random = () => { seed = (1664525 * seed + 1013904223) >>> 0; return seed / 4294967296; };
let wins = 0;
for (let i = 0; i < 10000; i++) {
    const result = poolResult(storyPool(rows,'N',random), ['N1'], ['N2']);
    assert.deepEqual(result.rows.map(r=>r.pct), [80,20]);
    if (result.winner.code === 'N1') wins++;
}
assert.ok(Math.abs(wins/10000 - 0.8) < 0.018);
const events = new EventEmitter();
let storyCalls = 0;
const ctx = {chatId:'A', characterId:0, characters:[{avatar:'商人.png',description:'市集里的商人'}],
    chat:[{is_user:true,mes:'我请商人商量一下。'}], extensionSettings:{},extensionPrompts:{},
    eventSource:events, eventTypes:{MESSAGE_RECEIVED:'received',MESSAGE_SWIPED:'swiped',GENERATION_ENDED:'ended',GENERATION_STOPPED:'stop'},
    saveSettingsDebounced(){},setExtensionPrompt(id,text){this.extensionPrompts[id]=text; this.lastPrompt=text;},
    generateQuietPrompt(){throw Error('unexpected extra model request');},
    updateMessageBlock(id,msg){assert.equal(msg,this.chat[id]);},
};
globalThis.fetch = () => { throw Error('unexpected separate API'); };
globalThis.SillyTavern = {getContext:()=>ctx};
const entry = new URL('../index.js', import.meta.url);
globalThis.document = Object.assign(new EventTarget(),{readyState:'loading',scripts:[{src:entry.href}]});
await import(entry);
const run = (type='normal') => globalThis.FairDiceIndependentInterceptor([],4096,()=>{},type);
await run(); // create settings for a fresh installation
const cfg = ctx.extensionSettings.fair_dice_winmiu_v1, key = 'char:商人.png:A';
assert.equal(cfg.storyMode, true);
cfg.enabledChats[key] = true;
cfg.chatProfiles[key] = {events:[],reactions:structuredClone(rows)};
const base = JSON.stringify(cfg.chatProfiles[key]);
const respond = (text, receipt, turn) => {
    storyCalls++;
    const mes = text + (receipt ? '\n<!--FD-' + turn.token + ' ' + JSON.stringify(receipt) + '-->' : '');
    const msg = { mes, swipe_id:0, swipes:[mes], extra:{reasoning:'SHOULD NOT BE READ'} };
    ctx.chat.push(msg);
    events.emit('ended'); // streaming hosts can announce the end before the message
    events.emit('received',ctx.chat.length - 1,'normal');
    return msg;
};
await run();
let turn = cfg.storyTurns[key];
const trade = { use:'npc',up:['N1'],down:['N2'],picks:[poolResult(turn.reactions,['N1'],['N2']).winner.code],why:'商人已经收到订金' };
assert.match(ctx.lastPrompt,/当前角色卡/);
assert.match(ctx.lastPrompt,/NPC本机抽签顺序/);
const body = '商人收好订金，低声说了几句话。';
const message = respond(body, trade, turn);
assert.equal(message.mes, body);
assert.equal(message.swipes[0], body);
assert.equal(turn.confirmed.up[0], 'N1');
assert.equal(storyCalls, 1);
assert.ok(!JSON.stringify(cfg).includes('SHOULD NOT BE READ'));
assert.equal(ctx.lastPrompt, '');
const firstToken = turn.token;
await run('regenerate');
assert.equal(cfg.storyTurns[key].token, firstToken);
assert.match(ctx.lastPrompt,/本回合已确认/);
assert.doesNotMatch(ctx.lastPrompt,/<!--FD-/);
events.emit('received', ctx.chat.length-1, 'regenerate');
// Selecting another completion parses its own receipt. Returning to the original restores it.
const other = {use:'none',up:[],down:[],picks:[],why:'事情已经谈妥'};
message.mes = '商人点头。\n<!--FD-' + firstToken + ' ' + JSON.stringify(other) + '-->';
events.emit('swiped',ctx.chat.length-1);
assert.equal(turn.confirmed.use, 'none');
assert.equal(message.mes, '商人点头。');
message.mes = body;
events.emit('swiped',ctx.chat.length-1);
assert.equal(turn.confirmed.use, 'npc');

ctx.chat.push({is_user:true,mes:'对方得知货物损坏后改变了立场。'});
await run();
turn = cfg.storyTurns[key];
assert.notEqual(turn.token, firstToken);
const cool = {use:'npc',up:['N2'],down:['N1'],picks:[poolResult(turn.reactions,['N2'],['N1']).winner.code],why:'商人看见货物裂痕'};
respond('商人发现货物上有一道裂痕。',cool,turn);
assert.deepEqual(poolResult(turn.reactions,turn.confirmed.up,turn.confirmed.down).rows.map(r=>r.pct),[20,80]);
assert.equal(JSON.stringify(cfg.chatProfiles[key]), base);
assert.equal(confirmStory(turn,{...cool,up:['N3']}), null);
assert.equal(confirmStory(turn,{...cool,picks:[]}), null);
assert.equal(confirmStory(turn,{...cool,down:['N2']}), null);
assert.equal(readReceipt('别人的注释<!-- FD 演示 -->', turn.token), null);
assert.equal(readReceipt('故事\n<!--FD-'+turn.token+' {"use":',turn.token).body,'故事');
assert.deepEqual(readReceipt('故事\n<!--FD-'+turn.token+' {"use":"none"}',turn.token).value,{use:'none'});
ctx.chat.push({is_user:true,mes:'继续。'});
await run();
turn = cfg.storyTurns[key];
respond('这一条没有附带记录。',null,turn);
assert.ok(turn.unconfirmed && !turn.confirmed);
assert.equal(storyCalls,3);
assert.match(JSON.stringify(cfg.runLogs[key]),/未追加模型请求/);
await run('regenerate');
assert.equal(cfg.storyTurns[key].token,turn.token);
events.emit('stop');
respond('已停止。',other,turn);
assert.ok(!turn.confirmed);
ctx.chatId = 'B';
await run();
assert.equal(ctx.lastPrompt,'');
assert.equal(cfg.storyTurns['char:商人.png:B'],undefined);
// Exercise the new branches through the automatic generation hook with no manually supplied stats.
ctx.characterId = 1;
ctx.characters.push({avatar:'拳手.png',description:'这名退役拳手在训练馆教课，会修记分器。'});
ctx.chatId = '训练馆';
const ring = 'char:拳手.png:训练馆';
cfg.enabledChats[ring] = true;
ctx.chat = [{is_user:true,mes:'我和刚报名的新人切磋一合。'}];
await run();
let fight = cfg.storyTurns[ring];
assert.deepEqual([fight.checks.actorLevel,fight.checks.opponentLevel],[null,null]);
assert.match(ctx.lastPrompt,/交锋树/);
const ruling = {use:'c-above',state:'flat',world:'urban',foes:1,actor:'退役拳手经常授课',opposition:'对手刚报名学习',why:'双方状态正常'};
function report(die,threshold) {
    if (die <= threshold) return die <= 5 ? '大成' : '成';
    return die >= 96 ? '大败' : '败';
}
respond('两人在训练馆完成了这一合。',{...ruling,result:report(fight.checks.die,65)},fight);
assert.equal(fight.confirmed.check.chance,65);
assert.equal(fight.confirmed.check.roll,fight.checks.die);
assert.match(JSON.stringify(cfg.runLogs[ring]),/对手 1 人/);
ctx.chat.push({is_user:true,mes:'伤肩还在痛，这一回有两名对手参加。'});
await run();
fight = cfg.storyTurns[ring];
respond('这一合结束，两人各自退开。',{...ruling,foes:2,state:'bad',why:'伤肩影响动作',result:report(fight.checks.die,33)},fight);
assert.equal(fight.confirmed.check.chance,33);
assert.equal(cfg.manualChecks[ring],undefined);
await run('regenerate');
assert.match(ctx.lastPrompt,/本回合已确认/);
assert.match(ctx.lastPrompt,/33%/);
ctx.chat.push({is_user:true,mes:'我试着修好计分器。'});
await run();
const task = cfg.storyTurns[ring];
respond('他检查了记分器。',{use:'a-normal',state:'good',actor:'长期维护计分器',opposition:'显示零件错位',why:'手边有配套工具',result:report(task.checks.die,65)},task);
assert.equal(task.confirmed.check.chance,65);
// Old confirmed turns stay fixed; unresolved 1.7 candidates keep their original die on upgrade.
const oldToken = task.token;
delete task.checks;
await run('regenerate');
assert.equal(cfg.storyTurns[ring].token,oldToken);
assert.match(ctx.lastPrompt,/本回合已确认/);
delete task.confirmed;
task.actions = [{roll:54}];
await run('regenerate');
assert.equal(cfg.storyTurns[ring].checks.die,54);
assert.notEqual(cfg.storyTurns[ring].token,oldToken);
assert.match(ctx.lastPrompt,/交锋树/);
console.log('Single-request generation, adaptive distribution, regeneration, swipes, stop and chat isolation passed.');
