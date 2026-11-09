import { parse, renderSlideToSvg } from '@web-ppt/core';

let presentation: Awaited<ReturnType<typeof parse>> | undefined;
self.onmessage = async (event: MessageEvent<{ id: number; file?: File; page?: number }>) => {
  const { id, file, page } = event.data;
  try {
    if (file) {
      presentation?.dispose?.();
      presentation = await parse(file, { lazy: true, embeddedFonts: 'source' });
      self.postMessage({ id, pages: presentation.slides.length });
    } else if (presentation && page) {
      let svg = renderSlideToSvg(presentation, presentation.slides[page - 1], { textMode: 'svg' });
      // A standalone page must carry its images: blob URLs created in the worker
      // cannot be embedded as external references inside another SVG image.
      const assets = [...new Set(svg.match(/blob:[^"'\s<>]+/g) || [])];
      for (const url of assets) {
        const blob = await (await fetch(url)).blob(), data = new Uint8Array(await blob.arrayBuffer());
        let binary = '';
        for (let start = 0; start < data.length; start += 8192) binary += String.fromCharCode(...data.subarray(start, start + 8192));
        svg = svg.replaceAll(url, `data:${blob.type || 'image/png'};base64,${btoa(binary)}`);
      }
      self.postMessage({ id, src: `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}` });
    }
  } catch (error) { self.postMessage({ id, error: error instanceof Error ? error.message : 'Unable to open presentation' }); }
};
