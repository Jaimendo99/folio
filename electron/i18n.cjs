// Main-process messages are kept here because the sandboxed renderer cannot load Node modules.
const en = {
  openFile: "Couldn't open file", cameraTitle: "Use camera for signature?",
  cameraMessage: "Allow Folio to use your camera to capture a signature?",
  cameraDetail: "Camera images are processed on this device. No microphone is requested.",
  allowCamera: "Allow camera", cancel: "Cancel", closeWithoutSaving: "Close without saving",
  unsavedTitle: "Unsaved changes", unsavedMessage: "One or more tabs have unsaved changes.",
  unsavedDetail: "Press {shortcut} in each marked tab to save a copy before closing Folio.",
  openLinkTitle: "Open link?", openMailMessage: "Open this email link in your mail app?",
  openBrowserMessage: "Open {host} in your browser?", openMail: "Open mail app", openLink: "Open link",
  localTitle: "Open a local address?", localMessage: "Open {host}?",
  localDetail: "Allow {origin} to connect to the following resolved addresses?\n\n{addresses}\n\n{url}",
  open: "Open", chooseCertificate: "Choose your certificate", certificates: "Certificates (.p12, .pfx)",
  saveSigned: "Save signed copy",
};
const es = {
  openFile: "No se pudo abrir el archivo", cameraTitle: "¿Usar la cámara para la firma?",
  cameraMessage: "¿Permitir que Folio use la cámara para capturar una firma?",
  cameraDetail: "Las imágenes de la cámara se procesan en este dispositivo. No se solicita acceso al micrófono.",
  allowCamera: "Permitir cámara", cancel: "Cancelar", closeWithoutSaving: "Cerrar sin guardar",
  unsavedTitle: "Cambios sin guardar", unsavedMessage: "Una o más pestañas tienen cambios sin guardar.",
  unsavedDetail: "Presiona {shortcut} en cada pestaña marcada para guardar una copia antes de cerrar Folio.",
  openLinkTitle: "¿Abrir enlace?", openMailMessage: "¿Abrir este enlace de correo en tu aplicación de correo?",
  openBrowserMessage: "¿Abrir {host} en tu navegador?", openMail: "Abrir aplicación de correo", openLink: "Abrir enlace",
  localTitle: "¿Abrir una dirección local?", localMessage: "¿Abrir {host}?",
  localDetail: "¿Permitir que {origin} se conecte a las siguientes direcciones resueltas?\n\n{addresses}\n\n{url}",
  open: "Abrir", chooseCertificate: "Elegir certificado", certificates: "Certificados (.p12, .pfx)",
  saveSigned: "Guardar copia firmada",
};
let language = "en";
function setLanguage(choice, systemLocale) {
  language = choice === "es" || (choice === "system" && /^es(?:[-_]|$)/i.test(systemLocale)) ? "es" : "en";
}
function t(key, values = {}) {
  return (language === "es" ? es[key] : en[key]).replace(/\{(\w+)\}/g, (_, name) => String(values[name] ?? `{${name}}`));
}
module.exports = { setLanguage, t };
