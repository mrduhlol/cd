// Diagnostic transport ceiling, not a product benchmark or an unencrypted mode.
// Uses private, capability-authenticated rooms and throwaway random data only.
import assert from 'node:assert/strict';
import {createServer,request as httpRequest} from 'node:http';
import {randomBytes,createHash} from 'node:crypto';
import {mkdtemp,writeFile,readFile,rm} from 'node:fs/promises';
import {join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {chromium} from 'playwright-core';
import {findChromium,startWorker} from './harness.mjs';
const mib=Number(process.env.CD_CEILING_MIB||64),runs=Number(process.env.CD_CEILING_RUNS||3);
assert.ok(Number.isInteger(mib)&&mib>0&&mib<=256);assert.ok(Number.isInteger(runs)&&runs>0);
const modes=(process.env.CD_CEILING_MODES||'default').split(',');
assert.ok(modes.length>0&&modes.every(mode=>['default','0','1'].includes(mode)));
const chunks=(process.env.CD_CEILING_CHUNKS||'262144,786432').split(',').map(Number);
assert.ok(chunks.length>0&&chunks.every(size=>Number.isInteger(size)&&size>0&&size<=1048576));
const drainDelays=(process.env.CD_CEILING_DRAIN_MS||'10').split(',').map(Number);
assert.ok(drainDelays.length>0&&drainDelays.every(delay=>Number.isInteger(delay)&&delay>=0&&delay<=100));
const output=resolve(process.env.CD_CEILING_OUTPUT||'/tmp/cd-browser-ceiling.json');
const work=await mkdtemp('/dev/shm/cd-ceiling-');
const digest=bytes=>createHash('sha256').update(bytes).digest('hex');
const payload=randomBytes(mib*1048576),source=join(work,'payload.bin');await writeFile(source,payload);
let browser,worker,proxy;const sockets=new Set();
let interrupted=false;
for(const signal of ['SIGINT','SIGTERM'])process.once(signal,()=>{interrupted=true;void browser?.close().catch(()=>{})});
const report={version:1,streamingEnabled:process.env.CD_CEILING_STREAMING==='1',mib,runs,modes,chunks,drainDelays,requestedRuntimeCompressionOff:process.env.CD_CEILING_RUNTIME_NO_COMPRESSION==='1',startedAt:new Date().toISOString(),rows:[],method:'Raw browser WebSocket to Node receiver through the real local Worker. Random payload preloaded outside timing, no CD file/record encryption, disk writing or application ACK window. Measures transport overhead only. SHA256 checked after timing. Private authenticated throwaway room; never exposes an unencrypted production transfer option.'};
function client(url){
 const socket=new WebSocket(url);sockets.add(socket);socket.binaryType='arraybuffer';
 const queue=[],waiters=[];let failure=null;
 const push=value=>{queue.push(value);waiters.shift()?.()};
 socket.addEventListener('message',event=>push(typeof event.data==='string'?JSON.parse(event.data):new Uint8Array(event.data)));
 socket.addEventListener('error',()=>{failure=new Error('socket failed');for(const wake of waiters.splice(0))wake()});
 socket.addEventListener('close',()=>{failure=new Error('socket closed');for(const wake of waiters.splice(0))wake()});
 return {socket,opened:new Promise((resolve,reject)=>{socket.addEventListener('open',resolve,{once:true});socket.addEventListener('error',reject,{once:true})}),async next(){
  const deadline=Date.now()+60000;
  for(;;){if(queue.length)return queue.shift();if(failure)throw failure;const remaining=deadline-Date.now();assert.ok(remaining>0,'socket timed out');await new Promise(resolve=>{const timer=setTimeout(resolve,remaining);waiters.push(()=>{clearTimeout(timer);resolve()})})}
 }};
}
try{
 process.env.CD_VERIFY_WRANGLER_CONFIG=process.env.CD_CEILING_CONFIG||fileURLToPath(new URL('./bench-worker.wrangler.jsonc',import.meta.url));
 if(process.env.CD_CEILING_BUNDLE){
  const {startDirectRuntime}=await import('./bench-direct-runtime.mjs');
  worker=await startDirectRuntime(process.env.CD_CEILING_BUNDLE,{compression:process.env.CD_CEILING_RUNTIME_NO_COMPRESSION!=='1',streaming:process.env.CD_CEILING_STREAMING==='1'});report.directRuntime=true;

 }else worker=await startWorker(work);
 if(process.env.CD_CEILING_NO_EXTENSION==='1'){
  const upstream=new URL(worker.publicBase),connections=new Set();
  const target=req=>{const url=new URL(req.url,'http://localhost');return {protocol:upstream.protocol,hostname:upstream.hostname,port:upstream.port,path:url.pathname+url.search}};
  const headers=req=>{const result={...req.headers};delete result['sec-websocket-extensions'];return result};
  proxy=createServer((req,res)=>{const outgoing=httpRequest({...target(req),method:req.method,headers:headers(req)},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res)});outgoing.on('error',()=>res.destroy());req.pipe(outgoing)});
  proxy.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))});
  proxy.on('upgrade',(req,socket,head)=>{
   const outgoing=httpRequest({...target(req),headers:headers(req)});
   outgoing.on('upgrade',(response,peer,peerHead)=>{
    socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n');
    if(head.length)peer.write(head);if(peerHead.length)socket.write(peerHead);
    socket.pipe(peer).pipe(socket);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());socket.on('close',()=>peer.destroy());peer.on('close',()=>socket.destroy());
   });outgoing.on('error',()=>socket.destroy());outgoing.end();
  });
  await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
  const publicBase='http://127.0.0.1:'+proxy.address().port;worker={...worker,publicBase,relayBase:publicBase.replace('http:','ws:')+'/ws/v1'};
  proxy.stop=async()=>{for(const socket of connections)socket.destroy();await new Promise(resolve=>proxy.close(resolve))};
  report.noExtensionProxy=true;
 }
 browser=await chromium.launch({executablePath:await findChromium(),headless:true});
 const cases=modes.flatMap(mode=>chunks.flatMap(chunkBytes=>drainDelays.map(drainMs=>({mode,chunkBytes,drainMs}))));
 for(let run=0;run<runs;run++)for(const {mode,chunkBytes,drainMs} of cases.slice(run%cases.length).concat(cases.slice(0,run%cases.length))){
  if(interrupted)throw new Error('benchmark interrupted');
  const context=await browser.newContext();
  let receiver;
  try{
   const page=await context.newPage();await page.route('**/favicon.ico',route=>route.fulfill({status:204,body:''}));await page.goto(worker.publicBase+'/api/health');
   await page.evaluate(()=>{document.body.innerHTML='<input type="file" id="payload">'});
   await page.locator('#payload').setInputFiles(source);
   await page.evaluate(async()=>{window.payload=new Uint8Array(await document.getElementById('payload').files[0].arrayBuffer())});
   const token=randomBytes(32).toString('base64url'),tokenHash=createHash('sha256').update(Buffer.from(token,'base64url')).digest('base64url'),url=worker.relayBase+'/'+randomBytes(16).toString('base64url')+(mode==='default'?'':'?stream='+mode);
   await page.evaluate(async({url,tokenHash})=>{
    window.sender=new WebSocket(url);sender.binaryType='arraybuffer';
    await new Promise((resolve,reject)=>{sender.onopen=resolve;sender.onerror=reject});
    const accepted=new Promise((resolve,reject)=>{const timer=setTimeout(()=>reject(new Error('sender admission timed out')),15000);sender.addEventListener('close',()=>{clearTimeout(timer);reject(new Error('sender admission rejected'))},{once:true});sender.addEventListener('message',event=>{if(typeof event.data==='string'&&JSON.parse(event.data).type==='accepted'){clearTimeout(timer);resolve()}})});
    sender.send(JSON.stringify({type:'join',protocol:'cd-transfer-v1',role:'sender',receiverTokenHash:tokenHash}));await accepted;
   },{url,tokenHash});
   receiver=client(url);await receiver.opened;receiver.socket.send(JSON.stringify({type:'join',protocol:'cd-transfer-v1',role:'receiver',receiverToken:token}));
   assert.equal((await receiver.next()).type,'accepted');
   const received=[];let bytes=0;
   const receive=(async()=>{while(bytes<payload.byteLength){const frame=await receiver.next();if(!(frame instanceof Uint8Array))continue;received.push(frame);bytes+=frame.byteLength;assert.ok(bytes<=payload.byteLength,'unexpected bytes')}})();
   const started=performance.now();
   const sending=page.evaluate(async({chunkBytes,drainMs})=>{
    let maxBuffered=0,polls=0;
    for(let offset=0;offset<payload.byteLength;offset+=chunkBytes){const chunk=payload.subarray(offset,offset+chunkBytes);while(sender.bufferedAmount+chunk.byteLength>4*1048576){polls++;await new Promise(resolve=>setTimeout(resolve,drainMs))}sender.send(chunk);maxBuffered=Math.max(maxBuffered,sender.bufferedAmount)}
    return {maxBuffered,polls};
   },{chunkBytes,drainMs});
   await receive;const milliseconds=performance.now()-started;const senderStats=await sending;
   assert.equal(digest(Buffer.concat(received)),digest(payload));
   const extensions=await page.evaluate(()=>sender.extensions);
   if(report.noExtensionProxy){assert.equal(extensions,'');assert.equal(receiver.socket.extensions,'')}
   report.rows.push({run,mode,chunkBytes,drainMs,extensions,receiverExtensions:receiver.socket.extensions,bytes,milliseconds,mibPerSecond:mib/(milliseconds/1000),senderStats,ok:true});
   console.error(mode+'/'+chunkBytes+'/'+drainMs+' #'+(run+1)+': '+milliseconds.toFixed(1)+'ms');
  }finally{receiver?.socket.close();await context.close()}
  await writeFile(output,JSON.stringify(report,null,2));
 }
}catch(error){report.error=error.stack;process.exitCode=1}
finally{for(const s of sockets)try{s.close()}catch{}await browser?.close();await proxy?.stop();await worker?.stop();await rm(work,{recursive:true,force:true});report.finishedAt=new Date().toISOString();await writeFile(output,JSON.stringify(report,null,2))}
console.log(JSON.stringify({output,successful:report.rows.length,error:report.error}));
