type RRole = 'sender' | 'receiver';
type Pending = { kind: 'resume-pending'; expiresAt: number; rootId: string };
type Peer = { kind: 'resume-peer'; role: RRole; rootId: string; sessionNonce: string; receiverNonce?: string; lastActivityAt?: number };
type Attachment = Pending | Peer;
type ResumeState = { status: 'empty'|'waiting'|'interrupted'|'paired'|'terminal'; expiresAt: number; senderTokenHash?: string; receiverTokenHash?: string; sessionNonce?: string; senderProof?: string; receiverNonce?: string; receiverProof?: string; receiverCompleteForwarded?: boolean; sessions: number; nonces: string[] };
const TTL = 24 * 60 * 60 * 1000;
const JOIN_TIMEOUT = 10_000;
// Existing v2 clients need no new heartbeat. ACKs also traverse the relay when
// CHUNK uses WebRTC; hashing and waiting for a receiver get conservative leases.
const WAITING_LEASE = 16 * 60 * 1000;
const PAIRED_LEASE = 15 * 60 * 1000;
const MAX_JOIN = 2048;
const MAX_FRAME = 1024 * 1024;
const MAX_BUFFER = 32 * 1024 * 1024;
const encode = (v: Uint8Array) => { let s=''; for(const b of v)s+=String.fromCharCode(b); return btoa(s).replaceAll('+','-').replaceAll('/','_').replaceAll('=',''); };
const decode = (v: string) => { const x=atob(v.replaceAll('-','+').replaceAll('_','/')+'='.repeat((4-v.length%4)%4)); return Uint8Array.from(x,c=>c.charCodeAt(0)); };
const is32 = (v: unknown): v is string => typeof v==='string' && /^[A-Za-z0-9_-]{43}$/.test(v);
const equal = (a:string,b:string) => { try { const x=decode(a),y=decode(b);if(x.length!==32||y.length!==32)return false;let d=0;for(let i=0;i<32;i++)d|=x[i]^y[i];return d===0; } catch { return false; } };
async function hash(value:string){return encode(new Uint8Array(await crypto.subtle.digest('SHA-256',decode(value))));}
function event(type:string, extra:Record<string,unknown>={}) { return JSON.stringify({type,protocol:'cd-transfer-v2',...extra}); }

// V2 shares the existing TRANSFERS namespace and Durable Object class. Its
// persisted state uses a separate storage key and its sockets are dispatched
// by attachment kind, keeping v1 room semantics untouched.
export class ResumeRoomProtocol {
  constructor(private ctx: DurableObjectState, private env: Env) {
    // Persist one migration grace for sockets admitted before leases existed.
    // Reconstructing this protocol after hibernation must not restart the grace.
    if(ctx.getWebSockets().some(socket=>{const a=socket.deserializeAttachment() as Attachment;return a?.kind==='resume-peer'&&a.lastActivityAt===undefined;})){
      ctx.blockConcurrencyWhile(async()=>this.scheduleAlarm(await this.state()));
    }
  }
  async fetch(request: Request, rootId: string): Promise<Response> {
    const state=await this.state(); if(state.status==='terminal'&&state.expiresAt>Date.now())return new Response('transfer complete',{status:410});
    if(state.status!=='empty'&&state.expiresAt<=Date.now()){await this.ctx.storage.delete('resume-room');}
    if(request.headers.get('Upgrade')?.toLowerCase()!=='websocket')return new Response('websocket required',{status:426});
    if(this.ctx.getWebSockets().filter(s=>{const a=s.deserializeAttachment() as Attachment;return a?.kind?.startsWith('resume-')}).length>=4)return new Response('room connection limit reached',{status:429});
    const pair=new WebSocketPair(), expiresAt=Date.now()+JOIN_TIMEOUT;pair[1].serializeAttachment({kind:'resume-pending',expiresAt,rootId} satisfies Pending);this.ctx.acceptWebSocket(pair[1]);
    const alarm=await this.ctx.storage.getAlarm();if(alarm===null||expiresAt<alarm)await this.ctx.storage.setAlarm(expiresAt);
    return new Response(null,{status:101,webSocket:pair[0]});
  }
  async message(socket:WebSocket,message:string|ArrayBuffer){
    const a=socket.deserializeAttachment() as Attachment;if(!a||!a.kind?.startsWith('resume-'))return;
    let state=await this.state();if(state.status!=='empty'&&state.expiresAt<=Date.now()){this.reject(socket,4408,'transfer expired');return;}
    if(a.kind==='resume-pending') {if(typeof message!=='string'||new TextEncoder().encode(message).length>MAX_JOIN){this.reject(socket,4406,'invalid protocol join');return;}let j:any;try{j=JSON.parse(message);}catch{this.reject(socket,4406,'invalid protocol join');return;}await this.ctx.blockConcurrencyWhile(async()=>this.admit(socket,a,j,await this.state()));return;}
    if(state.status==='terminal') {
      if(typeof message==='string'&&a.role==='sender'&&this.isComplete(message,{...a,role:'receiver',receiverNonce:state.receiverNonce},state)){try{socket.send(event('completed'));}catch{};return;}
      if(typeof message==='string'&&this.isComplete(message,a,state)){try{socket.send(event('completed'));}catch{};return;}
      this.reject(socket,4409,'transfer is terminal');return;
    }
    if(state.status!=='paired'||!state.sessionNonce||!state.receiverNonce||a.sessionNonce!==state.sessionNonce){this.reject(socket,4409,'stale session');return;}
    if(typeof message==='string'){
      if(a.role!=='receiver'||!this.isComplete(message,a,state)){this.reject(socket,4403,'invalid relay control');return;}
      if(!state.receiverCompleteForwarded){this.reject(socket,4403,'encrypted COMPLETE required first');return;}
      const sender=this.peer('sender');if(!sender){this.reject(socket,4404,'sender unavailable');return;}
      try{sender.send(message);}catch{this.reject(socket,1011,'relay failed');return;}
      state.status='terminal';await this.save(state);const ack=event('completed');for(const peer of [sender,socket])try{peer.send(ack);}catch{};return;
    }
    if(message.byteLength>MAX_FRAME){this.reject(socket,4403,'invalid relay frame');return;}
    const peer=this.peer(a.role==='sender'?'receiver':'sender');if(!peer){this.reject(socket,4404,'peer unavailable');return;}
    if(peer.bufferedAmount+message.byteLength>MAX_BUFFER){this.reject(socket,4429,'peer is too slow');this.reject(peer,4429,'peer is too slow');await this.interrupt(state);return;}
    try{peer.send(message);}catch{this.reject(socket,1011,'relay failed');this.reject(peer,1011,'relay failed');await this.interrupt(state);return;}
    this.touch(socket);this.touch(peer);
    if(a.role==='receiver'&&message.byteLength>=28){const h=new Uint8Array(message);if(h[0]===67&&h[1]===68&&h[2]===2&&h[3]===6){state.receiverCompleteForwarded=true;await this.save(state);}}
  }
  async close(socket:WebSocket){const a=socket.deserializeAttachment() as Attachment;if(a?.kind!=='resume-peer')return;const state=await this.state();if((state.status==='paired'||state.status==='waiting')&&state.sessionNonce===a.sessionNonce)await this.interrupt(state);}
  async alarm(){
    const state=await this.state(),now=Date.now();
    for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment() as Attachment;if(a?.kind==='resume-pending'&&a.expiresAt<=now)this.reject(socket,4408,'join expired');}
    if(state.status!=='empty'&&state.expiresAt<=now){for(const s of this.ctx.getWebSockets())this.reject(s,4408,'transfer expired');await this.ctx.storage.delete('resume-room');return;}
    if(this.peerDeadlines(state).some(deadline=>deadline<=now)){await this.interrupt(state);return;}
    await this.scheduleAlarm(state);
  }
  private async admit(socket:WebSocket,p:Pending,j:any,state:ResumeState){
    if(j?.type!=='join'||j.protocol!=='cd-transfer-v2'||!['sender','receiver'].includes(j.role)){this.reject(socket,4406,'invalid protocol join');return;}
    if(j.role==='sender'){
      if(!is32(j.senderToken)||!is32(j.sessionNonce)||!is32(j.nonceProof)){this.reject(socket,4406,'invalid sender join');return;}
      const tokenHash=await hash(j.senderToken), initial=state.status==='empty';
      if(initial){if(!is32(j.senderTokenHash)||!is32(j.receiverTokenHash)||!equal(await hash(j.senderToken),j.senderTokenHash)){this.reject(socket,4406,'invalid sender credentials');return;}const requestedExpiry=j.expiresAt; if(requestedExpiry!==undefined&&(!Number.isSafeInteger(requestedExpiry)||requestedExpiry<=Date.now()||requestedExpiry>Date.now()+TTL)){this.reject(socket,4406,'invalid transfer expiry');return;}state={status:'waiting',expiresAt:requestedExpiry??Date.now()+TTL,senderTokenHash:j.senderTokenHash,receiverTokenHash:j.receiverTokenHash,sessions:0,nonces:[]};}
      else {
        const hasHashes='senderTokenHash' in j||'receiverTokenHash' in j;
        const matchingHashes=!hasHashes||(is32(j.senderTokenHash)&&is32(j.receiverTokenHash)&&equal(j.senderTokenHash,state.senderTokenHash??'')&&equal(j.receiverTokenHash,state.receiverTokenHash??''));
        const recoverable=state.status==='interrupted'||((state.status==='waiting'||state.status==='paired')&&!this.peer('sender'));if(!recoverable||this.peer('sender')||!state.senderTokenHash||!equal(tokenHash,state.senderTokenHash)||!matchingHashes){this.reject(socket,4401,'sender unauthorized');return;}
      }
      if(state.nonces.includes(j.sessionNonce)){this.reject(socket,4409,'session nonce replay');return;}
      if(state.sessions>=128){this.exhausted(socket);return;}
      // The relay cannot validate master-key HMAC proofs. It binds the opaque
      // proof to this session and forwards it for end-to-end verification.
      state.status='waiting';state.sessions++;state.nonces=[...state.nonces.slice(-127),j.sessionNonce];state.sessionNonce=j.sessionNonce;state.senderProof=j.nonceProof;state.receiverNonce=undefined;state.receiverProof=undefined;state.receiverCompleteForwarded=false;
      socket.serializeAttachment({kind:'resume-peer',role:'sender',rootId:p.rootId,sessionNonce:j.sessionNonce,lastActivityAt:Date.now()} satisfies Peer);
      await this.save(state);socket.send(event('accepted',{expiresAt:state.expiresAt,sessionNonce:j.sessionNonce,senderNonceProof:j.nonceProof}));
      const receiver=this.peer('receiver');if(receiver){this.reject(receiver,4409,'session interrupted');}return;
    }
    if(!is32(j.receiverToken)||!is32(j.receiverNonce)||!is32(j.nonceProof)){this.reject(socket,4406,'invalid receiver join');return;}
    if(!['waiting','interrupted'].includes(state.status)||!state.receiverTokenHash||!equal(await hash(j.receiverToken),state.receiverTokenHash)){this.reject(socket,4401,'receiver unauthorized');return;}
    if(state.nonces.includes(j.receiverNonce)){this.reject(socket,4409,'receiver nonce replay');return;}
    if(state.status==='interrupted'){if(state.sessions>=128)this.exhausted(socket);else this.reject(socket,4409,'sender must resume first');return;}
    const sender=this.peer('sender');if(!sender||!state.sessionNonce){this.reject(socket,4404,'sender unavailable');return;}
    state.status='paired';state.receiverNonce=j.receiverNonce;state.receiverProof=j.nonceProof;state.nonces=[...state.nonces.slice(-255),j.receiverNonce];state.receiverCompleteForwarded=false;socket.serializeAttachment({kind:'resume-peer',role:'receiver',rootId:p.rootId,sessionNonce:state.sessionNonce,receiverNonce:j.receiverNonce,lastActivityAt:Date.now()} satisfies Peer);sender.serializeAttachment({...sender.deserializeAttachment() as Peer,receiverNonce:j.receiverNonce,lastActivityAt:Date.now()});await this.save(state);
    const bound={sessionNonce:state.sessionNonce,receiverNonce:j.receiverNonce,senderNonceProof:state.senderProof,receiverNonceProof:j.nonceProof,expiresAt:state.expiresAt};
    socket.send(event('accepted',bound));socket.send(event('peer-joined',bound));sender.send(event('peer-joined',bound));
  }
  private isComplete(message:string,a:Peer,s:ResumeState){try{const v=JSON.parse(message);return v?.type==='complete'&&v.protocol==='cd-transfer-v2'&&v.sessionNonce===s.sessionNonce&&v.receiverNonce===s.receiverNonce&&a.role==='receiver'&&a.receiverNonce===s.receiverNonce;}catch{return false;}}
  private async interrupt(s:ResumeState){if(s.status==='terminal')return;s.status='interrupted';await this.save(s);for(const peer of this.ctx.getWebSockets()){const a=peer.deserializeAttachment() as Attachment;if(a?.kind==='resume-peer')try{peer.send(event('peer-left',{reason:'session interrupted'}));peer.close(4404,'session interrupted');}catch{}}}
  private peer(role:RRole){return this.ctx.getWebSockets().find(s=>{const a=s.deserializeAttachment() as Attachment;return s.readyState===WebSocket.OPEN&&a?.kind==='resume-peer'&&a.role===role;})??null;}
  private async state():Promise<ResumeState>{return await this.ctx.storage.get<ResumeState>('resume-room')??{status:'empty',expiresAt:0,sessions:0,nonces:[]};}
  private async save(s:ResumeState){await this.ctx.storage.put('resume-room',s);await this.scheduleAlarm(s);}
  private touch(socket:WebSocket){const a=socket.deserializeAttachment() as Attachment;if(a?.kind==='resume-peer')socket.serializeAttachment({...a,lastActivityAt:Date.now()});}
  private peerDeadlines(s:ResumeState):number[]{
    if(s.status!=='waiting'&&s.status!=='paired')return [];
    const lease=s.status==='waiting'?WAITING_LEASE:PAIRED_LEASE,deadlines:number[]=[];
    for(const socket of this.ctx.getWebSockets()){
      const a=socket.deserializeAttachment() as Attachment;
      if(socket.readyState!==WebSocket.OPEN||a?.kind!=='resume-peer'||a.sessionNonce!==s.sessionNonce)continue;
      if(a.lastActivityAt===undefined){a.lastActivityAt=Date.now();socket.serializeAttachment(a);}
      deadlines.push(a.lastActivityAt+lease);
    }
    return deadlines;
  }
  private async scheduleAlarm(s:ResumeState){const deadlines:number[]=this.peerDeadlines(s);if(s.status!=='empty')deadlines.push(s.expiresAt);for(const socket of this.ctx.getWebSockets()){const a=socket.deserializeAttachment() as Attachment;if(a?.kind==='resume-pending'&&socket.readyState===WebSocket.OPEN)deadlines.push(a.expiresAt);}if(deadlines.length)await this.ctx.storage.setAlarm(Math.min(...deadlines));}
  private exhausted(socket:WebSocket){try{socket.send(event('exhausted',{reason:'session_limit'}));}catch{}this.reject(socket,4410,'transfer session limit reached');}
  private reject(s:WebSocket,code:number,reason:string){try{s.close(code,reason);}catch{}}
}
