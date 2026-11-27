import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
const entry = new URL('../' + manifest.js, import.meta.url);
const key = 'char:card.png:one', slot = 'fair_dice_winmiu_injection_v1';

test('legacy and fresh installations only inject into the host request', async () => {
    for (const legacy of [{autoJudge:true, storyMode:false, refereeApi:'main', compactJudge:true},
        {autoJudge:true, refereeApi:'independent', refereeModel:'fixture', refereeAddress:'https://unused.invalid'},
        {autoJudge:false, storyMode:false}, {autoJudge:true, storyMode:true}, {}]) {
        const url = new URL(entry);
        url.searchParams.set('case', JSON.stringify(legacy));
        const events = new EventEmitter(), requests = [], violations = [];
        const forbidden = label => () => { violations.push(label); throw Error(label); };
        const previousFetch = globalThis.fetch;
        globalThis.fetch = forbidden('unexpected fetch');
        try {
            const cfg = {...legacy, enabledChats:{[key]:true}, assessments:{[key]:{stakes:'OLD-CONSEQUENCE'}},
                queued:{[key]:{rationale:'OLD-CONSEQUENCE'}}};
            const ctx = {
                extensionSettings:{fair_dice_winmiu_v1:cfg}, chatId:'one', characterId:0, characters:[{avatar:'card.png'}],
                chat:[{is_user:true,mes:'我试着修好计分器。'}], extensionPrompts:{},
                eventTypes:{GENERATION_ENDED:'ended',GENERATION_STOPPED:'stop',CHAT_CHANGED:'change',MESSAGE_RECEIVED:'received'},
                eventSource:events, saveSettingsDebounced(){},
                generateQuietPrompt:forbidden('quiet request'), generate:forbidden('generation'), generateRaw:forbidden('raw generation'),
                updateMessageBlock(_id, message){assert.equal(message.mes,'计分器亮了。');},
                setExtensionPrompt(id,value,position,depth,scan,role,filter) {
                    this.extensionPrompts[id]={value,position,depth,scan,role,filter};
                },
            };
            globalThis.document = Object.assign(new EventTarget(),{readyState:'loading',scripts:[{src:url.href}]});
            globalThis.SillyTavern = {getContext:()=>ctx};
            await import(url.href);
            const hook = globalThis[manifest.generate_interceptor];
            function assemble(type) {
                hook([],8192,forbidden('aborted host'),type);
                return Object.values(ctx.extensionPrompts).filter(p=>p.filter?.()).map(p=>p.value);
            }
            function hostReply(type) {
                const input = assemble(type);
                requests.push(input); // the host's one narration call
                const turn = ctx.chat.findLast(m => m.is_user).extra.fairDiceFloorV2;
                const prefix = turn.verdict ? '' : '<!--FD-' + turn.token + ' 行|一般|中性|' + (turn.die <= 50 ? '成' : '败') + '|玩家已开始维修计分器 -->\n';
                const body = {is_user:false,mes:prefix + '计分器亮了。',swipe_id:0,swipes:[prefix + '计分器亮了。']};
                ctx.chat.push(body);
                if (type === 'normal') events.emit('ended'); // streaming order
                events.emit('received',ctx.chat.length-1,type);
                events.emit('ended');
                assert.equal(body.mes,'计分器亮了。');
                assert.equal(body.swipes[0],body.mes);
                return input;
            }
            const input = hostReply('normal');
            assert.equal(input.length,1);
            assert.match(input[0],/d100=\d+/);
            for (const rule of ['先找出仍未确定的问题', '行动：', '没有数值就用人设', '事件走向：', 'NPC 反应：', '每轮重评']) {
                assert.ok(input[0].includes(rule), rule);
            }
            assert.match(input[0],/后果、严重程度和后续情节全部由主预设/);
            assert.doesNotMatch(input[0],/OLD-CONSEQUENCE|stakes|大败|大成|致命|失败可带来/);
            assert.equal(requests.length,1);
            assert.deepEqual(ctx.extensionPrompts,{});
            assert.equal(events.listenerCount('received'),1);
            const fixed = hostReply('regenerate');
            assert.match(fixed[0],/本楼已确认裁定[\s\S]*维修计分器[\s\S]*阈值 50%/);
            assert.doesNotMatch(fixed[0],/候选顺序|<!--FD/);
            ctx.chat.splice(1); // delete the replies and reload the stored player message
            ctx.chat = JSON.parse(JSON.stringify(ctx.chat));
            ctx.characters[0].description = '角色卡编辑';
            cfg.chatProfiles[key].events = [];
            for (const type of ['swipe','continue','normal']) assert.deepEqual(hostReply(type),fixed);
            ctx.chat.push({is_user:true,mes:'新的玩家楼层'});
            const newInput = assemble('normal');
            assert.match(newInput[0],/<!--FD-/);
            assert.doesNotMatch(newInput[0],/事件走向：/);
            ctx.chat.push({mes:'本轮只有故事。'});
            events.emit('received',ctx.chat.length-1,'normal');
            assert.match(JSON.stringify(cfg.runLogs[key][0]),/未附可识别/);
            events.emit('ended');
            ctx.chat.splice(-2);
            assert.deepEqual(assemble('normal'),fixed);
            assemble('normal'); assemble('normal');
            assert.deepEqual(Object.keys(ctx.extensionPrompts),[slot]);
            assert.equal(ctx.extensionPrompts[slot].depth,0);
            events.emit('stop');
            assert.deepEqual(ctx.extensionPrompts,{});
            for(const type of ['quiet','impersonate']) assert.deepEqual(assemble(type),[]);
            ctx.chatId = 'two';
            events.emit('change');
            assert.deepEqual(assemble('normal'),[]);
            ctx.chatId = 'one';
            cfg.enabledChats[key]=false;
            assert.deepEqual(assemble('normal'),[]);
            const history = cfg.runLogs[key];
            assert.ok(history.some(run => cfg.runInputs[key][run.inputId] === input[0]));
            assert.ok(history.some(run => cfg.runInputs[key][run.inputId] === fixed[0]));
            assert.match(JSON.stringify(history),/沿用本楼已确认裁定/);
            assert.deepEqual(violations,[]);
        } finally { globalThis.fetch = previousFetch; }
    }
});
