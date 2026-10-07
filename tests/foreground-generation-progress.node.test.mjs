import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';
import {generationProgressDisplay, visibleGenerationJobs} from '../public/scripts/generation-progress-display.js';
const source=fs.readFileSync(new URL('../public/scripts/generation-jobs.js',import.meta.url),'utf8');
const recoverSource=source.slice(source.indexOf('async function recoverGenerationJobs('),source.indexOf('export function initializeGenerationJobs'));
const initializeSource=source.slice(source.indexOf('export function initializeGenerationJobs')).replace('export ','');
test('foreground lifecycle includes tools path, excludes quiet/dry run and clears on end/stop/navigation',()=>{
 const handlers={};let updates=0;const origin={file:'world'};
 const ctx={foregroundGeneration:null,eventSource:{on:(key,fn)=>{handlers[key]=fn;}},event_types:{GENERATION_STARTED:'start',GENERATION_ENDED:'end',GENERATION_STOPPED:'stop',APP_READY:'ready',CHAT_CHANGED:'chat'},recoverGenerationJobs:()=>{updates++;},generationOrigin:()=>origin,sameOrigin:x=>x===origin,clearPreview(){},document:{addEventListener(){}},window:{addEventListener(){}},setInterval(){}};
 vm.runInNewContext(initializeSource+'\ninitializeGenerationJobs()',ctx);
 handlers.start('quiet',{},false);handlers.start('normal',{},true);assert.equal(ctx.foregroundGeneration,null);
 handlers.start('normal',{},false);assert.equal(ctx.foregroundGeneration.foregroundOnly,true);const first=ctx.foregroundGeneration;handlers.start('normal',{},false);assert.equal(ctx.foregroundGeneration,first);
 for(const key of ['end','stop','chat']){handlers[key]();assert.equal(ctx.foregroundGeneration,null);handlers.start('normal',{},false);}
 assert.ok(updates>0);
});
for(const durable of [false,true])test(`single status uses ${durable?'durable job':'foreground timer'} without claiming persistence for tool calls`,async()=>{
 const status={dataset:{},children:[],set textContent(value){this.children=[];},append(row){this.children.push(row);}};
 const makeRow=()=>({textContent:'',children:[],append(x){this.children.push(x);}});
 const origin={file:'world'};let stops=0;
 const ctx={foregroundGeneration:{id:'foreground',foregroundOnly:true,status:'running',createdAt:new Date(Date.now()-4000).toISOString(),origin},recovering:false,knownJobs:[],document:{hidden:false,querySelector:()=>status,createElement:makeRow,createTextNode:x=>x},request:async()=>durable?[{id:'durable',status:'running',createdAt:new Date().toISOString(),origin}]:[],sameOrigin:()=>true,terminal:new Set(['completed']),generationProgressDisplay,visibleGenerationJobs,observed:new Set(),waiting:new Set(),clearPreview(){},console,stopGeneration:()=>{stops++;}};
 const recover=vm.runInNewContext(recoverSource+'\nrecoverGenerationJobs',ctx);await recover();assert.equal(status.children.length,1);const row=status.children[0];assert.match(row.textContent,/초 경과/);
 assert.equal(row.children.some(x=>typeof x==='string'&&x.includes('다른 화면')),durable);
 if(!durable){row.children[0].onclick();assert.equal(stops,1);}
});
