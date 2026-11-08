// Observe encrypted payload sends; explicit relay-only mode disables WebRTC.
export function probe({ relayOnly }) {
  window.__fresh = { relay: 0, direct: 0, firstAt: null, lastAt: null, maxGapMs: 0, records: 0, peers: [], sockets: [] };
  const stat = window.__fresh;
  window.__CD_TRANSFER_TEST_OBSERVER__ = snapshot => {
    if (snapshot.window) stat.window = { size: snapshot.window.size, inFlight: snapshot.window.inFlight, minRTT: snapshot.window.minRTT, acknowledged: String(snapshot.window.acknowledged) };
  };
  function sent(bytes, route) {
    if (!bytes) return;
    const now = performance.now();
    if (stat.lastAt !== null) stat.maxGapMs = Math.max(stat.maxGapMs, now - stat.lastAt);
    stat.firstAt ??= now; stat.lastAt = now;
    stat[route] += bytes; stat.records++;
  }
  const NativeSocket = WebSocket;
  window.WebSocket = class extends NativeSocket {
    constructor(...args) {
      super(...args);
      const socket = { path: new URL(this.url).pathname.replace(/\/[A-Za-z0-9_-]{22}$/, '/<id>'), received: 0, maxGapMs: 0, lastAt: null };
      stat.sockets.push(socket);
      this.addEventListener('message', event => {
        const now = performance.now();
        if (socket.lastAt !== null) socket.maxGapMs = Math.max(socket.maxGapMs, now - socket.lastAt);
        socket.lastAt = now;
        if (typeof event.data !== 'string') socket.received += event.data.byteLength ?? event.data.size ?? 0;
      });
      this.addEventListener('open', () => { socket.extensions = this.extensions; });
      this.addEventListener('close', event => { socket.closeCode = event.code; });
    }
  };
  const NativePeer = RTCPeerConnection;
  const connections = [];
  window.__freshSnapshot = async () => {
    for (const connection of connections) {
      const peer = connection.__freshPeer;
      peer.sctpState = connection.sctp?.state;
      try {
        const items = await connection.getStats();
        const pairs = [...items.values()].filter(item => item.type === 'candidate-pair' && (item.nominated || item.selected)).map(item => ({
          state: item.state, bytesSent: item.bytesSent, bytesReceived: item.bytesReceived,
          currentRoundTripTime: item.currentRoundTripTime, requestsSent: item.requestsSent, responsesReceived: item.responsesReceived,
          localType: items.get(item.localCandidateId)?.candidateType, remoteType: items.get(item.remoteCandidateId)?.candidateType,
          protocol: items.get(item.localCandidateId)?.protocol
        }));
        if (pairs.length) { peer.selectedPairs = pairs; peer.pairsObservedAt = performance.now(); }
      } catch (error) { peer.statsError = error.name; }
    }
    return stat;
  };
  window.RTCPeerConnection = class extends NativePeer {
    constructor(...args) {
      super(...args); const peer = { states: [], candidateTypes: [], iceStates: [], candidatesAdded: [], channels: [] }; stat.peers.push(peer);
      this.__freshPeer = peer; connections.push(this);
      this.addEventListener('connectionstatechange', () => {
        peer.states.push(this.connectionState);
        if (this.connectionState === 'connected') void window.__freshSnapshot();
      });
      this.addEventListener('iceconnectionstatechange', () => peer.iceStates.push({ state: this.iceConnectionState, at: performance.now() }));
      this.addEventListener('icecandidate', event => { if (event.candidate) peer.candidateTypes.push(event.candidate.type); });
    }
    addIceCandidate(candidate) {
      this.__freshPeer.candidatesAdded.push({ at: performance.now(), type: candidate?.candidate?.match(/ typ (\w+)/)?.[1] });
      return super.addIceCandidate(candidate);
    }
    createDataChannel(...args) {
      const channel = super.createDataChannel(...args), observed = { label: channel.label, events: [] };
      this.__freshPeer.channels.push(observed);
      for (const name of ['open', 'close', 'error']) channel.addEventListener(name, event => {
        observed.events.push({ event: name, at: performance.now(), bufferedAmount: channel.bufferedAmount, error: event.error?.message, detail: event.error?.errorDetail });
      });
      return channel;
    }
    close() { this.__freshPeer.closeCalledAt = performance.now(); return super.close(); }
  };
  const socketSend = WebSocket.prototype.send;
  WebSocket.prototype.send = function(data) {
    const result = socketSend.call(this, data);
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (bytes && bytes.length >= 12 && bytes[0] === 0x43 && bytes[1] === 0x44 && bytes[3] === 2) sent(new DataView(bytes.buffer, bytes.byteOffset).getUint32(8), 'relay');
    return result;
  };
  const channelSend = RTCDataChannel.prototype.send;
  const states = new WeakMap();
  RTCDataChannel.prototype.send = function(data) {
    const result = channelSend.call(this, data);
    if (this.label !== 'cd-direct') return result;
    const bytes = data instanceof ArrayBuffer ? new Uint8Array(data) : ArrayBuffer.isView(data) ? new Uint8Array(data.buffer, data.byteOffset, data.byteLength) : null;
    if (!bytes) return result;
    let state = states.get(this);
    if (!state) { state = { header: [], remaining: 0, payload: 0 }; states.set(this, state); }
    let cursor = 0;
    while (cursor < bytes.length) {
      if (!state.remaining) {
        while (state.header.length < 12 && cursor < bytes.length) state.header.push(bytes[cursor++]);
        if (state.header.length < 12) break;
        assertHeader(state.header);
        const length = new DataView(Uint8Array.from(state.header).buffer).getUint32(8);
        state.remaining = length + 16; state.payload = state.header[3] === 2 ? length : 0; state.header = [];
      }
      const take = Math.min(state.remaining, bytes.length - cursor);
      cursor += take; state.remaining -= take;
      if (!state.remaining) sent(state.payload, 'direct');
    }
    return result;
  };
  function assertHeader(header) { if (header[0] !== 0x43 || header[1] !== 0x44 || header[2] !== 1) throw new Error('unexpected direct record'); }
  if (relayOnly) window.RTCPeerConnection = class { constructor() { throw new Error('fresh benchmark forced relay'); } };
}
