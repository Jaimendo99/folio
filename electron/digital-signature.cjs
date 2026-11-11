const { t, currentLanguage } = require("./i18n.cjs");
// Digital signatures (PAdES, adbe.pkcs7.detached) made with a .p12/.pfx certificate, plus a visible stamp.
// Runs in the main process only, so the private key never reaches the page.
// node-forge reads the certificate because many issuers (Ecuador's Banco Central, Security Data, Uanataca, ANF...)
// still protect theirs with RC2/3DES, which Node's OpenSSL 3 refuses.
const crypto = require("node:crypto");
const forge = require("node-forge");
const QRCode = require("qrcode");
const {
  PDFArray, PDFDocument, PDFHexString, PDFInvalidObject, PDFName, PDFNumber, PDFRef, PDFSignature, PDFString,
  StandardFonts, beginText, endText, fill, popGraphicsState, pushGraphicsState, rectangle, setFillingGrayscaleColor,
  setFontAndSize, setTextMatrix, showText,
} = require("pdf-lib");
const { SignPdf, Signer } = require("@signpdf/signpdf");
const { DEFAULT_BYTE_RANGE_PLACEHOLDER, SUBFILTER_ADOBE_PKCS7_DETACHED, SIG_FLAGS, ANNOTATION_FLAGS } = require("@signpdf/utils");

const MAX_CERTIFICATE_BYTES = 1024 * 1024;
// Room for the CMS signature: the signer's certificate, its issuers and the signature itself.
const SIGNATURE_LENGTH = 16384;
const MAX_FIELD_NAME = 500;

class CertificateError extends Error {}

// forge hands back attribute values as the raw bytes of the certificate, so UTF8String and BMPString names
// (MARÍA JOSÉ PEÑA, AUTORIDAD DE CERTIFICACIÓN) need decoding here.
function field(name, short) {
  const attribute = name.getField(short);
  let value = attribute?.value;
  if (typeof value !== "string") return "";
  try {
    if (attribute.valueTagClass === forge.asn1.Type.UTF8) value = forge.util.decodeUtf8(value);
    else if (attribute.valueTagClass === forge.asn1.Type.BMPSTRING) value = Buffer.from(value, "binary").swap16().toString("utf16le");
  } catch { /* not valid UTF-8: show the bytes as they are */ }
  return value.trim();
}

/** False for CA certificates and for ones whose key usage leaves out signing. */
function canSign(cert) {
  if (cert.getExtension("basicConstraints")?.cA) return false;
  const usage = cert.getExtension("keyUsage");
  return !usage || !!(usage.digitalSignature || usage.nonRepudiation);
}

/** Decrypts the certificate and picks the signing identity: the end-entity certificate that matches a private key. */
function openP12(data, password) {
  if (!data || data.length === 0 || data.length > MAX_CERTIFICATE_BYTES) throw new CertificateError(t("This isn't a .p12 or .pfx certificate."));
  let asn1;
  try { asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(data).toString("binary"))); }
  catch { throw new CertificateError(t("This isn't a .p12 or .pfx certificate.")); }
  let p12;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password ?? "")); }
  catch (error) {
    if (/password|mac/i.test(String(error?.message))) throw new CertificateError(t("Wrong password for this certificate."));
    // Without a MAC to check, a wrong password shows up as undecryptable contents.
    throw new CertificateError(t("Couldn't open the certificate. Check the password."));
  }
  const bags = (type) => p12.getBags({ bagType: type })[type] ?? [];
  const keyBags = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)];
  const certs = bags(forge.pki.oids.certBag).map(bag => bag.cert).filter(Boolean);
  if (!keyBags.length) throw new CertificateError(t("This certificate file has no private key, so it can't sign."));
  const keys = keyBags.map(bag => bag.key).filter(Boolean);
  if (!keys.length) throw new CertificateError(t("Only RSA certificates can sign in Folio."));

  // Some files hold several certificates and keys; the signer is the one whose public key matches a private key.
  const now = new Date();
  const pairs = [];
  for (const key of keys) {
    for (const cert of certs) {
      const pub = cert.publicKey;
      if (pub?.n && pub.n.equals(key.n) && pub.e.equals(key.e)) pairs.push({ key, cert });
    }
  }
  if (!pairs.length) throw new CertificateError(t("The private key in this file doesn't match any of its certificates."));
  // Validators reject signatures from CA certificates and from ones not issued for signing, so those never sign.
  const usable = pairs.filter(({ cert }) => canSign(cert));
  if (!usable.length) throw new CertificateError(t("This certificate isn't meant for signing documents. Choose your signing certificate."));
  const score = ({ cert }) => (cert.getExtension("keyUsage") ? 2 : 0)
    + (cert.validity.notBefore <= now && now <= cert.validity.notAfter ? 4 : 0);
  usable.sort((a, b) => score(b) - score(a));
  const { key, cert } = usable[0];
  return { key, cert, chain: certs.filter(other => other !== cert), info: describe(cert, now) };
}

function describe(cert, now = new Date()) {
  const name = field(cert.subject, "CN") || [field(cert.subject, "GN"), field(cert.subject, "SN")].filter(Boolean).join(" ") || t("Unknown signer");
  const provider = field(cert.issuer, "O") || field(cert.issuer, "CN") || t("Unknown issuer");
  return {
    name, provider, serial: cert.serialNumber,
    validFrom: cert.validity.notBefore.toISOString(), validTo: cert.validity.notAfter.toISOString(),
    expired: now > cert.validity.notAfter, notYetValid: now < cert.validity.notBefore,
  };
}

/** Signer name, issuer, serial and validity of a .p12/.pfx certificate. Throws CertificateError with a readable message. */
function readP12(data, password) {
  return openP12(data, password).info;
}

// The CMS is assembled from DER bytes here rather than with forge.pkcs7, which re-encodes names (garbling
// UTF8String issuers, so verifiers can't find the signer) and leaves the signed attributes in insertion order.
function der(tag, ...parts) {
  const body = Buffer.concat(parts);
  let length;
  if (body.length < 0x80) length = Buffer.from([body.length]);
  else {
    const bytes = [];
    for (let n = body.length; n > 0; n = Math.floor(n / 256)) bytes.unshift(n & 0xff);
    length = Buffer.from([0x80 | bytes.length, ...bytes]);
  }
  return Buffer.concat([Buffer.from([tag]), length, body]);
}
const bytesOf = (node) => Buffer.from(forge.asn1.toDer(node).getBytes(), "binary");
const oid = (id) => der(0x06, Buffer.from(forge.asn1.oidToDer(id).getBytes(), "binary"));
const algorithm = (id) => der(0x30, oid(id), Buffer.from([0x05, 0x00]));
const time = (date) => date.getUTCFullYear() >= 1950 && date.getUTCFullYear() < 2050
  ? der(0x17, Buffer.from(forge.asn1.dateToUtcTime(date), "latin1"))
  : der(0x18, Buffer.from(forge.asn1.dateToGeneralizedTime(date), "latin1"));
const certificateDer = (cert) => bytesOf(forge.pki.certificateToAsn1(cert));

/** The signed attributes as a DER SET OF: elements sorted by their encodings (X.690 11.6). */
function signedAttributes(digest, signingTime) {
  const attribute = (type, value) => der(0x30, oid(type), der(0x31, value));
  const attributes = [
    attribute(forge.pki.oids.contentType, oid(forge.pki.oids.data)),
    attribute(forge.pki.oids.messageDigest, der(0x04, digest)),
    attribute(forge.pki.oids.signingTime, time(signingTime)),
  ].sort(Buffer.compare);
  return der(0x31, ...attributes);
}

/** issuerAndSerialNumber copied from the certificate's own TBSCertificate, byte for byte. */
function issuerAndSerial(cert) {
  const fields = cert.tbsCertificate.value;
  const start = fields[0].tagClass === forge.asn1.Class.CONTEXT_SPECIFIC ? 1 : 0;
  return der(0x30, bytesOf(fields[start + 2]), bytesOf(fields[start]));
}

/** Detached CMS (SHA-256) over the signed byte ranges, with the certificate chain from the file. */
function createCms({ key, cert, chain }, content, signingTime) {
  const digest = crypto.createHash("sha256").update(content).digest();
  const attributes = signedAttributes(digest, signingTime);
  // RFC 5652 5.4: the signature covers the attributes as a SET OF; the SignerInfo carries the same bytes as [0].
  const md = forge.md.sha256.create();
  md.update(attributes.toString("binary"));
  const signature = Buffer.from(key.sign(md), "binary");
  const signerInfo = der(0x30,
    der(0x02, Buffer.from([1])),
    issuerAndSerial(cert),
    algorithm(forge.pki.oids.sha256),
    Buffer.concat([Buffer.from([0xa0]), attributes.subarray(1)]),
    algorithm(forge.pki.oids.rsaEncryption),
    der(0x04, signature));
  const signedData = der(0x30,
    der(0x02, Buffer.from([1])),
    der(0x31, algorithm(forge.pki.oids.sha256)),
    der(0x30, oid(forge.pki.oids.data)),
    der(0xa0, ...[cert, ...chain].map(certificateDer)),
    der(0x31, signerInfo));
  return der(0x30, oid(forge.pki.oids.signedData), der(0xa0, signedData));
}

class CmsSigner extends Signer {
  constructor(identity) { super(); this.identity = identity; }
  async sign(pdfBuffer, signingTime = new Date()) {
    return createCms(this.identity, pdfBuffer, signingTime);
  }
}

/** 2026-11-10T14:03:22-05:00: the signer's local time with its offset, as FirmaEC shows it. */
function localIso(date) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

// The standard PDF fonts cover WinAnsi (Spanish accents and Ñ included); anything else would make pdf-lib throw.
function printable(font, text) {
  return [...String(text).normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, " ")].map(character => {
    try { font.encodeText(character); font.widthOfTextAtSize(character, 1); return character; } catch { return "?"; }
  }).join("");
}

function wrap(font, text, size, width) {
  const lines = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    const next = line ? line + " " + word : word;
    if (!line || font.widthOfTextAtSize(next, size) <= width) { line = next; continue; }
    lines.push(line); line = word;
  }
  if (line) lines.push(line);
  // A single word wider than the box is cut rather than spilling over the page.
  return lines.map(part => {
    while (part.length > 1 && font.widthOfTextAtSize(part, size) > width) part = [...part].slice(0, -1).join("");
    return part;
  });
}

/** The stamp (QR code and signer details) as a form XObject `width` x `height` points, for the widget's appearance. */
async function stampAppearance(pdfDoc, width, height, { name, provider, date, reason, location }) {
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ops = [pushGraphicsState(), setFillingGrayscaleColor(0)];

  const payload = [`FIRMADO POR: ${name}`, `RAZON: ${reason}`, `LOCALIZACION: ${location}`, `FECHA: ${date}`, `EMISOR: ${provider}`].join("\n");
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const qrSide = Math.min(height, width * 0.4);
  const cell = qrSide / qr.size;
  const qrBottom = (height - qrSide) / 2;
  for (let row = 0; row < qr.size; row++) {
    // Runs of dark cells as one rectangle each keep the file small.
    for (let col = 0; col < qr.size;) {
      if (!qr.get(row, col)) { col++; continue; }
      let end = col;
      while (end < qr.size && qr.get(row, end)) end++;
      ops.push(rectangle(col * cell, qrBottom + qrSide - (row + 1) * cell, (end - col) * cell, cell));
      col = end;
    }
  }
  ops.push(fill());

  const textLeft = qrSide + Math.min(6, width * 0.03);
  const textWidth = width - textLeft;
  const entries = [
    { text: "Firmado electrónicamente por:", font: regular, scale: 0.85 },
    { text: name, font: bold, scale: 1.15 },
    { text: `Emisor: ${provider}`, font: regular, scale: 0.85 },
    { text: `Fecha: ${date}`, font: regular, scale: 0.85 },
    ...(reason ? [{ text: `Razón: ${reason}`, font: regular, scale: 0.85 }] : []),
    ...(location ? [{ text: `Localización: ${location}`, font: regular, scale: 0.85 }] : []),
  ].map(entry => ({ ...entry, text: printable(entry.font, entry.text) }));
  let lines = [];
  for (let size = 10; size >= 3; size -= 0.5) {
    lines = entries.flatMap(entry => wrap(entry.font, entry.text, size * entry.scale, textWidth)
      .map(text => ({ text, font: entry.font, size: size * entry.scale })));
    if (lines.reduce((sum, line) => sum + line.size * 1.2, 0) <= height) break;
  }
  const total = lines.reduce((sum, line) => sum + line.size * 1.2, 0);
  let y = Math.min(height, (height + total) / 2);
  ops.push(beginText());
  for (const line of lines) {
    y -= line.size * 1.2;
    if (y < -0.5) break;
    ops.push(setFontAndSize(line.font === bold ? "F2" : "F1", line.size), setTextMatrix(1, 0, 0, 1, textLeft, y + line.size * 0.25),
      showText(line.font.encodeText(line.text)));
  }
  ops.push(endText(), popGraphicsState());
  const stream = pdfDoc.context.formXObject(ops, {
    BBox: [0, 0, width, height], Resources: { Font: { F1: regular.ref, F2: bold.ref } },
  });
  return pdfDoc.context.register(stream);
}

/** PDF text: literal for ASCII, UTF-16 otherwise. */
const pdfText = (text) => /^[\x20-\x7e]*$/.test(text) ? PDFString.of(text) : PDFHexString.fromText(text);

/** The /Sig dictionary with the /ByteRange and /Contents placeholders that SignPdf fills in. */
function signatureDictionary(pdfDoc, { name, reason, location, now }) {
  const byteRange = PDFArray.withContext(pdfDoc.context);
  byteRange.push(PDFNumber.of(0));
  for (let i = 0; i < 3; i++) byteRange.push(PDFName.of(DEFAULT_BYTE_RANGE_PLACEHOLDER));
  const dict = pdfDoc.context.obj({
    Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: SUBFILTER_ADOBE_PKCS7_DETACHED,
    ByteRange: byteRange, Contents: PDFHexString.of("0".repeat(SIGNATURE_LENGTH)),
    Reason: pdfText(reason), M: PDFString.fromDate(now), ContactInfo: PDFString.of(""), Name: pdfText(name), Location: pdfText(location),
    Prop_Build: { Filter: { Name: "Adobe.PPKLite" }, App: { Name: "Folio" } },
  });
  // Written as plain bytes so it never lands in an object stream, where SignPdf couldn't find the placeholders.
  const bytes = new Uint8Array(dict.sizeInBytes());
  dict.copyBytesInto(bytes, 0);
  return pdfDoc.context.register(PDFInvalidObject.of(bytes));
}

/** The AcroForm, created if missing, with SigFlags set; returns its /Fields array (resolving an indirect one). */
function signatureForm(pdfDoc) {
  const form = pdfDoc.catalog.getOrCreateAcroForm().dict;
  const flags = form.lookupMaybe(PDFName.of("SigFlags"), PDFNumber)?.asNumber() ?? 0;
  form.set(PDFName.of("SigFlags"), PDFNumber.of(flags | SIG_FLAGS.SIGNATURES_EXIST | SIG_FLAGS.APPEND_ONLY));
  let fields = form.lookupMaybe(PDFName.of("Fields"), PDFArray);
  if (!fields) form.set(PDFName.of("Fields"), fields = pdfDoc.context.obj([]));
  return fields;
}

function pageIndexOf(pdfDoc, widgetRef, widget) {
  const pages = pdfDoc.getPages();
  const found = pages.findIndex(page => page.node.Annots()?.asArray().some(ref => ref === widgetRef || (ref instanceof PDFRef && widgetRef
    && ref.objectNumber === widgetRef.objectNumber && ref.generationNumber === widgetRef.generationNumber)));
  if (found >= 0) return found;
  const parent = widget.P();
  return parent ? pages.findIndex(page => page.ref === parent || page.ref.objectNumber === parent.objectNumber) : -1;
}

/** The unsigned signature field named `name` (its full name), with the widget to put the stamp in. */
function existingField(pdfDoc, name, preferredPage) {
  let fields = [];
  try { fields = pdfDoc.getForm().getFields(); } catch { /* no usable form */ }
  const target = fields.find(item => item.getName() === name);
  if (!target) throw new CertificateError(t("That signature field isn't in this document anymore. Choose another stamp position."));
  if (!(target instanceof PDFSignature)) throw new CertificateError(t("That field isn't a signature field."));
  if (target.acroField.dict.has(PDFName.of("V"))) throw new CertificateError(t("That signature field is already signed."));
  const widgets = target.acroField.getWidgets().map(widget => {
    const ref = pdfDoc.context.getObjectRef(widget.dict);
    return { widget, ref, pageIndex: pageIndexOf(pdfDoc, ref, widget) };
  }).filter(item => item.pageIndex >= 0);
  if (!widgets.length) throw new CertificateError(t("That signature field isn't on any page. Choose another stamp position."));
  return { field: target, ...(widgets.find(item => item.pageIndex === preferredPage - 1) ?? widgets[0]) };
}

/**
 * Signs with a visible stamp. With `field` (the full name of an unsigned signature field) the signature goes into that
 * field and its widget shows the stamp; otherwise a new field is added at `rect` (PDF points, [x0, y0, x1, y1]) on
 * `page` (1-based). The returned bytes are final: any later rewrite of the file would break the signature.
 */
async function signPdf(pdfBytes, { p12, password, page = 1, rect, field: fieldName, reason = "", location = "", now = new Date() }) {
  if (fieldName !== undefined && fieldName !== null && (typeof fieldName !== "string" || !fieldName || fieldName.length > MAX_FIELD_NAME)) {
    throw new CertificateError(t("That signature field isn't valid. Choose another stamp position."));
  }
  const identity = openP12(p12, password);
  const { info } = identity;
  const day = (iso) => new Intl.DateTimeFormat(currentLanguage(), { year: "numeric", month: "short", day: "numeric", timeZone: "UTC" }).format(new Date(iso));
  if (info.expired) throw new CertificateError(t("This certificate expired on {v0}. Signatures made with it aren't valid.", { v0: day(info.validTo) }));
  if (info.notYetValid) throw new CertificateError(t("This certificate is valid from {v0}.", { v0: day(info.validFrom) }));

  let pdfDoc;
  try { pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false }); }
  catch (error) {
    if (/encrypt/i.test(String(error?.message))) throw new CertificateError(t("Folio can't sign password-protected PDFs."));
    throw new CertificateError(t("Couldn't read this PDF for signing."));
  }
  if (pdfDoc.isEncrypted) throw new CertificateError(t("Folio can't sign password-protected PDFs."));
  // Folio rewrites the whole file to add the signature, which would break signatures already in it.
  let signed = false;
  try { signed = pdfDoc.getForm().getFields().some(f => f instanceof PDFSignature && f.acroField.dict.has(PDFName.of("V"))); } catch { /* no usable form */ }
  if (signed) throw new CertificateError(t("This PDF is already signed. Folio can't add another signature to it."));

  const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const details = { name: info.name, provider: info.provider, date: localIso(now), reason: clean(reason), location: clean(location) };
  const pages = pdfDoc.getPages();

  if (fieldName) {
    const { field: target, widget } = existingField(pdfDoc, fieldName, Number(page));
    const box = widget.getRectangle();
    if (box.width < 4 || box.height < 4) throw new CertificateError(t("That signature field is too small for a stamp. Choose another stamp position."));
    const appearance = await stampAppearance(pdfDoc, box.width, box.height, details);
    signatureForm(pdfDoc);
    target.acroField.dict.set(PDFName.of("V"), signatureDictionary(pdfDoc, { ...details, now }));
    widget.dict.set(PDFName.of("AP"), pdfDoc.context.obj({ N: appearance }));
    widget.dict.delete(PDFName.of("AS"));
    const flags = widget.dict.lookupMaybe(PDFName.of("F"), PDFNumber)?.asNumber() ?? 0;
    widget.dict.set(PDFName.of("F"), PDFNumber.of(flags | ANNOTATION_FLAGS.PRINT));
  } else {
    const target = pages[Math.min(pages.length, Math.max(1, Math.round(Number(page) || 1))) - 1];
    const box = target.getCropBox();
    let area = Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) ? rect.map(Number) : null;
    if (area) area = [Math.min(area[0], area[2]), Math.min(area[1], area[3]), Math.max(area[0], area[2]), Math.max(area[1], area[3])];
    if (!area || area[2] - area[0] < 40 || area[3] - area[1] < 20) area = defaultRect([box.x, box.y, box.x + box.width, box.y + box.height]);
    const appearance = await stampAppearance(pdfDoc, area[2] - area[0], area[3] - area[1], details);
    const fields = signatureForm(pdfDoc);
    const widget = pdfDoc.context.register(pdfDoc.context.obj({
      Type: "Annot", Subtype: "Widget", FT: "Sig", Rect: area, V: signatureDictionary(pdfDoc, { ...details, now }),
      T: PDFString.of(uniqueFieldName(pdfDoc)), F: ANNOTATION_FLAGS.PRINT, P: target.ref, AP: { N: appearance },
    }));
    let annots = target.node.lookupMaybe(PDFName.of("Annots"), PDFArray);
    if (!annots) target.node.set(PDFName.of("Annots"), annots = pdfDoc.context.obj([]));
    annots.push(widget);
    fields.push(widget);
  }
  const prepared = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return new SignPdf().sign(prepared, new CmsSigner(identity), now);
}

/** Signature1, or Signature2... when the form already has a field by that name. */
function uniqueFieldName(pdfDoc) {
  let names = new Set();
  try { names = new Set(pdfDoc.getForm().getFields().map(item => item.getName())); } catch { /* no usable form */ }
  let index = 1;
  while (names.has(`Signature${index}`)) index++;
  return `Signature${index}`;
}

/** 220 x 70 points in the bottom-right corner of a page box [x0, y0, x1, y1], inside a 36-point margin. */
function defaultRect(view) {
  const [left, bottom, right, top] = view;
  const width = Math.min(220, right - left - 20), height = Math.min(70, top - bottom - 20);
  const margin = Math.min(36, (right - left - width) / 2, (top - bottom - height) / 2);
  return [right - margin - width, bottom + margin, right - margin, bottom + margin + height];
}

module.exports = { readP12, signPdf, defaultRect, CertificateError, MAX_CERTIFICATE_BYTES, MAX_FIELD_NAME };
