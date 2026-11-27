import assert from 'node:assert/strict';
import test from 'node:test';
import { actionOdds, combatOdds, COMBAT_PROFILES } from '../engine.js';
import { checkInstructions } from '../scene-check.js';
import { storyPool } from '../story-turn.js';

test('the input table describes only the binary result for fixed scene conditions', () => {
    for (const die of [1,5,33,54,96,100]) {
        const prompt = checkInstructions(die);
        const row = prompt.split('\n').find(s => s.split('：')[0].split('/').includes('现实') && s.includes('优势='));
        const counts = /，优势=([\d/]+)/.exec(row)[1].split('/').map(Number);
        for (const [i,modifier] of [-15,0,15].entries()) {
            for (let n=1; n<=100; n++) {
                const odds = combatOdds({relativeBase:65,modifier,opponentCount:n,profile:COMBAT_PROFILES.urban});
                assert.equal(n <= counts[i],die <= odds.probability);
            }
        }
        const action = /一般=([成败/]+)/.exec(prompt)[1].split('/');
        for (const [i,modifier] of [-15,0,15].entries()) {
            assert.equal(action[i],die <= actionOdds({difficulty:'normal',modifier}).probability ? '成' : '败');
        }
    }
});

test('disabled and zero-weight entries are excluded while custom entries retain all three coefficients', () => {
    const pool=storyPool([
        {enabled:true,weight:10,name:'协商',id:'a'}, {enabled:true,weight:10,name:'观望',id:'b'},
        {enabled:true,weight:0,name:'忽略'}, {enabled:false,weight:200,name:'关闭'},
    ],'N',()=>0.5);
    assert.equal(pool.items.length,2);
    assert.deepEqual([...pool.order].sort(),['+N1','+N2','-N1','-N2','N1','N2']);
});
