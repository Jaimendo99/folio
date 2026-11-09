import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { PDFViewer } from "./viewer";
import { Icon } from "./icons";

/** The stamp's default size in PDF points, as drawn by the desktop shell (electron/digital-signature.cjs). */
const STAMP_WIDTH = 220, STAMP_HEIGHT = 70;
const ASPECT = STAMP_WIDTH / STAMP_HEIGHT;
const MIN_WIDTH = 90;

/** PDF user space: [left, bottom, right, top]. */
type Rect = [number, number, number, number];
interface PageGeometry {
  div: HTMLElement;
  viewport: { width: number; height: number; viewBox: number[]; convertToPdfPoint(x: number, y: number): number[];
    convertToViewportPoint(x: number, y: number): number[] };
}

function geometry(viewer: PDFViewer, pageNumber: number): PageGeometry | null {
  const view = viewer.getPageView(pageNumber - 1);
  return view?.div && view.viewport ? { div: view.div, viewport: view.viewport } : null;
}

/** A point on the screen in the page's PDF coordinates, at whatever zoom the page is shown (kept on the page). */
function pdfPoint({ div, viewport }: PageGeometry, clientX: number, clientY: number) {
  const box = div.getBoundingClientRect();
  const fractionX = Math.max(0, Math.min(1, (clientX - box.left - div.clientLeft) / div.clientWidth));
  const fractionY = Math.max(0, Math.min(1, (clientY - box.top - div.clientTop) / div.clientHeight));
  return viewport.convertToPdfPoint(fractionX * viewport.width, fractionY * viewport.height);
}

/** Moves `rect` (shrinking it if needed) so it lies inside the page. */
function inside(rect: Rect, view: number[]): Rect {
  const width = Math.min(rect[2] - rect[0], view[2] - view[0]);
  const height = Math.min(rect[3] - rect[1], view[3] - view[1], width / ASPECT);
  const left = Math.max(view[0], Math.min(rect[0], view[2] - width));
  const bottom = Math.max(view[1], Math.min(rect[1], view[3] - height));
  return [left, bottom, left + height * ASPECT, bottom + height];
}

const around = ([x, y]: number[], width: number, view: number[]): Rect =>
  inside([x - width / 2, y - width / ASPECT / 2, x + width / 2, y + width / ASPECT / 2], view);

/**
 * Places the digital signature stamp on a page: a box over the document that can be dragged, resized from its corner
 * (keeping the stamp's proportions), nudged with the arrow keys, or moved by clicking elsewhere on any page. The box is
 * kept in PDF points, so zooming or resizing the window leaves it where it was put. Rotated pages aren't supported:
 * the stamp is drawn upright in the page's own coordinates.
 */
export function StampPlacement({ viewer, container, pageNumber, suggestion, signer, busy, error, onSign, onBack, onCancel }: {
  viewer: PDFViewer; container: HTMLElement; pageNumber: number;
  /** A spot to start from (PDF points on `pageNumber`), e.g. next to a "Signature" label. */
  suggestion?: number[];
  signer: string; busy: boolean; error: string;
  onSign: (pageNumber: number, rect: number[]) => void; onBack: () => void; onCancel: () => void;
}) {
  const [place, setPlace] = useState<{ page: number; rect: Rect } | null>(null);
  const [, setLayout] = useState(0);
  const boxRef = useRef<HTMLDivElement>(null);
  const placeRef = useRef(place);
  placeRef.current = place;
  const busyRef = useRef(busy);
  busyRef.current = busy;
  const cancelRef = useRef(onCancel);
  cancelRef.current = onCancel;

  // Start on the page being read: next to a suggested spot, or in the middle of the part of the page in view.
  useLayoutEffect(() => {
    const page = geometry(viewer, pageNumber);
    if (!page) return;
    const view = page.viewport.viewBox;
    const width = Math.min(STAMP_WIDTH, (view[2] - view[0]) * 0.9);
    if (suggestion?.length === 4) {
      setPlace({ page: pageNumber, rect: inside([suggestion[0], suggestion[1], suggestion[0] + width, suggestion[1] + width / ASPECT], view) });
    } else {
      const shown = page.div.getBoundingClientRect(), frame = container.getBoundingClientRect();
      const x = (Math.max(shown.left, frame.left) + Math.min(shown.right, frame.right)) / 2;
      const y = (Math.max(shown.top, frame.top) + Math.min(shown.bottom, frame.bottom)) / 2;
      setPlace({ page: pageNumber, rect: around(pdfPoint(page, x, y), width, view) });
    }
    requestAnimationFrame(() => boxRef.current?.focus({ preventScroll: true }));
  }, [viewer, container, pageNumber, suggestion]);

  // Zoom, the sidebar or the window size move the page; follow it.
  const page = place && geometry(viewer, place.page);
  useEffect(() => {
    if (!page) return;
    const observer = new ResizeObserver(() => setLayout(count => count + 1));
    observer.observe(container); observer.observe(page.div);
    return () => observer.disconnect();
  }, [container, page?.div]);

  // The document doesn't react to the pointer while the stamp is being placed: no text selection, links or tools.
  useEffect(() => {
    let drag: { pointerId: number; resize: boolean; page: number; origin: Rect; from: number[] } | null = null;
    const listeners = new AbortController();
    const options = { capture: true, signal: listeners.signal };
    window.addEventListener("pointerdown", event => {
      const target = event.target as Element;
      // The container itself is hit only on its scrollbars, which keep working.
      if (!container.contains(target) || target === container) return;
      event.preventDefault(); event.stopPropagation();
      const current = placeRef.current;
      if (!current || busyRef.current || !event.isPrimary || event.button !== 0) return;
      let { page: pageNumber, rect } = current;
      if (!target.closest(".stamp-box")) {
        const pageElement = target.closest<HTMLElement>(".page[data-page-number]");
        const clicked = pageElement && geometry(viewer, Number(pageElement.dataset.pageNumber));
        if (!clicked) return;
        pageNumber = Number(pageElement.dataset.pageNumber);
        rect = around(pdfPoint(clicked, event.clientX, event.clientY), rect[2] - rect[0], clicked.viewport.viewBox);
        setPlace({ page: pageNumber, rect });
      }
      const onPage = geometry(viewer, pageNumber)!;
      drag = { pointerId: event.pointerId, resize: !!target.closest(".stamp-resize"), page: pageNumber, origin: rect,
        from: pdfPoint(onPage, event.clientX, event.clientY) };
      boxRef.current?.focus({ preventScroll: true });
    }, options);
    window.addEventListener("pointermove", event => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      const onPage = geometry(viewer, drag.page);
      if (!onPage) return;
      const view = onPage.viewport.viewBox;
      const [x, y] = pdfPoint(onPage, event.clientX, event.clientY);
      const [left, bottom, right, top] = drag.origin;
      if (drag.resize) {
        // The top-left corner stays put; the width follows whichever way the pointer went further.
        const width = Math.max(MIN_WIDTH, Math.min(Math.max(x - left, (top - y) * ASPECT), view[2] - left, (top - view[1]) * ASPECT));
        setPlace({ page: drag.page, rect: [left, top - width / ASPECT, left + width, top] });
      } else {
        const dx = x - drag.from[0], dy = y - drag.from[1];
        setPlace({ page: drag.page, rect: inside([left + dx, bottom + dy, right + dx, top + dy], view) });
      }
    }, options);
    const end = (event: PointerEvent) => { if (drag?.pointerId === event.pointerId) drag = null; };
    window.addEventListener("pointerup", end, options);
    window.addEventListener("pointercancel", end, options);
    window.addEventListener("click", event => {
      if (container.contains(event.target as Node)) { event.preventDefault(); event.stopPropagation(); }
    }, options);
    window.addEventListener("keydown", event => {
      if (event.key === "Escape" && !busyRef.current) { event.preventDefault(); cancelRef.current(); }
    }, options);
    return () => listeners.abort();
  }, [viewer, container]);

  const nudge = (event: React.KeyboardEvent) => {
    if (!place || !page || busy) return;
    const step = event.shiftKey ? 10 : 2;
    const moves: Record<string, number[]> = { ArrowLeft: [-step, 0], ArrowRight: [step, 0], ArrowUp: [0, step], ArrowDown: [0, -step] };
    const view = page.viewport.viewBox;
    const [left, bottom, right, top] = place.rect;
    if (moves[event.key]) {
      const [dx, dy] = moves[event.key];
      setPlace({ page: place.page, rect: inside([left + dx, bottom + dy, right + dx, top + dy], view) });
    } else if (event.key === "+" || event.key === "=" || event.key === "-") {
      const width = Math.max(MIN_WIDTH, right - left + (event.key === "-" ? -10 : 10));
      setPlace({ page: place.page, rect: inside([left, top - width / ASPECT, left + width, top], view) });
    } else if (event.key === "Enter") {
      onSign(place.page, place.rect);
    } else return;
    event.preventDefault();
  };

  let style: React.CSSProperties | null = null;
  if (place && page) {
    const { div, viewport } = page;
    const [a, b] = viewport.convertToViewportPoint(place.rect[0], place.rect[1]);
    const [c, d] = viewport.convertToViewportPoint(place.rect[2], place.rect[3]);
    const frame = container.getBoundingClientRect(), shown = div.getBoundingClientRect();
    const scaleX = div.clientWidth / viewport.width, scaleY = div.clientHeight / viewport.height;
    const height = Math.abs(d - b) * scaleY;
    style = {
      left: shown.left - frame.left + container.scrollLeft + div.clientLeft + Math.min(a, c) * scaleX,
      top: shown.top - frame.top + container.scrollTop + div.clientTop + Math.min(b, d) * scaleY,
      width: Math.abs(c - a) * scaleX, height, fontSize: Math.max(6, height / 6),
    };
  }

  return <>
    {style && createPortal(<div ref={boxRef} className="stamp-box" style={style} tabIndex={0} role="img" data-busy={busy || undefined}
      aria-label={`Signature stamp on page ${place!.page}. Drag to move, or use the arrow keys. Press + or - to resize.`}
      onKeyDown={nudge}>
      <span className="stamp-qr" aria-hidden="true" />
      <span className="stamp-text" aria-hidden="true"><small>Signed digitally by</small><strong>{signer}</strong></span>
      <span className="stamp-resize" aria-hidden="true" title="Drag to resize" />
    </div>, container)}
    <div className="stamp-placement-bar" role="region" aria-label="Place the stamp">
      <div className="stamp-placement-text">
        <strong>Place the stamp on page {place?.page ?? pageNumber}</strong>
        <span>Drag it where it goes, or click the page. Drag the corner to resize.</span>
        {error && <span className="form-error" role="alert">{error}</span>}
      </div>
      <div className="form-actions">
        <button className="btn ghost" disabled={busy} onClick={onBack}>Back</button>
        <button className="btn ghost" disabled={busy} onClick={onCancel} title="Cancel (Esc)">Cancel</button>
        <button className="btn primary" disabled={busy || !place} onClick={() => place && onSign(place.page, place.rect)}>
          <Icon name="check" size={15} />{busy ? "Signing..." : "Sign"}</button>
      </div>
    </div>
  </>;
}
