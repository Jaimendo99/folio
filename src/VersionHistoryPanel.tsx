import { translateUi } from "./i18n";
import { locale } from "./i18n";
import { useEffect, useState } from "react";
import { Icon } from "./icons";
import { clearVersions, HISTORY_CHANNEL, listVersions, readVersion, type PdfChange, type PdfVersion } from "./versionHistory";

function Changes({ changes }: { changes: PdfChange[] }) {
  return <ul className="version-changes">{changes.map((change, i) =>
    <li key={i}>
      <div className="version-change-heading"><Icon size={14} name={change.kind === "text" ? "text" : change.kind === "image" ? "camera" : change.kind === "pages" ? "grid" : "pen"} />
        {change.kind === "text" ? change.after ? translateUi("Edited text") : translateUi("Removed text") : change.kind === "image" ? translateUi("Replaced image") :
          change.kind === "pages" ? translateUi("Reordered pages") : translateUi("Updated annotations or fields")}
        {"page" in change && <span>{translateUi("Page")} {change.page}</span>}
      </div>
      {change.kind === "text" && <div className="version-words">
        <del aria-label={translateUi("Previous text")}>{change.before}</del>
        {change.after && <ins aria-label={translateUi("New text")}>{change.after}</ins>}
      </div>}
      {change.kind === "image" && <p>{change.fileName}</p>}
      {change.kind === "pages" && <p>{change.order.join(" → ")}</p>}
    </li>)}</ul>;
}

export function VersionHistoryPanel({ id, allowed, pending, active, canOpen, onOpen, onDownload, onClose }: {
  id: string; allowed: boolean; pending: PdfChange[]; active: boolean;
  canOpen: (id: string) => boolean;
  onOpen: (version: PdfVersion, data: Blob) => void; onDownload: (version: PdfVersion, data: Blob) => void; onClose: () => void;
}) {
  const [versions, setVersions] = useState<PdfVersion[] | null>(null);
  const [error, setError] = useState("");
  const [confirmClear, setConfirmClear] = useState(false);
  useEffect(() => {
    if (!allowed || !active) return;
    let generation = 0;
    const refresh = async () => {
      const request = ++generation;
      try { const rows = await listVersions(id); if (request === generation) { setVersions(rows); setError(""); } }
      catch { if (request === generation) setError(translateUi("Couldn’t read version history on this device.")); }
    };
    const channel = new BroadcastChannel(HISTORY_CHANNEL);
    channel.onmessage = refresh;
    void refresh();
    return () => { generation++; channel.close(); };
  }, [id, allowed, active]);

  const recover = async (row: PdfVersion, download = false) => {
    try {
      const data = await readVersion(row.id);
      if (!data) throw new Error();
      (download ? onDownload : onOpen)(row, data);
    } catch { setError(translateUi("This version could not be opened.")); }
  };
  return <aside className="version-panel" aria-label={translateUi("Version history")}>
    <header><div><h2>{translateUi("Version history")}</h2><p>{translateUi("Stored on this device")}</p></div>
      <button className="icon-btn" aria-label={translateUi("Close version history")} onClick={onClose}><Icon name="close" /></button></header>
    <div className="version-list">
      {error && <p role="alert">{error}</p>}
      {!allowed ? <p>{translateUi("History is available for unencrypted PDFs up to 50 MB.")}</p> : <>
        {pending.length > 0 && <section className="version-draft"><h3>{translateUi("Unsaved changes")}</h3><Changes changes={pending} /></section>}
        {versions === null && !error && <p role="status">{translateUi("Loading versions…")}</p>}
        {versions?.length === 0 && <div className="version-empty"><Icon name="history" size={22} />
          <h3>{translateUi("No saved versions yet")}</h3><p>{translateUi("Save a copy after editing. Your original PDF and the edited version will appear here.")}</p></div>}
        {versions?.map(v => <section className="version-entry" key={v.id}>
          <h3>{translateUi("Version")} {v.number} {v.id === id && <small>{pending.length ? translateUi("Editing from") : translateUi("This PDF")}</small>}</h3>
          <p className="version-date">{new Date(v.createdAt).toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" })}</p>
          {v.number === 1 ? <p>{translateUi("Original PDF")}</p> : <>
            {v.parent !== v.number - 1 && <p>{translateUi("Edited from version")} {v.parent}</p>}
            <Changes changes={v.changes} />
          </>}
          <div className="version-actions">
            {v.id !== id && canOpen(v.id) && <button className="link small" onClick={() => void recover(v)}>{translateUi("Open version")} {v.number}</button>}
            <button className="link small" aria-label={translateUi("Download version {v0}", { v0: v.number })} onClick={() => void recover(v, true)}>{translateUi("Download")}</button>
          </div>
        </section>)}
      </>}
    </div>
    {allowed && !!versions?.length && <footer>{confirmClear ? <>
      <p>{translateUi("Delete all local versions of this PDF?")}</p>
      <button className="link small" onClick={() => setConfirmClear(false)}>{translateUi("Cancel")}</button>
      <button className="link small" onClick={async () => {
        try { await clearVersions(id); setConfirmClear(false); } catch { setError(translateUi("Couldn’t clear version history.")); }
      }}>{translateUi("Delete history")}</button>
    </> : <button className="link small" onClick={() => setConfirmClear(true)}>{translateUi("Clear history…")}</button>}</footer>}
  </aside>;
}
