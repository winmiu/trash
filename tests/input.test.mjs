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
                updateMessageBlock:forbidden('edited output'),
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
                const body = Object.freeze({is_user:false,mes:'计分器亮了。'});
                ctx.chat.push(body);
                events.emit('received',ctx.chat.length-1,type);
                events.emit('ended');
                assert.equal(body.mes,'计分器亮了。');
                return input;
            }
            const input = hostReply('normal');
            assert.equal(input.length,1);
            assert.match(input[0],/d100=\d+/);
            assert.match(input[0],/后果、严重程度和后续情节全部由主预设/);
            assert.doesNotMatch(input[0],/OLD-CONSEQUENCE|<!--|HTML|JSON|stakes|字段|回执|大败|大成|致命|失败可带来/);
            assert.equal(requests.length,1);
            assert.deepEqual(ctx.extensionPrompts,{});
            assert.equal(events.listenerCount('received'),0);
            for (const type of ['regenerate','swipe','continue']) assert.deepEqual(hostReply(type),input);
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
            assert.match(JSON.stringify(cfg.runLogs[key]),/已注入正文输入/);
            assert.deepEqual(violations,[]);
        } finally { globalThis.fetch = previousFetch; }
    }
});
