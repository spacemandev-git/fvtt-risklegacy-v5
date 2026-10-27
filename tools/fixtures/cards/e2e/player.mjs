#!/usr/bin/env node
/**
 * Player-side check: a GM session idles (it runs the GM actions) while a player session draws for its own faction,
 * sees other hands face down, and is refused when acting for another faction. Run after flow.eval / shots.mjs:
 *   node tools/fixtures/cards/e2e/player.mjs --port 30013 --out /tmp/rl-cards-shots
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { pathToFileURL } from "node:url";

const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : undefined; };
const port = Number(opt("port") ?? 30013);
const outDir = path.resolve(opt("out") ?? "/tmp/rl-cards-shots");
fs.mkdirSync(outDir, { recursive: true });
const req = createRequire(path.join(process.env.PLAYWRIGHT_HOME ?? process.cwd(), "noop.js")); // see shots.mjs
const pw = await import(pathToFileURL(req.resolve("playwright")).href);
const browser = await (pw.default ?? pw).chromium.launch({ headless: true });
const errors = [];

async function login(user) {
  const page = await (await browser.newContext({ viewport: { width: 1400, height: 900 } })).newPage();
  page.on("pageerror", err => errors.push(`${user}: ${err}`));
  page.on("console", m => { if ( m.type() === "error" ) errors.push(`${user}: ${m.text().slice(0, 300)}`); });
  await page.addInitScript(() => {
    localStorage.setItem("core.noCanvas", "true");
    localStorage.setItem("core.tourProgress", JSON.stringify({ core: { welcome: 3 } }));
  });
  await page.goto(`http://localhost:${port}/join`);
  await page.waitForSelector("select[name=userId]");
  const value = await page.locator("select[name=userId] option", { hasText: user }).first().getAttribute("value");
  await page.selectOption("select[name=userId]", value);
  await Promise.all([page.waitForURL(/\/game$/), page.click("button[name=join]")]);
  await page.waitForFunction(() => globalThis.game?.ready === true);
  await page.waitForTimeout(1200);
  return page;
}
const run = (page, code) => page.evaluate(async src => new (Object.getPrototypeOf(async function() {}).constructor)(src)(), code);

const gm = await login("Gamemaster");
const staged = await run(gm, `
  const S = game.risklegacy.state, C = game.risklegacy.cards;
  let user = game.users.getName("Player1") ?? await User.implementation.create({ name: "Player1", role: 1 });
  const A = S.getFactionByKey("balkania");
  await A.update({ "system.war.playerId": user.id, "system.war.playerName": user.name });
  await new Promise(r => setTimeout(r, 500));
  const war = S.getWar();
  await war.update({ "system.phase": "end", "system.turn.cardDrawn": false, "system.turn.missionCompleted": false, "system.turn.conquered": 1 });
  return { user: user.id, handOwnership: S.getHand(A).ownership, current: war.combatant?.actor?.name };
`);
console.log("staged", JSON.stringify(staged));

const player = await login("Player1");
const result = await run(player, `
  const S = game.risklegacy.state, C = game.risklegacy.cards;
  const A = S.getFactionByKey("balkania"), B = S.getFactionByKey("enclave");
  const out = {};
  out.ownHandOwner = S.getHand(A).isOwner;
  out.otherHandLimited = S.getHand(B).permission;
  out.deckPermission = S.getCardStack("territoryDeck").permission;
  out.rowPermission = S.getCardStack("row").permission;
  out.otherHandHtmlHidden = (await C.renderHand(B)).includes("is-hidden");
  out.ownHandHtmlHidden = (await C.renderHand(A)).includes("is-hidden");
  try { await C.drawResourceCard({ faction: B.id, cardId: null }); out.otherFaction = "allowed?!"; } catch(err) { out.otherFaction = err.message; }
  const opts = C.drawOptions(A.id);
  out.options = { eligible: opts.eligible, cards: opts.territoryCardIds.length, coin: opts.coinAllowed };
  await C.openSideboard();
  await new Promise(r => setTimeout(r, 800));
  out.takeButtons = document.querySelectorAll("#rl-sideboard [data-action=take], #rl-sideboard [data-action=takeCoin]").length;
  return out;
`);
console.log("player", JSON.stringify(result));
await player.locator("#rl-sideboard").screenshot({ path: path.join(outDir, "sideboard-player.png") });
// Draw through the GM action bus from the player's client
const drawn = await run(player, `
  const S = game.risklegacy.state, C = game.risklegacy.cards;
  const A = S.getFactionByKey("balkania");
  const opts = C.drawOptions(A.id);
  const before = C.getResourceCards(A.id).length;
  const r = await C.drawResourceCard({ faction: A.id, cardId: opts.territoryCardIds[0] ?? null });
  await new Promise(res => setTimeout(res, 800));
  return { r, before, after: C.getResourceCards(A.id).length, row: C.getRow().map(c => c.system.slot + ":" + c.name) };
`);
console.log("draw", JSON.stringify(drawn));
await run(player, `await game.risklegacy.cards.openHand(game.risklegacy.state.getFactionByKey("enclave")); await new Promise(r => setTimeout(r, 600));`);
await player.locator("[id^=rl-hand-]").first().screenshot({ path: path.join(outDir, "hand-other-player.png") });
console.log(JSON.stringify({ errors }, null, 1));
await browser.close();
