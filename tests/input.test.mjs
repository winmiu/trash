import assert from 'node:assert/strict';
import test from 'node:test';
import { EventEmitter } from 'node:events';
import { readFile } from 'node:fs/promises';
import { placeInChat, presentIn } from '../delivery.js';
import { judgeFloor } from '../profile-judge.js';
import { customJudge, customKey, normalizeAddress, mainJudge } from '../judge-api.js';

const manifest = JSON.parse(await readFile(new URL('../manifest.json', import.meta.url)));
const entry = new URL('../' + manifest.js, import.meta.url);
const key = 'char:card.png:one', slot = 'fair_dice_winmiu_injection_v1';

test('legacy and fresh installations only inject into the host request', async () => {
    for (const legacy of [{autoJudge:true, storyMode:false, refereeApi:'main', compactJudge:true},
        {autoJudge:true, refereeApi:'independent', refereeModel:'fixture', refereeAddress:'https://unused.invalid'},
        {autoJudge:false, storyMode:false}, {autoJudge:true, storyMode:true},
        {judgeEnabled:false,judgeRoute:'custom',judgeAddress:'https://unused.invalid/v1',judgeModel:'unused',judgeProfileId:'saved'}, {}]) {
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
                assert.match(body.extra.fairDiceAudit.text,/成功阈值 50%/);
                return input;
            }
            const input = hostReply('normal');
            assert.equal(input.length,1);
            assert.match(input[0],/d100=\d+/);
            for (const rule of ['闲聊/既定事实略过', '任务门槛', '无数值用已知表现', '自然转场', 'NPC选择', '加倍/减半/排除']) {
                assert.ok(input[0].includes(rule), rule);
            }
            assert.match(input[0],/后果交主预设/);
            assert.doesNotMatch(input[0],/OLD-CONSEQUENCE|stakes|大败|大成|致命|失败可带来/);
            assert.equal(requests.length,1);
            assert.deepEqual(ctx.extensionPrompts,{});
            assert.equal(events.listenerCount('received'),1);
            const fixed = hostReply('regenerate');
            assert.match(fixed[0],/本楼裁定[\s\S]*维修计分器[\s\S]*阈值 50%/);
            assert.doesNotMatch(fixed[0],/候选顺序|<!--FD/);
            ctx.chat.splice(1); // delete the replies and reload the stored player message
            ctx.chat = JSON.parse(JSON.stringify(ctx.chat));
            ctx.characters[0].description = '角色卡编辑';
            cfg.chatProfiles[key].events = [];
            for (const type of ['swipe','continue','normal']) assert.deepEqual(hostReply(type),fixed);
            ctx.chat.push({is_user:true,mes:'新的玩家楼层'});
            const newInput = assemble('normal');
            assert.match(newInput[0],/<!--FD-/);
            assert.doesNotMatch(newInput[0],/自然转场/);
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
            assert.match(JSON.stringify(history),/已准备本楼已确认裁定/);
            assert.deepEqual(violations,[]);
        } finally { globalThis.fetch = previousFetch; }
    }
});

test('a dedicated API uses only credentials for its current endpoint and account', async () => {
    const ctx = {extensionSettings:{},getRequestHeaders:()=>({'content-type':'application/json'})};
    const address = normalizeAddress('https://one.invalid/v1/chat/completions/');
    customKey(ctx,address,'fixture-one');
    const sent=[], original=globalThis.fetch;
    globalThis.fetch=async (path,options)=>{
        assert.equal(path,'/api/backends/chat-completions/generate');
        sent.push(JSON.parse(options.body));
        return {ok:true,json:async()=>({choices:[{message:{content:'略|问好'}}]})};
    };
    try {
        for (const endpoint of [address,'https://two.invalid/v1']) {
            assert.equal(await customJudge(ctx,{judgeAddress:endpoint,judgeModel:'fixture'},[],new AbortController().signal),'略|问好');
        }
        assert.equal(sent[0].proxy_password,'fixture-one');
        assert.equal(sent[1].proxy_password,'');
        assert.equal(customKey({extensionSettings:{}},address),'');
        assert.doesNotMatch(JSON.stringify(ctx.extensionSettings),/fixture-one/);
        customKey(ctx,address,''); assert.equal(customKey(ctx,address),'');
    } finally {globalThis.fetch=original;}
});

test('follow-main uses the current text API and discards a result after cancellation', async () => {
    const controller=new AbortController(), messages=[{role:'user',content:'fixture'}];
    let finish;
    const ctx={mainApi:'textgenerationwebui',generateRaw:({prompt})=>{
        assert.deepEqual(prompt,messages);return new Promise(resolve=>{finish=resolve;});
    }};
    const pending=mainJudge(ctx,messages,controller.signal);
    controller.abort('judge-off');
    await assert.rejects(pending,/cancelled/);
    finish('略|迟到的回复');
});

test('the budgeted slot becomes one final instruction without changing preset or assistant prefill', () => {
    const text='【公平骰】本楼交锋失败。', slot='[fd:abc]'+text+'[/fd:abc]';
    const prefill=Object.freeze({role:'assistant',content:'故事开场。'});
    const preset=Object.freeze({role:'system',content:'遵守正文格式。'});
    for (const budgeted of [[], [{role:'system',content:slot}], [{role:'system',content:'前文'+slot+'后文'}],
        [{role:'user',content:[{type:'image_url',image_url:{url:'fixture'}},{type:'text',text:slot}]}]]) {
        const data=placeInChat([...budgeted,preset,prefill],text,'abc');
        assert.equal(data.at(-1),prefill);
        assert.equal(data.at(-2).content,'遵守正文格式。\n\n'+text);
        assert.equal(JSON.stringify(data).split(text).length-1,1);
        assert.ok(presentIn(data,text));
        assert.ok(!JSON.stringify(data).includes('[fd:abc]'));
        assert.equal(preset.content,'遵守正文格式。');
    }
});

test('independent profile receives only scene material, returns conditions, and a locked floor pays no judge again', async () => {
    const profileId='fixture', events=new EventEmitter();
    const cfg={enabledChats:{[key]:true},judgeProfileId:profileId};
    const ctx={mainApi:'openai',chatId:'one',characterId:0,characters:[{avatar:'card.png'}],
        extensionSettings:{fair_dice_winmiu_v1:cfg},extensionPrompts:{},chat:[{is_user:true,mes:'我修计分器。'}],
        eventTypes:{GENERATE_AFTER_DATA:'assembled',CHAT_COMPLETION_SETTINGS_READY:'outgoing',GENERATION_ENDED:'end',GENERATION_STOPPED:'stop'},
        eventSource:events,saveSettingsDebounced(){},getCharacterCardFields(){return {description:'角色是维修工。'};},
        setExtensionPrompt(id,value){this.extensionPrompts[id]={value};}};
    let calls=0;
    ctx.ConnectionManagerRequestService={
        getSupportedProfiles:()=>[{id:profileId,mode:'cc',api:'openai'}],
        async sendRequest(id,messages,limit,options){
            assert.equal(id,profileId); assert.equal(options.includePreset,false); assert.equal(limit,256);
            assert.match(messages[1].content,/维修工/); assert.match(messages[1].content,/计分器/);
            assert.doesNotMatch(messages[0].content,/d100=|<!--FD/);
            calls++; return {content:'行|一般|有利|*|角色有维修经验'};
        },
    };
    const url=new URL(entry);url.searchParams.set('case','profile');
    globalThis.document=Object.assign(new EventTarget(),{readyState:'loading',scripts:[{src:url.href}]});
    globalThis.SillyTavern={getContext:()=>ctx};
    await import(url.href);
    for (const type of ['normal','regenerate']) {
        await globalThis[manifest.generate_interceptor]([],8192,()=>assert.fail('abort'),type);
        const data={prompt:[{role:'system',content:ctx.extensionPrompts[slot].value},{role:'system',content:'故事预设'}]};
        events.emit('assembled',data,true);
        assert.equal(data.prompt.length,2);
        events.emit('assembled',data,false);
        assert.equal(data.prompt.length,1); assert.match(data.prompt[0].content,/故事预设[\s\S]*维修经验[\s\S]*阈值 65%/);
        assert.doesNotMatch(data.prompt[0].content,/\[fd:|<!--FD-|名次/);
        events.emit('outgoing',{type,messages:data.prompt});
        assert.match(JSON.stringify(cfg.runLogs[key][0]),/发往接口的正文请求中核对到/);
        events.emit('end');
    }
    assert.equal(calls,1);
    ctx.chat.push({is_user:true,mes:'第二楼'});
    let release;
    ctx.ConnectionManagerRequestService.sendRequest=()=>new Promise(resolve=>{release=resolve;});
    let aborted=false;
    const pending=globalThis[manifest.generate_interceptor]([],1024,()=>{aborted=true;},'normal');
    events.emit('stop'); release({content:'略|日常聊天'}); await pending;
    assert.equal(aborted,true); assert.equal(ctx.chat.at(-1).extra.fairDiceFloorV2.verdict,undefined);
    assert.deepEqual(ctx.extensionPrompts,{});
});

test('a custom judge profile cannot use an active Custom key at a different address', async () => {
    const ctx={chat:[],ConnectionManagerRequestService:{getSupportedProfiles:()=>[{id:'x',mode:'cc',api:'custom','api-url':'https://judge.invalid/v1'}],
        sendRequest:()=>assert.fail('wrong destination')},chatCompletionSettings:{custom_url:'https://main.invalid/v1'}};
    const empty={items:[],order:[]};
    await assert.rejects(judgeFloor(ctx,{judgeRoute:'profile',judgeProfileId:'x'},{events:empty,reactions:empty},new Set(),new AbortController().signal),/地址不同/);
});
