import assert from 'node:assert/strict';
import test from 'node:test';
import { actionOdds, DIFFICULTY } from '../engine.js';
import { checkInstructions } from '../scene-check.js';
import { confirmVerdict, readRecord, storyPool, storyPrompt } from '../story-turn.js';

test('the three compact action cutoffs reproduce the same odds at every roll', () => {
    for (let die=1; die<=100; die++) {
        const limits = /最多成功到([^；]+)/.exec(checkInstructions(die))[1].split('/');
        const options = Object.entries(DIFFICULTY);
        for (const [column, modifier] of [-15,0,15].entries()) {
            const last = options.findIndex(([,d]) => d.name === limits[column]);
            for (const [i,[difficulty]] of options.entries()) {
                assert.equal(i <= last, die <= actionOdds({difficulty,modifier}).probability);
            }
        }
    }
});

test('one-line model decisions are checked against the real threshold and weighted tickets', () => {
    const rows = [{name:'延续', enabled:true, weight:20}, {name:'变化', enabled:true, weight:10}];
    const turn = {die:58, events:storyPool(rows, 'E', () => 0.3), reactions:storyPool(rows, 'N', () => 0.3)};
    const combat = '战|一般|优势|中性|1|成|角色卡写明对方初学，双方均未受伤';
    assert.match(confirmVerdict(turn, combat)[0], /对手 1 人.*d100=58 \/ 阈值 65%，成功/);
    assert.equal(confirmVerdict(turn, combat.replace('|成|', '|败|')), null);
    assert.equal(confirmVerdict(turn, combat.replace('|1|', '|2|')), null);
    assert.equal(confirmVerdict(turn, combat.replace('|成|', '|成|私自新增后果|')), null);
    assert.equal(confirmVerdict(turn, combat.replace('角色卡写明对方初学，双方均未受伤', '失败则对方会离开')), null);
    assert.match(confirmVerdict(turn, '行|困难|不利|败|工具不足')[0], /阈值 15%，失败/);
    assert.match(confirmVerdict(turn, '略|只是寒暄')[0], /无需判定/);
    assert.match(confirmVerdict(turn, '缓|看不清来者')[0], /暂缓判定/);
    const both = confirmVerdict(turn, '事|!E1 +E2|E2|已到交班时间；人|0|N1|有旧约');
    assert.equal(both.length,2);
    assert.match(both[0], /延续排除、变化×2/);
    assert.equal(confirmVerdict(turn, '事|!E1 +E2|E1|已到交班时间'),null);
    assert.equal(confirmVerdict(turn, '事|+N1|E1|错误分组'),null);
    assert.match(confirmVerdict(turn, '事|!E1 !E2|0|均与现场矛盾')[0], /全部排除/);
});

test('only the completed current-floor marker is removed, including on continuation', () => {
    const prefix='<!-- unrelated -->先前正文。\n', tail='新的正文。<!-- other -->';
    const text=prefix+'<!--FD-abc 略|只是寒暄 -->\n'+tail;
    assert.deepEqual(readRecord(text, 'abc'), {record:'略|只是寒暄', body:prefix+tail});
    assert.equal(readRecord(text, 'another'),null);
    assert.equal(readRecord('<!--FD-abc 未完成\n正文<!-- other -->','abc'),null);
});

test('disabled and zero-weight entries are excluded while custom entries retain all three coefficients', () => {
    const pool=storyPool([
        {enabled:true,weight:10,name:'协商',id:'a'}, {enabled:true,weight:10,name:'观望',id:'b'},
        {enabled:true,weight:0,name:'忽略'}, {enabled:false,weight:200,name:'关闭'},
    ],'N',()=>0.5);
    assert.equal(pool.items.length,2);
    assert.deepEqual([...pool.order].sort(),['+N1','+N2','-N1','-N2','N1','N2']);
});

test('the same draws allow a different choice when the scene changes the coefficients', () => {
    const draws = [0.35, 0.45];
    const pool = storyPool([
        {name:'协商', enabled:true, weight:10}, {name:'观望', enabled:true, weight:10},
    ], 'N', () => draws.shift());
    function firstEligible(eligible) { return pool.order.find(code => eligible.includes(code)); }
    assert.equal(firstEligible(['N1', 'N2']), 'N1');
    assert.equal(firstEligible(['-N1', '+N2']), '+N2');
    assert.equal(firstEligible(['N2']), 'N2');
    assert.equal(firstEligible([]), undefined);
});

test('the prompt offers each narrative branch only with its own active candidates', () => {
    const rows = [{name:'候选', enabled:true, weight:10}];
    for (const events of [false, true]) {
        for (const reactions of [false, true]) {
            const prompt = storyPrompt({
                die:45, events:storyPool(events ? rows : [], 'E', () => 0.4),
                reactions:storyPool(reactions ? rows : [], 'N', () => 0.4),
            });
            assert.equal(prompt.includes('事：自然转场'), events);
            assert.equal(prompt.includes('E1=候选'), events);
            assert.equal(prompt.includes('人：未决NPC'), reactions);
            assert.equal(prompt.includes('N1=候选'), reactions);
            assert.equal(prompt.includes('全排除填0'), events || reactions);
            assert.match(prompt, /行：/);
            assert.match(prompt, /战：/);
        }
    }
});
