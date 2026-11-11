import { locale, translateUi } from "./i18n";
import { useEffect, useId, useRef, useState } from "react";
import { Icon } from "./icons";
import { SCAN_LANGUAGES, scanLanguageName, type ScanLanguage } from "./scanLanguage";
import { installedScanLanguages, installScanLanguage } from "./scanLanguagePacks";

function searchable(text: string) {
  return text.normalize("NFD").replace(/\p{M}/gu, "").toLowerCase().trim();
}

export function ScanLanguagePicker({ value, onChange }: { value: ScanLanguage[]; onChange: (next: ScanLanguage[]) => void }) {
  const id = useId();
  const panel = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const session = useRef<AbortController | null>(null);
  const [installed, setInstalled] = useState<Set<ScanLanguage> | null>(null);
  const [downloading, setDownloading] = useState("");
  const [error, setError] = useState("");
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState(value);
  const languages = SCAN_LANGUAGES.map(language => ({ ...language, name: scanLanguageName(language.id) }));
  const selected = languages.filter(language => value.includes(language.id));
  const filter = searchable(query);
  const visible = [...selected, ...languages.filter(language => !value.includes(language.id))]
    .filter(language => searchable(language.name + " " + language.nativeName).includes(filter));
  const summary = selected.length === 1 ? selected[0].name : translateUi("{v0} languages", { v0: selected.length });
  const missing = languages.filter(({ id }) => draft.includes(id) && !installed?.has(id) && id !== "eng");
  const megabytes = (missing.reduce((sum, language) => sum + language.bytes, 0) / 1_000_000).toLocaleString(locale(), { minimumFractionDigits: 1, maximumFractionDigits: 1 });
  useEffect(() => () => session.current?.abort(), []);

  async function apply() {
    const signal = session.current?.signal;
    if (!signal || signal.aborted) return;
    setError("");
    try {
      for (const language of missing) {
        setDownloading(language.name);
        await installScanLanguage(language.id, signal);
        signal.throwIfAborted();
        setInstalled(previous => new Set(previous).add(language.id));
      }
      if (!panel.current?.matches(":popover-open")) return;
      if (missing.length || draft.join("+") !== value.join("+")) onChange([...draft]);
      panel.current?.hidePopover();
    } catch (reason) {
      if (!signal.aborted) setError(reason instanceof Error ? reason.message : translateUi("Couldn't save the language pack."));
    } finally {
      if (!signal.aborted) setDownloading("");
    }
  }

  return <div className="scan-picker" onKeyDown={event => {
    if (event.key === "Escape" && panel.current?.matches(":popover-open")) {
      event.stopPropagation();
      event.preventDefault();
      panel.current.hidePopover();
    }
  }}>
    <button type="button" className="btn scan-picker-trigger" popoverTarget={id} aria-haspopup="dialog"
      aria-label={translateUi("Scan languages: {v0}", { v0: summary })} onClick={() => { setDraft(value); setQuery(""); }}>
      {summary}<Icon name="chevronDown" size={14} />
    </button>
    <div ref={panel} id={id} popover="auto" role="dialog" aria-label={translateUi("Choose scan languages")} className="scan-picker-panel"
      onToggle={event => {
        session.current?.abort();
        if (event.newState !== "open") return;
        session.current = new AbortController();
        const { signal } = session.current;
        setInstalled(null);
        setDownloading("");
        setError("");
        search.current?.focus();
        void installedScanLanguages().then(packs => { if (!signal.aborted) setInstalled(packs); }).catch(() => {
          if (!signal.aborted) setError(translateUi("Couldn't read saved language packs. Check device storage and reopen the list."));
        });
      }}>
      <input ref={search} type="search" aria-label={translateUi("Search languages")} placeholder={translateUi("Search languages")}
        value={query} onChange={event => setQuery(event.target.value)} />
      <div className="scan-picker-options">
        {visible.map(({ id: code, name, nativeName }) => <label key={code}>
          <input type="checkbox" aria-label={name} checked={draft.includes(code)} disabled={!!downloading}
            onChange={event => setDraft(event.target.checked ? [...draft, code] : draft.filter(item => item !== code))} />
          <span>{name}</span>{nativeName && <small dir="auto">{nativeName}</small>}
          {installed && !installed.has(code) && <span title={translateUi("One-time download")} className="scan-pack-icon"><Icon name="download" size={13} /></span>}
        </label>)}
        {!visible.length && <p role="status">{translateUi("No matching languages")}</p>}
      </div>
      {error && <p role="alert" className="form-error">{error}</p>}
      <footer>
        <span role="status">{downloading ? translateUi("Downloading {v0}…", { v0: downloading }) : draft.length ? translateUi("{v0} selected", { v0: draft.length }) : translateUi("Choose a language")}</span>
        <button type="button" className="btn primary" disabled={!draft.length || !!downloading || (!installed && !!missing.length)}
          onClick={() => void apply()}>{missing.length ? translateUi("Download · {v0} MB", { v0: megabytes }) : translateUi("Apply")}</button>
      </footer>
    </div>
  </div>;
}
