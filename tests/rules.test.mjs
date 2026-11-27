import assert from 'node:assert/strict';
import test from 'node:test';
import { actionOdds, DIFFICULTY } from '../engine.js';
import { auditText, checkInstructions } from '../scene-check.js';
import { confirmVerdict, disputedCheck, readRecord, storyPool, storyPrompt } from '../story-turn.js';

test('action rule names, numerical base chances and boundary comparisons match the engine', () => {
    const turn={die:88};
    assert.match(checkInstructions(88),/基值90\/70\/50\/30\/10\/0/);
    for (const [difficulty,entry] of Object.entries(DIFFICULTY)) {
        for (const [state,modifier] of [['不利',-15],['中性',0],['有利',15]]) {
            const n=actionOdds({difficulty,modifier}).probability;
            const result=n>=88?'成':'败';
            const verdict=confirmVerdict(turn,['行',entry.name,state,n+'%'+result,'修理古钟'].join('|'));
            assert.ok(auditText(verdict).includes('成功阈值 '+n+'%，88 '+(n>=88?'≤':'>')+' '+n));
        }
    }
    assert.match(auditText(confirmVerdict({die:50},'行|一般|中性|50%成功|修理古钟')),/50 ≤ 50，成功/);
    assert.match(auditText(['行动 · 旧楼。d100=88 / 阈值 1%，失败。']),/88 > 1，失败/);
    assert.match(disputedCheck(turn,'行|极难|不利|5%败|工具不合适'),/复核.*88 > 1，失败/);
    assert.equal(disputedCheck(turn,'行|极低|不明|失败|工具不合适'),'');
});

test('one-line model decisions are checked against the real threshold and weighted tickets', () => {
    const rows = [{name:'延续', enabled:true, weight:20}, {name:'变化', enabled:true, weight:10}];
    const turn = {die:58, events:storyPool(rows, 'E', () => 0.3), reactions:storyPool(rows, 'N', () => 0.3)};
    const combat = '战|一般|优势|中性|1|成|角色卡写明对方初学，双方均未受伤';
    assert.match(confirmVerdict(turn, combat)[0], /对手 1 人.*d100=58，成功阈值 65%，58 ≤ 65，成功/);
    assert.equal(confirmVerdict(turn, combat.replace('|成|', '|败|')), null);
    assert.equal(confirmVerdict(turn, combat.replace('|1|', '|2|')), null);
    assert.equal(confirmVerdict(turn, combat.replace('|成|', '|成|私自新增后果|')), null);
    assert.equal(confirmVerdict(turn, combat.replace('角色卡写明对方初学，双方均未受伤', '失败则对方会离开')), null);
    assert.match(confirmVerdict(turn, '行|困难|不利|败|工具不足')[0], /阈值 15%，58 > 15，失败/);
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

test('action and combat bind the stated goal and both outcomes to the floor, leaving narration to the preset', () => {
    const pool = {items:[], order:[]};
    const target = '目标：把信交到对方手中，依据：对方就在面前';
    for (const die of [50, 51]) {
        const turn = {die, events:pool, reactions:pool, token:'floor'};
        for (const branch of ['行|一般|中性', '战|一般|相当|中性|1']) {
            const record = branch + '|' + (die === 50 ? '50%成' : '50%败') + '|' + target;
            const verdict = confirmVerdict(turn, record);
            assert.ok(verdict[0].includes(target));
            assert.match(verdict[0], die === 50 ? /50 ≤ 50，成功/ : /51 > 50，失败/);
            for (const prompt of [storyPrompt(turn), storyPrompt({...turn, verdict})]) {
                for (const rule of ['本楼目标已达成', '不能换人或换方法达成同一目标', '不得以拦截、补救或反转抵消成败', '续写承接已写事实', '挽回须等玩家下一条消息再判', '篇幅、文风与格式均依主预设']) {
                    assert.ok(prompt.includes(rule), rule);
                }
            }
            assert.ok(storyPrompt({...turn, verdict}).includes(target));
        }
    }
    assert.match(storyPrompt({verdict:['行动 · 旧楼。d100=88 / 阈值 1%，失败。']}), /挽回须等玩家下一条消息再判/);
    for (const summary of ['本轮无需判定 · 正在寒暄。', '暂缓判定 · 来者身份不明。', '事件 · 正值交班。']) {
        assert.doesNotMatch(storyPrompt({verdict:[summary]}), /同一目标|补救或反转/);
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
