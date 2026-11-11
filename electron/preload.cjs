// Minimal bridge between the Folio page and the desktop shell.
const { contextBridge, ipcRenderer, webUtils } = require("electron");

contextBridge.exposeInMainWorld("folioDesktop", {
  getPrinters: () => ipcRenderer.invoke("folio:printers"),
  printSheets: (job) => ipcRenderer.invoke("folio:print-sheets", job),
  /** Called with (name, data, note?) whenever a PDF is opened from Explorer, or a Word document has been converted. */
  onOpenFile(callback) {
    const listener = (_e, file) => callback(file.name, new Uint8Array(file.data), file.note ?? undefined, file.token);
    ipcRenderer.on("folio:open-file", listener);
    return () => ipcRenderer.removeListener("folio:open-file", listener);
  },
  /** Called with the file name when a Word document starts converting, and with a message if it fails. */
  onConverting(callback) {
    const listener = (_e, file) => callback(file.name, file.token);
    ipcRenderer.on("folio:converting", listener);
    return () => ipcRenderer.removeListener("folio:converting", listener);
  },
  onOpenFailed(callback) {
    const listener = (_e, failure) => callback(failure.message, failure.token);
    ipcRenderer.on("folio:open-failed", listener);
    return () => ipcRenderer.removeListener("folio:open-failed", listener);
  },
  onTabCommand(callback) {
    const listener = (_e, command) => callback(command);
    ipcRenderer.on("folio:tab-command", listener);
    return () => ipcRenderer.removeListener("folio:tab-command", listener);
  },
  /** Returns the converted PDF to the tab that opened the Word document. */
  async openDocument(file) {
    const result = await ipcRenderer.invoke("folio:open-document", webUtils.getPathForFile(file));
    if (result.error) throw new Error(result.error);
    return result;
  },
  ready: () => ipcRenderer.invoke("folio:ready"),
  platform: process.platform,
  systemLocale: ipcRenderer.sendSync("folio:system-locale"),
  setLanguage: (language) => ipcRenderer.send("folio:language", language),
  openDownload: () => ipcRenderer.invoke("folio:open-download"),
  downloadOcrModel: (code) => ipcRenderer.invoke("folio:download-ocr-model", code),
  /**
   * Downloads a PDF from an http(s) link; resolves to { name, data: Uint8Array }, or null if the user said no
   * or the request was stopped with cancelFetchPdf(id).
   */
  async fetchPdf(url, id) {
    const file = await ipcRenderer.invoke("folio:fetch-pdf", url, id);
    if (file.cancelled) return null;
    if (file.error) throw new Error(file.error);
    return { name: file.name, data: new Uint8Array(file.data) };
  },
  cancelFetchPdf: (id) => ipcRenderer.invoke("folio:cancel-fetch-pdf", id),
  getAppInfo: () => ipcRenderer.invoke("folio:app-info"),
  openInstallation: () => ipcRenderer.invoke("folio:open-installation"),
  setTheme: (theme) => ipcRenderer.send("folio:theme", theme),
  installUpdate: () => ipcRenderer.send("folio:install-update"),
  /** Called with the updater state ({ state, version?, percent?, message? }) now and whenever it changes. */
  onUpdateStatus(callback) {
    const listener = (_e, status) => callback(status);
    ipcRenderer.on("folio:update-status-changed", listener);
    ipcRenderer.invoke("folio:update-state").then(callback);
    return () => ipcRenderer.removeListener("folio:update-status-changed", listener);
  },
  checkForUpdates: () => ipcRenderer.send("folio:check-update"),
  getAutoUpdateEnabled: () => ipcRenderer.invoke("folio:auto-update-setting"),
  setAutoUpdateEnabled: (enabled) => ipcRenderer.invoke("folio:set-auto-update-setting", enabled),
  /** Each call resolves to { error } on failure; chooseCertificate and sign resolve to null when the user cancels. */
  signing: {
    chooseCertificate: () => ipcRenderer.invoke("folio:signing-choose-certificate"),
    savedCertificates: () => ipcRenderer.invoke("folio:signing-saved-certificates"),
    useSaved: (savedId) => ipcRenderer.invoke("folio:signing-use-saved", savedId),
    forgetSaved: (savedId) => ipcRenderer.invoke("folio:signing-forget-saved", savedId),
    readCertificate: (id, password) => ipcRenderer.invoke("folio:signing-read-certificate", id, password),
    forget: () => ipcRenderer.invoke("folio:signing-forget"),
    async sign(request) {
      const result = await ipcRenderer.invoke("folio:signing-sign", request);
      return result && !result.error ? { name: result.name, data: new Uint8Array(result.data) } : result;
    },
  },
  ai: {
    status: () => ipcRenderer.invoke("folio:ai-status"),
    signInChatGPT: () => ipcRenderer.invoke("folio:ai-chatgpt-signin"),
    signOutChatGPT: () => ipcRenderer.invoke("folio:ai-chatgpt-signout"),
    chatgptWelcomeSeen: () => ipcRenderer.invoke("folio:ai-chatgpt-welcome-seen"),
    chatgptModels: () => ipcRenderer.invoke("folio:ai-chatgpt-models"),
    recheckClaude: () => ipcRenderer.invoke("folio:ai-claude-recheck"),
    openRouterKey: (action, key) => ipcRenderer.invoke("folio:ai-router-key", action, key),
    openRouterModels: () => ipcRenderer.invoke("folio:ai-router-models"),
    ask: (request) => ipcRenderer.invoke("folio:ai-ask", request),
    cancel: (id) => ipcRenderer.invoke("folio:ai-cancel", id),
    /** Called with { id, type: "delta" | "done" | "error", text?, message?, code?, link? } for every answer. */
    onEvent(callback) {
      const listener = (_e, event) => callback(event);
      ipcRenderer.on("folio:ai-event", listener);
      return () => ipcRenderer.removeListener("folio:ai-event", listener);
    },
  },
});
