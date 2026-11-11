const assert = require("node:assert/strict");
const { en, es } = require("../electron/i18n.cjs");
const fs = require("node:fs");
const path = require("node:path");

function checkParity(english, spanish, label) {
  assert.deepEqual(Object.keys(spanish).sort(), Object.keys(english).sort(), `${label} dictionaries must have the same keys`);
  const placeholders = text => [...text.matchAll(/\{(\w+)\}/g)].map(match => match[1]).sort();
  for (const key of Object.keys(english)) {
    assert.deepEqual(placeholders(spanish[key]), placeholders(english[key]), `${label} message ${key} has different placeholders`);
  }
}

(async () => {
  const { uiEn, uiEs } = await import("../src/uiMessages.ts");
  checkParity(en, es, "Native");
  const electronDir = path.join(__dirname, "../electron");
  for (const file of fs.readdirSync(electronDir).filter(name => name.endsWith(".cjs"))) {
    const source = fs.readFileSync(path.join(electronDir, file), "utf8");
    for (const pattern of [/\bt\(("(?:[^"\\]|\\.)*")/g, /\bitem\("[^"]+",\s*("(?:[^"\\]|\\.)*")\)/g]) {
      for (const match of source.matchAll(pattern)) {
        const key = JSON.parse(match[1]);
        assert.ok(Object.hasOwn(en, key), `${file} references a missing native message: ${key}`);
      }
    }
  }
  checkParity(uiEn, uiEs, "Renderer");
  for (const key of Object.keys(en)) {
    const message = en[key];
    if (Object.hasOwn(uiEn, message) && !message.includes("{")) {
      assert.equal(es[key], uiEs[message], `Shared translation differs for ${message}`);
    }
  }
  console.log(`ok  language dictionaries and shared messages match (${Object.keys(uiEn).length} renderer, ${Object.keys(en).length} native)`);
})().catch(error => { console.error(error); process.exitCode = 1; });
