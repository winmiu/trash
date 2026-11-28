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
                updateMessageBlock(_id, message){assert.doesNotMatch(message.mes,/<!--FD-/);},
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
                const prefix = turn.verdict ? '' : '<!--FD-' + turn.token + ' 行|一般|中性|' + (turn.die <= 50 ? '成' : '败') + '|目标：修好计分器，依据：玩家有工具 -->\n';
                const story = turn.die <= 50 ? '计分器亮了。' : '计分器依然黑着。';
                const body = {is_user:false,mes:prefix + story,swipe_id:0,swipes:[prefix + story]};
                ctx.chat.push(body);
                if (type === 'normal') events.emit('ended'); // streaming order
                events.emit('received',ctx.chat.length-1,type);
                events.emit('ended');
                assert.equal(body.mes,story);
                assert.equal(body.swipes[0],body.mes);
                assert.match(body.extra.fairDiceAudit.text,/成功阈值 50%/);
                const steps = cfg.runLogs[key][0].steps;
                assert.ok(steps.some(step => step.text.endsWith(body.extra.fairDiceAudit.text.split(' · ')[1])));
                return input;
            }
            const input = hostReply('normal');
            assert.equal(input.length,1);
            assert.match(input[0],/d100=\d+/);
            for (const rule of ['闲聊/既定事实略过', '任务门槛', '无数值用已知表现', '自然转场', 'NPC选择', '加倍/减半/排除']) {
                assert.ok(input[0].includes(rule), rule);
            }
            assert.match(input[0],/挽回须等玩家下一条消息再判/);
            assert.match(input[0],/正文用剧情体现成败，不展示骰点、阈值或判定行/);
            assert.doesNotMatch(input[0],/OLD-CONSEQUENCE|stakes|大败|大成|致命|失败可带来/);
            assert.equal(requests.length,1);
            assert.deepEqual(ctx.extensionPrompts,{});
            assert.equal(events.listenerCount('received'),1);
            const fixed = hostReply('regenerate');
            assert.match(fixed[0],/本楼裁定[\s\S]*目标：修好计分器[\s\S]*阈值 50%[\s\S]*挽回须等玩家下一条消息再判/);
            assert.match(fixed[0],/正文用剧情体现成败，不展示骰点、阈值或判定行/);
            assert.doesNotMatch(fixed[0],/候选顺序|<!--FD/);
            ctx.chat.splice(1); // delete the replies and reload the stored player message
            ctx.chat = JSON.parse(JSON.stringify(ctx.chat));
            ctx.characters[0].description = '角色卡编辑';
            cfg.chatProfiles[key].events = [];
            for (const type of ['swipe','continue','normal']) assert.deepEqual(hostReply(type),fixed);
            ctx.chat.push({is_user:true,mes:'新的玩家楼层'});
            const newInput = assemble('normal');
            assert.match(newInput[0],/<!--FD-/);
            assert.doesNotMatch(newInput[0],/目标：修好计分器|本楼裁定】/);
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

test('a dedicated judge validates final text parts and does not accept hidden reasoning, truncated or malformed results', async () => {
    const ctx={chat:[{is_user:true,mes:'我修计分器。'}],extensionSettings:{},getRequestHeaders:()=>({})};
    const pool={items:[],order:[]}, turn={events:pool,reactions:pool,die:50};
    const cfg={judgeRoute:'custom',judgeAddress:'https://dice.invalid/v1/chat/completions',judgeModel:'gpt-5-mini'};
    const line='行|一般|中性|*|目标：修好计分器，依据：已有工具';
    const fenced=['```text',line,'```'].join('\n');
    const original=globalThis.fetch;
    try {
        let reply;
        globalThis.fetch=async (path,options)=>{
            const wire=JSON.parse(options.body);
            assert.equal(path,'/api/backends/chat-completions/generate');
            assert.equal(wire.reverse_proxy,'https://dice.invalid/v1');
            assert.equal(wire.max_completion_tokens,1024);
            assert.equal(wire.max_tokens,undefined);
            assert.match(wire.messages[0].content,/【公平骰·独立裁判】/);
            assert.doesNotMatch(wire.messages[0].content,/d100=|<!--FD-|依主预设/);
            return Response.json(reply);
        };
        const judge=()=>judgeFloor(ctx,cfg,turn,new Set(),new AbortController().signal);
        for (const content of [line, fenced, '<think>忽略</think>\n'+fenced,
            [{type:'reasoning',text:'略|无效'}, {type:'text',text:line.slice(0,8)}, {type:'text',text:line.slice(8)}]]) {
            reply={choices:[{message:{content}}]};
            assert.match((await judge())[0],/目标：修好计分器.*50 ≤ 50，成功/);
        }
        for (const [response,error] of [
            [{choices:[{finish_reason:'length',message:{content:line}}]},/长度上限/],
            [{error:{message:'Unauthorized'}},/鉴权/],
            [{choices:[{message:{content:null,reasoning_content:line}}]},/没有最终裁定/],
            [{choices:[{message:{content:'叙述一段故事'}}]},/栏位未通过校验/],
        ]) {
            reply=response;
            await assert.rejects(judge(),error);
        }
    } finally {globalThis.fetch=original;}
});

test('a failed custom judge stops narration; retry keeps the floor and only sends its confirmed result to the story', async () => {
    const events=new EventEmitter(),cfg={judgeEnabled:true,judgeRoute:'custom',judgeAddress:'https://dice.invalid/v1',judgeModel:'fast',enabledChats:{[key]:true}};
    const ctx={chatId:'one',characterId:0,characters:[{avatar:'card.png'}],chat:[{is_user:true,mes:'修表'}],
        extensionSettings:{fair_dice_winmiu_v1:cfg},extensionPrompts:{},eventTypes:{GENERATION_ENDED:'end'},eventSource:events,
        getRequestHeaders:()=>({}),setExtensionPrompt(id,value){this.extensionPrompts[id]={value};}};
    const url=new URL(entry);url.searchParams.set('case','custom-retry');
    globalThis.document=Object.assign(new EventTarget(),{readyState:'loading',scripts:[{src:url.href}]});
    globalThis.SillyTavern={getContext:()=>ctx};
    await import(url.href);
    const original=globalThis.fetch;
    let calls=0, stories=0;
    globalThis.fetch=async (_url,{signal})=>{
        // Some mobile browsers provide AbortSignal without throwIfAborted().
        Object.defineProperty(signal,'throwIfAborted',{value:undefined});
        calls++;
        if (calls===1) return Response.json({error:{message:'Unauthorized'}});
        return Response.json({choices:[{message:{content:[{type:'text',text:'行|一般|中性|*|修表工具齐全'}]}}]});
    };
    async function generate(type){
        let stopped=false;
        await globalThis[manifest.generate_interceptor]([],8192,()=>{stopped=true;},type);
        if (stopped) return '';
        stories++;
        const prompt=ctx.extensionPrompts[slot].value;
        events.emit('end');
        return prompt;
    }
    try {
        assert.equal(await generate('normal'),'');
        const floor=ctx.chat[0].extra.fairDiceFloorV2,die=floor.die;
        assert.equal(floor.verdict,undefined);
        assert.deepEqual(ctx.extensionPrompts,{});
        assert.equal(stories,0);
        assert.match(cfg.runLogs[key][0].title,/独立裁判 · 独立 API/);
        assert.match(JSON.stringify(cfg.runLogs[key][0].steps),/鉴权失败/);
        const result=await generate('regenerate');
        assert.match(result,/本楼裁定.*修表工具齐全/);
        assert.doesNotMatch(result,/<!--FD-|【公平骰·独立裁判】/);
        assert.equal(await generate('continue'),result);
        assert.equal(floor.die,die);
        assert.deepEqual([calls,stories],[2,2]);
        assert.match(JSON.stringify(cfg.runLogs[key][0].steps),/沿用本楼已确认裁定/);
    } finally {globalThis.fetch=original;}
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
            assert.equal(id,profileId); assert.equal(options.includePreset,false); assert.equal(limit,1024);
            assert.match(messages[1].content,/维修工/); assert.match(messages[1].content,/计分器/);
            assert.doesNotMatch(messages[0].content,/d100=|<!--FD/);
            assert.match(messages[0].content,/目标：动作及对象，依据：事实/);
            calls++; return {content:'行|一般|有利|*|目标：修好计分器，依据：角色有维修经验'};
        },
    };
    const url=new URL(entry);url.searchParams.set('case','profile');
    globalThis.document=Object.assign(new EventTarget(),{readyState:'loading',scripts:[{src:url.href}]});
    globalThis.SillyTavern={getContext:()=>ctx};
    await import(url.href);
    for (const type of ['normal','regenerate','swipe','continue']) {
        await globalThis[manifest.generate_interceptor]([],8192,()=>assert.fail('abort'),type);
        const data={prompt:[{role:'system',content:ctx.extensionPrompts[slot].value},{role:'system',content:'故事预设'}]};
        events.emit('assembled',data,true);
        assert.equal(data.prompt.length,2);
        events.emit('assembled',data,false);
        assert.equal(data.prompt.length,1); assert.match(data.prompt[0].content,/故事预设[\s\S]*目标：修好计分器[\s\S]*维修经验[\s\S]*阈值 65%[\s\S]*挽回须等玩家下一条消息再判/);
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
