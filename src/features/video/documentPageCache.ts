type Page = { local: string; shared?: string };
type Upload = { page: number; resolve: (src: string) => void; reject: (error: unknown) => void };

/** Bounded, per-file previews. Rendering never waits for an HTTP upload. */
export class DocumentPageCache {
  private pages = new Map<number, Page>();
  private rendering = new Map<number, Promise<string>>();
  private sharing = new Map<number, Promise<string>>();
  private queue: Upload[] = [];
  private uploading = false;
  private closed = false;
  private warmRevision = 0;
  constructor(private options: {
    count: number;
    render: (page: number) => Promise<string>;
    publish: (src: string, page: number) => Promise<string>;
    onReady: (src: string, page: number) => void;
    limit?: number;
  }) {}

  async local(page: number): Promise<string> {
    if (this.closed) throw new Error('Document closed');
    const cached = this.pages.get(page);
    if (cached) { this.touch(page, cached); return cached.local; }
    let pending = this.rendering.get(page);
    if (!pending) {
      pending = this.options.render(page).then(src => {
        if (this.closed) throw new Error('Document closed');
        this.touch(page, { local: src }); return src;
      }).finally(() => this.rendering.delete(page));
      this.rendering.set(page, pending);
    }
    return pending;
  }

  share(page: number, foreground = true): Promise<string> {
    if (this.closed) return Promise.reject(new Error('Document closed'));
    const ready = this.pages.get(page)?.shared;
    if (ready) return Promise.resolve(ready);
    const pending = this.sharing.get(page);
    if (pending) {
      if (foreground) { const index = this.queue.findIndex(job => job.page === page); if (index > 0) this.queue.unshift(...this.queue.splice(index, 1)); }
      return pending;
    }
    const promise = new Promise<string>((resolve, reject) => {
      const job = { page, resolve, reject };
      if (foreground) this.queue.unshift(job); else this.queue.push(job);
    }).finally(() => this.sharing.delete(page));
    this.sharing.set(page, promise); void this.drain(); return promise;
  }

  warm(around: number) {
    const revision = ++this.warmRevision;
    void (async () => {
      for (const page of [around + 1, around - 1, around + 2, around - 2]) {
        if (revision !== this.warmRevision || this.closed) return;
        if (page < 1 || page > this.options.count) continue;
        try { await this.local(page); if (revision !== this.warmRevision || this.closed) return; await this.share(page, false); } catch { /* The visible page can retry failed warm-up work. */ }
      }
    })();
  }

  dispose() {
    this.closed = true; this.warmRevision++;
    this.pages.clear(); this.rendering.clear();
    for (const job of this.queue.splice(0)) job.reject(new Error('Document closed'));
  }

  private touch(page: number, value: Page) {
    this.pages.delete(page); this.pages.set(page, value);
    while (this.pages.size > (this.options.limit || 8)) this.pages.delete(this.pages.keys().next().value!);
  }

  private async drain() {
    if (this.uploading || this.closed) return;
    this.uploading = true;
    try {
      while (this.queue.length && !this.closed) {
        const job = this.queue.shift()!;
        try {
          const local = await this.local(job.page);
          const src = await this.options.publish(local, job.page);
          if (this.closed) throw new Error('Document closed');
          const entry = this.pages.get(job.page);
          if (entry) entry.shared = src;
          this.options.onReady(src, job.page); job.resolve(src);
        } catch (error) { job.reject(error); }
      }
    } finally { this.uploading = false; }
  }
}
