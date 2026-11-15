import type { Socket } from 'socket.io-client';

export type ClassroomOperation = { kind: string; relayId: string; [key: string]: unknown };
export class ClassroomRelay {
  private socket?: Socket;
  private closed = false;
  private ready = false;
  private sending = false;
  private queue: Array<{ operation: ClassroomOperation; bytes: number }> = [];
  private bytes = 0;
  private timer?: ReturnType<typeof setTimeout>;
  private reconnect?: ReturnType<typeof setTimeout>;
  get available() { return this.ready && !!this.socket?.connected; }
  constructor(private bookingId: string, portal: 'teachers' | 'students', private receive: (message: unknown) => void, private onReady: () => void) {
    void import('socket.io-client').then(({ io }) => {
      if (this.closed) return;
      this.socket = io(import.meta.env.VITE_API_URL || window.location.origin, { withCredentials: true, auth: { portal }, transports: ['websocket', 'polling'], tryAllTransports: true, forceNew: true });
      this.socket.on('connect', () => {
        this.socket?.timeout(5000).emit('classroom:join', { bookingId }, () => undefined);
      });
      this.socket.on('classroom:ready', (state: { bookingId: string; ready: boolean }) => {
        if (state.bookingId !== bookingId) return;
        const before = this.ready; this.ready = state.ready;
        if (this.ready) { this.schedule(0); if (!before) this.onReady(); }
      });
      this.socket.on('classroom:operations', (payload: { bookingId: string; operations: ClassroomOperation[] }, ack?: (response: { received: boolean }) => void) => {
        if (this.closed || payload?.bookingId !== bookingId || !Array.isArray(payload.operations)) return ack?.({ received: false });
        try { for (const operation of payload.operations) this.receive(operation); ack?.({ received: true }); }
        catch { ack?.({ received: false }); }
      });
      this.socket.on('disconnect', reason => {
        this.ready = false;
        if (reason === 'io server disconnect' && !this.closed) this.reconnect = setTimeout(() => this.socket?.connect(), 1000);
      });
    }).catch(() => undefined); // Existing direct transport continues if unavailable.
  }
  send(operation: ClassroomOperation) {
    if (this.closed) return;
    const bytes = new TextEncoder().encode(JSON.stringify(operation)).length;
    if (bytes > 500 * 1024 || this.bytes + bytes > 4 * 1024 * 1024) return;
    // Viewport updates describe only the latest position, unlike durable edits.
    if (operation.kind === 'document-view') {
      let index = -1;
      for (let i = this.queue.length - 1; i >= (this.sending ? 32 : 0); i--) if (this.queue[i].operation.kind === 'document-view') { index = i; break; }
      if (index >= 0) { this.bytes -= this.queue[index].bytes; this.queue.splice(index, 1); }
    }
    this.queue.push({ operation, bytes }); this.bytes += bytes; this.schedule(100);
  }
  private schedule(delay: number) {
    if (this.closed || this.timer || this.sending) return;
    this.timer = setTimeout(() => { this.timer = undefined; this.flush(); }, delay);
  }
  private flush() {
    if (this.closed || !this.ready || !this.socket?.connected || this.sending || !this.queue.length) return;
    const batch: typeof this.queue = []; let bytes = 0;
    for (const entry of this.queue) { if (batch.length === 32 || bytes + entry.bytes > 500 * 1024) break; batch.push(entry); bytes += entry.bytes; }
    this.sending = true;
    this.socket.timeout(6000).emit('classroom:operations', { bookingId: this.bookingId, operations: batch.map(entry => entry.operation) }, (error: Error | null, result?: { delivered?: boolean; rejected?: boolean }) => {
      this.sending = false;
      if (this.closed) return;
      if (!error && (result?.delivered || result?.rejected)) { this.queue.splice(0, batch.length); this.bytes -= bytes; }
      this.schedule(!error && result?.delivered ? 0 : 1000);
    });
  }
  close() {
    this.closed = true; clearTimeout(this.timer); clearTimeout(this.reconnect);
    this.socket?.disconnect(); this.queue = []; this.bytes = 0;
  }
}
