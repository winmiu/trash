import assert from 'node:assert/strict';
import { sceneChecks, checkInstructions, confirmCheck } from '../scene-check.js';
import { confirmStory } from '../story-turn.js';
import { combatOdds, COMBAT_PROFILES, resolveCheck } from '../engine.js';

const input = { actorLevel:null, opponentLevel:null, opponentCount:1, difficulty:'normal', modifier:0 };
const options = { action:true, combat:true, profile:'auto', allowUnknown:false };
const s = sceneChecks(input, 54, options);
const boxer = { use:'c-above', actor:'行动方曾长期参加拳击训练', opposition:'对手刚开始练拳', state:'flat',
    world:'urban', foes:1, why:'双方按同一套训练规则切磋' };
const trade = { use:'a-normal', actor:'人物擅长修理这类器具', opposition:'齿轮轻微错位', state:'good', why:'熟悉这种机械结构' };
const rules = checkInstructions(s);
assert.match(rules,/交锋树/);
assert.match(rules,/行动树/);
assert.match(rules,/c-above/);
assert.match(rules,/c-hold/);
assert.doesNotMatch(rules,/c-rated|c-unknown/);
assert.equal(confirmCheck(s,boxer).chance,65);
assert.equal(confirmCheck(s,boxer).success,true);
const hurt = confirmCheck(s,{...boxer, state:'bad', foes:2, why:'本轮伤肩仍在疼痛'});
assert.equal(hurt.chance,33);
assert.equal(hurt.success,false);
assert.equal(hurt.roll,54);
assert.equal(confirmCheck(s,trade).chance,65);
assert.equal(confirmCheck(s,{...trade,state:'bad',why:'现场妨碍了精细操作'}).chance,35);
assert.ok(confirmCheck(s,{use:'c-hold',why:'无法从现有描写比较双方'}).pending);
assert.equal(confirmCheck(s,{use:'c-hold'}),null);
assert.ok(confirmCheck(s,{use:'a-hold',why:'缺少判断门槛的事实'}).pending);
for (const invalid of [{actor:''},{opposition:''},{why:''},{world:'anything'},{state:'extra'},
    {foes:-1},{foes:1.2},{foes:'2'},{use:'c-rated'},{use:'c-unknown'},{use:'c-constructor'}]) {
    assert.equal(confirmCheck(s,{...boxer,...invalid}), null);
}
assert.equal(confirmCheck(s,{...boxer,use:'c-above',foes:100}).chance,1);
const locked = sceneChecks({...input,actorLevel:55,opponentLevel:45,opponentCount:'3',modifier:7,difficulty:'hard'},54,{...options,profile:'urban'});
const numeric = {...boxer,use:'c-rated',foes:3};
const odds = combatOdds({actorLevel:55,opponentLevel:45,opponentCount:3,modifier:7,profile:COMBAT_PROFILES.urban});
assert.equal(confirmCheck(locked,numeric).chance,odds.probability);
for (const invalid of [{use:'c-above'},{foes:1},{state:'good'},{world:'neutral'}]) {
    assert.equal(confirmCheck(locked,{...numeric,...invalid}),null);
}
assert.equal(confirmCheck(locked,trade),null);
assert.equal(confirmCheck(locked,{...trade,use:'a-hard',state:'flat'}).chance,37);
const partial = sceneChecks({...input,actorLevel:0},54,options);
assert.match(checkInstructions(partial),/行动方 0，对手 未知/);
assert.ok(confirmCheck(partial,boxer));
const disabled = sceneChecks(input,54,{...options,combat:false,action:false});
assert.equal(checkInstructions(disabled),'');
for (const v of [boxer, trade, {use:'c-hold',why:'原因'}]) assert.equal(confirmCheck(disabled,v),null);
const optIn = sceneChecks(input,54,{...options,allowUnknown:true});
assert.equal(confirmCheck(optIn,{...boxer,use:'c-unknown'}).chance,50);
assert.equal(confirmCheck(optIn,{...boxer,use:'c-unknown',state:'good'}),null);

// Decode the table actually shown to the model. Check lookup boundaries at high and low rolls,
// including critical degrees and the crowd caps, against the verdict written to the log.
const names = { 成:'成功', 败:'失败', 大成:'显著成功', 大败:'严重失利' };
function lookup(cell,n) {
    for (const segment of cell.split(',')) {
        const [,lo,span,hi,label] = /^(\d+)?([–+])?(\d+)?(大?[成败])$/.exec(segment);
        if (!lo || (n >= +lo && n <= (span === '+' ? 100 : span === '–' ? +hi : +lo))) return names[label];
    }
    throw Error('no table entry');
}
for (const die of [1,5,6,33,54,65,95,96,100]) {
    const turn = sceneChecks(input,die,options);
    const prompt = checkInstructions(turn);
    for (const world of turn.worlds) {
        const line = prompt.split('\n').find(line=>line.split('：')[0].split('/').includes(world) && line.includes('c-above('));
        for (const base of turn.combat) {
            const cells = line.match(new RegExp('c-'+base+'\\([^)]*\\)=([^；]+)'))[1].split('/');
            for (const [i,state] of ['bad','flat','good'].entries()) {
                for (const foes of [1,2,3,4,5,7,10,49,50,100]) {
                    const actual = confirmCheck(turn,{...boxer,use:'c-'+base,state,foes,world});
                    assert.equal(lookup(cells[i],foes),actual.degree);
                    assert.equal(actual.degree,resolveCheck(actual.chance,die).degree);
                }
            }
        }
    }
}
const emptyPool = {items:[],order:[]};
const ticket = {checks:s,events:emptyPool,reactions:emptyPool};
assert.equal(confirmStory(ticket,{...boxer,result:'成'}).check.chance,65);
assert.equal(confirmStory(ticket,{...trade,result:'成'}).check.chance,65);
assert.equal(confirmStory(ticket,{...boxer,result:'败'}),null);
assert.equal(confirmStory(ticket,trade),null);
assert.equal(confirmStory(ticket,{use:'combat'}),null);
assert.equal(confirmStory(ticket,{use:'none',why:'两人只是在交谈'}).use,'none');
console.log('Decision-tree rehearsal, no-stat scenes, manual overrides, disabled branches and printed outcome tables passed.');
