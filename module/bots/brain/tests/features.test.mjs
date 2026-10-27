/**
 * Board features on fixtures: the Red Star race, continents, borders, HQ danger, what a conquest changes.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  borderInfo, codeLeader, continentStatus, defendersNeeded, distancesFrom, garrisonFor, hqDanger, recruitForecast,
  standings, takeEffects, threatTo
} from "../features.mjs";
import { codeValueLevel, movePlans, startCandidates, bestTrade, starCards } from "../candidates.mjs";
import { factionFacts, takeFacts, targetFacts } from "../context.mjs";
import { PROFILES } from "../profiles.mjs";
import { band, starsText } from "../util.mjs";
import { makeContext, makeState, readSituation, reset } from "./helpers.mjs";

const ctxOf = (name, opts = {}) => makeContext(readSituation(name), opts);

test("standings: Red Stars, cards and who is closest to winning", () => {
  reset();
  const ctx = ctxOf("leader-one-star");
  const list = standings(ctx);
  const bal = list.find(s => s.id === "balkania");
  assert.equal(bal.stars, 3);
  assert.equal(bal.toWin, 1);
  assert.deepEqual(bal.hqs.sort(), ["egypt", "russia"]);
  assert.equal(list.find(s => s.id === "saharan").stars, 1);   // its HQ was captured
  assert.equal(codeLeader(list).leader, "balkania");
  assert.match(factionFacts(ctx, bal, "full").red_stars, /one Red Star from winning/);
  assert.match(factionFacts(ctx, bal, "full").hqs_held, /Saharan Republic's HQ in Egypt/);
  assert.equal(starsText(2), "2 Red Stars: needs 2 more to win");
  assert.equal(band(0.74), "likely (74%)");
});

test("continents and borders", () => {
  const ctx = ctxOf("hq-win-vs-continent");
  const sah = continentStatus(ctx.state, "saharan");
  assert.equal(sah.africa.complete, true);
  assert.equal(sah.south_america.complete, true);
  const khan = continentStatus(ctx.state, "khan");
  assert.equal(khan.asia.complete, false);
  assert.ok(khan.asia.missing.includes("china"));
  const b = borderInfo(ctx.state, "khan");
  assert.equal(b.middle_east.hq, true);
  assert.ok(b.afghanistan.enemies.some(e => e.id === "russia" && e.owner === "balkania"));
  assert.equal(distancesFrom(ctx.state, "afghanistan").russia, 1);
  assert.equal(recruitForecast(ctx.state, "saharan"), 3 + 3 + 2);
});

test("takeEffects: win now, HQ capture, continent break, card conquest, knock-out", () => {
  const ctx = ctxOf("hq-win-vs-continent");
  const win = takeEffects(ctx, "afghanistan", "russia");
  assert.equal(win.winNow, true);
  assert.equal(win.hq, "balkania");
  assert.equal(win.starsAfter, 4);
  assert.equal(win.defenderStarsAfter, 1);
  const brk = takeEffects(ctx, "middle_east", "east_africa");
  assert.deepEqual(brk.breaks, [{ continent: "africa", faction: "saharan" }]);
  assert.equal(brk.winNow, false);
  const card = takeEffects(ctx, "afghanistan", "china");
  assert.equal(card.earnsCard, true);
  assert.equal(card.hq, null);
  assert.match(takeFacts(ctx, win).join(" | "), /wins the war/);
  assert.match(takeFacts(ctx, brk).join(" | "), /breaks Saharan Republic's hold on Africa/);
  // Knock-out: the defender's last territory.
  const s = makeState({
    factions: { a: {}, b: { hand: { count: 5, coins: 9 } } },
    pieces: { brazil: { a: 6 }, peru: { b: 1 } },
    turn: { faction: "a", phase: "attack", log: { recruited: true } }
  });
  const ko = takeEffects({ me: "a", state: s, view: { hands: { b: { count: 5, coins: 9 } }, factionNames: { a: "A", b: "B" } } }, "brazil", "peru");
  assert.equal(ko.knockOut, true);
  assert.equal(ko.cardsGained, 5);
  assert.ok(codeValueLevel({ state: s, me: "a" }, ko) >= 3);
});

test("HQ danger and the garrison it needs", () => {
  const ctx = ctxOf("hq-under-threat");
  const [d] = hqDanger(ctx, "saharan");
  assert.equal(d.territory, "north_africa");
  assert.equal(d.worstFaction, "balkania");
  assert.ok(d.worst > 0.9, `2 defenders vs 10 + recruit: ${d.worst}`);
  const safe = garrisonFor(ctx, "north_africa", 0.35);
  assert.ok(safe > 10 && safe < 30, `garrison ${safe}`);
  assert.ok(threatTo(ctx, "balkania", "north_africa", { extra: safe - 2 }).p <= 0.35);
  assert.equal(defendersNeeded(ctx, "north_africa", 0.35), safe - 2);
  const calm = ctxOf("placement-exposure");
  assert.equal(hqDanger(calm, "khan")[0].worst, 0);
});

test("move plans: legal, scored, and chains only for the hard bot", () => {
  const ctx = ctxOf("hq-win-vs-continent", { call: { phase: "attack" } });
  const normal = movePlans(ctx, PROFILES.normal);
  assert.ok(normal.length > 3);
  assert.ok(normal.every(p => !p.chain));
  const russia = normal.find(p => p.to === "russia" && p.from === "afghanistan");
  assert.ok(russia && Math.abs(russia.P - 0.9103) < 0.001);
  const hard = movePlans(ctx, PROFILES.hard);
  assert.ok(hard.some(p => p.chain && p.path.length >= 3));
  const t = targetFacts(ctx, russia, standings(ctx));
  assert.equal(t.territory, "Russia");
  assert.ok(!("chance_to_take" in t), "odds stay out of the value question's state");
});

test("starting candidates, card maths", () => {
  const ctx = ctxOf("starting-territory");
  const legal = ["ontario", "argentina", "western_europe", "japan"];
  const c = startCandidates(ctx, legal);
  assert.equal(c.length, 4);
  assert.ok(c.every(x => typeof x.pre === "number"));
  const hand = [{ id: "a", coins: 1 }, { id: "b", coins: 2 }, { id: "c", coins: 3 }, { id: "d", coins: 3 }, { id: "e", coins: 4 }];
  const trade = bestTrade(ctx.state, "enclave", hand);
  assert.equal(trade.coins, 10);
  assert.equal(trade.troops, 30);
  assert.deepEqual(starCards(hand), ["a", "b", "c", "d"]);
});
