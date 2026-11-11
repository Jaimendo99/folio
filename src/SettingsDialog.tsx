import { translateKnownUi, translateUi } from "./i18n";
import { locale, t, useLanguage, setLanguage, type Language } from "./i18n";
import { useEffect, useRef, useState, type ReactNode } from "react";
import { Modal } from "./Dialogs";
import { CLAUDE_CODE_URL, PROVIDERS, savedProvider, saveAiPreference, signInChatGPT, USAGE_URL, type AiProvider } from "./ai";
import { OpenRouterSettings } from "./OpenRouterSettings";
import { updateSummary } from "./updates";
import { ScanLanguagePicker } from "./ScanLanguagePicker";
import type { ScanLanguage } from "./scanLanguage";
import { Icon } from "./icons";
import { clearStoredData, countStoredData, onStoredDataCleared, type StoredCategory } from "./recent";

/** One place for every Folio preference. */
interface Props {
  initialSection?: "General" | "Ask AI";
  theme: string;
  onTheme: (theme: "light" | "dark") => void;
  night: boolean;
  onNight: (on: boolean) => void;
  wheelPaging: boolean;
  onWheelPaging: (on: boolean) => void;
  scanLanguages: ScanLanguage[];
  onScanLanguages: (languages: ScanLanguage[]) => void;
  onOpenChangelog: () => void;
  onClose: () => void;
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="settings-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

function Row({ label, hint, children }: { label: string; hint?: ReactNode; children: ReactNode }) {
  return (
    <div className="settings-row">
      <div className="settings-label">
        <span>{label}</span>
        {hint && <small>{hint}</small>}
      </div>
      <div className="settings-control">{children}</div>
    </div>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (on: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      disabled={disabled}
      className={`switch ${checked ? "on" : ""}`}
      onClick={() => onChange(!checked)}
    >
      <span />
    </button>
  );
}

function Choice<T extends string>({ value, options, onChange, label }: { value: T; options: readonly { id: T; name: string }[]; onChange: (v: T) => void; label: string }) {
  return (
    <div className="segmented small" role="radiogroup" aria-label={label}>
      {options.map((o) => (
        <button key={o.id} role="radio" aria-checked={value === o.id} className={value === o.id ? "on" : ""} onClick={() => onChange(o.id)}>
          {o.name}
        </button>
      ))}
    </div>
  );
}

const storedCategories = {
  notes: { label: "Saved annotations", action: "Clear annotations", question: "Clear all saved annotations?",
    detail: "This permanently removes the highlights, drawings, text boxes, notes, and bookmarks Folio saved on this device. Your PDF files are kept." },
  ai: { label: "Ask AI conversations", action: "Clear chats", question: "Clear all saved chats?",
    detail: "This permanently removes the Ask AI conversations Folio saved on this device." },
} as const;

function StoredData() {
  const [open, setOpen] = useState(false);
  const [counts, setCounts] = useState<Awaited<ReturnType<typeof countStoredData>> | null>(null);
  const [confirm, setConfirm] = useState<StoredCategory | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const trigger = useRef<HTMLButtonElement | null>(null);
  const summary = useRef<HTMLElement>(null);

  useEffect(() => {
    if (!open) return;
    let active = true;
    const refresh = async () => {
      try {
        const next = await countStoredData();
        if (active) setCounts(next);
      } catch {
        if (active) setError(translateUi("Couldn't count stored documents. Close and reopen this section to try again."));
      }
    };
    void refresh();
    const stop = onStoredDataCleared(() => void refresh());
    return () => { active = false; stop(); };
  }, [open]);

  const cancel = () => { setConfirm(null); trigger.current?.focus(); };
  const clear = async (kind: StoredCategory) => {
    setBusy(true);
    setError("");
    try {
      await clearStoredData(kind);
      setCounts(current => current && { ...current, [kind]: 0 });
      setConfirm(null);
      summary.current?.focus();
    } catch { setError(translateUi("Couldn't clear the saved data. Try again.")); }
    finally { setBusy(false); }
  };

  return <details className="settings-section stored-data" onToggle={event => {
    setOpen(event.currentTarget.open);
    if (!event.currentTarget.open) { setConfirm(null); setError(""); setCounts(null); }
  }}>
    <summary ref={summary}><Icon name="chevronRight" size={15} />{translateUi("Stored data")}</summary>
    {open && <div className="stored-body">
      <p className="stored-hint">{translateUi("Includes documents no longer in Recent.")}</p>
      {(["notes", "ai"] as const).map(kind => {
        const { label, action } = storedCategories[kind];
        const count = counts?.[kind];
        return <Row key={kind} label={translateKnownUi(label)} hint={count === undefined ? "…" : translateUi("{v0} document{v1}", { v0: count, v1: count === 1 ? "" : "s" })}>
          <button className="btn ghost" disabled={!count || busy} onClick={event => {
            trigger.current = event.currentTarget;
            setError("");
            setConfirm(kind);
          }}>{translateKnownUi(action)}…</button>
        </Row>;
      })}
      {confirm && <div key={confirm} className="stored-confirm" role="alertdialog" aria-labelledby="stored-question" aria-describedby="stored-detail"
        onKeyDown={event => { if (event.key === "Escape") { event.stopPropagation(); if (!busy) cancel(); } }}>
        <strong id="stored-question">{translateKnownUi(storedCategories[confirm].question)}</strong>
        <p id="stored-detail">{translateKnownUi(storedCategories[confirm].detail)}</p>
        <button className="btn ghost" autoFocus disabled={busy} onClick={cancel}>{translateUi("Cancel")}</button>
        <button className="btn primary" disabled={busy} onClick={() => void clear(confirm)}>{translateKnownUi(storedCategories[confirm].action)}</button>
      </div>}
      {error && <p className="form-error" role="alert">{error}</p>}
    </div>}
  </details>;
}

export function SettingsDialog({ initialSection = "General", theme, onTheme, night, onNight, wheelPaging, onWheelPaging, scanLanguages, onScanLanguages, onOpenChangelog, onClose }: Props) {
  const language = useLanguage();
  const desktop = window.folioDesktop;
  const ai = desktop?.ai;
  const [error, setError] = useState<string | null>(null);
  const [section, setSection] = useState<"General" | "Ask AI" | "Storage">(initialSection);

  // Updates
  const [info, setInfo] = useState<Awaited<ReturnType<FolioDesktop["getAppInfo"]>> | null>(null);
  const [status, setStatus] = useState<UpdateStatus>({ state: "idle" });
  const [autoUpdate, setAutoUpdate] = useState<boolean | null>(null);
  const [savingUpdate, setSavingUpdate] = useState(false);
  useEffect(() => {
    if (!desktop) return;
    let cancelled = false;
    desktop.getAppInfo().then((i) => { if (!cancelled) setInfo(i); }).catch(() => {});
    desktop.getAutoUpdateEnabled().then((on) => { if (!cancelled) setAutoUpdate(on); }).catch(() => {});
    const unsubscribe = desktop.onUpdateStatus(setStatus);
    return () => { cancelled = true; unsubscribe?.(); };
  }, [desktop]);
  // Installed Windows copies and Linux AppImages update themselves; Macs check and offer the download.
  const updatable = info?.mode === "installed" || info?.mode === "appimage";
  // Unsigned Mac builds only announce updates (with a download link); signed ones install them.
  const notifyOnly = !!info?.notifyOnly;

  // Ask AI
  const [aiStatus, setAiStatus] = useState<AiStatus | null>(null);
  const [provider, setProvider] = useState(savedProvider);
  const [signingIn, setSigningIn] = useState(false);
  useEffect(() => {
    if (section !== "Ask AI") return;
    let current = true;
    void ai?.status().then(value => { if (current) setAiStatus(value); })
      .catch(() => { if (current) setError(translateUi("Couldn't check the provider connections.")); });
    return () => { current = false; };
  }, [ai, section]);

  // Signature
  const [savedSignature, setSavedSignature] = useState(() => {
    try { return !!localStorage.getItem("folio:signature"); } catch { return false; }
  });

  return (
    <Modal title={t("settings")} onClose={onClose}>
      <div className="settings">
        <nav className="settings-nav" aria-label={translateUi("Settings sections")}>
          {(["General", "Ask AI", "Storage"] as const).filter(name => name !== "Ask AI" || ai).map(name =>
            <button key={name} type="button" aria-current={section === name ? "page" : undefined}
              onClick={() => { setSection(name); setError(null); }}>{name === "General" ? t("general") : name === "Storage" ? t("storage") : translateUi("Ask AI")}</button>)}
        </nav>
        {section === "General" && <><Section title={t("language")} >
          <Row label={t("language")}><Choice label={t("language")} value={language} onChange={(value: Language) => {
            if (!setLanguage(value)) setError(t("languageSaveFailed"));
          }} options={[{ id: "system", name: t("system") }, { id: "en", name: t("english") }, { id: "es", name: t("spanish") }]} /></Row>
        </Section><Section title={t("appearance")}>
          <Row label={t("theme")}>
            <Choice label={t("theme")} value={theme === "dark" ? "dark" : "light"} onChange={onTheme}
              options={[{ id: "light", name: t("light") }, { id: "dark", name: t("dark") }]} />
          </Row>
          <Row label={t("darkMode")} hint={t("darkModeHint")}>
            <Switch label={t("darkMode")} checked={night} onChange={onNight} />
          </Row>
        </Section>

        <Section title={t("reading")}>
          <Row label={t("wheel")} hint={t("wheelHint")}>
            <Switch label={t("wheel")} checked={wheelPaging} onChange={onWheelPaging} />
          </Row>
          <Row label={t("scan")} hint={t("scanHint")}>
            <ScanLanguagePicker value={scanLanguages} onChange={onScanLanguages} />
          </Row>
        </Section>

        </>}

        {ai && section === "Ask AI" && (
          <section className="settings-section">
            <Row label={translateUi("Provider")}>
              <select aria-label={translateUi("Ask AI provider")} className="ai-provider" value={provider} onChange={event => {
                const next = event.target.value as AiProvider;
                setProvider(next); setError(null); saveAiPreference("folio:ai-provider", next);
              }}>{Object.entries(PROVIDERS).map(([id, name]) => <option key={id} value={id}>{name}</option>)}</select>
            </Row>
            {provider === "chatgpt" && <Row
              label="ChatGPT"
              hint={!aiStatus ? translateUi("Checking…") : aiStatus.chatgpt.connected
                ? <>{translateUi("Signed in")}{aiStatus.chatgpt.email ? translateUi(" as {v0}", { v0: aiStatus.chatgpt.email }) : ""}{translateUi(". Uses your ChatGPT plan ·")} <a href={USAGE_URL} target="_blank" rel="noreferrer">{translateUi("Manage usage")}</a></>
                : translateUi("Use your ChatGPT plan (Go, Plus, or Pro). No API key needed.")}
            >
              {aiStatus?.chatgpt.connected ? (
                <button className="btn ghost" onClick={async () => setAiStatus({ ...aiStatus, chatgpt: await ai!.signOutChatGPT() })}>{translateUi("Sign out")}</button>
              ) : (
                <button className="btn primary" disabled={!aiStatus} onClick={async () => {
                  setSigningIn(true);
                  setError(null);
                  const result = await signInChatGPT(ai!);
                  setSigningIn(false);
                  setError(result.error);
                  setAiStatus(result.status);
                }}>{signingIn ? translateUi("Open the sign-in page again") : translateUi("Continue with ChatGPT")}</button>
              )}
            </Row>}
            {provider === "claude" && <Row
              label="Claude"
              hint={!aiStatus ? translateUi("Checking…") : !aiStatus.claude.installed
                ? <>{translateUi("Uses your Claude subscription through")} <a href={CLAUDE_CODE_URL} target="_blank" rel="noreferrer">{translateUi("Claude Code")}</a>{translateUi(". Install it and sign in once.")}</>
                : aiStatus.claude.loggedIn
                  ? translateUi("Claude Code {v0} is signed in{v1}.", { v0: aiStatus.claude.version ?? "", v1: aiStatus.claude.subscription ? translateUi(" with your Claude subscription") : "" })
                  : translateUi("Claude Code is installed but not signed in. Run claude in a terminal and sign in.")}
            >
              <button className="btn ghost" disabled={!aiStatus} onClick={async () => setAiStatus({ ...aiStatus!, claude: await ai!.recheckClaude() })}>{translateUi("Check again")}</button>
            </Row>}
            {provider === "openrouter" && (aiStatus ? <OpenRouterSettings ai={ai} configured={!!aiStatus.openrouter?.configured}
              onConfigured={configured => setAiStatus({ ...aiStatus, openrouter: { configured } })} /> : <p className="settings-hint">{translateUi("Checking connection…")}</p>)}
          </section>
        )}

        {section === "Storage" && <><StoredData /><Section title={translateUi("Signature")}>
          <Row label={translateUi("Remembered signature")} hint={savedSignature
            ? translateUi("Saved on this computer (unencrypted) for quick signing.")
            : translateUi("None. You can choose to remember one when you sign a document.")}>
            <button className="btn ghost" disabled={!savedSignature} onClick={() => {
              try { localStorage.removeItem("folio:signature"); setSavedSignature(false); }
              catch { setError(translateUi("Couldn't forget the signature. Please try again.")); }
            }}>{translateUi("Forget")}</button>
          </Row>
        </Section></>}

        {desktop && section === "General" && (
          <Section title={translateUi("Updates")}>
            {updatable && (
              <Row label={translateUi("Automatic updates")} hint={autoUpdate === false
                ? translateUi("Off: no background checks or downloads. You can still check manually.")
                : notifyOnly
                  ? translateUi("Folio checks for new versions and lets you know; download them from the releases page.")
                  : translateUi("Downloads updates in the background and installs them when Folio closes.")}>
                <Switch label={translateUi("Automatic updates")} checked={autoUpdate === true} disabled={autoUpdate === null || savingUpdate} onChange={async (on) => {
                  setSavingUpdate(true);
                  setError(null);
                  try { setAutoUpdate(await desktop.setAutoUpdateEnabled(on)); }
                  catch { setError(translateUi("Couldn't save the update setting. Try again.")); }
                  finally { setSavingUpdate(false); }
                }} />
              </Row>
            )}
            <Row label={`Folio ${info?.version ?? ""}`.trim()} hint={updateSummary(status) || (status.checkedAt ? translateUi("Last checked {v0}", { v0: new Date(status.checkedAt).toLocaleString(locale()) }) : undefined)}>
              {updatable ? (
                <button className="btn ghost" disabled={status.state === "checking" || status.state === "downloading"}
                  onClick={() => status.state === "ready" ? desktop.installUpdate() : status.state === "available" ? void desktop.openDownload() : desktop.checkForUpdates()}>
                  {status.state === "ready" ? translateUi("Restart and update") : status.state === "available" ? translateUi("Download {v0}", { v0: status.version }) : translateUi("Check for updates")}
                </button>
              ) : null}
            </Row>
          </Section>
        )}

        {section === "General" && <Section title={translateUi("About")}>
          <Row label={translateUi("What's new")} hint={translateUi("Changes in each version of Folio.")}>
            <button className="btn ghost" onClick={onOpenChangelog}>{translateUi("View changelog")}</button>
          </Row>
        </Section>}

        {error && <p className="form-error">{error}</p>}
      </div>
    </Modal>
  );
}
