// Certificates the user chose to remember for Sign digitally. Each entry is the file's path plus the certificate's
// public details (signer, issuer, serial, expiry); passwords are never kept. The page refers to entries only by id,
// so it can't make Folio read a file the user didn't pick.
const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");

const MAX_ENTRIES = 20;
const CERTIFICATE_FILE = /\.(p12|pfx)$/i;
const ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

const text = (value, limit = 300) => typeof value === "string" ? value.slice(0, limit) : "";

/** Only these fields are ever written, whatever else the caller's objects carry. */
function entryOf(id, file, info) {
  return { id, path: file, name: text(info?.name), provider: text(info?.provider), serial: text(info?.serial, 100),
    validTo: text(info?.validTo, 40) };
}

function valid(entry) {
  return entry && typeof entry.id === "string" && ID.test(entry.id) && typeof entry.path === "string"
    && path.isAbsolute(entry.path) && CERTIFICATE_FILE.test(entry.path) && !/[\u0000-\u001f]/.test(entry.path);
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

function createCertificateStore(file) {
  const read = () => {
    try {
      const list = JSON.parse(fs.readFileSync(file, "utf8"));
      return Array.isArray(list) ? list.filter(valid).map(entry => entryOf(entry.id, entry.path, entry)) : [];
    } catch { return []; }
  };
  const write = (list) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const temporary = `${file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(list, null, 2), { mode: 0o600 });
    fs.renameSync(temporary, file);
  };
  return {
    /** What the page sees: no paths, just the file name and whether the file is still there. */
    list(now = new Date()) {
      return read().map(entry => ({ id: entry.id, fileName: path.basename(entry.path), name: entry.name, provider: entry.provider,
        serial: entry.serial, validTo: entry.validTo, expired: !!entry.validTo && new Date(entry.validTo) < now, missing: !isFile(entry.path) }));
    },
    /** The saved entry with this id, or null. Anything but a known id (a path, an object) finds nothing. */
    find(id) {
      if (typeof id !== "string" || !ID.test(id)) return null;
      return read().find(entry => entry.id === id) ?? null;
    },
    /** True when this file is already remembered. */
    has(certificatePath) {
      return read().some(entry => entry.path === certificatePath);
    },
    /**
     * Remembers `certificatePath` with the public details in `info`. The same file, or the same certificate found at a
     * new path (a moved file chosen again), updates its entry instead of adding another. Returns the entry's id.
     */
    remember(certificatePath, info) {
      if (typeof certificatePath !== "string" || !path.isAbsolute(certificatePath) || !CERTIFICATE_FILE.test(certificatePath)) {
        throw new Error("Only .p12 and .pfx files can be remembered.");
      }
      const list = read();
      const same = (entry) => entry.path === certificatePath
        || (!!info?.serial && entry.serial === info.serial && entry.provider === text(info.provider));
      const existing = list.find(same);
      const entry = entryOf(existing?.id ?? crypto.randomUUID(), certificatePath, info);
      write([entry, ...list.filter(other => !same(other))].slice(0, MAX_ENTRIES));
      return entry.id;
    },
    forget(id) {
      const list = read();
      const kept = list.filter(entry => entry.id !== id);
      if (kept.length !== list.length) write(kept);
      return kept.length !== list.length;
    },
  };
}

module.exports = { createCertificateStore, CERTIFICATE_FILE };
