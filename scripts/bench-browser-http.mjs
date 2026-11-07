// Private raw transport diagnostic. No CD feature or unencrypted sharing mode.
import assert from 'node:assert/strict';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,rm} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {findChromium,startWorker} from './harness.mjs';
import {echoWebSocket} from './websocket-echo.mjs';
const mib=Number(process.env.CD_CEILING_MIB||16),runs=Number(process.env.CD_CEILING_RUNS||3);
assert.ok(Number.isInteger(mib)&&mib>0&&mib<=16);assert.ok(Number.isInteger(runs)&&runs>0);
const output=resolve(process.env.CD_CEILING_OUTPUT||'/tmp/cd-browser-http.json'),work=await mkdtemp('/dev/shm/cd-http-ceiling-');
const payload=randomBytes(mib*1048576),source=join(work,'payload.bin'),expected=createHash('sha256').update(payload).digest('hex');await writeFile(source,payload);
const report={version:1,mib,runs,rows:[],startedAt:new Date().toISOString(),method:'Raw browser echo through a stateless local Worker, HTTP POST versus WebSocket. Same bytes uploaded and downloaded, no encryption, OPFS or CD processing. HTTP buffers at most 16 MiB before responding to avoid the measured local streaming-echo stall; WebSocket echoes while receiving. Preload and SHA256 outside timing. Diagnostic only, not a production feature or comparison with croc.'};
let worker,browser;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{void browser?.close().catch(()=>{})});
try{
 process.env.CD_VERIFY_WRANGLER_CONFIG=fileURLToPath(new URL('./browser-ceiling-worker.wrangler.jsonc',import.meta.url));worker=await startWorker(work);
 browser=await chromium.launch({executablePath:await findChromium(),headless:true});
 for(let run=0;run<runs;run++)for(const transport of ['http','websocket']){
  const context=await browser.newContext();
  try{
   const page=await context.newPage();await page.goto(worker.publicBase);await page.evaluate(()=>{document.body.innerHTML='<input type="file" id="payload">'});await page.locator('#payload').setInputFiles(source);
   await page.evaluate(async()=>{window.payload=new Uint8Array(await document.getElementById('payload').files[0].arrayBuffer())});
   const result=transport==='websocket' ? await page.evaluate(echoWebSocket,{}) : await page.evaluate(async()=>{
    const start=performance.now(),response=await fetch('/echo',{method:'POST',body:payload,headers:{'X-Diagnostic-Bytes':String(payload.byteLength)},signal:AbortSignal.timeout(60000)});
    if(!response.ok)throw new Error('echo rejected');
    const received=new Uint8Array(await response.arrayBuffer()),ms=performance.now()-start;
    const hash=[...new Uint8Array(await crypto.subtle.digest('SHA-256',received))].map(n=>n.toString(16).padStart(2,'0')).join('');
    return {ms,hash,bytes:received.byteLength};
   });
   assert.equal(result.hash,expected);assert.equal(result.bytes,payload.byteLength);report.rows.push({run,transport,...result,mibPerSecond:mib/(result.ms/1000)});console.error(transport+' #'+(run+1)+': '+result.ms.toFixed(1)+'ms');
  }finally{await context.close()}
  await writeFile(output,JSON.stringify(report,null,2));
 }
}catch(error){report.error=error.stack;process.exitCode=1}
finally{await browser?.close();await worker?.stop();await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
console.log(JSON.stringify({output,rows:report.rows.length,error:report.error}));
