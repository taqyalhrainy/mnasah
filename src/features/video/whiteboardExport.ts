import { apiMediaUrl } from '../../services/platformApi';

type Point = { x: number; y: number };
type Stroke = { points: Point[]; color: string; size: number };
type BoardItem = { type: 'image' | 'text'; x: number; y: number; width: number; height: number; opacity?: number; src?: string; fit?: 'contain' | 'cover'; borderRadius?: number; text?: string; color?: string; fontSize?: number; fontFamily?: string; fontWeight?: number; fontStyle?: string; textAlign?: 'start' | 'center' | 'end'; background?: string };

async function loadImage(src: string) {
  // Blob/data URLs keep authenticated images exportable without external SVG resources.
  const response = await fetch(apiMediaUrl(src), { credentials: 'include' });
  if (!response.ok) throw new Error('Image unavailable');
  const url = URL.createObjectURL(await response.blob());
  try {
    return await new Promise<HTMLImageElement>((resolve, reject) => {
      const image = new Image(); image.onload = () => resolve(image); image.onerror = () => reject(new Error('Image unavailable')); image.src = url;
    });
  } finally { URL.revokeObjectURL(url); }
}

export async function whiteboardPng({ view, items, strokes }: { view: { x: number; y: number; width: number; height: number }; items: BoardItem[]; strokes: Stroke[] }): Promise<Blob> {
  const canvas = document.createElement('canvas');
  const scale = 2048 / Math.max(view.width, view.height);
  canvas.width = Math.max(1, Math.round(view.width * scale)); canvas.height = Math.max(1, Math.round(view.height * scale));
  const context = canvas.getContext('2d');
  if (!context) throw new Error('Canvas unavailable');
  await document.fonts?.ready;
  const images = await Promise.all(items.map(item => item.type === 'image' && item.src ? loadImage(item.src) : null));
  context.fillStyle = '#fff'; context.fillRect(0, 0, canvas.width, canvas.height);
  context.scale(scale, scale); context.translate(-view.x, -view.y);
  // Render the model directly: foreignObject and SVG-only downloads fail in Photos/Safari.
  items.forEach((item, index) => {
    context.save(); context.globalAlpha = item.opacity ?? 1;
    context.beginPath(); context.roundRect(item.x, item.y, item.width, item.height, Math.min(item.borderRadius || 0, item.width / 2, item.height / 2)); context.clip();
    const image = images[index];
    if (image) {
      const ratio = item.fit === 'cover' ? Math.max(item.width / image.naturalWidth, item.height / image.naturalHeight) : Math.min(item.width / image.naturalWidth, item.height / image.naturalHeight);
      const width = image.naturalWidth * ratio, height = image.naturalHeight * ratio;
      context.drawImage(image, item.x + (item.width - width) / 2, item.y + (item.height - height) / 2, width, height);
    } else if (item.type === 'text') {
      if (item.background) { context.fillStyle = item.background; context.fillRect(item.x, item.y, item.width, item.height); }
      const size = item.fontSize || 28;
      context.font = `${item.fontStyle || 'normal'} ${item.fontWeight || 400} ${size}px ${item.fontFamily || 'Tajawal, Arial, sans-serif'}`;
      context.fillStyle = item.color || '#171717'; context.textBaseline = 'top';
      let y = item.y + 6;
      for (const paragraph of (item.text || '').split('\n')) {
        const rtl = /[\u0600-\u06ff]/.test(paragraph);
        context.direction = rtl ? 'rtl' : 'ltr';
        context.textAlign = item.textAlign === 'center' ? 'center' : item.textAlign === 'end' ? (rtl ? 'left' : 'right') : rtl ? 'right' : 'left';
        const x = context.textAlign === 'center' ? item.x + item.width / 2 : context.textAlign === 'right' ? item.x + item.width - 6 : item.x + 6;
        let line = '';
        const draw = () => { context.fillText(line, x, y); y += size * 1.35; };
        for (const word of paragraph.split(' ')) {
          const next = line ? `${line} ${word}` : word;
          if (line && context.measureText(next).width > item.width - 12) { draw(); line = word; } else line = next;
        }
        draw();
      }
    }
    context.restore();
  });
  for (const stroke of strokes) {
    if (!stroke.points.length) continue;
    context.fillStyle = context.strokeStyle = stroke.color; context.lineWidth = stroke.size * 2; context.lineCap = context.lineJoin = 'round'; context.beginPath();
    if (stroke.points.length === 1) { context.arc(stroke.points[0].x, stroke.points[0].y, stroke.size, 0, Math.PI * 2); context.fill(); }
    else { stroke.points.forEach((point, index) => index ? context.lineTo(point.x, point.y) : context.moveTo(point.x, point.y)); context.stroke(); }
  }
  return new Promise((resolve, reject) => canvas.toBlob(blob => { canvas.width = canvas.height = 1; if (blob) resolve(blob); else reject(new Error('PNG export failed')); }, 'image/png'));
}

export function downloadBoardImage(file: File) {
  const url = URL.createObjectURL(file), anchor = document.createElement('a');
  anchor.href = url; anchor.download = file.name; document.body.append(anchor); anchor.click(); anchor.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 60000);
}
