import assert from 'node:assert/strict';
import { actionOdds, combatOdds, parseLevel, rollD100, resolveCheck, detectKind, COMBAT_PROFILES } from '../engine.js';

assert.equal(actionOdds({difficulty:'impossible',modifier:35}).probability,0);
assert.equal(actionOdds({difficulty:'normal',modifier:0}).probability,50);
assert.equal(parseLevel(''),null);
assert.equal(detectKind('我向对方出拳'), 'combat');
assert.equal(detectKind('我试着撬开锁'), 'action');
assert.equal(detectKind('我看看街上的天气'), 'narrative');
assert.equal(rollD100(()=>0),1);
assert.equal(rollD100(()=>0.999),100);
assert.equal(resolveCheck(0,1).success,false);
assert.equal(combatOdds({actorLevel:80,opponentLevel:20,opponentCount:50,profile:COMBAT_PROFILES.strict}).probability<=1,true);
assert.ok(combatOdds({actorLevel:80,opponentLevel:20,profile:COMBAT_PROFILES.urban}).probability<99);

const chats = [{is_user:true,mes:'我试着说服商人降价'}];
let quietCalls = 0;
const injections=[];
let reply={
    kind:'action',shouldRoll:true,eventRelevant:false,npcRelevant:false,
    actorLevel:null,opponentLevel:null,opponentCount:1,
    modifier:5,difficulty:'hard',evidence:'这是一次价格谈判',stakes:'对方可能拒绝'
};
const c={
    chatId:'session1',characterId:0,characters:[{avatar:'test.png'}],name2:'Test',
    chat:chats, extensionSettings:{},extensionPrompts:{},saveSettingsDebounced(){},
    setExtensionPrompt(key,value){injections.push(value);this.extensionPrompts[key]=value;},
    async generateQuietPrompt({quietPrompt}) {
        quietCalls++;
        assert.match(quietPrompt,/独立的桌面角色扮演裁判/);
        // Ensure reentrant quiet calls cannot invoke another adjudication.
        await globalThis.FairDiceIndependentInterceptor([],1024,()=>{},'quiet');
        return JSON.stringify(reply);
    },
};
globalThis.SillyTavern={getContext:()=>c};
await import('../index.js');
const key='char:test.png:session1';
const settings=c.extensionSettings.fair_dice_winmiu_v1 ||= {};
settings.enabledChats={ [key]:true };
settings.autoJudge=true;
settings.eventDice=true;
settings.npcDice=true;
settings.fairness=true;
await globalThis.FairDiceIndependentInterceptor([],1024,()=>{},'normal');
assert.equal(quietCalls,1);
assert.match(injections.at(-1), /非战斗行动检定/);
assert.match(injections.at(-1), /独立d100=/);
const previous=injections.at(-1);
await globalThis.FairDiceIndependentInterceptor([],1024,()=>{},'regenerate');
assert.equal(quietCalls,1, 'one adjudication per user turn');
assert.equal(injections.at(-1), previous, 'same dice on regenerate');
chats.push({is_user:true,mes:'我坐着看窗外，没有进一步动作'});
reply={kind:'narrative',shouldRoll:false,eventRelevant:false,npcRelevant:false,
    actorLevel:null,opponentLevel:null,opponentCount:1,modifier:0,difficulty:'normal',
    evidence:'场景没有未定动作',stakes:'无'};
await globalThis.FairDiceIndependentInterceptor([],1024,()=>{},'normal');
assert.equal(quietCalls,2);
assert.match(injections.at(-1), /本轮没有有意义的不确定行动/);
assert.doesNotMatch(injections.at(-1), /独立d100=/);
settings.enabledChats[key]=false;
await globalThis.FairDiceIndependentInterceptor([],1024,()=>{},'normal');
assert.equal(quietCalls,2);
assert.equal(injections.at(-1),'');

// Unknown battle ability must fail closed, not invent a win.
chats.push({is_user:true,mes:'我扑过去尝试攻击强敌'});
settings.enabledChats[key]=true;
reply={kind:'combat',shouldRoll:true,eventRelevant:false,npcRelevant:false,
  actorLevel:null,opponentLevel:null,opponentCount:1,modifier:0,difficulty:'normal',
  evidence:'两人的战斗训练未知',stakes:'本次交锋的进退'};
await globalThis.FairDiceIndependentInterceptor([],1024,()=>{},'normal');
assert.match(injections.at(-1), /尚无足够依据进行概率裁决/);
console.log('Fair Dice v1.2 smoke tests PASSED');
