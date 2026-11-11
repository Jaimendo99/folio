import { locale } from "./i18n";
import { useEffect, useState } from "react";
import { Modal } from "./Dialogs";
import { Icon } from "./icons";
import type { SignatureTarget } from "./signatures";
import { StampPlacement } from "./StampPlacement";
import type { PDFViewer } from "./viewer";

export interface DigitalSignRequest {
  id: string; password: string; reason: string; location: string; page: number; rect?: number[]; remember: boolean;
  /** Full name of the empty signature field to sign; without it a new field goes at `rect`. */
  field?: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(locale(), { year: "numeric", month: "short", day: "numeric" });
const PLACE = "place";

/**
 * Signs with a .p12/.pfx certificate. The certificate file stays in the desktop shell; only its public details come
 * here. The stamp goes where the user puts it on the page (StampPlacement), or into an empty signature field.
 */
export function DigitalSignatureDialog({ viewer, container, targets, onSign, onClose }: {
  viewer: PDFViewer; container: HTMLElement;
  /** Detected on the page being read: empty signature fields to sign into, or a label to start the stamp next to. */
  targets: SignatureTarget[];
  /** Resolves to an error message, or null when the signed copy was saved (or saving was cancelled). */
  onSign: (request: DigitalSignRequest) => Promise<string | null>; onClose: () => void;
}) {
  const signing = window.folioDesktop!.signing;
  const [saved, setSaved] = useState<SavedCertificate[] | null>(null);
  const [file, setFile] = useState<ChosenCertificate | null>(null);
  const [password, setPassword] = useState("");
  const [info, setInfo] = useState<CertificateInfo | null>(null);
  const [remember, setRemember] = useState(true);
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const fields = targets.filter(target => target.kind === "field" && target.fieldName);
  const [targetId, setTargetId] = useState(fields[0]?.id ?? PLACE);
  const [placing, setPlacing] = useState<{ page: number; suggestion?: number[] } | null>(null);
  const [missing, setMissing] = useState<string | null>(null);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    void signing.savedCertificates().then(list => { if (!cancelled) setSaved(list); }, () => { if (!cancelled) setSaved([]); });
    return () => { cancelled = true; };
  }, [signing]);
  // The shell drops the chosen certificate when the dialog closes.
  useEffect(() => () => { void signing.forget(); }, [signing]);

  const opened = (picked: ChosenCertificate) => { setFile(picked); setInfo(null); setPassword(""); setMissing(null); setError(""); };
  const choose = async () => {
    setBusy(true); setError("");
    try {
      const picked = await signing.chooseCertificate();
      if (!picked) return;
      if ("error" in picked) { setError(picked.error); return; }
      opened(picked);
    } finally { setBusy(false); }
  };
  const openSaved = async (entry: SavedCertificate) => {
    setBusy(true); setError(""); setMissing(null);
    try {
      const picked = await signing.useSaved(entry.id);
      if ("error" in picked) {
        if (picked.missing) setMissing(entry.id);
        setError(picked.error);
        return;
      }
      opened(picked);
    } finally { setBusy(false); }
  };
  const forgetSaved = async (entry: SavedCertificate) => {
    setSaved(await signing.forgetSaved(entry.id));
    if (missing === entry.id) { setMissing(null); setError(""); }
  };
  const read = async () => {
    if (!file || busy) return;
    setBusy(true); setError("");
    try {
      const result = await signing.readCertificate(file.id, password);
      if ("error" in result) setError(result.error); else setInfo(result);
    } finally { setBusy(false); }
  };
  const sign = async (page: number, place: { rect?: number[]; field?: string }) => {
    if (!file || !info || busy) return;
    setBusy(true); setError("");
    try {
      const message = await onSign({ id: file.id, password, reason, location, page, remember: remember && !file.saved, ...place });
      if (message) setError(message); else onClose();
    } finally { setBusy(false); }
  };
  const next = () => {
    const field = fields.find(target => target.id === targetId);
    const page = viewer.currentPageNumber;
    if (field) { void sign(page, { field: field.fieldName }); return; }
    setError("");
    setPlacing({ page, suggestion: targets.find(target => target.kind === "label")?.rect });
  };
  const invalid = info && (info.expired ? `This certificate expired on ${day(info.validTo)}. It can't make a valid signature.`
    : info.notYetValid ? `This certificate is valid from ${day(info.validFrom)}.` : "");

  if (placing && info) {
    return <StampPlacement viewer={viewer} container={container} pageNumber={placing.page} suggestion={placing.suggestion} signer={info.name}
      busy={busy} error={error} onSign={(page, rect) => void sign(page, { rect })}
      onBack={() => { setPlacing(null); setError(""); }} onCancel={onClose} />;
  }

  return <Modal title="Sign digitally" onClose={() => { if (!busy) onClose(); }}>
    <form className="digital-signature" onSubmit={event => { event.preventDefault(); if (file) void (info ? next() : read()); }}>
      <p className="search-hint">Signs with your .p12 or .pfx certificate and adds a stamp with a QR code where you place it. The signed copy is saved as a new file.</p>
      {!file && <>
        {!!saved?.length && <div className="saved-certificates" role="group" aria-label="Saved certificates">
          <h3>Saved certificates</h3>
          <ul>
            {saved.map(entry => <li key={entry.id} data-missing={entry.missing || missing === entry.id || undefined}>
              <button type="button" className="saved-certificate" disabled={busy} onClick={() => void openSaved(entry)}
                title={entry.fileName} aria-label={`Use ${entry.name}, ${entry.fileName}`}>
                <Icon name="lock" size={15} />
                <span className="saved-certificate-text">
                  <strong>{entry.name || entry.fileName}</strong>
                  <small>{entry.provider}</small>
                  <small>{entry.missing || missing === entry.id ? <em>File not found: {entry.fileName}</em>
                    : entry.expired ? <em>Expired {day(entry.validTo)}</em> : entry.validTo ? `Valid until ${day(entry.validTo)}` : entry.fileName}</small>
                </span>
              </button>
              <button type="button" className="pill-btn" disabled={busy} onClick={() => void forgetSaved(entry)}
                aria-label={`Forget ${entry.name || entry.fileName}`} title="Forget this certificate"><Icon name="trash" size={14} /></button>
            </li>)}
          </ul>
        </div>}
        <button type="button" className="btn ghost digital-signature-choose" disabled={busy || !saved} onClick={() => void choose()}>
          <Icon name="file" size={15} />{saved?.length ? "Choose another file…" : "Choose certificate"}</button>
      </>}
      {file && <div className="digital-signature-file">
        <Icon name="file" size={16} /><span title={file.name}>{file.name}</span>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => { void signing.forget(); setFile(null); setInfo(null); setPassword(""); setError(""); }}>Change</button>
      </div>}
      {file && <label className="signature-field">Password
        <input type="password" autoFocus autoComplete="off" value={password} disabled={busy}
          onChange={event => { setPassword(event.target.value); setInfo(null); }} />
      </label>}
      {info && <dl className="info-list">
        <div><dt>Signer</dt><dd>{info.name}</dd></div>
        <div><dt>Issued by</dt><dd>{info.provider}</dd></div>
        <div><dt>Valid until</dt><dd>{day(info.validTo)}</dd></div>
      </dl>}
      {info && !invalid && <>
        {!file?.saved && <label className="signature-remember"><input type="checkbox" checked={remember} disabled={busy} onChange={event => setRemember(event.target.checked)} />
          <span>Remember this certificate<small>Keeps its location and details, never the password.</small></span></label>}
        <label className="signature-field">Reason (optional)<input value={reason} maxLength={200} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <label className="signature-field">Location (optional)<input value={location} maxLength={200} disabled={busy} onChange={event => setLocation(event.target.value)} /></label>
        {fields.length > 0 && <label className="signature-field">Stamp position<select value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}>
          {fields.map(target => <option key={target.id} value={target.id}>Signature field: {target.label}</option>)}
          <option value={PLACE}>Choose a place on the page</option>
        </select></label>}
      </>}
      {(error || invalid) && <p className="form-error" role="alert">{error || invalid}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        {info ? <button type="submit" className="btn primary" disabled={busy || !!invalid}>
          {targetId === PLACE || !fields.some(target => target.id === targetId) ? "Choose place" : busy ? "Signing..." : <><Icon name="check" size={15} />Sign and save</>}</button>
          : file && <button type="submit" className="btn primary" disabled={busy}>{busy ? "Opening..." : "Open certificate"}</button>}
      </div>
    </form>
  </Modal>;
}
