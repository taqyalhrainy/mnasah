import { io, type Socket } from 'socket.io-client';
import { AdaptiveCallQuality, speechSdp, type QualityLevel } from './adaptiveCallQuality';
import { groupRequest, type GroupMessage, type GroupSession } from './groupCallApi';
import type { PeerCallbacks, VideoConnectionHandle } from './videoConnection';
import { t } from '../i18n/preferences';

type PeerInfo = { id: string; memberId: string; name: string; host: boolean; audioEnabled: boolean; videoEnabled: boolean; screenEnabled: boolean; speaking: boolean; typing?: boolean };
export type GroupParticipant = PeerInfo & { stream: MediaStream; screenStream: MediaStream; primary: boolean };
type GroupPeer = PeerInfo & { pc: RTCPeerConnection; stream: MediaStream; screenStream: MediaStream; camera: RTCRtpSender; audio: RTCRtpSender; screen: RTCRtpSender; pendingIce: RTCIceCandidateInit[]; makingOffer: boolean; qualityStarted: boolean; quality: AdaptiveCallQuality; level: QualityLevel };
type Signal = { from: string; description?: RTCSessionDescriptionInit; candidate?: RTCIceCandidateInit; restart?: boolean; quality?: { level: number; protectAudio: boolean } };
const audioConstraints = { echoCancellation: true, noiseSuppression: true, autoGainControl: true, channelCount: { ideal: 1 } };
const videoConstraints = { width: { ideal: 640, max: 1280 }, height: { ideal: 360, max: 720 }, frameRate: { ideal: 20, max: 24 } };

export class GroupVideoConnection implements VideoConnectionHandle {
  private socket?: Socket;
  private local?: MediaStream;
  private screenStream?: MediaStream;
  private peers = new Map<string, GroupPeer>();
  private roster: PeerInfo[] = [];
  private selfId = '';
  private primaryId = '';
  private primarySignature = '';
  private screenSignature = '';
  private closed = false;
  private audioEnabled = true;
  private videoEnabled = false;
  private cameraFacing: 'user' | 'environment' = 'user';
  private servers: RTCIceServer[] = [{ urls: ['stun:stun.cloudflare.com:3478', 'stun:stun.l.google.com:19302'] }];
  private refreshTimer?: number;
  private operations: unknown[] = [];
  private sending = false;
  private operationTimer?: number;
  private pendingSignals = new Map<string, Signal[]>();
  constructor(private session: GroupSession, private callbacks: PeerCallbacks, private onParticipants: (peers: GroupParticipant[]) => void, private onMessage: (message: GroupMessage) => void) {}

  async start(options: { video?: boolean } = {}) {
    this.videoEnabled = options.video === true;
    const ice = groupRequest<{ ice_servers: RTCIceServer[] }>(`/${this.session.roomId}/ice`, undefined, this.session).catch(() => null);
    const stream = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: this.videoEnabled ? { ...videoConstraints, facingMode: { ideal: this.cameraFacing } } : false });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error(t('انتهت المكالمة')); }
    this.local = stream;
    const settings = await ice;
    if (settings?.ice_servers?.length) this.servers = settings.ice_servers;
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error(t('انتهت المكالمة')); }
    const socket = io(import.meta.env.VITE_API_URL || location.origin, { auth: { groupToken: this.session.token }, transports: ['websocket', 'polling'], tryAllTransports: true, forceNew: true, withCredentials: true });
    this.socket = socket;
    socket.on('connect', () => {
      socket.timeout(10000).emit('group:join', {}, (error: Error | null, response?: { accepted: boolean; selfId: string; state: object }) => {
        if (this.closed) return;
        if (error || !response?.accepted) { this.callbacks.onStatus(t('تعذر دخول المكالمة الجماعية. حاول مجدداً.')); return; }
        this.selfId = response.selfId;
        this.sendMedia();
        this.callbacks.onWhiteboardMessage?.({ ...response.state, kind: 'sync', relayId: crypto.randomUUID(), relaySource: 'server-group' });
        const stateMessages = (response.state as { messages?: GroupMessage[] }).messages || [];
        for (const message of stateMessages) this.onMessage(message);
        this.callbacks.onDataOpen?.();
        this.flushOperations();
      });
    });
    socket.on('group:peers', (peers: PeerInfo[]) => {
      if (!Array.isArray(peers) || this.closed) return;
      this.roster = peers.filter(peer => peer.id !== socket.id);
      for (const [id, peer] of this.peers) if (!this.roster.some(row => row.id === id)) { peer.quality.stop(); peer.pc.close(); this.peers.delete(id); }
      for (const row of this.roster) this.ensurePeer(row);
      this.publish();
    });
    socket.on('group:signal', (signal: Signal) => { void this.receiveSignal(signal).catch(() => this.requestRestart(signal.from)); });
    socket.on('group:operation', (operation: unknown) => this.callbacks.onWhiteboardMessage?.(operation));
    socket.on('group:message', (message: GroupMessage) => this.onMessage(message));
    socket.on('disconnect', () => { if (!this.closed) this.callbacks.onStatus(t('جاري إعادة الاتصال')); });
    socket.on('connect_error', () => { if (!this.closed) this.callbacks.onStatus(t('جاري إعادة الاتصال')); });
    this.refreshTimer = window.setInterval(() => { void this.refreshIce(); }, 300000);
    return stream;
  }
  private ensurePeer(info: PeerInfo) {
    const previous = this.peers.get(info.id);
    if (previous) { Object.assign(previous, info); return previous; }
    if (!this.local) return;
    const pc = new RTCPeerConnection({ iceServers: this.servers });
    const audio = pc.addTransceiver('audio', { direction: 'sendrecv', streams: [this.local] }).sender;
    const camera = pc.addTransceiver('video', { direction: 'sendrecv', streams: [this.local] }).sender;
    const screen = pc.addTransceiver('video', { direction: 'sendrecv' }).sender;
    const peer: GroupPeer = { ...info, pc, audio, camera, screen, stream: new MediaStream(), screenStream: new MediaStream(), pendingIce: [], makingOffer: false, qualityStarted: false, level: 0, quality: new AdaptiveCallQuality({
      connection: pc,
      onReceiveQuality: (level, protectAudio) => this.signal(info.id, { quality: { level, protectAudio } }),
      onChange: level => { peer.level = level; this.callbacks.onConnectionQuality?.(Math.max(0, ...[...this.peers.values()].map(p => p.level)) as QualityLevel, false); },
      expectsMedia: () => peer.audioEnabled ? 'audio' : peer.videoEnabled ? 'video' : null,
      expectsVideo: () => peer.videoEnabled && document.visibilityState !== 'hidden',
      onStall: () => this.requestRestart(info.id),
    }) };
    this.peers.set(info.id, peer);
    pc.onicecandidate = event => { if (event.candidate) this.signal(info.id, { candidate: event.candidate.toJSON() }); };
    pc.ontrack = event => {
      const target = event.transceiver.sender === peer.screen ? peer.screenStream : peer.stream;
      if (!target.getTrackById(event.track.id)) target.addTrack(event.track);
      event.track.onunmute = () => this.publish();
      this.publish();
    };
    pc.onconnectionstatechange = () => {
      if (pc.connectionState === 'connected') { if (!peer.qualityStarted) { peer.qualityStarted = true; peer.quality.start(); } this.callbacks.onStatus(t('متصل')); }
      if (pc.connectionState === 'failed') this.requestRestart(info.id);
      this.publish();
    };
    pc.onnegotiationneeded = () => { if (this.selfId < info.id) void this.offer(peer); };
    void Promise.all([audio.replaceTrack(this.local.getAudioTracks()[0] || null), camera.replaceTrack(this.local.getVideoTracks()[0] || null), screen.replaceTrack(this.screenStream?.getVideoTracks()[0] || null)]).then(() => {
      if (this.selfId < info.id) void this.offer(peer);
    });
    const waiting = this.pendingSignals.get(info.id) || [];
    this.pendingSignals.delete(info.id);
    for (const signal of waiting) void this.receiveSignal(signal);
    return peer;
  }
  private signal(to: string, payload: Omit<Signal, 'from'>) { if (!this.closed) this.socket?.emit('group:signal', { to, ...payload }); }
  private async offer(peer: GroupPeer) {
    if (this.closed || peer.makingOffer || peer.pc.signalingState !== 'stable') return;
    peer.makingOffer = true;
    try {
      const offer = await peer.pc.createOffer();
      await peer.pc.setLocalDescription({ ...offer, sdp: speechSdp(offer.sdp || '') });
      this.signal(peer.id, { description: peer.pc.localDescription!.toJSON() });
    } catch { /* A closed or replaced participant does not stop the room. */ }
    finally { peer.makingOffer = false; }
  }
  private async receiveSignal(signal: Signal) {
    if (this.closed || !signal?.from) return;
    const peer = this.peers.get(signal.from);
    if (!peer) {
      const pending = this.pendingSignals.get(signal.from) || [];
      if (pending.length < 100) pending.push(signal);
      this.pendingSignals.set(signal.from, pending);
      return;
    }
    if (signal.quality) { peer.quality.remoteReceiveQuality(signal.quality.level, signal.quality.protectAudio); return; }
    if (signal.restart && this.selfId < signal.from) { peer.pc.restartIce(); await this.offer(peer); return; }
    if (signal.description) {
      if (signal.description.type === 'offer' && peer.pc.signalingState !== 'stable') return;
      await peer.pc.setRemoteDescription(signal.description);
      for (const candidate of peer.pendingIce.splice(0)) await peer.pc.addIceCandidate(candidate);
      if (signal.description.type === 'offer') {
        const answer = await peer.pc.createAnswer();
        await peer.pc.setLocalDescription({ ...answer, sdp: speechSdp(answer.sdp || '') });
        this.signal(signal.from, { description: peer.pc.localDescription!.toJSON() });
      }
    } else if (signal.candidate) {
      if (peer.pc.remoteDescription) await peer.pc.addIceCandidate(signal.candidate);
      else if (peer.pendingIce.length < 100) peer.pendingIce.push(signal.candidate);
    }
  }
  private requestRestart(id: string) {
    const peer = this.peers.get(id);
    if (!peer || this.closed) return;
    if (this.selfId < id) { peer.pc.restartIce(); void this.offer(peer); }
    else this.signal(id, { restart: true });
  }
  private publish() {
    const values = [...this.peers.values()];
    if (!this.peers.has(this.primaryId)) { this.primaryId = values.find(p => p.host)?.id || values[0]?.id || ''; this.primarySignature = ''; }
    const primary = this.peers.get(this.primaryId);
    this.onParticipants(values.map(peer => ({ ...peer, primary: peer.id === this.primaryId })));
    this.callbacks.onRemotePresence?.(values.length > 0);
    this.callbacks.onRemoteTyping?.(values.some(peer => peer.typing));
    if (!primary) { if (this.primarySignature) this.callbacks.onPeerLeft(); this.primarySignature = ''; if (this.screenSignature) this.callbacks.onRemoteScreenStream?.(null); this.screenSignature = ''; return; }
    this.callbacks.onRemoteProfile?.({ name: primary.name });
    this.callbacks.onRemoteAudioEnabled?.(primary.audioEnabled);
    this.callbacks.onRemoteVideoEnabled?.(primary.videoEnabled);
    this.callbacks.onRemoteSpeaking?.(primary.speaking);
    const signature = `${primary.id}:${primary.stream.getTracks().map(track => track.id).join(',')}`;
    if (primary.stream.getTracks().length && this.primarySignature !== signature) { this.primarySignature = signature; this.callbacks.onRemoteStream(primary.stream); }
    const screenSignature = primary.screenEnabled ? `${primary.id}:${primary.screenStream.getTracks().map(track => track.id).join(',')}` : '';
    if (screenSignature !== this.screenSignature) { this.screenSignature = screenSignature; this.callbacks.onRemoteScreenStream?.(primary.screenEnabled ? primary.screenStream : null); }
  }
  selectParticipant(id: string) { if (this.peers.has(id)) { this.primaryId = id; this.primarySignature = ''; this.publish(); } }
  private sendMedia(extra: Record<string, boolean> = {}) { this.socket?.emit('group:media', { audioEnabled: this.audioEnabled, videoEnabled: this.videoEnabled, screenEnabled: !!this.screenStream, ...extra }); }
  toggleAudio(enabled: boolean) { this.audioEnabled = enabled; this.local?.getAudioTracks().forEach(track => { track.enabled = enabled; }); this.sendMedia(); }
  async repairAudio() {
    if (this.closed || !this.local || this.local.getAudioTracks().some(track => track.readyState === 'live')) return;
    const capture = await navigator.mediaDevices.getUserMedia({ audio: audioConstraints, video: false });
    if (this.closed) { capture.getTracks().forEach(track => track.stop()); return; }
    const track = capture.getAudioTracks()[0]; track.enabled = this.audioEnabled;
    for (const old of this.local.getAudioTracks()) { this.local.removeTrack(old); old.stop(); }
    this.local.addTrack(track);
    await Promise.all([...this.peers.values()].map(peer => peer.audio.replaceTrack(track)));
    this.callbacks.onLocalStreamChange?.(this.local);
  }
  async toggleVideo(enabled: boolean) {
    if (!this.local || this.closed) return this.local;
    if (enabled && !this.local.getVideoTracks().some(track => track.readyState === 'live')) {
      const capture = await navigator.mediaDevices.getUserMedia({ audio: false, video: { ...videoConstraints, facingMode: { ideal: this.cameraFacing } } });
      if (this.closed) { capture.getTracks().forEach(track => track.stop()); return this.local; }
      for (const track of this.local.getVideoTracks()) this.local.removeTrack(track);
      this.local.addTrack(capture.getVideoTracks()[0]);
    }
    this.videoEnabled = enabled;
    const track = enabled ? this.local.getVideoTracks()[0] : null;
    await Promise.all([...this.peers.values()].map(peer => peer.camera.replaceTrack(track)));
    if (!enabled) for (const old of this.local.getVideoTracks()) { this.local.removeTrack(old); old.stop(); }
    this.callbacks.onLocalStreamChange?.(this.local); this.sendMedia();
    return this.local;
  }
  getCameraFacing() { return this.cameraFacing; }
  async switchCamera() {
    const next = this.cameraFacing === 'user' ? 'environment' : 'user';
    if (!this.local) return { stream: this.local, facing: this.cameraFacing };
    const acquire = () => navigator.mediaDevices.getUserMedia({ audio: false, video: { ...videoConstraints, facingMode: { ideal: next } } });
    let capture: MediaStream;
    try { capture = await acquire(); }
    catch { await this.toggleVideo(false); capture = await acquire(); }
    if (this.closed) { capture.getTracks().forEach(track => track.stop()); return { stream: this.local, facing: this.cameraFacing }; }
    const old = this.local.getVideoTracks();
    const track = capture.getVideoTracks()[0];
    await Promise.all([...this.peers.values()].map(peer => peer.camera.replaceTrack(track)));
    old.forEach(value => { this.local?.removeTrack(value); value.stop(); });
    this.local.addTrack(track); this.cameraFacing = next; this.videoEnabled = true;
    this.callbacks.onLocalStreamChange?.(this.local); this.sendMedia();
    return { stream: this.local, facing: next as 'user' | 'environment' };
  }
  async repairVideo() { if (this.videoEnabled) await this.toggleVideo(true); }
  async startScreenShare() {
    const stream = await navigator.mediaDevices.getDisplayMedia({ video: { frameRate: { ideal: 10, max: 15 } }, audio: false });
    if (this.closed) { stream.getTracks().forEach(track => track.stop()); throw new Error(t('انتهت المكالمة')); }
    await this.stopScreenShare(); this.screenStream = stream;
    const track = stream.getVideoTracks()[0]; track.onended = () => { void this.stopScreenShare(); };
    await Promise.all([...this.peers.values()].map(peer => peer.screen.replaceTrack(track)));
    this.callbacks.onLocalScreenStream?.(stream); this.callbacks.onLocalVideoSource('screen'); this.sendMedia();
    return stream;
  }
  async stopScreenShare() {
    const stream = this.screenStream; this.screenStream = undefined;
    await Promise.all([...this.peers.values()].map(peer => peer.screen.replaceTrack(null).catch(() => undefined)));
    stream?.getTracks().forEach(track => track.stop());
    this.callbacks.onLocalScreenStream?.(null); this.callbacks.onLocalVideoSource('camera'); this.sendMedia();
    return this.local;
  }
  private async refreshIce() {
    try {
      const value = await groupRequest<{ ice_servers: RTCIceServer[] }>(`/${this.session.roomId}/ice`, undefined, this.session);
      if (this.closed || !value.ice_servers?.length) return;
      this.servers = value.ice_servers;
      for (const peer of this.peers.values()) peer.pc.setConfiguration({ iceServers: this.servers });
    } catch { /* Keep the existing allocation while the provider is unavailable. */ }
  }
  reconnectSignaling() { if (!this.closed && !this.socket?.connected) this.socket?.connect(); }
  resumeAfterBackground() { this.reconnectSignaling(); void this.repairAudio().catch(() => undefined); void this.repairVideo().catch(() => undefined); for (const peer of this.peers.values()) if (['failed', 'disconnected'].includes(peer.pc.connectionState)) this.requestRestart(peer.id); }
  sendWhiteboard(message: unknown) {
    if (this.closed) return false;
    const kind = (message as { kind?: string })?.kind;
    if (['pointer', 'stroke-start', 'stroke-points', 'document-preload'].includes(kind || '')) { if (this.socket?.connected) this.socket.emit('group:operation', message); return !!this.socket?.connected; }
    this.operations.push(message); this.flushOperations(); return true;
  }
  private flushOperations() {
    if (this.closed || this.sending || !this.socket?.connected || !this.selfId || !this.operations.length) return;
    this.sending = true;
    this.socket.timeout(7000).emit('group:operation', this.operations[0], (error: Error | null, result?: { accepted: boolean }) => {
      this.sending = false;
      if (this.closed) return;
      if (!error && result) this.operations.shift();
      clearTimeout(this.operationTimer);
      this.operationTimer = window.setTimeout(() => this.flushOperations(), error ? 1200 : 0);
    });
  }
  sendTyping(typing: boolean) { this.sendMedia({ typing }); return !!this.socket?.connected; }
  sendSpeaking(speaking: boolean) { this.sendMedia({ speaking }); return !!this.socket?.connected; }
  sendProfile(_profile: { name: string; avatar?: string }) {}
  sendMessage(body: string) { return new Promise<void>((resolve, reject) => { this.socket?.timeout(7000).emit('group:message', { body }, (error: Error | null, value?: { ok: boolean }) => error || !value?.ok ? reject(new Error(t('تعذر إرسال الرسالة.'))) : resolve()); }); }
  close() {
    this.closed = true; clearInterval(this.refreshTimer); clearTimeout(this.operationTimer);
    this.socket?.disconnect();
    for (const peer of this.peers.values()) { peer.quality.stop(); peer.pc.close(); }
    this.peers.clear(); this.operations = []; this.pendingSignals.clear();
    this.local?.getTracks().forEach(track => track.stop()); this.screenStream?.getTracks().forEach(track => track.stop());
    this.onParticipants([]);
  }
}
