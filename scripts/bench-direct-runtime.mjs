// Local benchmark runtime without Wrangler's additional development proxy.
import {Miniflare,convertV4MiniflareOptions} from 'miniflare';
import {resolve,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {readFile} from 'node:fs/promises';
import {createServer,request as httpRequest} from 'node:http';

async function frontend(upstreamBase){
 const root=fileURLToPath(new URL('../dist/',import.meta.url));
 const upstream=new URL(upstreamBase),connections=new Set();
 const target=req=>{const url=new URL(req.url,'http://localhost');return {protocol:upstream.protocol,hostname:upstream.hostname,port:upstream.port,path:url.pathname+url.search}};
 const proxy=createServer(async(req,res)=>{
  const pathname=new URL(req.url,'http://localhost').pathname;
  if(/^\/(api|ws|peerjs)\//.test(pathname)){
   const outgoing=httpRequest({...target(req),method:req.method,headers:req.headers},incoming=>{res.writeHead(incoming.statusCode,incoming.headers);incoming.pipe(res)});
   outgoing.on('error',()=>res.destroy());req.pipe(outgoing);return;
  }
  try{
   const decoded=decodeURIComponent(pathname);
   let path=resolve(root,'.'+decoded);
   if(decoded==='/'||!decoded.split('/').at(-1).includes('.'))path=resolve(root,'index.html');
   if(!path.startsWith(root)){res.writeHead(404);res.end();return}
   const body=await readFile(path),extension=path.split('.').at(-1);
   res.writeHead(200,{'Content-Type':({html:'text/html',js:'text/javascript',css:'text/css',json:'application/json',svg:'image/svg+xml',png:'image/png',wasm:'application/wasm'})[extension]||'application/octet-stream'});res.end(body);
  }catch{res.writeHead(404);res.end()}
 });
 proxy.on('connection',socket=>{connections.add(socket);socket.on('close',()=>connections.delete(socket))});
 proxy.on('upgrade',(req,socket,head)=>{
  const outgoing=httpRequest({...target(req),headers:req.headers});
  outgoing.on('upgrade',(response,peer,peerHead)=>{
   socket.write('HTTP/1.1 101 Switching Protocols\r\n'+Object.entries(response.headers).map(([key,value])=>key+': '+value).join('\r\n')+'\r\n\r\n');
   if(head.length)peer.write(head);if(peerHead.length)socket.write(peerHead);
   socket.pipe(peer).pipe(socket);socket.on('error',()=>peer.destroy());peer.on('error',()=>socket.destroy());socket.on('close',()=>peer.destroy());peer.on('close',()=>socket.destroy());
  });
  outgoing.on('response',response=>{socket.end('HTTP/1.1 '+response.statusCode+' Rejected\r\nConnection: close\r\n\r\n');response.resume()});
  outgoing.on('error',()=>socket.destroy());outgoing.end();
 });
 await new Promise(resolve=>proxy.listen(0,'127.0.0.1',resolve));
 return {publicBase:'http://127.0.0.1:'+proxy.address().port,stop:async()=>{for(const socket of connections)socket.destroy();await new Promise(resolve=>proxy.close(resolve))}};
}
export async function startDirectRuntime(bundle,{compression=true,assets=false,streaming=false}={}){
 const scriptPath=resolve(bundle);
 const runtime=new Miniflare(convertV4MiniflareOptions({
  modules:true,modulesRoot:dirname(scriptPath),scriptPath,compatibilityDate:'2026-09-12',
  compatibilityFlags:compression?[]:['no_web_socket_compression'],
  bindings:streaming?{CD_RELAY_STREAMING:'1'}:{},
  unsafeDirectSockets:[{entrypoint:'default',host:'127.0.0.1',port:0}],
  durableObjects:Object.fromEntries(Object.entries({TRANSFERS:'TransferRoom',PEERS:'PeerSignal',CODES:'CodeDirectory',DEVICES:'DeviceRoom'}).map(([binding,className])=>[binding,{className,useSQLite:true}])),
  ratelimits:Object.fromEntries(['CONNECTION_RATE_LIMITER','PEER_RATE_LIMITER'].map((name,index)=>[name,{namespace_id:String(9237491+index),simple:{limit:1000000,period:60}}]))
 }));
 let server,timer;
 try{
  const address=await Promise.race([runtime.unsafeGetDirectURL(),new Promise((_,reject)=>{timer=setTimeout(()=>reject(new Error('Direct runtime startup timed out')),30000)})]);clearTimeout(timer);
  let publicBase=address.origin;
  if(assets){server=await frontend(publicBase);publicBase=server.publicBase}
  return {publicBase,relayBase:publicBase.replace('http:','ws:')+'/ws/v1',stop:async()=>{await server?.stop();await runtime.dispose()}};
 }catch(error){clearTimeout(timer);await server?.stop();await runtime.dispose();throw error}
}
