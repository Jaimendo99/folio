import { translateUi } from "./i18n";
import { locale } from "./i18n";
import { useEffect, useRef, useState } from "react";
import { saveAiPreference } from "./ai";
import { readSetting } from "./preferences";

const MODEL_KEY = "folio:ai-model:openrouter";

function ModelPicker({ ai }: { ai: FolioAi }) {
  const [model, setModel] = useState(() => readSetting(MODEL_KEY) ?? "");
  const [editing, setEditing] = useState(!model);
  const [query, setQuery] = useState("");
  const [models, setModels] = useState<OpenRouterModel[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  useEffect(() => {
    if (!editing) return;
    let current = true;
    setLoading(true);
    setError("");
    ai.openRouterModels().then(result => {
      if (!current) return;
      setModels(result.models ?? []);
      setError(result.error ?? "");
    }).catch(() => { if (current) setError(translateUi("Couldn't load models. You can enter a model ID.")); })
      .finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [ai, editing]);
  const select = (id: string) => {
    saveAiPreference(MODEL_KEY, id);
    setModel(id); setEditing(false); setQuery("");
  };
  const typed = query.trim();
  const matches = models.filter(m => (m.name + " " + m.id).toLowerCase().includes(typed.toLowerCase()));
  const custom = /^[a-z\d_~@.-]+\/[a-z\d_:./~@-]+$/i.test(typed) && !models.some(m => m.id === typed);
  if (!editing) return <div className="settings-row"><div className="settings-label"><span>{translateUi("Model")}</span><small>{model}</small></div>
    <button className="btn ghost" onClick={() => setEditing(true)}>{translateUi("Change model")}</button></div>;
  return <div className="router-model-picker">
    <label htmlFor="router-model">{translateUi("Model")}</label>
    <input id="router-model" type="search" placeholder={translateUi("Search models or enter an ID")} maxLength={256} value={query}
      onChange={event => setQuery(event.target.value)} />
    <div className="router-models" aria-label={translateUi("Available models")}>
      {matches.map(m => <button key={m.id} onClick={() => select(m.id)}>
        <span>{m.name}<small>{m.id}</small></span>
        {m.contextLength && <small title={translateUi("Context window in tokens")}>{m.contextLength.toLocaleString(locale())} {translateUi("tokens")}</small>}
      </button>)}
      {custom && <button onClick={() => select(typed)}>{translateUi("Use")} {typed}</button>}
    </div>
    {loading && <small role="status">{translateUi("Loading models…")}</small>}
    {!loading && !error && !matches.length && !custom && <small>{translateUi("No matching models. You can enter an ID such as provider/model.")}</small>}
    {error && <small role="status">{error}</small>}
    {model && <button className="link small" onClick={() => { setEditing(false); setQuery(""); }}>{translateUi("Cancel")}</button>}
  </div>;
}

export function OpenRouterSettings({ ai, configured, onConfigured }: { ai: FolioAi; configured: boolean; onConfigured: (configured: boolean) => void }) {
  const key = useRef<HTMLInputElement>(null);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  const [error, setError] = useState("");
  const act = async (action: "save" | "check" | "remove") => {
    const value = action === "save" ? key.current?.value.trim() : undefined;
    if (key.current) key.current.value = "";
    setNotice(""); setError(""); setBusy(true);
    try {
      const result = await ai.openRouterKey(action, value);
      if (!result.ok) { setError(result.error || translateUi("Couldn't update the OpenRouter key.")); return; }
      onConfigured(!!result.configured);
      setEditing(false);
      setNotice(action === "check" ? translateUi("Connection verified.") : "");
      if (action !== "check") saveAiPreference("folio:ai-key-revision", crypto.randomUUID());
    } catch { setError(translateUi("Couldn't update the OpenRouter key. Try again.")); }
    finally { setBusy(false); }
  };
  return <div className="router-settings">
    <p className="settings-hint">{translateUi("OpenRouter bills your account. When you ask, OpenRouter and the provider serving your model receive the text you ask about and the conversation.")}</p>
    {configured && !editing ? <div className="settings-row">
      <div className="settings-label"><span>{translateUi("API key")}</span><small>{translateUi("Stored securely on this device.")}</small></div>
      <button className="link small" disabled={busy} onClick={() => { setEditing(true); setNotice(""); setError(""); }}>{translateUi("Manage key")}</button>
      <button className="btn ghost" disabled={busy} onClick={() => void act("check")}>{busy ? translateUi("Checking…") : translateUi("Check connection")}</button>
    </div> : <form className="router-key" onSubmit={event => { event.preventDefault(); void act("save"); }}>
      <label htmlFor="router-key">{configured ? translateUi("Replacement API key") : translateUi("API key")}</label>
      <div><input ref={key} id="router-key" type="password" autoComplete="off" spellCheck={false} maxLength={512} required
        placeholder={translateUi("Paste your OpenRouter key")} disabled={busy} />
        <button className="btn primary" disabled={busy}>{busy ? translateUi("Checking…") : translateUi("Verify and save")}</button></div>
      {configured && <div className="router-key-actions">
        <button type="button" className="link small" disabled={busy} onClick={() => { setEditing(false); setError(""); }}>{translateUi("Cancel")}</button>
        <button type="button" className="link small" disabled={busy} onClick={() => void act("remove")}>{translateUi("Remove saved key")}</button>
      </div>}
    </form>}
    {notice && <p role="status" className="settings-hint">{notice}</p>}
    {error && <p role="alert" className="form-error">{error}</p>}
    {configured && <ModelPicker ai={ai} />}
  </div>;
}
