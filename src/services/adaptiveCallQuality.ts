// Keep speech ahead of video. Browser congestion control still decides the
// actual rate; these are upper bounds, not a request to fill the connection.
export type QualityLevel = 0 | 1 | 2 | 3;
const profiles = [
  { video: 420000, screen: 350000, fps: 20, scale: 1 },
  { video: 140000, screen: 120000, fps: 12, scale: 2 },
  { video: 55000, screen: 45000, fps: 6, scale: 3 },
  { video: 28000, screen: 30000, fps: 4, scale: 4 },
];

// Opus FEC repairs some lost speech packets. Mono/DTX avoid spending bandwidth
// on stereo or silence. Apply to both offer and answer, preserving other codecs.
export function speechSdp(sdp: string): string {
  return sdp.split(/(?=^m=)/m).map(section => {
    if (!section.startsWith('m=audio')) return section;
    const payload = section.match(/^a=rtpmap:(\d+) opus\/48000/im)?.[1];
    if (!payload) return section;
    const pattern = new RegExp(`^a=fmtp:${payload} ([^\\r\\n]*)`, 'm');
    const existing = section.match(pattern);
    const params = new Map((existing?.[1] || '').split(';').filter(Boolean).map(part => {
      const [key, ...value] = part.trim().split('='); return [key, value.join('=')];
    }));
    for (const [key, value] of Object.entries({ useinbandfec: '1', usedtx: '1', stereo: '0', 'sprop-stereo': '0', maxaveragebitrate: '32000' })) params.set(key, value);
    const line = `a=fmtp:${payload} ${[...params].map(([key, value]) => `${key}=${value}`).join(';')}`;
    const eol = section.includes('\r\n') ? '\r\n' : '\n';
    return existing ? section.replace(pattern, line) : `${section}${section.endsWith('\n') ? '' : eol}${line}${eol}`;
  }).join('');
}

type Sample = Record<string, any>;
type Counter = { received: number; lost: number; concealed: number; samples: number };

export class AdaptiveCallQuality {
  private timer?: number;
  private stopped = false;
  private busy = false;
  private previous = new Map<string, Counter>();
  private sendLevel: QualityLevel = 0;
  private receiveLevel: QualityLevel = 0;
  private remoteLevel: QualityLevel = 0;
  private remoteUpdated = 0;
  private sendGood = 0;
  private receiveGood = 0;
  private level: QualityLevel = 0;
  private audioBad = 0;
  private audioGood = 0;
  private protectAudio = false;
  private remoteProtectAudio = false;
  private videoSuspended = false;
  private lastMediaPackets = -1;
  private lastExpectedMedia: 'audio' | 'video' | null = null;
  private stalledSamples = 0;

  constructor(private readonly options: {
    connection: RTCPeerConnection;
    screen?: () => RTCPeerConnection | undefined;
    onReceiveQuality: (level: QualityLevel, protectAudio: boolean) => void;
    onChange?: (level: QualityLevel, videoSuspended: boolean) => void;
    expectsMedia?: () => 'audio' | 'video' | null;
    onStall?: () => void;
  }) {}

  start() {
    void this.sample();
    this.timer = window.setInterval(() => void this.sample(), 2000);
  }

  stop() {
    this.stopped = true;
    if (this.timer !== undefined) window.clearInterval(this.timer);
    this.previous.clear();
  }

  remoteReceiveQuality(level: unknown, protectAudio: unknown = false) {
    if (this.stopped || !Number.isInteger(level) || Number(level) < 0 || Number(level) > 3) return;
    this.remoteLevel = level as QualityLevel;
    this.remoteProtectAudio = protectAudio === true;
    this.remoteUpdated = Date.now();
    // Apply on the next serialized sample so setParameters transactions cannot race.
  }

  private async sample() {
    if (this.stopped || this.busy) return;
    this.busy = true;
    try {
      const pc = this.options.connection;
      let send: QualityLevel = 0, receive: QualityLevel = 0, measured = false, audioTrouble = false, audioMeasured = false;
      if (typeof pc.getStats === 'function') {
        const report = await pc.getStats().catch(() => undefined);
        if (this.stopped) return;
        const rows: Sample[] = []; report?.forEach(row => rows.push(row));
        const encoders = rows.filter(row => row.type === 'outbound-rtp' && (row.kind || row.mediaType) === 'video' && typeof row.qualityLimitationReason === 'string');
        // A low BWE estimate while our encoder is intentionally capped/paused
        // is not evidence that the link is still congested. Otherwise the cap
        // can prevent probing and lock the call in low quality indefinitely.
        const bandwidthLimited = !encoders.length || encoders.some(row => row.qualityLimitationReason === 'bandwidth');
        // Use only the selected transport, never abandoned candidate pairs.
        const selected = new Set(rows.filter(row => row.type === 'transport').map(row => row.selectedCandidatePairId).filter(id => typeof id === 'string'));
        for (const row of rows) {
          if (row.type === 'candidate-pair' && row.state === 'succeeded' && (selected.size ? selected.has(row.id) : row.selected || row.nominated)) {
            measured = true;
            const rate = row.availableOutgoingBitrate;
            // With video paused, an audio-only bandwidth estimate can stay low
            // indefinitely. Clean audio/RTT allow a cautious low-video probe;
            // actual congestion immediately suspends that probe again.
            if (bandwidthLimited && typeof rate === 'number' && rate > 0 && !(this.level === 3 && rate < 90000)) send = Math.max(send, rate < 90000 ? 3 : rate < 160000 ? 2 : rate < 350000 ? 1 : 0) as QualityLevel;
            const rtt = row.currentRoundTripTime;
            // Long-distance RTT alone is not packet loss or a failed call.
            if (typeof rtt === 'number') send = Math.max(send, rtt > 1 ? 2 : rtt > .5 ? 1 : 0) as QualityLevel;
          }
          if (row.type === 'remote-inbound-rtp' && typeof row.fractionLost === 'number') {
            measured = true;
            send = Math.max(send, this.lossLevel(row.fractionLost)) as QualityLevel;
            if ((row.kind || row.mediaType) === 'audio') { audioMeasured = true; audioTrouble ||= row.fractionLost > .25; }
          }
          if (row.type !== 'inbound-rtp') continue;
          const current = { received: row.packetsReceived || 0, lost: row.packetsLost || 0, concealed: row.concealedSamples || 0, samples: row.totalSamplesReceived || 0 };
          const previous = this.previous.get(row.id); this.previous.set(row.id, current);
          if (!previous) continue;
          const received = current.received - previous.received, lost = Math.max(0, current.lost - previous.lost);
          if (received < 0 || received + lost <= 0) continue;
          measured = true;
          receive = Math.max(receive, this.lossLevel(lost / (received + lost))) as QualityLevel;
          if ((row.kind || row.mediaType) === 'audio') {
            const concealment = Math.max(0, current.concealed - previous.concealed) / Math.max(1, current.samples - previous.samples);
            receive = Math.max(receive, this.lossLevel(concealment)) as QualityLevel;
            audioMeasured = true;
            audioTrouble ||= lost / (received + lost) > .25 || concealment > .3;
            if (row.jitter > .12) receive = Math.max(receive, 2) as QualityLevel;
          }
        }
        const expected = this.options.expectsMedia?.() || null;
        if (expected !== this.lastExpectedMedia) { this.stalledSamples = 0; this.lastMediaPackets = -1; this.lastExpectedMedia = expected; }
        const media = expected ? rows.filter(row => row.type === 'inbound-rtp' && (row.kind || row.mediaType) === expected) : [];
        if (expected && report) {
          const packets = media.reduce((sum, row) => sum + (row.packetsReceived || 0), 0);
          this.stalledSamples = packets === this.lastMediaPackets ? this.stalledSamples + 1 : 0;
          this.lastMediaPackets = packets;
          if (this.stalledSamples >= 4) { this.stalledSamples = 0; this.options.onStall?.(); }
        } else { this.stalledSamples = 0; this.lastMediaPackets = -1; }
      }
      if (measured) {
        // Reduce immediately; recover only one step after 16 clean seconds.
        this.sendGood = send < this.sendLevel ? this.sendGood + 1 : 0;
        this.receiveGood = receive < this.receiveLevel ? this.receiveGood + 1 : 0;
        if (send >= this.sendLevel) this.sendLevel = send;
        else if (this.sendGood >= 8) { this.sendLevel = (this.sendLevel - 1) as QualityLevel; this.sendGood = 0; }
        if (receive >= this.receiveLevel) this.receiveLevel = receive;
        else if (this.receiveGood >= 8) { this.receiveLevel = (this.receiveLevel - 1) as QualityLevel; this.receiveGood = 0; }
        if (audioMeasured) {
          this.audioBad = audioTrouble ? this.audioBad + 1 : 0;
          this.audioGood = audioTrouble ? 0 : this.audioGood + 1;
          if (this.audioBad >= 3) this.protectAudio = true;
          if (this.audioGood >= 3) this.protectAudio = false;
        }
        this.options.onReceiveQuality(this.receiveLevel, this.protectAudio);
      }
      const remote = Date.now() - this.remoteUpdated < 15000 ? this.remoteLevel : 0;
      const next = Math.max(this.sendLevel, this.receiveLevel, remote) as QualityLevel;
      const suspend = this.protectAudio || (Date.now() - this.remoteUpdated < 15000 && this.remoteProtectAudio);
      if (next !== this.level || suspend !== this.videoSuspended) { this.level = next; this.videoSuspended = suspend; this.options.onChange?.(next, suspend); }
      for (const receiver of pc.getReceivers?.() || []) {
        if (receiver.track?.kind !== 'audio' || !('jitterBufferTarget' in receiver)) continue;
        // A small, bounded smoothing reserve only on unstable reception.
        try { const target = [null, 80, 120, 160][this.receiveLevel]; if (receiver.jitterBufferTarget !== target) receiver.jitterBufferTarget = target; } catch { /* Optional receiver API. */ }
      }
      const screen = this.options.screen?.();
      await this.configure(pc, false, Boolean(screen));
      if (screen && !this.stopped) await this.configure(screen, true, true);
    } catch { /* Missing stats/encoder knobs on older Safari must not break audio. */ }
    finally { this.busy = false; }
  }

  private lossLevel(loss: number): QualityLevel {
    return loss > .15 ? 3 : loss > .08 ? 2 : loss > .025 ? 1 : 0;
  }

  private async configure(pc: RTCPeerConnection, screen: boolean, sharing: boolean) {
    const profile = profiles[this.level];
    for (const sender of pc.getSenders()) {
      if (this.stopped || !sender.track || typeof sender.setParameters !== 'function') continue;
      const audio = sender.track.kind === 'audio';
      const params = sender.getParameters();
      if (!params.encodings?.length) continue; // Negotiation may still be in flight.
      const rate = audio ? (this.videoSuspended ? 24000 : 32000) : screen ? profile.screen : profile.video * (sharing ? .5 : 1);
      let changed = false;
      for (const encoding of params.encodings) {
        const desired = audio ? { maxBitrate: rate, priority: 'high', networkPriority: 'high' }
          : { maxBitrate: rate, active: !this.videoSuspended, maxFramerate: screen ? Math.min(10, profile.fps) : profile.fps, scaleResolutionDownBy: screen ? Math.min(2, profile.scale) : profile.scale, priority: 'low', networkPriority: 'low' };
        for (const [key, value] of Object.entries(desired)) {
          const settings = encoding as unknown as Record<string, unknown>;
          if (settings[key] !== value) { settings[key] = value; changed = true; }
        }
      }
      if (!audio && params.degradationPreference !== (screen ? 'maintain-resolution' : 'maintain-framerate')) {
        params.degradationPreference = screen ? 'maintain-resolution' : 'maintain-framerate'; changed = true;
      }
      if (!changed) continue;
      try { await sender.setParameters(params); }
      catch {
        if (this.stopped) return;
        // Some browsers reject optional priority/frame controls. Retain the
        // portable bitrate/active limits using a fresh transaction identifier.
        try {
          const basic = sender.getParameters();
          for (const encoding of basic.encodings || []) { encoding.maxBitrate = rate; if (!audio) encoding.active = !this.videoSuspended; }
          await sender.setParameters(basic);
        } catch { /* Native congestion control remains active. */ }
      }
    }
  }
}
