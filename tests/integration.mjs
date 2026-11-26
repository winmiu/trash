import assert from 'node:assert/strict';
const injected=[];
let gmResponse={};let quietCalls=0;
const ctx={
 chatId:'chat-A', characterId:0, characters:[{avatar:'a.png'}], name2:'Elias',
 chat:[{is_user:true,mes:'我们说说今晚的电影'}],extensionSettings:{},extensionPrompts:{},
 saveSettingsDebounced(){},
 setExtensionPrompt(key,value){injected.push({chatId:this.chatId,value});this.extensionPrompts[key]=value;},
 async generateQuietPrompt(){quietCalls++;return JSON.stringify(gmResponse);},
};
globalThis.SillyTavern={getContext:()=>ctx};
await import('../index.js');
const roll=async(type='normal')=>globalThis.FairDiceIndependentInterceptor([],512,()=>{},type);
const cfg=ctx.extensionSettings.fair_dice_winmiu_v1 ||= {};
cfg.enabledChats={'char:a.png:chat-A':true, 'char:a.png:chat-B':true};
// No dice: casual chat, even if event preset is enabled.
gmResponse={kind:'none',shouldRoll:false,eventRelevant:false,npcRelevant:false};
await roll();
assert.match(injected.at(-1).value,/不.*强行插入事件/);
assert.doesNotMatch(injected.at(-1).value,/事件权重抽签/);
// Per-chat weights are independent and don't silently carry over to other characters.
ctx.chat.push({is_user:true,mes:'新的一天开始了，看看街上发生什么'});
gmResponse={kind:'narrative',shouldRoll:true,eventRelevant:true,npcRelevant:false};
await roll();
const keyA='char:a.png:chat-A';
assert.ok(cfg.chatProfiles[keyA]);
cfg.chatProfiles[keyA].events=[{id:'custom',name:'仅A有的事件',note:'A',enabled:true,weight:100}];
ctx.chat.push({is_user:true,mes:'又一个清晨'});
await roll();
assert.match(injected.at(-1).value,/仅A有的事件/);
// User switches chats. B must use default entries.
ctx.chatId='chat-B';ctx.chat=[{is_user:true,mes:'新一天的开始'}];
await roll();
const keyB='char:a.png:chat-B';
assert.ok(cfg.chatProfiles[keyB]);
assert.notDeepEqual(cfg.chatProfiles[keyA].events,cfg.chatProfiles[keyB].events);
assert.doesNotMatch(injected.at(-1).value,/仅A有的事件/);
// Inferred levels require documented evidence and confidence.
ctx.chat.push({is_user:true,mes:'我和对手进入一次交锋'});
gmResponse={kind:'combat',shouldRoll:true,setting:'martial',actorLevel:75,actorSource:'inferred',actorEvidence:'',actorConfidence:'low',opponentLevel:40,opponentSource:'explicit',opponentEvidence:'世界书直接规定对手战力40',opponentConfidence:'high',opponentCount:1,modifier:0};
await roll();
assert.match(injected.at(-1).value,/尚无足够依据/);
// Two supported explicit values permit a real d100 roll.
ctx.chat.push({is_user:true,mes:'下一次交锋'});
gmResponse={kind:'combat',shouldRoll:true,setting:'martial',actorLevel:75,actorSource:'explicit',actorEvidence:'人设明确75',actorConfidence:'high',opponentLevel:40,opponentSource:'explicit',opponentEvidence:'人设明确40',opponentConfidence:'high',opponentCount:1,modifier:0};
await roll();
assert.match(injected.at(-1).value,/战斗交锋判定/);
assert.match(injected.at(-1).value,/独立d100=/);
const previous=injected.at(-1).value;
await roll('regenerate');
assert.equal(injected.at(-1).value,previous);
// Disabled: must remove prompt.
cfg.enabledChats[keyB]=false;
await roll();
assert.equal(injected.at(-1).value,'');
assert.equal(quietCalls,6);
console.log('Fair Dice v1.3 integration tests PASSED');
