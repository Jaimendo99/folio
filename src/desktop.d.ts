interface UpdateStatus {
  state: "idle" | "unsupported" | "checking" | "latest" | "available" | "downloading" | "ready" | "error";
  version?: string;
  percent?: number;
  message?: string;
  checkedAt?: number;
}

// Present only when Folio runs as the desktop app (see electron/preload.cjs).
interface FolioDesktop {
  getPrinters(): Promise<{ name: string; displayName: string; isDefault: boolean }[]>;
  printSheets(job: { images: string[]; paper: "Letter" | "A4" | "Legal"; landscape: boolean; dpi: 150 | 300 | 600;
    copies: number; printer: string; booklet: boolean }): Promise<{ ok: boolean; error?: string }>;
  /** `note` says where a converted Word document's PDF was saved. */
  onOpenFile(callback: (name: string, data: Uint8Array, note?: string, token?: string) => void): () => void;
  onConverting(callback: (name: string, token: string) => void): () => void;
  onOpenFailed(callback: (message: string, token: string) => void): () => void;
  onTabCommand(callback: (command: "new" | "close" | "next" | "previous") => void): () => void;
  openDocument(file: File): Promise<{ name: string; data: Uint8Array; note?: string }>;
  ready(): Promise<boolean>;
  /** Null when the user declines to open an address on their computer or local network, or the request is stopped. */
  fetchPdf(url: string, id: string): Promise<{ name: string; data: Uint8Array } | null>;
  /** Stops the fetchPdf request that was started with this id (it then resolves to null). */
  cancelFetchPdf(id: string): Promise<boolean>;
  getAppInfo(): Promise<{ version: string; mode: "development" | "portable" | "installed" | "appimage" | "package"; location: string; platform: string;
    /** True when updates are announced with a download link instead of installed (unsigned macOS builds). */
    notifyOnly: boolean }>;
  /** "win32", "darwin", or "linux". */
  platform: string;
  /** Opens the releases page (macOS, where updates are downloaded manually). */
  openDownload(): Promise<void>;
  downloadOcrModel(code: string): Promise<Uint8Array<ArrayBuffer>>;
  openInstallation(): Promise<string>;
  setTheme(theme: string): void;
  installUpdate(): void;
  onUpdateStatus(callback: (status: UpdateStatus) => void): () => void;
  checkForUpdates(): void;
  getAutoUpdateEnabled(): Promise<boolean>;
  setAutoUpdateEnabled(enabled: boolean): Promise<boolean>;
  ai: FolioAi;
  signing: FolioSigning;
}

interface CertificateInfo {
  name: string;
  /** The issuing provider (issuer organization, or its common name). */
  provider: string;
  serial: string;
  validFrom: string;
  validTo: string;
  expired: boolean;
  notYetValid: boolean;
}

/** A certificate the user chose to remember: public details only. Its path stays in the desktop shell. */
interface SavedCertificate {
  id: string;
  fileName: string;
  name: string;
  provider: string;
  serial: string;
  validTo: string;
  expired: boolean;
  /** The file is no longer where it was saved. */
  missing: boolean;
}

interface ChosenCertificate {
  id: string;
  name: string;
  /** Already in the saved list. */
  saved: boolean;
}

interface FolioSigning {
  /** Null when the user cancels the file picker. */
  chooseCertificate(): Promise<ChosenCertificate | { error: string } | null>;
  savedCertificates(): Promise<SavedCertificate[]>;
  /** Opens a saved certificate by its id; `missing` when its file has moved or been deleted. */
  useSaved(savedId: string): Promise<ChosenCertificate | { error: string; missing?: boolean }>;
  /** Removes a saved certificate from the list and returns what's left. */
  forgetSaved(savedId: string): Promise<SavedCertificate[]>;
  readCertificate(id: string, password: string): Promise<CertificateInfo | { error: string }>;
  forget(): Promise<boolean>;
  /**
   * Signs, asks where to save the copy, and returns it; null when the user cancels saving. With `remember`, the
   * certificate's path and public details are saved for next time once it has signed.
   */
  sign(request: { id: string; password: string; pdf: Uint8Array; page: number; rect?: number[]; field?: string; reason: string; location: string;
    name: string; remember?: boolean }):
    Promise<{ name: string; data: Uint8Array } | { error: string } | null>;
}

interface AiStatus {
  openrouter: { configured: boolean };
  chatgpt: { connected: boolean; email: string; name: string; welcomeSeen: boolean; encrypted: boolean };
  claude: { installed: boolean; loggedIn: boolean; version?: string; subscription?: boolean; authMethod?: string };
}

interface AiMessage {
  role: "user" | "assistant";
  content: string;
  context?: { text: string; page: number };
}

interface AiEvent {
  id: string;
  type: "delta" | "done" | "error";
  text?: string;
  message?: string;
  code?: string;
  link?: string;
}

interface FolioAi {
  status(): Promise<AiStatus>;
  signInChatGPT(): Promise<{ ok: boolean; status?: AiStatus["chatgpt"]; error?: string }>;
  signOutChatGPT(): Promise<AiStatus["chatgpt"]>;
  chatgptWelcomeSeen(): Promise<boolean>;
  chatgptModels(): Promise<{ ok: boolean; models?: { id: string; name: string }[]; error?: string; code?: string }>;
  recheckClaude(): Promise<AiStatus["claude"]>;
  openRouterKey(action: "save" | "check" | "remove", key?: string): Promise<{ ok: boolean; configured?: boolean; error?: string }>;
  openRouterModels(): Promise<{ ok: boolean; models?: OpenRouterModel[]; error?: string }>;
  ask(request: { id: string; provider: "chatgpt" | "claude" | "openrouter"; model: string; document: { name: string; text: string; truncated: boolean };
    messages: AiMessage[] }): Promise<boolean>;
  cancel(id: string): Promise<boolean>;
  onEvent(callback: (event: AiEvent) => void): () => void;
}

interface OpenRouterModel { id: string; name: string; contextLength: number | null }

interface Window {
  folioDesktop?: FolioDesktop;
}
