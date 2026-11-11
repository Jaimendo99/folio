import { translateUi } from "./i18n";
import { keys, set } from "idb-keyval";
import { downloadOcrModel } from "../electron/ocr-download.mjs";
import catalog from "../electron/ocr-models.json";
import { SCAN_LANGUAGES, scanLanguageName, type ScanLanguage } from "./scanLanguage";

// Tesseract's browser worker reads these IndexedDB keys before looking in its local langPath.
export const OCR_CACHE_PATH = catalog.baseUrl.slice(0, -1);
const cacheKey = (code: ScanLanguage) => `${OCR_CACHE_PATH}/${code}.traineddata`;

export async function installedScanLanguages(): Promise<Set<ScanLanguage>> {
  const stored = new Set(await keys());
  return new Set(SCAN_LANGUAGES.filter(({ id }) => id === "eng" || stored.has(cacheKey(id))).map(({ id }) => id));
}

export async function installScanLanguage(code: ScanLanguage, signal: AbortSignal) {
  if (code === "eng") return;
  const install = async () => {
    if ((await installedScanLanguages()).has(code)) return;
    const name = scanLanguageName(code);
    let data: Uint8Array;
    try {
      data = window.folioDesktop ? await window.folioDesktop.downloadOcrModel(code)
        : await downloadOcrModel(code, fetch, AbortSignal.any([signal, AbortSignal.timeout(90_000)]));
    } catch {
      throw new Error(translateUi("Couldn't download and verify the {v0} pack. Check your connection and try again.", { v0: name }));
    }
    signal.throwIfAborted();
    try { await set(cacheKey(code), data); }
    catch { throw new Error(translateUi("Couldn't save the {v0} pack. Check available storage and try again.", { v0: name })); }
  };
  if (navigator.locks) await navigator.locks.request(cacheKey(code), { signal }, install);
  else await install();
}
