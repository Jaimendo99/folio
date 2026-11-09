// Digital signatures (PAdES, adbe.pkcs7.detached) made with a .p12/.pfx certificate, plus a visible stamp.
// Runs in the main process only, so the private key never reaches the page.
// node-forge reads the certificate because many issuers (Ecuador's Banco Central, Security Data, Uanataca, ANF...)
// still protect theirs with RC2/3DES, which Node's OpenSSL 3 refuses.
const forge = require("node-forge");
const QRCode = require("qrcode");
const { PDFDocument, PDFName, PDFSignature, StandardFonts, rgb } = require("pdf-lib");
const { pdflibAddPlaceholder } = require("@signpdf/placeholder-pdf-lib");
const { SignPdf, Signer } = require("@signpdf/signpdf");

const MAX_CERTIFICATE_BYTES = 1024 * 1024;
// Room for the CMS signature: the signer's certificate, its issuers and the signature itself.
const SIGNATURE_LENGTH = 16384;

class CertificateError extends Error {}

function field(name, short) {
  const value = name.getField(short)?.value;
  return typeof value === "string" ? value.trim() : "";
}

function hasKeyUsage(cert) {
  const usage = cert.getExtension("keyUsage");
  return !!usage && (usage.digitalSignature || usage.nonRepudiation);
}

function isCa(cert) {
  return !!cert.getExtension("basicConstraints")?.cA;
}

/** Decrypts the certificate and picks the signing identity: the end-entity certificate that matches a private key. */
function openP12(data, password) {
  if (!data || data.length === 0 || data.length > MAX_CERTIFICATE_BYTES) throw new CertificateError("This isn't a .p12 or .pfx certificate.");
  let asn1;
  try { asn1 = forge.asn1.fromDer(forge.util.createBuffer(Buffer.from(data).toString("binary"))); }
  catch { throw new CertificateError("This isn't a .p12 or .pfx certificate."); }
  let p12;
  try { p12 = forge.pkcs12.pkcs12FromAsn1(asn1, false, String(password ?? "")); }
  catch (error) {
    if (/password|mac/i.test(String(error?.message))) throw new CertificateError("Wrong password for this certificate.");
    // Without a MAC to check, a wrong password shows up as undecryptable contents.
    throw new CertificateError("Couldn't open the certificate. Check the password.");
  }
  const bags = (type) => p12.getBags({ bagType: type })[type] ?? [];
  const keyBags = [...bags(forge.pki.oids.pkcs8ShroudedKeyBag), ...bags(forge.pki.oids.keyBag)];
  const certs = bags(forge.pki.oids.certBag).map(bag => bag.cert).filter(Boolean);
  if (!keyBags.length) throw new CertificateError("This certificate file has no private key, so it can't sign.");
  const keys = keyBags.map(bag => bag.key).filter(Boolean);
  if (!keys.length) throw new CertificateError("Only RSA certificates can sign in Folio.");

  // Some files hold several certificates and keys; the signer is the one whose public key matches a private key.
  const now = new Date();
  const pairs = [];
  for (const key of keys) {
    for (const cert of certs) {
      const pub = cert.publicKey;
      if (pub?.n && pub.n.equals(key.n) && pub.e.equals(key.e)) pairs.push({ key, cert });
    }
  }
  if (!pairs.length) throw new CertificateError("The private key in this file doesn't match any of its certificates.");
  const score = ({ cert }) => (hasKeyUsage(cert) ? 4 : 0) + (isCa(cert) ? 0 : 2)
    + (cert.validity.notBefore <= now && now <= cert.validity.notAfter ? 1 : 0);
  pairs.sort((a, b) => score(b) - score(a));
  const { key, cert } = pairs[0];
  return { key, cert, chain: certs.filter(other => other !== cert), info: describe(cert, now) };
}

function describe(cert, now = new Date()) {
  const name = field(cert.subject, "CN") || [field(cert.subject, "GN"), field(cert.subject, "SN")].filter(Boolean).join(" ") || "Unknown signer";
  const provider = field(cert.issuer, "O") || field(cert.issuer, "CN") || "Unknown issuer";
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

/** Detached CMS (SHA-256) over the signed byte ranges, with the certificate chain from the file. */
class ForgeSigner extends Signer {
  constructor(identity) { super(); this.identity = identity; }
  async sign(pdfBuffer, signingTime = new Date()) {
    const { key, cert, chain } = this.identity;
    const p7 = forge.pkcs7.createSignedData();
    p7.content = forge.util.createBuffer(pdfBuffer.toString("binary"));
    for (const certificate of [cert, ...chain]) p7.addCertificate(certificate);
    p7.addSigner({
      key, certificate: cert, digestAlgorithm: forge.pki.oids.sha256,
      authenticatedAttributes: [
        { type: forge.pki.oids.contentType, value: forge.pki.oids.data },
        { type: forge.pki.oids.messageDigest },
        { type: forge.pki.oids.signingTime, value: signingTime },
      ],
    });
    p7.sign({ detached: true });
    return Buffer.from(forge.asn1.toDer(p7.toAsn1()).getBytes(), "binary");
  }
}

/** 2026-11-10T14:03:22-05:00: the signer's local time with its offset, as FirmaEC shows it. */
function localIso(date) {
  const pad = (n) => String(Math.floor(Math.abs(n))).padStart(2, "0");
  const offset = -date.getTimezoneOffset();
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
    + `${offset >= 0 ? "+" : "-"}${pad(offset / 60)}:${pad(offset % 60)}`;
}

// The standard PDF fonts only cover Latin-1-ish text; anything else would make pdf-lib throw.
function printable(font, text) {
  return [...String(text).normalize("NFC").replace(/[\u0000-\u001f\u007f]+/g, " ")].map(character => {
    try { font.widthOfTextAtSize(character, 1); return character; } catch { return "?"; }
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
    while (part.length > 1 && font.widthOfTextAtSize(part, size) > width) part = part.slice(0, -1);
    return part;
  });
}

async function drawStamp(pdfDoc, page, rect, { name, provider, date, reason, location }) {
  const [x0, y0, x1, y1] = rect;
  const width = x1 - x0, height = y1 - y0;
  const regular = await pdfDoc.embedFont(StandardFonts.Helvetica);
  const bold = await pdfDoc.embedFont(StandardFonts.HelveticaBold);
  const ink = rgb(0, 0, 0);

  const payload = [`FIRMADO POR: ${name}`, `RAZON: ${reason}`, `LOCALIZACION: ${location}`, `FECHA: ${date}`, `EMISOR: ${provider}`].join("\n");
  const qr = QRCode.create(payload, { errorCorrectionLevel: "M" }).modules;
  const qrSide = Math.min(height, width * 0.4);
  const cell = qrSide / qr.size;
  const qrBottom = y0 + (height - qrSide) / 2;
  for (let row = 0; row < qr.size; row++) {
    // Runs of dark cells as one rectangle each keep the page small.
    for (let col = 0; col < qr.size;) {
      if (!qr.get(row, col)) { col++; continue; }
      let end = col;
      while (end < qr.size && qr.get(row, end)) end++;
      page.drawRectangle({ x: x0 + col * cell, y: qrBottom + qrSide - (row + 1) * cell, width: (end - col) * cell, height: cell, color: ink });
      col = end;
    }
  }

  const textLeft = x0 + qrSide + Math.min(6, width * 0.03);
  const textWidth = x1 - textLeft;
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
  let y = y0 + Math.min(height, (height + total) / 2);
  for (const line of lines) {
    y -= line.size * 1.2;
    if (y < y0 - 0.5) break;
    page.drawText(line.text, { x: textLeft, y: y + line.size * 0.25, size: line.size, font: line.font, color: ink });
  }
}

/**
 * Draws the visible stamp at `rect` (PDF points, [x0, y0, x1, y1]) on `page` (1-based), adds a signature field there
 * and signs. The returned bytes are final: any later rewrite of the file would break the signature.
 */
async function signPdf(pdfBytes, { p12, password, page = 1, rect, reason = "", location = "", now = new Date() }) {
  const identity = openP12(p12, password);
  const { info } = identity;
  const day = (iso) => iso.slice(0, 10);
  if (info.expired) throw new CertificateError(`This certificate expired on ${day(info.validTo)}. Signatures made with it aren't valid.`);
  if (info.notYetValid) throw new CertificateError(`This certificate is valid from ${day(info.validFrom)}.`);

  let pdfDoc;
  try { pdfDoc = await PDFDocument.load(pdfBytes, { updateMetadata: false }); }
  catch (error) {
    if (/encrypt/i.test(String(error?.message))) throw new CertificateError("Folio can't sign password-protected PDFs.");
    throw new CertificateError("Couldn't read this PDF for signing.");
  }
  if (pdfDoc.isEncrypted) throw new CertificateError("Folio can't sign password-protected PDFs.");
  // Folio rewrites the whole file to add the signature, which would break signatures already in it.
  let signed = false;
  try { signed = pdfDoc.getForm().getFields().some(f => f instanceof PDFSignature && f.acroField.dict.has(PDFName.of("V"))); } catch { /* no usable form */ }
  if (signed) throw new CertificateError("This PDF is already signed. Folio can't add another signature to it.");

  const pages = pdfDoc.getPages();
  const target = pages[Math.min(pages.length, Math.max(1, Math.round(Number(page) || 1))) - 1];
  const box = target.getCropBox();
  let area = Array.isArray(rect) && rect.length === 4 && rect.every(Number.isFinite) ? rect.map(Number) : null;
  if (area) area = [Math.min(area[0], area[2]), Math.min(area[1], area[3]), Math.max(area[0], area[2]), Math.max(area[1], area[3])];
  if (!area || area[2] - area[0] < 40 || area[3] - area[1] < 20) area = defaultRect([box.x, box.y, box.x + box.width, box.y + box.height]);

  const clean = (text) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, 200);
  const date = localIso(now);
  await drawStamp(pdfDoc, target, area, { name: info.name, provider: info.provider, date, reason: clean(reason), location: clean(location) });
  pdflibAddPlaceholder({
    pdfPage: target, reason: clean(reason), contactInfo: "", name: info.name, location: clean(location),
    signingTime: now, signatureLength: SIGNATURE_LENGTH, widgetRect: area, appName: "Folio",
  });
  const prepared = Buffer.from(await pdfDoc.save({ useObjectStreams: false }));
  return new SignPdf().sign(prepared, new ForgeSigner(identity), now);
}

/** 220 x 70 points in the bottom-right corner of a page box [x0, y0, x1, y1], inside a 36-point margin. */
function defaultRect(view) {
  const [left, bottom, right, top] = view;
  const width = Math.min(220, right - left - 20), height = Math.min(70, top - bottom - 20);
  const margin = Math.min(36, (right - left - width) / 2, (top - bottom - height) / 2);
  return [right - margin - width, bottom + margin, right - margin, bottom + margin + height];
}

module.exports = { readP12, signPdf, defaultRect, CertificateError, MAX_CERTIFICATE_BYTES };
