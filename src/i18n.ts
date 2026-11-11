import { useSyncExternalStore } from "react";
import { readSetting, writeSetting } from "./preferences";

const en = {
  back: "Back", forward: "Forward", newTab: "New tab", closeDocument: "Close document", saveCopy: "Save a copy",
  history: "Version history", print: "Print", info: "Document info", focus: "Focus mode", shortcuts: "Keyboard shortcuts", about: "About Folio",
  languageSaveFailed: "Could not save the language preference.",
  language: "Language", system: "System", english: "English", spanish: "Español",
  settings: "Settings", general: "General", storage: "Storage", appearance: "Appearance", theme: "Theme",
  light: "Light", dark: "Dark", darkMode: "PDF dark mode", darkModeHint: "Dims bright pages for night reading. Images keep their colors.",
  reading: "Reading", wheel: "Scroll one page at a time", wheelHint: "Turn a page with each mouse wheel click or trackpad swipe.",
  scan: "Scan languages", scanHint: "Download languages once to recognize scans offline.",
  hero: "Read beautifully.", heroHint: "A calm, fast PDF reader. Your files never leave this device.",
  opening: "Opening…", openPdf: "Open a PDF", dropDesktop: "Drop a PDF, a Word document, a link, or a webpage anywhere, or click to browse",
  dropWeb: "Drop a PDF, a link, or a webpage anywhere, or click to browse", openUrl: "Open from URL", sample: "Try a sample document",
  recent: "Recent", clearAll: "Clear all", clearRecent: "Remove all recent files from Folio? The original files aren't affected.",
  removeRecent: "Remove from recent", justNow: "Just now", minutesAgo: "{count}m ago", hoursAgo: "{count}h ago", daysAgo: "{count}d ago",
  page: "page", pages: "pages", more: "More", checkUpdates: "Check for updates", upToDate: "Up to date",
  restartUpdate: "Restart to update to {version}", downloadFolio: "Download Folio {version}", updateFailed: "Couldn't check for updates",
} as const;
const es: { [K in keyof typeof en]: string } = {
  back: "Atrás", forward: "Adelante", newTab: "Nueva pestaña", closeDocument: "Cerrar documento", saveCopy: "Guardar una copia",
  history: "Historial de versiones", print: "Imprimir", info: "Información del documento", focus: "Modo de concentración", shortcuts: "Atajos de teclado", about: "Acerca de Folio",
  languageSaveFailed: "No se pudo guardar la preferencia de idioma.",
  language: "Idioma", system: "Sistema", english: "English", spanish: "Español",
  settings: "Configuración", general: "General", storage: "Almacenamiento", appearance: "Apariencia", theme: "Tema",
  light: "Claro", dark: "Oscuro", darkMode: "Modo oscuro para PDF", darkModeHint: "Atenúa las páginas claras para leer de noche. Las imágenes conservan sus colores.",
  reading: "Lectura", wheel: "Desplazar una página a la vez", wheelHint: "Cambia de página con cada movimiento de la rueda o del panel táctil.",
  scan: "Idiomas de escaneo", scanHint: "Descarga los idiomas una vez para reconocer escaneos sin conexión.",
  hero: "Disfruta la lectura.", heroHint: "Un lector de PDF rápido y sencillo. Tus archivos nunca salen de este dispositivo.",
  opening: "Abriendo…", openPdf: "Abrir un PDF", dropDesktop: "Arrastra un PDF, un documento de Word, un enlace o una página web, o haz clic para buscar",
  dropWeb: "Arrastra un PDF, un enlace o una página web, o haz clic para buscar", openUrl: "Abrir desde una URL", sample: "Probar un documento de ejemplo",
  recent: "Recientes", clearAll: "Borrar todo", clearRecent: "¿Quitar todos los archivos recientes de Folio? Los archivos originales no se modifican.",
  removeRecent: "Quitar de recientes", justNow: "Ahora mismo", minutesAgo: "hace {count} min", hoursAgo: "hace {count} h", daysAgo: "hace {count} d",
  page: "página", pages: "páginas", more: "Más", checkUpdates: "Buscar actualizaciones", upToDate: "Actualizado",
  restartUpdate: "Reiniciar para actualizar a {version}", downloadFolio: "Descargar Folio {version}", updateFailed: "No se pudieron buscar actualizaciones",
};
export type Language = "system" | "en" | "es";
const key = "folio:language";
const systemLocale = (() => {
  try { return (window.folioDesktop ?? window.parent.folioDesktop)?.systemLocale || navigator.language; }
  catch { return navigator.language; }
})();
let preference: Language = (() => { const value = readSetting(key); return value === "en" || value === "es" ? value : "system"; })();
const listeners = new Set<() => void>();
export function locale(): "en" | "es" { return preference === "system" ? (/^es(?:[-_]|$)/i.test(systemLocale) ? "es" : "en") : preference; }
function changed() {
  document.documentElement.lang = locale();
  window.folioDesktop?.setLanguage(preference);
  listeners.forEach(fn => fn());
}
export function setLanguage(value: Language): boolean {
  preference = value;
  const saved = writeSetting(key, value);
  changed();
  return saved;
}
window.addEventListener("storage", event => {
  if (event.key !== key && event.key !== null) return;
  const value = readSetting(key);
  preference = value === "en" || value === "es" ? value : "system";
  changed();
});
export function useLanguage() {
  return useSyncExternalStore(fn => { listeners.add(fn); return () => listeners.delete(fn); }, () => preference);
}
export function t(id: keyof typeof en, values: Record<string, string | number> = {}): string {
  return (locale() === "es" ? es[id] : en[id]).replace(/\{(\w+)\}/g, (_, name: string) => String(values[name] ?? `{${name}}`));
}
changed();
