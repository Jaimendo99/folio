// Digital signing with a .p12/.pfx: certificates are made here with node-forge, including the legacy 3DES kind
// Ecuadorian providers issue, and each signature is checked against the PDF's byte ranges.
const test = require("node:test");
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const forge = require("node-forge");
const { PDFDocument } = require("pdf-lib");
const { readP12, signPdf, CertificateError } = require("../electron/digital-signature.cjs");

const SAMPLE = fs.readFileSync(path.join(__dirname, "..", "public", "sample.pdf"));
const PASSWORD = "clave segura ñ";

function keyPair() {
  const { privateKey, publicKey } = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
  return { privateKey: forge.pki.privateKeyFromPem(privateKey.export({ type: "pkcs1", format: "pem" })),
    publicKey: forge.pki.publicKeyFromPem(publicKey.export({ type: "spki", format: "pem" })) };
}

function certificate({ subject, issuer = subject, keys, signingKey = keys.privateKey, ca = false, from, to, serial }) {
  const cert = forge.pki.createCertificate();
  cert.publicKey = keys.publicKey;
  cert.serialNumber = serial;
  cert.validity.notBefore = from;
  cert.validity.notAfter = to;
  cert.setSubject(subject);
  cert.setIssuer(issuer);
  cert.setExtensions([{ name: "basicConstraints", cA: ca },
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

/** Checks the CMS signature in the PDF covers exactly its byte ranges and was made by `expected`. */
function verify(pdf, expected) {
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
  assert.ok(message.certificates.some(cert => cert.serialNumber === ca.serialNumber), "includes the chain");
  assert.equal(message.content, undefined, "detached");

  const signerInfo = message.rawCapture.signerInfos[0];
  const attributes = signerInfo.value.find(node => node.tagClass === forge.asn1.Class.CONTEXT_SPECIFIC && node.type === 0);
  const digestNode = signerInfo.value[signerInfo.value.length - 1];
  let messageDigest;
  for (const attribute of attributes.value) {
    if (forge.asn1.derToOid(attribute.value[0].value) === forge.pki.oids.messageDigest) messageDigest = Buffer.from(attribute.value[1].value[0].value, "binary");
  }
  const signed = Buffer.concat([pdf.subarray(a, a + b), pdf.subarray(c, c + d)]);
  assert.deepEqual(messageDigest, crypto.createHash("sha256").update(signed).digest(), "message digest matches the byte ranges");
  // The signature covers the attributes encoded as a SET, not with their [0] tag.
  const attributesDer = Buffer.from(forge.asn1.toDer(attributes).getBytes(), "binary");
  attributesDer[0] = 0x31;
  const publicKey = crypto.createPublicKey(forge.pki.publicKeyToPem(expected.publicKey));
  assert.ok(crypto.verify("sha256", attributesDer, publicKey, Buffer.from(digestNode.value, "binary")), "RSA signature verifies");
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
