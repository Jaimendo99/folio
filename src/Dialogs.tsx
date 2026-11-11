import { translateKnownUi, translateUi } from "./i18n";
import { locale } from "./i18n";
import { useEffect, useState, type ReactNode } from "react";
import type { PDFDocumentProxy } from "./pdf";
import { Icon } from "./icons";
import { keys } from "./platform";

export function Modal({ title, onClose, children }: { title: string; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <div className="modal-backdrop" onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true" aria-label={title}>
        <div className="modal-head">
          <h2>{title}</h2>
          <button className="pill-btn" onClick={onClose} aria-label={translateUi("Close")}>
            <Icon name="close" size={16} />
          </button>
        </div>
        {children}
      </div>
    </div>
  );
}

export function formatBytes(n: number) {
  if (n < 1024) return `${n} B`;
  if (n < 1024 ** 2) return `${(n / 1024).toLocaleString(locale(), { maximumFractionDigits: 0 })} KB`;
  return `${(n / 1024 ** 2).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 })} MB`;
}

const EDITIONS: Record<string, string> = {
  installed: "Installed",
  portable: "Portable - update manually",
  appimage: "AppImage",
  package: "Linux package (updates via apt)",
};

export function AboutDialog({ onClose }: { onClose: () => void }) {
  const desktop = window.folioDesktop;
  const [info, setInfo] = useState<Awaited<ReturnType<FolioDesktop["getAppInfo"]>> | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    let cancelled = false;
    desktop?.getAppInfo().then(info => { if (!cancelled) setInfo(info); }).catch(() => {
      if (!cancelled) setError(translateUi("Couldn't read application details."));
    });
    return () => { cancelled = true; };
  }, [desktop]);
  return <Modal title={translateUi("About Folio")} onClose={onClose}>
    <dl className="info-list">
      <div><dt>{translateUi("Version")}</dt><dd>{info?.version ?? (desktop ? translateUi("Loading...") : translateUi("Browser edition"))}</dd></div>
      <div><dt>{translateUi("Edition")}</dt><dd>{translateKnownUi(EDITIONS[info?.mode ?? ""] ?? (desktop ? "Development" : "Web"))}</dd></div>
      {info && <div><dt>{translateUi("Location")}</dt><dd className="installation-path">{info.location}</dd></div>}
    </dl>
    <div className="about-update">
      {!desktop && <p>{translateUi("Documents and reading preferences stay on this device.")}</p>}
      {info?.mode === "portable" && <p className="search-hint">{translateUi("Use the Setup installer for automatic updates and a single installed copy.")}</p>}
      {info?.mode === "package" && <p className="search-hint">{translateUi("New versions arrive with your system's software updates (apt).")}</p>}
      <div className="form-actions">
        {desktop && <button className="btn ghost" onClick={() => {
          void desktop.openInstallation().then(message => setError(message || null)).catch(() => setError(translateUi("Couldn't open the installation folder.")));
        }}>{translateUi("Open installation folder")}</button>}
      </div>
      {error && <p className="form-error">{error}</p>}
    </div>
  </Modal>;
}

function parsePdfDate(s?: string) {
  const m = s?.match(/D:(\d{4})(\d{2})?(\d{2})?(\d{2})?(\d{2})?/);
  if (!m) return null;
  const d = new Date(+m[1], +(m[2] ?? 1) - 1, +(m[3] ?? 1), +(m[4] ?? 0), +(m[5] ?? 0));
  return d.toLocaleString(locale(), { dateStyle: "medium", timeStyle: "short" });
}

export function InfoDialog({ pdf, name, size, onClose }: { pdf: PDFDocumentProxy; name: string; size: number; onClose: () => void }) {
  const [rows, setRows] = useState<[string, string][]>([]);

  useEffect(() => {
    (async () => {
      const { info } = (await pdf.getMetadata()) as { info: Record<string, string> };
      const first = await pdf.getPage(1);
      const [, , w, h] = first.view;
      const inches = (pt: number) => (pt / 72).toLocaleString(locale(), { minimumFractionDigits: 2, maximumFractionDigits: 2 });
      setRows(
        [
          [translateUi("File"), name],
          [translateUi("Title"), info.Title],
          [translateUi("Author"), info.Author],
          [translateUi("Subject"), info.Subject],
          [translateUi("Pages"), pdf.numPages.toLocaleString(locale())],
          [translateUi("Page size"), `${inches(w)} × ${inches(h)} ${translateUi("in")}`],
          [translateUi("File size"), formatBytes(size)],
          [translateUi("Created"), parsePdfDate(info.CreationDate)],
          [translateUi("Modified"), parsePdfDate(info.ModDate)],
          [translateUi("Application"), info.Creator],
          [translateUi("Producer"), info.Producer],
          [translateUi("PDF version"), info.PDFFormatVersion],
        ].filter((r): r is [string, string] => !!r[1]),
      );
    })();
  }, [pdf, name, size, locale()]);

  return (
    <Modal title={translateUi("Document info")} onClose={onClose}>
      <dl className="info-list">
        {rows.map(([k, v]) => (
          <div key={k}>
            <dt>{translateKnownUi(k)}</dt>
            <dd>{v}</dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

const SHORTCUTS: [string, string][] = [
  ["Open file", "Ctrl O"],
  ["New tab", "Ctrl T"],
  ["Close tab", "Ctrl W"],
  ["Next tab", "Control Tab"],
  ["Previous tab", "Control Shift Tab"],
  ["Open from URL", "Ctrl Shift O"],
  ["Back / forward through links", "Alt ← / Alt →"],
  ["Highlight selection or enter Highlight mode", "H"],
  ["Write a note on the selection", "N"],
  ["Remove a clicked highlight", "Delete"],
  ["Find", "Ctrl F"],
  ["Save / download", "Ctrl S"],
  ["Print", "Ctrl P"],
  ["Zoom in / out", "Ctrl + / −"],
  ["Reset zoom", "Ctrl 0"],
  ["Toggle sidebar", "Ctrl \\"],
  ["Select tool", "V"],
  ["Draw", "D"],
  ["Add text", "T"],
  ["Rotate pages", "R"],
  ["Two-page view", "2"],
  ["Focus mode", "F"],
  ["First / last page", "Home / End"],
  ["Settings", "Ctrl ,"],
  ["Shortcuts", "?"],
];

export function ShortcutsDialog({ onClose }: { onClose: () => void }) {
  return (
    <Modal title={translateUi("Keyboard shortcuts")} onClose={onClose}>
      <dl className="info-list shortcuts">
        {SHORTCUTS.map(([k, v]) => (
          <div key={k}>
            <dt>{translateKnownUi(k)}</dt>
            <dd>
              {keys(v).split(" ").map((key, i) => (key === "/" ? <span key={i}> / </span> : <kbd key={i}>{key}</kbd>))}
            </dd>
          </div>
        ))}
      </dl>
    </Modal>
  );
}

/** Returns the http(s) URL in `text`, or null if it isn't a single web link. */
export function parseWebUrl(text: string | null | undefined) {
  const value = (text ?? "").trim();
  if (!value || /\s/.test(value)) return null;
  try {
    const explicit = /^[a-z][a-z\d+.-]*:/i.test(value);
    const url = new URL(explicit ? value : "https://" + value);
    // Without a scheme, only accept text that looks like a domain ("example.com/a.pdf").
    return (url.protocol === "http:" || url.protocol === "https:") && (explicit || url.hostname.includes(".")) ? url.toString() : null;
  } catch {
    return null;
  }
}

export function OpenUrlDialog({ initial = "", onSubmit, onClose }: { initial?: string; onSubmit: (url: string) => void; onClose: () => void }) {
  const [value, setValue] = useState(initial);
  const url = parseWebUrl(value);
  return (
    <Modal title={translateUi("Open from URL")} onClose={onClose}>
      <form
        className="password-form"
        onSubmit={(e) => {
          e.preventDefault();
          if (url) onSubmit(url);
        }}
      >
        <p>{translateUi("Paste a link to a PDF or a webpage. Webpages become a PDF you can highlight and mark up. You can also drop or paste a link anywhere in Folio.")}</p>
        <input type="url" autoFocus value={value} onChange={(e) => setValue(e.target.value)} placeholder="https://example.com/article" aria-label={translateUi("PDF URL")} />
        {value.trim() && !url && <p className="form-error">{translateUi("Enter an http:// or https:// address.")}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onClose}>
            {translateUi("Cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!url}>
            {translateUi("Open")}
          </button>
        </div>
      </form>
    </Modal>
  );
}

export function PasswordDialog({
  name,
  error,
  onSubmit,
  onCancel,
}: {
  name: string;
  error?: string;
  onSubmit: (pw: string) => void;
  onCancel: () => void;
}) {
  const [pw, setPw] = useState("");
  return (
    <Modal title={translateUi("Password required")} onClose={onCancel}>
      <form
        className="password-form"
        onSubmit={(e) => {
          e.preventDefault();
          onSubmit(pw);
        }}
      >
        <p>
          “{name}{translateUi("” is protected. Enter its password to open it.")}
        </p>
        <input type="password" autoFocus value={pw} onChange={(e) => setPw(e.target.value)} placeholder={translateUi("Password")} />
        {error && <p className="form-error">{error}</p>}
        <div className="form-actions">
          <button type="button" className="btn ghost" onClick={onCancel}>
            {translateUi("Cancel")}
          </button>
          <button type="submit" className="btn primary" disabled={!pw}>
            {translateUi("Open")}
          </button>
        </div>
      </form>
    </Modal>
  );
}
