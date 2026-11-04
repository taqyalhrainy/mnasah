export type DocumentView = { zoom: number; x: number; y: number };
export type SurfaceSize = { width: number; height: number };
export const fitDocumentView: DocumentView = { zoom: 1, x: 0, y: 0 };
export function constrainDocumentView(view: DocumentView, page: SurfaceSize, surface: SurfaceSize): DocumentView {
  const zoom = Math.max(1, Math.min(6, view.zoom));
  const maxX = Math.max(0, (page.width * zoom - surface.width + 28) / 2);
  const maxY = Math.max(0, (page.height * zoom - surface.height + 28) / 2);
  return { zoom, x: Math.max(-maxX, Math.min(maxX, view.x)), y: Math.max(-maxY, Math.min(maxY, view.y)) };
}
export function zoomDocumentView(view: DocumentView, factor: number, anchor: { x: number; y: number }, page: SurfaceSize, surface: SurfaceSize): DocumentView {
  const zoom = Math.max(1, Math.min(6, view.zoom * factor));
  const scale = zoom / view.zoom;
  return constrainDocumentView({ zoom, x: anchor.x - (anchor.x - view.x) * scale, y: anchor.y - (anchor.y - view.y) * scale }, page, surface);
}
