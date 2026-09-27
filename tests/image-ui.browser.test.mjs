import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import { execFileSync } from 'node:child_process';
import test from 'node:test';

// Run with PLAYWRIGHT_MODULE pointing to the available workspace dependency when needed.
const { chromium } = await import(process.env.PLAYWRIGHT_MODULE || 'playwright');
const root = new URL('../', import.meta.url);
const read = name => fs.readFileSync(new URL(name, root), 'utf8').replaceAll('\r\n', '\n');
const main = read('public/script.js'), chats = read('public/scripts/chats.js'), sd = read('public/scripts/extensions/stable-diffusion/index.js');
const extract = (source, name) => source.match(new RegExp(`(?:async )?function ${name}\\([\\s\\S]*?^\\}`, 'm'))[0];
const index = read('public/index.html');
const templates = ['message_image_template','message_gallery_controls','message_video_template','message_audio_template','message_file_template'].map(id => {
    const start = index.indexOf(`        <div id="${id}"`), end = index.indexOf('\n        <div id=', start + 1);
    return index.slice(start, end);
}).join('\n');
const popupTemplate = index.match(/<template id="popup_template"[\s\S]*?<\/template>/)[0];
const popupCode = read('public/scripts/popup.js').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const statusCode = read('public/scripts/extensions/stable-diffusion/image-generation-status.js').replace(/^import .*;\n/gm, '').replace(/^export /gm, '');
const placeholder = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=', 'base64');
const image = process.env.IMAGE_UI_FIXTURE ? fs.readFileSync(process.env.IMAGE_UI_FIXTURE) : placeholder;
const baselineMain = process.env.MEDIA_UI_BENCHMARK ? execFileSync('git', ['show', 'HEAD:public/script.js'], { cwd: root, encoding: 'utf8' }).replaceAll('\r\n','\n') : null;
const baselineChats = process.env.MEDIA_UI_BENCHMARK ? execFileSync('git', ['show', 'HEAD:public/scripts/chats.js'], { cwd: root, encoding: 'utf8' }).replaceAll('\r\n','\n') : null;
const baselineCode = baselineMain ? extract(baselineMain, 'appendMediaToMessage').replace('function appendMediaToMessage','function baselineAppendMediaToMessage') + '\n' + extract(baselineChats, 'onImageSwiped').replace('function onImageSwiped','function baselineOnImageSwiped').replaceAll('appendMediaToMessage(', 'baselineAppendMediaToMessage(') : '';
const harness = `<!doctype html><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><link rel="stylesheet" href="/style.css"><link rel="stylesheet" href="/css/toggle-dependent.css">
<style>body{margin:0;min-width:0;--mainFontSize:16px;--animation-duration:0s}#chat{height:75vh;overflow:auto}.mes{display:block;padding:8px}.mes_img_container{position:relative;width:100%;height:240px}.mes_img{width:100%;height:240px;object-fit:contain}.template_element{display:none}.right_menu_button{font-size:18px}dialog{max-width:90vw}</style>
<body class="sd"><div id="chat"></div><div id="send_form"></div><div id="sd_wand_container"></div>${templates}${popupTemplate}
<script src="/lib/jquery-3.5.1.min.js"></script><script>
const power_user = {}; const toastPositionClasses = []; const shouldSendOnEnter = () => false;
const t = (strings,...values) => strings.reduce((result,value,index)=>result+value+(values[index]??''),'');
const runAfterAnimation = (element, callback) => queueMicrotask(callback);
const uuidv4 = () => crypto.randomUUID(); const removeFromArray = (items,item) => items.splice(items.indexOf(item),1);
const clamp = (value,min,max)=>Math.min(max,Math.max(min,value));
window.errors=[];window.toastr={options:{},info:()=>{},clear:()=>{},warning:()=>{},error:error=>errors.push(error)};
${popupCode}
</script><script type="module">
import { imageEditSettings, imageEditInstruction, assertImageEditGraph } from '/scripts/extensions/stable-diffusion/image-edit.js';
import { collectImageEvidence, prepareImageContinuity, applyReferenceImage } from '/scripts/extensions/stable-diffusion/image-continuity.js';
const MEDIA_TYPE={IMAGE:'image',VIDEO:'video',AUDIO:'audio'}, MEDIA_SOURCE={GENERATED:'generated'}, MEDIA_DISPLAY={GALLERY:'gallery',LIST:'list'}, SCROLL_BEHAVIOR={KEEP:'keep',ADJUST:'adjust',NONE:'none'}, SWIPE_DIRECTION={LEFT:'left',RIGHT:'right'};
const event_types={IMAGE_SWIPED:'swipe'}, MODULE_NAME='sd', initiators={wand:'wand'}, generationMode={FREE_EXTENDED:11};
const extension_settings={sd:{source:'comfy',comfy_type:'standard',comfy_url:'mock://comfy',model:'Juggernaut-XL_v9_RunDiffusionPhoto_v2.safetensors',width:768,height:512,steps:24,scale:5,sampler:'dpmpp_2m',scheduler:'karras',seed:1,denoising_strength:1,prompts:{},clip_skip:1}};
const context={chat:[],name2:'Synthetic',saveChat:async()=>{window.saves++}};
let current='synthetic';const getContext=()=>context,getCurrentChatId=()=>current,generationOrigin=()=>({file:current,integrity:'synthetic',expectedLength:context.chat.length+1});
const getRequestHeaders=()=>({});const substituteParams=x=>x;
const pendingImageSwipes=new WeakSet();let imageEditInProgress=false;
const chatElement=$('#chat'),getMediaIndex=message=>message.extra.media_index??0,getMediaDisplay=message=>message.extra.media_display||MEDIA_DISPLAY.GALLERY;
const ensureMessageMediaIsArray=()=>{}, humanFileSize=x=>String(x), AudioPlayer=class{};
const chat=context.chat;
const delay=ms=>new Promise(resolve=>setTimeout(resolve,ms));const debounce_timeout={short:200};
const saveChatDebounced=()=>{window.saves++}; const saveChatConditional=async()=>{const snapshot={chat:current,index:context.chat[0].extra.media_index};await delay(500);window.persisted=snapshot;window.saves++};
const eventSource={emit:async(event,payload)=>{if(event==='swipe')await delay(window.listenerDelay||0);else payload.appearanceContext={appearanceRevision:'current',currentScene:{location:'Synthetic garden',activeCharacterIds:['hero']},characters:[{characterId:'hero',appearance:'Blue coat'}],scope:{worldId:'synthetic'}}}};
const ActionLoaderHandle={EMPTY:{hide:async()=>{}}},loader={show:options=>{window.stopEdit=options.onStop;return{hide:async()=>{}}}};
${statusCode}
const imageDescriptionSnapshot=()=>null;
const generateQuietPrompt=async options=>{window.descriptions.push(options.quietPrompt);if(window.descriptionFail)throw Error('synthetic description failure');await delay(window.descriptionDelay||0);return 'woman, blue coat, facing forward, right hand holding a cup';};
const processReply=x=>x;const main_api='openai',oai_settings={chat_completion_source:'custom'},selected_group=null;
const isVideo=format=>format!=='png';const systemUserName='System';
const getBase64Async=blob=>new Promise((resolve,reject)=>{const reader=new FileReader();reader.onload=()=>resolve(reader.result);reader.onerror=()=>reject(reader.error);reader.readAsDataURL(blob)});
const originalFetch=window.fetch.bind(window);
const fetch=async(url,options)=>{if(url==='/api/sd/comfy/workflow')return{ok:true,json:async()=>await(await originalFetch('/reference.json')).text()};window.pixelFetches.push(url);return originalFetch(url,options);};
const sendGenerationRequest=async(type,prompt,negative,name,callback,initiator,signal,continuity)=>{await delay(window.generationDelay||0);signal.throwIfAborted();if(window.generationFail)return;window.requestedPrompts.push(prompt);window.workflows.push(JSON.parse(await prepareComfyWorkflow(negative,['model','sampler','scheduler','steps','scale','width','height'],continuity,signal)));await callback(null,null,null,null,null,null,'png',continuity);return '/user/images/Synthetic/edited.png';};
const renderExtensionTemplateAsync=async(ext,file)=>file==='button'?'<button id="sd_gen">Generate</button>':'<div id="sd_dropdown"><div id="sd_counterpart">Counterpart</div></div>';
const Popper={createPopper:()=>({update:()=>{}})},animation_duration=0,executeSlashCommandsWithOptions=()=>{},buttonAbortControllers=new WeakMap();
const addCopyToCodeBlocks=()=>{};
${extract(main,'appendMediaToMessage')}
${extract(chats,'onImageSwiped')}
${extract(chats,'expandMessageMedia')}
${baselineCode}
${extract(sd,'imageDescriptionInstruction')}
${extract(sd,'generatePrompt')}
${extract(sd,'assertImageGenerationOrigin')}
${extract(sd,'prepareComfyWorkflow')}
${extract(sd,'editGeneratedImage')}
${extract(sd,'addSDGenButtons')}
await addSDGenButtons();
$('#chat').on('click','.mes_img_swipe_right',e=>onImageSwiped(Number($(e.currentTarget).closest('.mes').attr('mesid')),$(e.currentTarget).closest('.mes'),'right'));
$('#chat').on('click','.mes_img',e=>{window.enlargements++;const image=$(e.currentTarget);expandMessageMedia(Number(image.closest('.mes').attr('mesid')),Number(image.closest('.mes_media_container').attr('data-index')))});
window.saves=0;window.persisted=null;window.requestedPrompts=[];window.descriptions=[];window.workflows=[];window.pixelFetches=[];window.enlargements=0;
window.reset=()=>{current='synthetic';context.chat.splice(0);$('#chat').empty();window.requestedPrompts.length=0;window.errors.length=0;window.workflows.length=0;window.descriptions.length=0;window.pixelFetches.length=0;window.saves=0;window.descriptionFail=false;window.generationFail=false;window.descriptionDelay=0;window.generationDelay=0;window.listenerDelay=0;
const message={extra:{media_display:'gallery',media_index:1,media:['first','middle','last'].map(name=>({url:'/user/images/Synthetic/'+name+'.png',type:'image',source:'generated',title:name+', blue coat',width:768,height:512}))}};context.chat.push(message);
$('#chat').append('<div class="mes" mesid="0"><div class="mes_text"></div><div class="mes_file_wrapper"></div><div class="mes_media_wrapper"></div></div>');appendMediaToMessage(message,$('.mes'),'keep');};
window.harness={context,extension_settings,appendMediaToMessage,onImageSwiped,expandMessageMedia,editGeneratedImage,switchChat:()=>{current='other'},Popup};
${baselineMain ? 'window.baselineOnImageSwiped=baselineOnImageSwiped;' : ''}
window.reset();window.ready=true;
</script>`;

test('actual media, popup and edit handlers in a touch browser with synthetic services', async t => {
    const server = http.createServer((req,res) => {
        if (req.url === '/') {res.setHeader('Content-Type','text/html');res.end(harness);return;}
        if (req.url === '/reference.json') {res.end(read('default/content/Local_Reference_Image_Continuity.json'));return;}
        if (req.url.startsWith('/user/images/Synthetic/')) {res.setHeader('Content-Type','image/png');setTimeout(()=>res.end(image),req.url.includes('first')||req.url.includes('delayed')?250:20);return;}
        const candidate = new URL('public'+decodeURIComponent(req.url.split('?')[0]),root);
        if (!candidate.pathname.startsWith(new URL('public/',root).pathname) || !fs.existsSync(candidate)) {res.statusCode=404;res.end();return;}
        res.setHeader('Content-Type',req.url.endsWith('.js')?'application/javascript':req.url.endsWith('.css')?'text/css':'application/octet-stream');res.end(fs.readFileSync(candidate));
    });
    await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
    let browser;
    try {
        browser=await chromium.launch({headless:true, ...(process.env.PLAYWRIGHT_CHANNEL ? {channel:process.env.PLAYWRIGHT_CHANNEL} : {})});
        const page=await browser.newPage({viewport:{width:390,height:844},isMobile:true,hasTouch:true});
        const pageErrors=[];page.on('pageerror',error=>pageErrors.push(error.message));
        await page.goto('http://127.0.0.1:'+server.address().port);
        await page.waitForFunction(()=>window.ready);
        const reset=async()=>page.evaluate(()=>window.reset());
        const openActions=async(index=0)=>{await page.locator('#chat .mes_img').nth(index).tap();await page.locator('.img_enlarged_actions').waitFor();};
        const openEdit=async(index=0)=>{await openActions(index);await page.locator('.img_enlarged_actions .sd_image_edit').tap();await page.locator('.sd_image_edit_popup').waitFor();};
        const submit=async(text='시선은 정면, 오른손은 잔을 잡도록',review=true)=>{
            await page.locator('.popup-input').fill(text);await page.locator('.popup-button-ok').click();
            if(!review)return;
            await page.waitForFunction(()=>document.querySelector('.sd_image_edit_prompt_popup')||!document.querySelector('#chat .sd_image_edit[aria-busy]'));
            if(await page.locator('.sd_image_edit_prompt_popup').count())await page.locator('.sd_image_edit_prompt_popup .popup-button-ok').click();
        };
        await t.test('touch controls are visible, at least 44px, and edit opens real popup with original preview',async()=>{
            assert.equal(await page.locator('#chat .sd_image_edit').isVisible(),false);
            assert.equal(await page.locator('#chat .mes_img_swipe_right').isVisible(),false);
            await openActions();const control=page.locator('.img_enlarged_actions .sd_image_edit');assert.ok(await control.isVisible());
            const box=await control.boundingBox();assert.ok(box.width>=44&&box.height>=44);
            assert.equal(await page.locator('#chat .mes_img_controls').evaluate(el=>getComputedStyle(el).display),'none');
            await control.tap();assert.equal(await page.locator('.sd_image_edit_preview').getAttribute('src'),'/user/images/Synthetic/middle.png');
            assert.equal(await page.locator('#sd_image_edit_strength').inputValue(),'0.55');
            assert.ok((await page.locator('.popup-button-ok').boundingBox()).height>=44);
            await page.locator('.popup-button-cancel').tap();
            await page.waitForFunction(()=>!document.querySelector('.popup'));
            assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media.length),3);
        });
        await t.test('scene correction edits selected pixels once and preserves originals and global settings',async()=>{
            await reset();const before=await page.evaluate(()=>({media:structuredClone(harness.context.chat[0].extra.media),settings:structuredClone(harness.extension_settings.sd)}));
            await openEdit();await submit();
            await page.waitForFunction(()=>harness.context.chat[0].extra.media.length===4);
            const after=await page.evaluate(()=>({media:harness.context.chat[0].extra.media,selected:harness.context.chat[0].extra.media_index,settings:harness.extension_settings.sd,descriptions,workflows,pixelFetches,enlargements}));
            assert.deepEqual(after.media.slice(0,3),before.media);assert.deepEqual(after.settings,before.settings);assert.equal(after.selected,3);
            assert.equal(after.workflows.length,1);assert.equal(after.workflows[0]['3'].inputs.denoise,0.55);
            assert.ok(after.descriptions[0].includes('Synthetic garden'));
            assert.ok(after.descriptions[0].includes('오른손은 잔'));assert.ok(after.pixelFetches.includes('/user/images/Synthetic/middle.png'));
            assert.ok(after.enlargements>=1);
        });
        await t.test('list-view edit targets clicked attachment instead of selected gallery variant',async()=>{
            await reset();await page.evaluate(()=>{harness.context.chat[0].extra.media_display='list';harness.appendMediaToMessage(harness.context.chat[0],$('.mes'),'keep')});
            await openEdit(0);await submit();
            await page.waitForFunction(()=>harness.context.chat[0].extra.media.length===4);
            assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media[3].image_edit.source_url),'/user/images/Synthetic/first.png');
        });
        await t.test('corrected prompt is reviewed before drawing; manual final text is used and saved exactly',async()=>{
            await reset();await openEdit();await submit('회색 로브를 붉은색으로',false);
            const review=page.locator('.sd_image_edit_prompt_popup');await review.waitFor();
            assert.equal(await review.locator('.popup-input').inputValue(),'woman, blue coat, facing forward, right hand holding a cup');
            assert.equal(await page.evaluate(()=>workflows.length),0);
            assert.equal(await page.evaluate(()=>pixelFetches.length),0);
            assert.ok((await review.textContent()).includes('회색 로브를 붉은색으로'));
            const final='(bright red robe:1.4), woman, holding a cup';await review.locator('.popup-input').fill(final);await review.locator('.popup-button-ok').click();
            await page.waitForFunction(()=>harness.context.chat[0].extra.media.length===4);
            assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media[3].title),final);
            assert.equal(await page.evaluate(()=>requestedPrompts.at(-1)),final);
            assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media[1].title),'middle, blue coat');
        });
        await t.test('cancelling the prompt review, or changing chat before confirming, sends no drawing request',async()=>{
            for(const action of ['cancel','switch']){
                await reset();await openEdit();await submit('red robe',false);await page.locator('.sd_image_edit_prompt_popup').waitFor();
                if(action==='switch'){await page.evaluate(()=>harness.switchChat());await page.locator('.sd_image_edit_prompt_popup .popup-button-ok').click();}
                else await page.locator('.sd_image_edit_prompt_popup .popup-button-cancel').click();
                await page.waitForFunction(()=>!document.querySelector('#chat .sd_image_edit[aria-busy]'));
                assert.equal(await page.evaluate(()=>workflows.length),0);assert.equal(await page.evaluate(()=>pixelFetches.length),0);
                assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media.length),3);
            }
        });
        await t.test('enlarged image zoom stays usable and stale actions cannot edit another chat',async()=>{
            await reset();await openActions();
            await page.locator('.img_enlarged').tap();assert.equal(await page.locator('.img_enlarged').evaluate(el=>el.classList.contains('zoomed')),true);
            await page.evaluate(()=>harness.switchChat());
            await page.locator('.img_enlarged_actions .sd_image_edit').tap();
            assert.equal(await page.locator('.sd_image_edit_popup').count(),0);
            assert.equal(await page.evaluate(()=>descriptions.length),0);
        });
        await t.test('viewer navigation stays open, arrows share one row, final choice persists and edits target that choice',async()=>{
            await reset();await openActions();
            const left=page.locator('.img_enlarged_navigation .mes_img_swipe_left'),right=page.locator('.img_enlarged_navigation .mes_img_swipe_right');
            const a=await left.boundingBox(),b=await right.boundingBox();assert.equal(a.y,b.y);
            await right.tap();await left.tap();await right.tap();
            assert.equal(await page.locator('.img_enlarged_container').count(),1);
            assert.equal(await page.locator('.img_enlarged').getAttribute('src'),'/user/images/Synthetic/last.png');
            assert.equal(await page.locator('.img_enlarged_counter').textContent(),'3 / 3');
            assert.equal(await page.locator('.img_enlarged_title').textContent(),'last, blue coat');
            await page.locator('.popup-button-close').tap();
            assert.equal(await page.locator('#chat .mes_img').getAttribute('src'),'/user/images/Synthetic/last.png');
            await page.waitForFunction(()=>persisted?.index===2);
            await openActions();await left.tap();
            await page.locator('.img_enlarged_actions .sd_image_edit').tap();
            assert.equal(await page.locator('.sd_image_edit_preview').getAttribute('src'),'/user/images/Synthetic/middle.png');
            await page.locator('.popup-button-cancel').tap();
        });
        await t.test('elapsed time advances across description and drawing, then clears on completion',async()=>{
            await reset();await page.evaluate(()=>{descriptionDelay=1200;generationDelay=1200});
            await openEdit();await submit();
            await page.waitForFunction(()=>document.querySelector('#sd_generation_status')?.textContent.includes('1초 경과'));
            await page.waitForFunction(()=>document.querySelector('#sd_generation_status')?.textContent.includes('원본을 바탕으로'));
            assert.match(await page.locator('#sd_generation_status').textContent(),/[12]초 경과/);
            await page.waitForFunction(()=>harness.context.chat[0].extra.media.length===4);
            await page.waitForFunction(()=>!document.querySelector('#sd_generation_status'));
        });
        await t.test('description and generation failures append nothing; retry succeeds and double invocation is blocked',async()=>{
            for(const field of ['descriptionFail','generationFail']){
                await reset();await page.evaluate(field=>window[field]=true,field);await openEdit();await submit();
                await page.waitForFunction(()=>!document.querySelector('#chat .sd_image_edit[aria-busy]'));
                assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media.length),3);
            }
            await page.evaluate(()=>{generationFail=false;generationDelay=100});
            await openEdit();await submit();
            await page.evaluate(()=>harness.editGeneratedImage($('#chat .sd_image_edit')));
            await page.waitForFunction(()=>harness.context.chat[0].extra.media.length===4);
            assert.equal(await page.evaluate(()=>workflows.length),1);
        });
        await t.test('cancel during description and chat switch prevent result attachment',async()=>{
            for(const action of ['cancel','switch','delete']){
                await reset();await page.evaluate(()=>descriptionDelay=120);await openEdit();await submit(undefined,false);
                await page.evaluate(action=>{if(action==='cancel')stopEdit();if(action==='switch')harness.switchChat();if(action==='delete')harness.context.chat[0].extra.media.splice(1,1)},action);
                await page.waitForFunction(()=>!document.querySelector('#chat .sd_image_edit[aria-busy]'));
                assert.equal(await page.evaluate(()=>workflows.length),0);
                assert.equal(await page.evaluate(()=>harness.context.chat[0].extra.media.length),action==='delete'?2:3);
            }
        });
        await t.test('rapid changes render immediately, old loads never restore prior selection; invalid enlarge is safe',async()=>{
            await reset();const result=await page.evaluate(async()=>{const m=harness.context.chat[0];m.extra.media_index=0;harness.appendMediaToMessage(m,$('.mes'),'keep');m.extra.media_index=2;harness.appendMediaToMessage(m,$('.mes'),'keep');const immediate=$('#chat .mes_img').attr('src');await new Promise(resolve=>setTimeout(resolve,350));return{immediate,late:$('#chat .mes_img').attr('src'),invalid:harness.expandMessageMedia(0,20)}});
            assert.equal(result.immediate,'/user/images/Synthetic/last.png');assert.equal(result.late,result.immediate);assert.equal(result.invalid,undefined);
            await openActions();await page.locator('.img_enlarged_actions .mes_img_swipe_right').tap();await page.waitForFunction(()=>harness.context.chat[0].extra.media_index===0);
            await page.locator('.popup-button-close').tap();
        });
        await t.test('selection saving begins before a chat switch and navigation stays available while saving',async()=>{
            await reset();
            await page.evaluate(()=>{window.navigation=harness.onImageSwiped(0,$('.mes'),'right')});
            await page.waitForFunction(()=>$('#chat .mes_img').attr('src').endsWith('last.png'));
            await page.evaluate(()=>harness.switchChat());
            await page.evaluate(()=>window.navigation);
            assert.deepEqual(await page.evaluate(()=>persisted),{chat:'synthetic',index:2});
            await reset();
            await page.evaluate(()=>{window.navigation=harness.onImageSwiped(0,$('.mes'),'right')});
            await page.waitForFunction(()=>harness.context.chat[0].extra.media_index===2);
            await page.evaluate(()=>{window.nextNavigation=harness.onImageSwiped(0,$('.mes'),'left')});
            await page.waitForFunction(()=>harness.context.chat[0].extra.media_index===1);
            await page.evaluate(()=>Promise.all([window.navigation,window.nextNavigation]));
        });
        if(process.env.MEDIA_UI_BENCHMARK)await t.test('navigation avoids a 500ms persistence delay measured against the previous source',async()=>{
            await reset();
            const measurements=await page.evaluate(async()=>{const m=harness.context.chat[0],desired='/user/images/Synthetic/last.png';const started=performance.now();await baselineOnImageSwiped(0,$('.mes'),'right');while($('#chat .mes_img').attr('src')!==desired)await new Promise(resolve=>setTimeout(resolve,1));const beforeMs=performance.now()-started;m.extra.media_index=1;harness.appendMediaToMessage(m,$('.mes'),'keep');const next=performance.now();const pending=harness.onImageSwiped(0,$('.mes'),'right');while($('#chat .mes_img').attr('src')!==desired)await new Promise(resolve=>setTimeout(resolve,1));const afterMs=performance.now()-next;await pending;return{beforeMs,afterMs,saveDelayMs:500,shown:$('#chat .mes_img').attr('src')}});
            assert.ok(measurements.beforeMs>=500);assert.ok(measurements.afterMs<200);assert.equal(measurements.shown,'/user/images/Synthetic/last.png');
            fs.writeFileSync(process.env.MEDIA_UI_BENCHMARK,JSON.stringify(measurements,null,2));
        });
        if(process.env.MEDIA_SCROLL_QA)await t.test('production media CSS delayed dimensionless-image scroll observations',async()=>{
            const results=await page.evaluate(async()=>{
                const style=document.querySelector('style'),original=style.textContent;
                style.textContent='body{margin:0;min-width:0;--mainFontSize:16px;--animation-duration:0s}#chat{height:60vh;overflow:auto}.mes{display:block;padding:8px}.template_element{display:none}';
                const results=[];
                for(const mode of ['bottom','reading','manual']){
                    const reading=mode==='reading';
                    const m={extra:{media_display:'gallery',media_index:0,media:[{url:'/user/images/Synthetic/delayed-'+mode+'.png',type:'image',source:'generated',title:'Synthetic test'}]}};
                    $('#chat').html('<div style="height:1000px;flex-shrink:0">Earlier messages</div><div class="mes"><div class="mes_text"></div><div class="mes_file_wrapper"></div><div class="mes_media_wrapper"></div></div>');
                    const el=document.querySelector('#chat');el.scrollTop=reading?400:el.scrollHeight;
                    harness.appendMediaToMessage(m,$('.mes'));
                    if(mode==='manual')el.scrollTop=400;
                    const before={top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop};
                    await new Promise(resolve=>setTimeout(resolve,500));
                    results.push({reading,manual:mode==='manual',before,after:{top:el.scrollTop,gap:el.scrollHeight-el.clientHeight-el.scrollTop},loaded:document.querySelector('#chat .mes_img').naturalWidth>0});
                }
                style.textContent=original;return results;
            });
            fs.writeFileSync(process.env.MEDIA_SCROLL_QA,JSON.stringify(results,null,2));assert.ok(results.every(item=>item.loaded));assert.ok(results.find(item=>item.reading).before.gap>100);assert.ok(results.find(item=>!item.reading).after.gap<=1);assert.equal(results.find(item=>item.reading).after.top,results.find(item=>item.reading).before.top);assert.equal(results.find(item=>item.manual).after.top,results.find(item=>item.manual).before.top);
        });
        await reset();await openEdit();
        if(process.env.IMAGE_UI_SCREENSHOT)await page.screenshot({path:process.env.IMAGE_UI_SCREENSHOT,fullPage:true});
        await page.locator('.popup-button-cancel').tap();
        assert.deepEqual(pageErrors,[]);
    } finally {await browser?.close();await new Promise(resolve=>server.close(resolve));}
});
