// UI screenshot runner for visual QA. Needs Playwright: from this folder's node_modules, or from $PLAYWRIGHT_HOME's.
// Usage: node tools/qa/shoot.mjs <scenario.js> <outdir> [--port 30001] [--user Gamemaster] [--themes dark,light]
//                                [--viewport 1600x1000] [--scale 1] [--canvas]
// scenario.js is the body of an async function(theme) run in the page after login. It opens windows and returns
// [{sel, name, run?, wait?}]: `sel` is a CSS selector to screenshot ("page" for the whole viewport), `run` is optional
// JS run before that shot (e.g. switch a tab). Files are written as <outdir>/<name>-<theme>.png.
// Prints {results, errors} as JSON; errors include page errors, console errors and failed requests.
import { createRequire } from "node:module";
import fs from "node:fs";
import path from "node:path";
const require = createRequire(path.join(process.env.PLAYWRIGHT_HOME ?? process.cwd(), "noop.js"));
const { chromium } = require("playwright");

const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const scenario = fs.readFileSync(args[0], "utf8");
const outdir = args[1];
fs.mkdirSync(outdir, { recursive: true });
const port = opt("port", "30001");
const user = opt("user", "Gamemaster");
const themes = opt("themes", "dark,light").split(",");
const canvas = args.includes("--canvas");
const [vw, vh] = opt("viewport", "1600x1000").split("x").map(Number);

const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
const ctx = await browser.newContext({ viewport: { width: vw, height: vh }, deviceScaleFactor: Number(opt("scale", "1")) });
const page = await ctx.newPage();
await page.addInitScript((noCanvas) => {
  const progress = JSON.parse(localStorage.getItem("core.tourProgress") || "{}");
  progress.core = { ...progress.core, welcome: 3 };
  localStorage.setItem("core.tourProgress", JSON.stringify(progress));
  if (noCanvas) localStorage.setItem("core.noCanvas", "true"); else localStorage.removeItem("core.noCanvas");
}, !canvas);
const errors = [];
page.on("pageerror", e => errors.push("PAGE " + String(e.stack ?? e).slice(0, 600)));
page.on("console", m => { if (m.type() === "error" && !/GL Driver|hardware/.test(m.text())) errors.push("CONSOLE " + m.text().slice(0, 600)); });
page.on("response", r => { if (r.status() >= 400 && !/favicon/.test(r.url())) errors.push(`HTTP ${r.status()} ${r.url()}`); });

await page.goto(`http://localhost:${port}/join`, { waitUntil: "domcontentloaded" });
await page.waitForSelector("select[name=userId]");
const value = await page.locator("select[name=userId] option", { hasText: new RegExp(`^\\s*${user}\\s*$`) }).first().getAttribute("value");
await page.selectOption("select[name=userId]", { value });
await page.fill("input[name=password]", "");
await Promise.all([page.waitForURL(/\/game$/), page.click("button[name=join]")]);
await page.waitForFunction(() => globalThis.game?.ready === true, null, { timeout: 60000 });
await page.waitForTimeout(1500);

const results = [];
for (const theme of themes) {
  await page.evaluate(async (theme) => {
    foundry.nue?.Tour?.activeTour?.exit();
    for (const app of foundry.applications.instances.values()) if (app.options?.classes?.includes("risklegacy")) await app.close({ animate: false });
    const cfg = foundry.utils.deepClone(game.settings.get("core", "uiConfig"));
    cfg.colorScheme = { applications: theme, interface: theme };
    await game.settings.set("core", "uiConfig", cfg);
  }, theme);
  await page.waitForTimeout(500);
  let shots;
  try {
    shots = await page.evaluate(async ({ src, theme }) => {
      const fn = new (Object.getPrototypeOf(async function() {}).constructor)("theme", src);
      return await fn(theme);
    }, { src: scenario, theme });
  } catch (e) { errors.push("SCENARIO " + e.message); shots = []; }
  await page.evaluate(() => ui.notifications?.clear());
  await page.waitForTimeout(700);
  for (const s of shots ?? []) {
    const file = path.join(outdir, `${s.name}-${theme}.png`);
    if (s.run) {
      try {
        await page.evaluate(async (src) => { const fn = new (Object.getPrototypeOf(async function() {}).constructor)(src); return await fn(); }, s.run);
      } catch (e) { errors.push(`RUN ${s.name}: ${e.message.split("\n")[0]}`); }
      await page.waitForTimeout(s.wait ?? 600);
    }
    try {
      if (s.sel === "page") await page.screenshot({ path: file });
      else await page.locator(s.sel).first().screenshot({ path: file, timeout: 5000 });
      results.push(file);
    } catch (e) { errors.push(`SHOT ${s.name}: ${e.message.split("\n")[0]}`); }
  }
}
console.log(JSON.stringify({ results, errors }, null, 2));
await browser.close();
