import { useEffect, useState } from "react";
import { Modal } from "./Dialogs";
import { Icon } from "./icons";
import type { SignatureTarget } from "./signatures";

export interface DigitalSignRequest {
  id: string; password: string; reason: string; location: string; rect?: number[];
  /** Full name of the empty signature field to sign; without it a new field goes at `rect`. */
  field?: string;
}

const day = (iso: string) => new Date(iso).toLocaleDateString(undefined, { year: "numeric", month: "short", day: "numeric" });

/** Signs with a .p12/.pfx certificate. The certificate file stays in the desktop shell; only its public details come here. */
export function DigitalSignatureDialog({ pageNumber, targets, onSign, onClose }: {
  pageNumber: number; targets: SignatureTarget[];
  /** Resolves to an error message, or null when the signed copy was saved (or saving was cancelled). */
  onSign: (request: DigitalSignRequest) => Promise<string | null>; onClose: () => void;
}) {
  const signing = window.folioDesktop!.signing;
  const [file, setFile] = useState<{ id: string; name: string } | null>(null);
  const [password, setPassword] = useState("");
  const [info, setInfo] = useState<CertificateInfo | null>(null);
  const [reason, setReason] = useState("");
  const [location, setLocation] = useState("");
  const [targetId, setTargetId] = useState(targets[0]?.id ?? "corner");
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);

  // The shell drops the chosen certificate when the dialog closes.
  useEffect(() => () => { void signing.forget(); }, [signing]);

  const choose = async () => {
    setBusy(true); setError("");
    try {
      const picked = await signing.chooseCertificate();
      if (!picked) return;
      if ("error" in picked) { setError(picked.error); return; }
      setFile(picked); setInfo(null); setPassword("");
    } finally { setBusy(false); }
  };
  const read = async () => {
    if (!file || busy) return;
    setBusy(true); setError("");
    try {
      const result = await signing.readCertificate(file.id, password);
      if ("error" in result) setError(result.error); else setInfo(result);
    } finally { setBusy(false); }
  };
  const sign = async () => {
    if (!file || !info || busy) return;
    setBusy(true); setError("");
    try {
      const target = targets.find(item => item.id === targetId);
      const message = await onSign({ id: file.id, password, reason, location, rect: target?.rect,
        field: target?.kind === "field" ? target.fieldName : undefined });
      if (message) setError(message); else onClose();
    } finally { setBusy(false); }
  };
  const invalid = info && (info.expired ? `This certificate expired on ${day(info.validTo)}. It can't make a valid signature.`
    : info.notYetValid ? `This certificate is valid from ${day(info.validFrom)}.` : "");

  return <Modal title="Sign digitally" onClose={() => { if (!busy) onClose(); }}>
    <form className="digital-signature" onSubmit={event => { event.preventDefault(); void (info ? sign() : read()); }}>
      <p className="search-hint">Signs with your .p12 or .pfx certificate and adds a stamp with a QR code to page {pageNumber}. The signed copy is saved as a new file.</p>
      <div className="digital-signature-file">
        <Icon name="file" size={16} /><span>{file ? file.name : "No certificate chosen"}</span>
        <button type="button" className="btn ghost" disabled={busy} onClick={() => void choose()}>{file ? "Change" : "Choose certificate"}</button>
      </div>
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
        <label className="signature-field">Reason (optional)<input value={reason} maxLength={200} disabled={busy} onChange={event => setReason(event.target.value)} /></label>
        <label className="signature-field">Location (optional)<input value={location} maxLength={200} disabled={busy} onChange={event => setLocation(event.target.value)} /></label>
        <label className="signature-field">Stamp position<select value={targetId} disabled={busy} onChange={event => setTargetId(event.target.value)}>
          {targets.map(target => <option key={target.id} value={target.id}>{target.label}</option>)}
          <option value="corner">Bottom right of page {pageNumber}</option>
        </select></label>
      </>}
      {(error || invalid) && <p className="form-error" role="alert">{error || invalid}</p>}
      <div className="form-actions">
        <button type="button" className="btn ghost" disabled={busy} onClick={onClose}>Cancel</button>
        {info ? <button type="submit" className="btn primary" disabled={busy || !!invalid}><Icon name="check" size={15} />{busy ? "Signing..." : "Sign and save"}</button>
          : <button type="submit" className="btn primary" disabled={busy || !file}>{busy && file ? "Opening..." : "Open certificate"}</button>}
      </div>
    </form>
  </Modal>;
}
