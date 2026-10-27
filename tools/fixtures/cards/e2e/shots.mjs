#!/usr/bin/env node
/**
 * Screenshots of the cards area UI in one logged-in session (the harness's `screenshot` command can't stage UI).
 * Run after flow.eval on the same world:
 *   node tools/fixtures/cards/e2e/shots.mjs --port 30013 --out /tmp/rl-cards-shots
 * Needs Playwright: from this folder's node_modules, or from $PLAYWRIGHT_HOME's (e.g. the foundry-vtt-dev harness's).
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const args = Object.fromEntries(process.argv.slice(2).reduce((acc, a, i, all) => {
  if ( a.startsWith("--") ) acc.push([a.slice(2), all[i + 1]?.startsWith("--") ? true : (all[i + 1] ?? true)]);
  return acc;
}, []));
const port = Number(args.port ?? 30013);
const outDir = path.resolve(args.out ?? "/tmp/rl-cards-shots");
const theme = args.theme ?? "light";
fs.mkdirSync(outDir, { recursive: true });

const req = createRequire(path.join(process.env.PLAYWRIGHT_HOME ?? process.cwd(), "noop.js"));
const pw = await import(pathToFileURL(req.resolve("playwright")).href);
const chromium = (pw.default ?? pw).chromium;
const browser = await chromium.launch({ headless: true, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
const page = await (await browser.newContext({ viewport: { width: 1600, height: 1000 } })).newPage();
const errors = [];
page.on("pageerror", err => errors.push(String(err)));
page.on("console", msg => { if ( msg.type() === "error" ) errors.push(msg.text().slice(0, 400)); });
await page.addInitScript(() => {
  localStorage.setItem("core.noCanvas", "true");
  const progress = JSON.parse(localStorage.getItem("core.tourProgress") || "{}");
  progress.core = { ...progress.core, welcome: 3 };
  localStorage.setItem("core.tourProgress", JSON.stringify(progress));
});
await page.goto(`http://localhost:${port}/join`);
await page.waitForSelector("select[name=userId]");
const value = await page.locator("select[name=userId] option", { hasText: "Gamemaster" }).first().getAttribute("value");
await page.selectOption("select[name=userId]", value);
await Promise.all([page.waitForURL(/\/game$/), page.click("button[name=join]")]);
await page.waitForFunction(() => globalThis.game?.ready === true);
await page.waitForTimeout(1500);

const run = code => page.evaluate(async src => {
  const fn = new (Object.getPrototypeOf(async function() {}).constructor)(src);
  return fn();
}, code);
const shot = async (selector, name) => {
  await page.waitForTimeout(500);
  const file = path.join(outDir, `${name}.png`);
  await page.locator(selector).first().screenshot({ path: file });
  console.log("shot", file);
};

// Stage: A's End of Turn with a conquest, A controls the territory in slot 3, cards in hand, discard, events, mission
const staged = await run(`
  await game.settings.set("core", "uiConfig", { ...game.settings.get("core", "uiConfig"), colorScheme: { applications: "${theme}", interface: "${theme}" } }).catch(() => {});
  const SYS = "fvtt-risklegacy-v5", RL = game.risklegacy, C = RL.cards, S = RL.state;
  ui.notifications.clear(); foundry.nue?.Tour?.activeTour?.exit();
  const A = S.getFactionByKey("balkania"), B = S.getFactionByKey("enclave");
  const war = S.getWar();
  const idx = war.turns.findIndex(c => c.actorId === A.id);
  if ( war.turn !== idx ) {
    await war.update({ turn: idx }, { direction: 1 });
    for ( let i = 0; (i < 30) && (war.system.turn.faction !== A.id); i++ ) await new Promise(r => setTimeout(r, 100));
    await new Promise(r => setTimeout(r, 300));
  }
  await war.update({ "system.phase": "end", "system.turn": foundry.data.operators.ForcedReplacement.create({ ...CONFIG.Combat.dataModels.war.freshTurn(A.id), conquered: 2 }) });
  const row = C.getRow();
  const scene = S.getBoardScene(); const board = S.getCampaignBoard();
  const t = row[2].system.territory; const [x, y] = board.territories[t].center;
  if ( !scene.tokens.some(k => k.actorId === A.id && Math.abs(k.x - (x - 50)) < 2) ) {
    await scene.createEmbeddedDocuments("Token", [{ actorId: A.id, name: A.name, x: x - 50, y: y - 50, actorLink: true, flags: { [SYS]: { piece: "troop" } } }]);
  }
  const deck = S.getCardStack("territoryDeck");
  const hand = S.getHand(A);
  if ( C.getResourceCards(A.id).length < 4 ) {
    await deck.deal([hand], 4, { chatNotification: false });
    await C.dealCoins({ faction: A.id, count: 2 });
    await deck.deal([S.getHand(B)], 3, { chatNotification: false });
    await deck.deal([S.getCardStack("discard")], 3, { chatNotification: false });
  }
  if ( !S.getCardStack("eventDiscard").cards.size ) {
    const ev = S.getCardStack("eventDeck");
    const fortify = ev.cards.find(c => c.system.catalogId === "fortify" && !c.drawn);
    if ( fortify ) await ev.updateEmbeddedDocuments("Card", [{ _id: fortify.id, sort: -100 }]);
    await C.revealEvent({});
  }
  if ( !C.currentMission() ) await C.revealMission({});
  const scars = await C.dealScars({ factions: [A.id, B.id] });
  return { row: C.getRow().map(c => c.name), hand: C.getResourceCards(A.id).length, scars };
`);
console.log("staged", JSON.stringify(staged));

// 1. Sideboard with A's draw pending
await run(`await game.risklegacy.cards.openSideboard(); ui.sidebar?.collapse?.();`);
await shot("#rl-sideboard", `sideboard-${theme}`);

// 2. Hover zoom over the slot-3 card
const card = page.locator("#rl-sideboard .rl-sb-slot--row").nth(2).locator("img").first();
await card.hover();
await page.waitForTimeout(400);
await page.screenshot({ path: path.join(outDir, `sideboard-zoom-${theme}.png`) });
console.log("shot zoom");
await page.mouse.move(5, 5);

// 3. Hand window
await run(`await game.risklegacy.cards.openHand(game.risklegacy.state.getFactionByKey("balkania"));`);
await page.waitForTimeout(800);
await shot("[id^=rl-hand-]", `hand-${theme}`);

// 4. Draw prompt
await run(`game.risklegacy.cards.promptResourceDraw(game.risklegacy.state.getFactionByKey("balkania")); await new Promise(r => setTimeout(r, 600));`);
await page.locator(".rl-draw-dialog .rl-pick.is-allowed").first().click();
await shot(".rl-draw-dialog", `prompt-draw-${theme}`);
await shot("#rl-sideboard", `sideboard-prompting-${theme}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(400);

// 5. Turn-in picker (troops)
await run(`game.risklegacy.cards.chooseResourceCards({ faction: game.risklegacy.state.getFactionByKey("balkania"), purpose: "troops" }); await new Promise(r => setTimeout(r, 600));`);
const picks = page.locator(".rl-pick-dialog .rl-pick");
await picks.nth(0).click();
await picks.nth(1).click();
await shot(".rl-pick-dialog", `choose-troops-${theme}`);
await page.keyboard.press("Escape");
await page.waitForTimeout(300);
await run(`game.risklegacy.cards.chooseResourceCards({ faction: game.risklegacy.state.getFactionByKey("balkania"), purpose: "redStar" }); await new Promise(r => setTimeout(r, 600));`);
for ( let i = 0; i < 4; i++ ) await page.locator(".rl-pick-dialog .rl-pick").nth(i).click();
await shot(".rl-pick-dialog", `choose-stars-${theme}`);
await page.keyboard.press("Escape");

// 6. Events in play
await run(`game.risklegacy.cards.browsePile("eventDiscard"); await new Promise(r => setTimeout(r, 500));`);
await shot("#rl-pile-eventDiscard", `pile-events-${theme}`);

// 7. Chat log
await run(`for ( const app of foundry.applications.instances.values() ) if ( app.options.window?.frame !== false && app.id !== "sidebar" && app.hasFrame ) await app.close(); `).catch(() => {});
await run(`for ( const id of [...foundry.applications.instances.keys()] ) { const app = foundry.applications.instances.get(id); if ( app?.window?.windowId || app?.options?.classes?.includes("risklegacy") ) await app.close?.(); }`).catch(() => {});
await run(`ui.sidebar.expand?.(); ui.sidebar.changeTab("chat", "primary"); await new Promise(r => setTimeout(r, 500)); ui.chat.scrollBottom?.();`);
await page.waitForTimeout(600);
await shot("#sidebar", `chat-${theme}`);

console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
