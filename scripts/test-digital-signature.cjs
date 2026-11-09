// Digital signing with a .p12/.pfx: certificates are made here with node-forge, including the legacy 3DES kind
// Ecuadorian providers issue, and each signature is checked against the PDF's byte ranges.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const zlib = require("node:zlib");
const forge = require("node-forge");
const { PDFArray, PDFDocument, PDFName, PDFString } = require("pdf-lib");
const { readP12, signPdf, CertificateError } = require("../electron/digital-signature.cjs");

const SAMPLE = fs.readFileSync(path.join(__dirname, "..", "public", "sample.pdf"));
const PASSWORD = "clave segura ñ";

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" })),
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" })) };
}

function certificate({ subject, issuer = subject, keys, signingKey = keys.privateKey, ca = false, from, to, serial, extensions }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = from;
  cert.validity.notAfter = to;
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.setExtensions(extensions ?? [{ name: "basicConstraints", cA: ca },
    ca ? { name: "keyUsage", keyCertSign: true, cRLSign: true } : { name: "keyUsage", digitalSignature: true, nonRepudiation: true }]);
  cert.sign(signingKey, forge.md.sha256.create());
  return cert;
}

const DAY = 86400000;
const caKeys = keyPair();
const caSubject = [{ shortName: "CN", value: "AUTORIDAD DE CERTIFICACION DE PRUEBA" }, { shortName: "O", value: "Proveedor de Prueba S.A." }, { shortName: "C", value: "EC" }];
const ca = certificate({ subject: caSubject, keys: caKeys, ca: true, from: new Date(Date.now() - 400 * DAY), to: new Date(Date.now() + 3650 * DAY), serial: "01" });
const signerKeys = keyPair();
const signerSubject = [{ shortName: "CN", value: "MARÍA JOSÉ PEÑA" }, { shortName: "C", value: "EC" }];
const signer = certificate({ subject: signerSubject, issuer: caSubject, keys: signerKeys, signingKey: caKeys.privateKey,
  from: new Date(Date.now() - DAY), to: new Date(Date.now() + 365 * DAY), serial: "0a1b2c" });

const p12 = (key, certs, algorithm) => Buffer.from(forge.asn1.toDer(
  forge.pkcs12.toPkcs12Asn1(key, certs, PASSWORD, { algorithm, generateLocalKeyId: true, friendlyName: "firma" })).getBytes(), "binary");
// CA first, as some issuers do: the signer must still be the certificate that matches the key.
const modern = p12(signerKeys.privateKey, [ca, signer], "aes256");
const legacy = p12(signerKeys.privateKey, [ca, signer], "3des");

// An OpenSSL with `cms` (LibreSSL, macOS's default, lacks it) checks signatures independently of node-forge.
const OPENSSL = [process.env.OPENSSL, "openssl", "/opt/homebrew/bin/openssl", "/usr/local/opt/openssl@3/bin/openssl"]
  .filter(Boolean).find(command => spawnSync(command, ["cms", "-help"], { stdio: "ignore" }).status === 0);

function opensslVerify(signature, content) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "folio-sign-"));
  try {
    fs.writeFileSync(path.join(dir, "signature.der"), signature);
    fs.writeFileSync(path.join(dir, "content.bin"), content);
    const run = spawnSync(OPENSSL, ["cms", "-verify", "-binary", "-noverify", "-inform", "DER", "-in", path.join(dir, "signature.der"),
      "-content", path.join(dir, "content.bin"), "-out", path.join(dir, "out.bin")], { encoding: "utf8" });
    assert.equal(run.status, 0, `openssl cms -verify: ${run.stderr}`);
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
}

/** Checks the CMS signature in the PDF covers exactly its byte ranges and was made by `expected`. */
function verify(pdf, expected, chain = ca) {
  const text = pdf.toString("latin1");
  const match = /\/ByteRange\s*\[\s*(\d+)\s+(\d+)\s+(\d+)\s+(\d+)\s*\]/.exec(text);
  assert.ok(match, "has /ByteRange");
  const [a, b, c, d] = match.slice(1).map(Number);
  assert.equal(a, 0);
  assert.equal(c + d, pdf.length, "byte range reaches the end of the file");
  const contents = text.slice(b, c);
  assert.match(contents, /^<[0-9a-f]+>$/i, "/Contents sits between the byte ranges");
  assert.match(text.slice(b - 12, b), /\/Contents\s*$/);
  const der = Buffer.from(contents.slice(1, -1), "hex");
  const cms = forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")), { parseAllBytes: false });
  const message = forge.pkcs7.messageFromAsn1(cms);
  assert.ok(message.certificates.some(cert => cert.serialNumber === expected.serialNumber), "includes the signer certificate");
  assert.ok(message.certificates.some(cert => cert.serialNumber === chain.serialNumber), "includes the chain");
  assert.equal(message.content, undefined, "detached");

  const signerInfo = message.rawCapture.signerInfos[0];
  const attributes = signerInfo.value.find(node => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0);
  const digestNode = signerInfo.value[signerInfo.value.length - 1];
  let messageDigest;
  for (const attribute of attributes.value) {
    if (forge.asn1.derToOid(attribute.value[0].value) === forge.pki.oids.messageDigest) messageDigest = Buffer.from(attribute.value[1].value[0].value, "binary");
  }
  // DER needs a SET OF sorted by encoding; Bouncy Castle (and so Java validators like FirmaEC) rejects anything else.
  const encoded = attributes.value.map(attribute => Buffer.from(forge.asn1.toDer(attribute).getBytes(), "binary"));
  assert.deepEqual(encoded, [...encoded].sort(Buffer.compare), "signed attributes are in DER order");
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  assert.deepEqual(messageDigest, crypto.createHash("sha256").update(signed).digest(), "message digest matches the byte ranges");
  // The signature covers the attributes encoded as a SET, not with their [0] tag.
  const attributesDer = Buffer.from(forge.asn1.toDer(attributes).getBytes(), "binary");
  attributesDer[0] = 0x31;
  const publicKey = crypto.createPublicKey(forge.pki.publicKeyToPem(expected.publicKey));
  assert.ok(crypto.verify("sha256", attributesDer, publicKey, Buffer.from(digestNode.value, "binary")), "RSA signature verifies");
  if (OPENSSL) opensslVerify(der, signed);
  return { der, signed };
}

test("reads signer, provider and validity", () => {
  const info = readP12(modern, PASSWORD);
  assert.equal(info.name, "MARÍA JOSÉ PEÑA");
  assert.equal(info.provider, "Proveedor de Prueba S.A.");
  assert.equal(info.serial, "0a1b2c");
  assert.equal(info.expired, false);
});

for (const [kind, file] of [["AES", modern], ["legacy 3DES", legacy]]) {
  test(`signs the sample with a ${kind} certificate`, async () => {
    const out = await signPdf(SAMPLE, { p12: file, password: PASSWORD, page: 1, rect: [300, 40, 560, 110], reason: "Aprobación", location: "Quito" });
    const doc = await PDFDocument.load(out);
    assert.equal(doc.getPageCount(), (await PDFDocument.load(SAMPLE)).getPageCount());
    assert.ok(doc.getForm().getFields().some(f => f.constructor.name === "PDFSignature"));
    verify(out, signer);
  });
}

test("signs with the default stamp place when none is given", async () => {
  verify(await signPdf(SAMPLE, { p12: legacy, password: PASSWORD }), signer);
});

test("a wrong password gives a clear error", async () => {
  assert.throws(() => readP12(legacy, "wrong"), (error) => error instanceof CertificateError && /wrong password/i.test(error.message));
  await assert.rejects(signPdf(SAMPLE, { p12: modern, password: "wrong" }), /wrong password/i);
});

test("an expired certificate is refused", async () => {
  const keys = keyPair();
  const old = certificate({ subject: [{ shortName: "CN", value: "Old Signer" }], keys, from: new Date(Date.now() - 800 * DAY), to: new Date(Date.now() - DAY), serial: "02" });
  const file = p12(keys.privateKey, [old], "3des");
  assert.equal(readP12(file, PASSWORD).expired, true);
  await assert.rejects(signPdf(SAMPLE, { p12: file, password: PASSWORD }), /expired/);
});

test("an already signed PDF is refused", async () => {
  const once = await signPdf(SAMPLE, { p12: modern, password: PASSWORD });
  await assert.rejects(signPdf(once, { p12: modern, password: PASSWORD }), /already signed/);
});

test("a file that isn't a certificate is refused", () => {
  assert.throws(() => readP12(SAMPLE, PASSWORD), /isn't a \.p12/);
});

test("OpenSSL verifies the signature on its own", { skip: !OPENSSL && "no OpenSSL with cms on this machine" }, async () => {
  const { der, signed } = verify(await signPdf(SAMPLE, { p12: legacy, password: PASSWORD }), signer);
  opensslVerify(der, signed);
  // A changed byte must fail, or the check above proves nothing.
  const tampered = Buffer.from(signed);
  tampered[100] ^= 1;
  assert.throws(() => opensslVerify(der, tampered));
});

test("accented UTF8String names verify and show as written", async () => {
  const utf8 = (shortName, value) => ({ shortName, value, valueTagClass: forge.asn1.Type.UTF8 });
  const issuerKeys = keyPair();
  const issuerName = [utf8("CN", "AUTORIDAD DE CERTIFICACIÓN"), utf8("O", "Señal Ñandú Firmas S.A."), { shortName: "C", value: "EC" }];
  const issuerCert = certificate({ subject: issuerName, keys: issuerKeys, ca: true, from: new Date(Date.now() - DAY), to: new Date(Date.now() + 3650 * DAY), serial: "11" });
  const keys = keyPair();
  const person = certificate({ subject: [utf8("CN", "MARÍA JOSÉ PEÑA"), { shortName: "C", value: "EC" }], issuer: issuerName, keys,
    signingKey: issuerKeys.privateKey, from: new Date(Date.now() - DAY), to: new Date(Date.now() + 365 * DAY), serial: "00e1" });
  const file = p12(keys.privateKey, [issuerCert, person], "3des");
  const info = readP12(file, PASSWORD);
  assert.equal(info.name, "MARÍA JOSÉ PEÑA");
  assert.equal(info.provider, "Señal Ñandú Firmas S.A.");

  const out = await signPdf(SAMPLE, { p12: file, password: PASSWORD, rect: [300, 40, 560, 110] });
  const { der } = verify(out, person, issuerCert);
  // The SignerInfo names the issuer with the certificate's own bytes, so verifiers find the signer.
  const signerInfo = forge.pkcs7.messageFromAsn1(forge.asn1.fromDer(forge.util.createBuffer(der.toString("binary")), { parseAllBytes: false })).rawCapture.signerInfos[0];
  const issuerDer = Buffer.from(forge.asn1.toDer(signerInfo.value[1].value[0]).getBytes(), "binary");
  assert.deepEqual(issuerDer, Buffer.from(forge.asn1.toDer(person.tbsCertificate.value[3]).getBytes(), "binary"));
  assert.ok(issuerDer.includes(Buffer.from("CERTIFICACIÓN", "utf8")));

  // The stamp draws the accents in WinAnsi (Í = CD, Ñ = D1, Ó = D3) rather than dropping them.
  const doc = await PDFDocument.load(out);
  const widget = doc.getForm().getFields().find(f => f.constructor.name === "PDFSignature").acroField.getWidgets()[0];
  const stream = doc.context.lookup(widget.getAppearances().normal);
  const text = zlib.inflateSync(Buffer.from(stream.getContents())).toString("latin1").toUpperCase();
  const winAnsi = (word) => Buffer.from(word, "latin1").toString("hex").toUpperCase();
  for (const word of ["MARÍA", "JOSÉ", "PEÑA", "Señal", "Ñandú", "electrónicamente"]) assert.ok(text.includes(winAnsi(word)), `${word} is in the stamp`);
});

test("certificates not meant for signing are refused", async () => {
  const keys = keyPair();
  const from = new Date(Date.now() - DAY), to = new Date(Date.now() + 365 * DAY);
  const authority = certificate({ subject: [{ shortName: "CN", value: "Only A CA" }], keys, ca: true, from, to, serial: "21" });
  const caOnly = p12(keys.privateKey, [authority], "aes256");
  assert.throws(() => readP12(caOnly, PASSWORD), /isn't meant for signing/);
  await assert.rejects(signPdf(SAMPLE, { p12: caOnly, password: PASSWORD }), /isn't meant for signing/);

  const other = keyPair();
  const encipherOnly = certificate({ subject: [{ shortName: "CN", value: "Encryption Only" }], keys: other, from, to, serial: "22",
    extensions: [{ name: "basicConstraints", cA: false }, { name: "keyUsage", keyEncipherment: true, dataEncipherment: true }] });
  const encryption = p12(other.privateKey, [encipherOnly], "aes256");
  assert.throws(() => readP12(encryption, PASSWORD), /isn't meant for signing/);
  await assert.rejects(signPdf(SAMPLE, { p12: encryption, password: PASSWORD }), /isn't meant for signing/);

  // Without a keyUsage extension at all, a non-CA certificate can still sign.
  const plain = keyPair();
  const noUsage = certificate({ subject: [{ shortName: "CN", value: "No Usage" }], keys: plain, from, to, serial: "23",
    extensions: [{ name: "basicConstraints", cA: false }] });
  assert.equal(readP12(p12(plain.privateKey, [noUsage], "aes256"), PASSWORD).name, "No Usage");
});

/** The sample with an AcroForm whose /Fields is an indirect array holding two text fields. */
async function formWithIndirectFields() {
  const doc = await PDFDocument.load(SAMPLE);
  const form = doc.getForm();
  form.createTextField("Applicant.Name").addToPage(doc.getPage(0), { x: 50, y: 700, width: 200, height: 20 });
  form.createTextField("Applicant.City").addToPage(doc.getPage(0), { x: 50, y: 660, width: 200, height: 20 });
  const fields = form.acroForm.dict.lookup(PDFName.of("Fields"), PDFArray);
  form.acroForm.dict.set(PDFName.of("Fields"), doc.context.register(fields));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

test("existing form fields survive when /Fields is an indirect reference", async () => {
  const source = await formWithIndirectFields();
  assert.match(source.toString("latin1"), /\/Fields \d+ 0 R/);
  const out = await signPdf(source, { p12: modern, password: PASSWORD, rect: [300, 40, 560, 110] });
  const names = (await PDFDocument.load(out)).getForm().getFields().map(f => f.getName()).sort();
  assert.deepEqual(names, ["Applicant.City", "Applicant.Name", "Signature1"]);
  verify(out, signer);
});

/** The sample with an empty signature field: merged field and widget, or (`kids`) a parent field with a widget kid. */
async function formWithSignatureField(kids = false) {
  const doc = await PDFDocument.load(SAMPLE);
  const page = doc.getPage(0);
  const context = doc.context;
  const form = doc.getForm();
  const widget = context.obj({ Type: "Annot", Subtype: "Widget", Rect: [320, 60, 540, 130], F: 4, P: page.ref,
    ...(kids ? {} : { FT: "Sig", T: PDFString.of("ApplicantSignature") }) });
  const widgetRef = context.register(widget);
  let fieldRef = widgetRef;
  if (kids) {
    fieldRef = context.register(context.obj({ FT: "Sig", T: PDFString.of("ApplicantSignature"), Kids: [widgetRef] }));
    widget.set(PDFName.of("Parent"), fieldRef);
  }
  page.node.set(PDFName.of("Annots"), context.obj([widgetRef]));
  form.acroForm.dict.set(PDFName.of("Fields"), context.obj([fieldRef]));
  return Buffer.from(await doc.save({ useObjectStreams: false }));
}

for (const kids of [false, true]) {
  test(`signs into an existing empty signature field${kids ? " with a separate widget" : ""}`, async () => {
    const out = await signPdf(await formWithSignatureField(kids), { p12: modern, password: PASSWORD, page: 1, field: "ApplicantSignature",
      rect: [0, 0, 1, 1] });
    verify(out, signer);
    const doc = await PDFDocument.load(out);
    const fields = doc.getForm().getFields();
    assert.deepEqual(fields.map(f => f.getName()), ["ApplicantSignature"], "no extra field");
    const field = fields[0];
    assert.equal(doc.context.lookup(field.acroField.dict.get(PDFName.of("V"))).get(PDFName.of("Type")).toString(), "/Sig");
    const widgets = field.acroField.getWidgets();
    assert.equal(widgets.length, 1);
    assert.ok(widgets[0].getAppearances()?.normal, "the widget shows the stamp");
    assert.deepEqual(widgets[0].getRectangle(), { x: 320, y: 60, width: 220, height: 70 }, "the field keeps its place");
    assert.equal(doc.getPage(0).node.Annots().size(), 1, "no extra widget");
  });
}

test("a missing, invalid or already signed field is refused", async () => {
  const source = await formWithSignatureField();
  await assert.rejects(signPdf(source, { p12: modern, password: PASSWORD, field: "Nope" }), /isn't in this document/);
  await assert.rejects(signPdf(source, { p12: modern, password: PASSWORD, field: 42 }), /isn't valid/);
  await assert.rejects(signPdf(source, { p12: modern, password: PASSWORD, field: "x".repeat(600) }), /isn't valid/);
  const once = await signPdf(source, { p12: modern, password: PASSWORD, field: "ApplicantSignature" });
  await assert.rejects(signPdf(once, { p12: modern, password: PASSWORD, field: "ApplicantSignature" }), /already signed/);
  const textField = await formWithIndirectFields();
  await assert.rejects(signPdf(textField, { p12: modern, password: PASSWORD, field: "Applicant.Name" }), /isn't a signature field/);
});
