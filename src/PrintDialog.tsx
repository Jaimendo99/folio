import { locale, translateKnownUi, translateUi } from "./i18n";
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import type { PDFDocumentProxy } from "./pdf";
import { Modal } from "./Dialogs";
import { DEFAULT_PRINT, parsePages, planSheets, checkPrintBudget, overlapFromPoints, overlapToPoints, type OverlapUnit, type PageSize, type PrintSettings } from "./printLayout";
import { renderPrintSheet, encodePrintSheet } from "./printRender";
import "./print.css";

const previewStyle = (size?: PageSize): CSSProperties => ({
  "--print-ratio": size ? size.width / size.height : 8.5 / 11,
} as CSSProperties);

function dimensions(size: PageSize) {
  return [size.width, size.height].map(points => (points / 72).toLocaleString(locale(), { maximumFractionDigits: 2 })).join(" × ") + " " + translateUi("in");
}

function BasicPrint({ pdf, currentPage, onPrint }: { pdf: PDFDocumentProxy; currentPage: number; onPrint: () => void }) {
  const [number, setNumber] = useState(currentPage);
  const [preview, setPreview] = useState<{ number: number; size: PageSize; url: string } | null>(null);
  const [failedPage, setFailedPage] = useState<number | null>(null);
  useEffect(() => {
    const controller = new AbortController();
    const { signal } = controller;
    void (async () => {
      const page = await pdf.getPage(number);
      signal.throwIfAborted();
      const { width, height } = page.getViewport({ scale: 1 });
      const size = { width, height };
      const clip = { x: 0, y: 0, width, height };
      const sheet = { ...size, placements: [{ ...clip, clip, page: number, scale: 1 }] };
      // Only the visible thumbnail is rasterized. Print hands off the complete PDF snapshot.
      const canvas = await renderPrintSheet(pdf, sheet, DEFAULT_PRINT, 900 * 72 / Math.max(width, height), signal);
      try {
        if (!signal.aborted) setPreview({ number, size, url: canvas.toDataURL() });
      } finally { canvas.width = canvas.height = 0; }
    })().catch(() => { if (!signal.aborted) setFailedPage(number); });
    return () => controller.abort();
  }, [pdf, number]);
  const visible = preview?.number === number ? preview : null;
  return <div className="print-basic" style={previewStyle(preview?.size)}>
    <div className="print-paper">
      {visible ? <img src={visible.url} alt={translateUi("Preview of page {v0}", { v0: number })} /> :
        <p>{failedPage === number ? translateUi("Preview unavailable.") : translateUi("Preparing preview…")}</p>}
    </div>
    <div className="print-preview-nav">
      <button className="pill-btn" aria-label={translateUi("Previous page")} disabled={number === 1} onClick={() => setNumber(number - 1)}>‹</button>
      <span aria-live="polite">{translateUi("Page")} {number} {translateUi("of")} {pdf.numPages}{visible && " · " + dimensions(visible.size)}</span>
      <button className="pill-btn" aria-label={translateUi("Next page")} disabled={number === pdf.numPages} onClick={() => setNumber(number + 1)}>›</button>
    </div>
    <div className="print-footer"><p className="print-hint">{translateUi("Choose your printer, pages, and copies in the system dialog.")}</p>
      <button className="btn primary" onClick={onPrint}>{translateUi("Print…")}</button></div>
  </div>;
}

export function PrintDialog({ pdf, currentPage, name, onPrint, onClose }: {
  pdf: PDFDocumentProxy; currentPage: number; name: string; onPrint: () => void; onClose: () => void;
}) {
  const [advanced, setAdvanced] = useState(false);
  const [settings, setSettings] = useState(DEFAULT_PRINT);
  const [overlapUnit, setOverlapUnit] = useState<OverlapUnit>("in");
  const [selection, setSelection] = useState("all");
  const [range, setRange] = useState("");
  const [copies, setCopies] = useState(1);
  const [printers, setPrinters] = useState<{ name: string; displayName: string; isDefault: boolean }[]>([]);
  const [printer, setPrinter] = useState("");
  const [sizes, setSizes] = useState<PageSize[]>([]);
  const [sheetIndex, setSheetIndex] = useState(0);
  const [preview, setPreview] = useState("");
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [progress, setProgress] = useState("");
  const root = useRef<HTMLDivElement>(null);
  const job = useRef<AbortController | null>(null);
  const handingOff = useRef(false);
  const update = <K extends keyof PrintSettings>(key: K, value: PrintSettings[K]) => setSettings(s => ({ ...s, [key]: value }));
  useEffect(() => {
    const oldFocus = document.activeElement as HTMLElement | null;
    const dialog = root.current!.closest<HTMLElement>(".modal")!;
    dialog.querySelector<HTMLElement>("select,button")?.focus();
    const trap = (event: KeyboardEvent) => {
      if (event.key !== "Tab") return;
      const controls = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled),input:not(:disabled),select:not(:disabled),summary,[tabindex='0']")]
        .filter(control => control.checkVisibility() && control.tabIndex >= 0);
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && document.activeElement === first) { event.preventDefault(); last?.focus(); }
      if (!event.shiftKey && document.activeElement === last) { event.preventDefault(); first?.focus(); }
    };
    dialog.addEventListener("keydown", trap);
    return () => { job.current?.abort(); dialog.removeEventListener("keydown", trap); oldFocus?.focus(); };
  }, []);
  useEffect(() => {
    if (!advanced || sizes.length) return;
    let cancelled = false;
    void (async () => {
      const result: PageSize[] = [];
      for (let n = 1; n <= pdf.numPages; n++) {
        if (cancelled) return;
        const page = await pdf.getPage(n), size = page.getViewport({ scale: 1 });
        result.push({ width: size.width, height: size.height });
      }
      if (!cancelled) setSizes(result);
    })().catch(() => { if (!cancelled) setError(translateUi("Couldn't read page sizes.")); });
    return () => { cancelled = true; };
  }, [pdf, advanced, sizes.length]);
  useEffect(() => {
    if (!advanced) return;
    let cancelled = false;
    void window.folioDesktop?.getPrinters().then(result => {
      if (!cancelled) setPrinters(result);
    }).catch(() => { if (!cancelled) setMessage(translateUi("Printer list unavailable. Choose a printer in the system dialog.")); });
    return () => { cancelled = true; };
  }, [advanced]);

  const layout = useMemo(() => {
    if (!advanced || !sizes.length) return { sheets: [], error: "" };
    try {
      const pages = selection === "current" ? [currentPage] : selection === "range" ? parsePages(range, pdf.numPages) : sizes.map((_, i) => i + 1);
      return { sheets: planSheets(pages, sizes, settings), error: "" };
    } catch (e) { return { sheets: [], error: (e as Error).message }; }
  }, [advanced, sizes, selection, currentPage, range, pdf.numPages, settings]);
  const index = Math.min(sheetIndex, Math.max(0, layout.sheets.length - 1));
  const sheet = layout.sheets[index];
  const budgetError = useMemo(() => {
    try { checkPrintBudget(layout.sheets, settings.dpi); return ""; }
    catch (error) { return (error as Error).message; }
  }, [layout.sheets, settings.dpi]);
  useEffect(() => {
    const controller = new AbortController();
    setPreview("");
    if (sheet) void renderPrintSheet(pdf, sheet, settings, 38, controller.signal).then(canvas => {
      if (!controller.signal.aborted) setPreview(canvas.toDataURL());
      canvas.width = canvas.height = 0;
    }).catch(() => { if (!controller.signal.aborted) setError(translateUi("Couldn't render the print preview.")); });
    return () => controller.abort();
  }, [pdf, sheet, settings]);

  const submit = async () => {
    if (!window.folioDesktop || busy || budgetError || !layout.sheets.length || copies < 1 || copies > 999 || !Number.isInteger(copies)) return;
    const controller = new AbortController(); job.current = controller;
    setBusy(true); setError(""); setMessage("");
    try {
      const images: string[] = []; let bytes = 0;
      for (let i = 0; i < layout.sheets.length; i++) {
        setProgress(translateUi("Preparing sheet {v0} of {v1}…", { v0: i + 1, v1: layout.sheets.length }));
        const canvas = await renderPrintSheet(pdf, layout.sheets[i], settings, settings.dpi, controller.signal,
          layout.sheets[0].width > layout.sheets[0].height);
        let image: string;
        try { image = await encodePrintSheet(canvas, controller.signal); }
        finally { canvas.width = canvas.height = 0; }
        bytes += image.length;
        if (bytes > 64 * 1024 * 1024) throw new Error(translateUi("This job exceeds 64 MiB of encoded images. Select fewer pages, reduce poster scale/overlap, or choose a lower DPI."));
        images.push(image);
      }
      controller.signal.throwIfAborted();
      handingOff.current = true;
      setProgress(translateUi("Waiting for the system print dialog…"));
      const result = await window.folioDesktop.printSheets({ images, paper: settings.paper, dpi: settings.dpi,
        landscape: layout.sheets[0].width > layout.sheets[0].height, copies, printer, booklet: settings.mode === "booklet" });
      if (controller.signal.aborted) return;
      if (result.ok) { setMessage(translateUi("Print job accepted by the system.")); }
      else if (/cancel/i.test(result.error ?? "")) setMessage(translateUi("Printing cancelled."));
      else setError(result.error || translateUi("Couldn't print. Check the selected printer."));
    } catch (e) { if (!controller.signal.aborted) setError((e as Error).message); }
    finally { if (job.current === controller) { job.current = null; handingOff.current = false; setBusy(false); setProgress(""); } }
  };
  const close = () => { if (!busy) onClose(); else if (!handingOff.current) { job.current?.abort(); setProgress(translateUi("Cancelling preparation…")); } };
  return <Modal title={translateUi("Print")} onClose={close}>
    <div className="print-dialog" ref={root}>
      <div className="print-tabs" role="tablist" aria-label={translateUi("Print settings")}>{["Basic", "Advanced"].map(tab =>
        <button key={tab} role="tab" id={`print-tab-${tab}`} aria-controls="print-panel" aria-selected={advanced === (tab === "Advanced")}
          tabIndex={advanced === (tab === "Advanced") ? 0 : -1} disabled={busy} onClick={() => setAdvanced(tab === "Advanced")}
          onKeyDown={event => {
            if (event.altKey || !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) return;
            event.preventDefault();
            const next = event.key === "Home" ? false : event.key === "End" ? true : !advanced;
            setAdvanced(next); root.current?.querySelector<HTMLElement>(`#print-tab-${next ? "Advanced" : "Basic"}`)?.focus();
          }}>{translateKnownUi(tab)}</button>)}</div>
      <div id="print-panel" role="tabpanel" aria-labelledby={`print-tab-${advanced ? "Advanced" : "Basic"}`}>
        <p className="print-filename" title={name}><strong>{name}</strong><span>{pdf.numPages} {pdf.numPages === 1 ? "page" : "pages"}</span></p>
        {!advanced ? <BasicPrint pdf={pdf} currentPage={currentPage} onPrint={onPrint} /> : <>
          <div className="print-columns">
            <fieldset disabled={busy} className="print-options">
              <section><h3>{translateUi("Layout")}</h3><div className="print-modes" role="group" aria-label={translateUi("Layout")}>
                {(["size", "poster", "multiple", "booklet"] as const).map(mode => <button key={mode} type="button" aria-pressed={settings.mode === mode} onClick={() => update("mode", mode)}>{translateKnownUi({ size: "Single page", poster: "Poster", multiple: "Pages per sheet", booklet: "Booklet" }[mode])}</button>)}
              </div>
              {settings.mode === "size" && <label className="print-inline">{translateUi("Sizing")}
                <select value={settings.sizing} onChange={e => update("sizing", e.target.value as PrintSettings["sizing"])}>
                  <option value="fit">{translateUi("Fit to page")}</option><option value="actual">{translateUi("Actual size")}</option>
                  <option value="shrink">{translateUi("Shrink oversized pages")}</option><option value="custom">{translateUi("Custom scale")}</option>
                </select></label>}
              {settings.mode === "size" && (settings.sizing === "actual" || settings.sizing === "custom") && <p className="print-hint">{translateUi("Content outside the sheet's quarter-inch margins is clipped. Check the preview.")}</p>}
              {(settings.mode === "poster" || settings.mode === "size" && settings.sizing === "custom") && <label className="print-inline">{settings.mode === "poster" ? translateUi("Tile scale (%)") : translateUi("Custom scale (%)")}<input type="number" min="10" max="400" value={settings.scale} onChange={e => update("scale", e.target.valueAsNumber)} /></label>}
              {settings.mode === "poster" && <><label className="print-inline">{translateUi("Overlap")}<input aria-label={translateUi("Poster overlap")} type="number" min="0" step={overlapUnit === "in" ? "0.05" : "1"}
                value={Number.isFinite(settings.overlapPoints) ? +overlapFromPoints(settings.overlapPoints, overlapUnit).toFixed(6) : ""}
                onChange={e => update("overlapPoints", overlapToPoints(e.target.valueAsNumber, overlapUnit))} /></label>
                <label className="print-inline">{translateUi("Overlap units")}<select aria-label={translateUi("Overlap units")} value={overlapUnit} onChange={e => setOverlapUnit(e.target.value as OverlapUnit)}><option value="in">{translateUi("Inches")}</option><option value="mm">{translateUi("Millimeters")}</option></select></label>
                <p className="print-hint">{translateUi("Adjacent tiles repeat the chosen overlap, left to right then down. Trim the quarter-inch paper margins and align the repeated content. Cut marks are not included.")}</p></>}
              {settings.mode === "multiple" && <label className="print-inline">{translateUi("Pages per sheet")}<select value={settings.perSheet} onChange={e => update("perSheet", +e.target.value)}>{[2, 4, 6, 9, 16].map(n => <option key={n}>{n}</option>)}</select></label>}
              {settings.mode === "booklet" && <p className="print-hint">{translateUi("Fold down the middle. Choose two-sided printing with")} {settings.orientation === "portrait" ? translateUi("long-edge") : translateUi("short-edge")} {translateUi("binding in the system dialog.")}</p>}
              </section>
              <section><div className="print-inline print-selection"><label htmlFor="print-pages">{translateUi("Pages to print")}</label>
                <select id="print-pages" value={selection} onChange={e => setSelection(e.target.value)}>
                <option value="all">{translateUi("All pages")}</option><option value="current">{translateUi("Current page (")}{currentPage})</option><option value="range">{translateUi("Page range…")}</option>
              </select></div>
              {selection === "range" && <input aria-label={translateUi("Page range")} placeholder="1-3, 5" value={range} onChange={e => setRange(e.target.value)} />}</section>
              <details><summary>{translateUi("Paper and quality")}</summary><label className="print-inline">{translateUi("Print quality")}<select aria-label={translateUi("Print quality")} value={settings.dpi} onChange={e => update("dpi", +e.target.value as PrintSettings["dpi"])}>{[150, 300, 600].map(dpi => <option key={dpi} value={dpi}>{dpi} dpi</option>)}</select></label>
                <label className="print-inline">{translateUi("Paper size")}<select value={settings.paper} onChange={e => update("paper", e.target.value as PrintSettings["paper"])}>{["Letter", "A4", "Legal"].map(p => <option key={p} value={p}>{translateKnownUi(p)}</option>)}</select></label>
                <h3>{translateUi("Orientation")}</h3><div className="print-radio-row">{(["auto", "portrait", "landscape"] as const).map(value => <label key={value}><input type="radio" name="print-orientation" checked={settings.orientation === value} onChange={() => update("orientation", value)} />{translateKnownUi(value[0].toUpperCase() + value.slice(1))}</label>)}</div>
                <label className="print-check"><input type="checkbox" checked={settings.grayscale} onChange={e => update("grayscale", e.target.checked)} />{translateUi("Print in grayscale")}</label>
                <label className="print-check"><input type="checkbox" checked={settings.toner} onChange={e => update("toner", e.target.checked)} />{translateUi("Save ink/toner")}</label>
              </details>
              <details className="print-device"><summary>{translateUi("Printer and copies")}</summary><fieldset disabled={busy} className="print-printer">
                <label>{translateUi("Printer")}<select value={printer} onChange={e => setPrinter(e.target.value)}>
                  <option value="">{translateUi("System default")}</option>{printers.map(p => <option key={p.name} value={p.name}>{p.displayName || p.name}</option>)}
                </select></label>
                <label>{translateUi("Copies")}<input type="number" min="1" max="999" value={copies} onChange={e => setCopies(e.target.valueAsNumber)} /></label>
              </fieldset></details>
            </fieldset>
            <div className="print-preview" aria-label={translateUi("Print preview")} style={previewStyle(sheet)}>
              {sheet && <><p>{translateUi("Scale:")} {[...new Set(sheet.placements.map(p => `${Math.round(p.scale * 100)}%`))].join(", ") || translateUi("Blank")}</p><p>{(sheet.width / 72).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} × {(sheet.height / 72).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 })} {translateUi("inches")}</p></>}
              <div className="print-paper">{preview ? <img src={preview} alt={translateUi("Preview of sheet {v0}", { v0: index + 1 })} /> : <p>{layout.error ? translateUi("No preview") : translateUi("Preparing preview…")}</p>}</div>
              <div className="print-preview-nav"><button className="pill-btn" aria-label={translateUi("Previous sheet")} disabled={index === 0} onClick={() => setSheetIndex(index - 1)}>‹</button><span>{translateUi("Sheet")} {sheet ? index + 1 : 0} {translateUi("of")} {layout.sheets.length}</span><button className="pill-btn" aria-label={translateUi("Next sheet")} disabled={index >= layout.sheets.length - 1} onClick={() => setSheetIndex(index + 1)}>›</button></div>
            </div>
          </div>
          {(layout.error || budgetError || error || !Number.isInteger(copies) || copies < 1 || copies > 999) && <p className="form-error" role="alert">{layout.error || budgetError || error || translateUi("Copies must be between 1 and 999.")}</p>}
          <p className="print-status" role="status">{progress || message}</p>
          <div className="form-actions"><button className="btn ghost" onClick={close} disabled={busy && handingOff.current}>{busy ? translateUi("Cancel preparation") : translateUi("Cancel")}</button>
            <button className="btn primary" onClick={() => void submit()} disabled={busy || !window.folioDesktop || !preview || !sheet || !!layout.error || !!budgetError || !Number.isInteger(copies) || copies < 1 || copies > 999}>{translateUi("Continue to print…")}</button></div>
        </>}
      </div>
    </div>
  </Modal>;
}
