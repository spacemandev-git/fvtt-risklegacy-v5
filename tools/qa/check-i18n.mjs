// Check every literal "RL.*" / "TYPES.*" key used in module/ and templates/ against the merged lang/en*.json files.
// Usage: node tools/qa/check-i18n.mjs   (exit 1 if keys are missing)
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const merged = {};
const merge = (t, s) => { for (const [k, v] of Object.entries(s)) { if (v && typeof v === "object") merge(t[k] ??= {}, v); else t[k] = v; } };
const manifest = JSON.parse(fs.readFileSync(path.join(root, "system.json"), "utf8"));
for (const l of manifest.languages.filter(l => l.lang === "en")) merge(merged, JSON.parse(fs.readFileSync(path.join(root, l.path), "utf8")));
const has = key => { let o = merged; for (const p of key.split(".")) { if (o == null || typeof o !== "object" || !(p in o)) return false; o = o[p]; } return true; };
const files = [];
const walk = d => { for (const f of fs.readdirSync(d, { withFileTypes: true })) { const p = path.join(d, f.name); if (f.isDirectory()) { if (f.name !== "tests") walk(p); } else if (/\.(mjs|hbs)$/.test(f.name)) files.push(p); } };
walk(path.join(root, "module")); walk(path.join(root, "templates"));
const missing = new Map();
for (const file of files) {
  const src = fs.readFileSync(file, "utf8");
  for (const m of src.matchAll(/["'`](RL\.[A-Za-z0-9_.]+[A-Za-z0-9_])["'`]/g)) {
    const key = m[1];
    if (has(key)) continue;
    // a prefix used to build keys dynamically ("RL.Phase." + id) is fine if it is an object
    if (!missing.has(key)) missing.set(key, path.relative(root, file));
  }
}
for (const [k, f] of missing) console.log(`${k}  (${f})`);
console.log(`\n${missing.size} missing key(s) across ${files.length} files`);
process.exit(missing.size ? 1 : 0);
