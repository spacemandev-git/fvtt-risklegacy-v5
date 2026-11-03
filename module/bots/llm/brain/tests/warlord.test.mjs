/**
 * The chat Warlord's staff work and sanity layer (BOTS-LLM.md §11): race maths, valued and pruned menus, stricter
 * odds floors, and the code overrides of clearly bad picks. Recruit and Commander keep their old behaviour.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../index.mjs";
import {
  LLM_PROFILES, WARLORD_CLASSIC, knobsOf, oddsFloor, setLLMProfilePatch, stepFloor, warlordTradeFloor
} from "../../profiles.mjs";
import { attackMenu, cardMenu } from "../menus.mjs";
import { cardConquest, raceThreats, winChanceNextTurn, worstThreat } from "../strategy.mjs";
import { situationOf } from "../turn.mjs";
import {
  enumOf, fakeChat, makeLLMContext, readLLMSituation, readSituation, reset, runLLMCall, systemOf, userOf
} from "./helpers.mjs";

const STOP = () => ({ thinking: "Not worth it.", steps: ["stop_now"], keep_at_least: 0, stop_when: "after_these_steps", say: "" });

test("race maths: cards that buy the last stars are a certain win; an HQ one star away is its capture chance; knocked out is zero", () => {
  reset();
  const spec = readSituation("leader-one-star");
  const ctx = makeLLMContext(spec, { difficulty: "hard" });
  // Balkania: 3 Red Stars (its HQ + Saharan's captured HQ + a token): its best HQ capture next turn.
  const b = winChanceNextTurn(ctx, "balkania");
  assert.equal(b.how, "hq");
  assert.equal(b.need, 1);
  assert.ok(b.p > 0.5 && b.p <= 1, `balkania ${b.p}`);
  assert.ok(b.best?.target && b.best.owner !== "balkania");
  // With 4 cards in hand it buys its 4th star: certain.
  ctx.view.hands.balkania = { count: 4, coins: 4 };
  assert.deepEqual([winChanceNextTurn(ctx, "balkania").p, winChanceNextTurn(ctx, "balkania").how], [1, "cards"]);
  // Two stars short with no cards: needs two captures (rough product), so lower than one capture.
  const k = winChanceNextTurn(ctx, "khan");
  assert.equal(k.need, 2);
  assert.ok(k.p < b.p);
  // A faction with no territories can't win next turn.
  const gone = structuredClone(ctx.state);
  gone.factions.saharan.territories = [];
  assert.equal(winChanceNextTurn(ctx, "saharan", gone).p, 0);
  // raceThreats: likeliest first, only real chances.
  const threats = raceThreats(ctx);
  assert.equal(threats[0].fid, "balkania");
  assert.ok(threats.every(t => t.p >= 0.1 && t.fid !== ctx.me));
});

test("Warlord menu: every option valued; nothing worth less than nothing unless decisive or race-stopping; stricter floors; race and value in the prompt", async () => {
  reset();
  const chat = fakeChat(STOP);
  const { ctx } = await runLLMCall(brain, "leader-one-star", 1, { chat, difficulty: "hard" });
  const sit = await situationOf(ctx);
  const knobs = knobsOf(ctx);
  const menu = attackMenu(ctx, LLM_PROFILES.hard, knobs, sit);
  assert.ok(menu.length >= 3);
  for ( const o of menu ) {
    assert.equal(typeof o.value, "number", `${o.key}: valued`);
    assert.ok(o.value >= 0 || o.decisive || o.stops, `${o.key}: value ${o.value}`);
    if ( o.kind === "attack" && !o.decisive ) assert.ok(o.P >= oddsFloor(LLM_PROFILES.hard, knobs, o.big), `${o.key}: ${o.P}`);
  }
  // Best first by net value.
  for ( let i = 1; i < menu.length; i++ ) assert.ok(menu[i - 1].plan.staff.value >= menu[i].plan.staff.value);
  // The HQ captures lower Balkania's chance to win next turn, and say so.
  const egypt = menu.find(o => o.to === "egypt");
  assert.ok(egypt?.stops, "taking Balkania's captured HQ stops its win");
  assert.ok(egypt.race.some(r => r.name === "Imperial Balkania" && r.after < r.before));
  const u = userOf(chat.calls[0].request);
  assert.match(u, /THE RACE \(who could win on their next turn\):\n- Imperial Balkania is one Red Star short/);
  assert.match(u, /Lowers Imperial Balkania's chance to win next turn: \d+% → \d+%/);
  assert.match(u, /Net value \+\d+\.\d \(staff estimate, in troops\)/);
  assert.match(u, /Staff notes: options are listed best first by net value/);
  assert.match(u, /No conquest yet this turn: your first one earns a resource card/);
  assert.match(systemOf(chat.calls[0].request), /At this level winning comes first/);

  // Commander: unchanged (no values, no race block, no staff notes, no Warlord rule).
  reset();
  const n = fakeChat(STOP);
  await runLLMCall(brain, "leader-one-star", 1, { chat: n, difficulty: "normal" });
  const un = userOf(n.calls[0].request);
  for ( const re of [/THE RACE/, /Net value/, /Staff notes/, /No conquest yet this turn/] ) assert.doesNotMatch(un, re);
  assert.doesNotMatch(systemOf(n.calls[0].request), /At this level winning comes first/);
});

test("Warlord floors: 45% ordinary, 33% big swing, risk moves them only ±5 points; Commander keeps its ±10", () => {
  const hard = LLM_PROFILES.hard;
  const at = risk => ({ risk, aggression: 0.5, chattiness: 0.5, vengeance: 0.5, patience: 0.5 });
  assert.equal(oddsFloor(hard, at(0.5)), 0.45);
  assert.equal(oddsFloor(hard, at(0.5), true), 0.33);
  assert.ok(Math.abs(oddsFloor(hard, at(1)) - 0.40) < 1e-9, "the gambler at Warlord: 40%");
  assert.ok(Math.abs(oddsFloor(hard, at(0)) - 0.50) < 1e-9);
  assert.ok(Math.abs(stepFloor(hard, at(0.5)) - 0.40) < 1e-9, "a running attack stops under 40%");
  assert.ok(Math.abs(stepFloor(hard, at(0.5), false, true) - 0.28) < 1e-9);
  assert.equal(stepFloor(hard, at(0.5), true), 0.15, "decisive");
  // Commander: unchanged (25% ± 10).
  assert.ok(Math.abs(oddsFloor(LLM_PROFILES.normal, at(1)) - 0.15) < 1e-9);
  assert.ok(Math.abs(oddsFloor(LLM_PROFILES.normal, at(0)) - 0.35) < 1e-9);
});

test("Warlord sanity layer: a rival about to win is answered even when the model says stop", async () => {
  reset();
  const chat = fakeChat(STOP);
  const { out } = await runLLMCall(brain, "leader-one-star", 1, { chat, difficulty: "hard" });
  assert.equal(out.type, "attack");
  assert.equal(out.why.veto, "stopLeader");
  assert.ok(["egypt", "russia"].includes(out.to), `hits one of Balkania's HQs (${out.to})`);
  assert.equal(chat.calls.length, 1, "no extra call");
  // A plan that already answers the threat is left alone.
  reset();
  const ok = fakeChat(() => ({ thinking: "Egypt.", steps: ["attack_egypt_from_southern_europe"], keep_at_least: 0, stop_when: "after_these_steps", say: "" }));
  const r = await runLLMCall(brain, "leader-one-star", 1, { chat: ok, difficulty: "hard" });
  assert.equal(r.out.to, "egypt");
  assert.equal(r.out.why.veto, undefined);
});

test("Warlord sanity layer: no turn ends without the safe conquest that earns a card; Commander's stop stands", async () => {
  reset();
  const chat = fakeChat(STOP);
  const { out, ctx } = await runLLMCall(brain, "continent-vs-card", 0, { chat, difficulty: "hard" });
  assert.equal(out.type, "attack");
  assert.equal(out.why.veto, "earnCard");
  assert.equal(out.why.reason, "cardConquest");
  assert.ok(out.why.chance >= 0.75);
  // Only safe ones: cardConquest picks high odds, low losses, positive value.
  const sit = await situationOf(ctx);
  const plan = cardConquest(ctx, attackMenu(ctx, LLM_PROFILES.hard, knobsOf(ctx), sit).map(o => o.plan));
  assert.ok(!plan || (plan.P >= 0.75 && plan.eLoss <= 2));
  // After a conquest this turn there is nothing to insure.
  ctx.state.turn.log.conquered = 1;
  assert.equal(cardConquest(ctx, attackMenu(ctx, LLM_PROFILES.hard, knobsOf(ctx), sit).map(o => o.plan)), null);

  reset();
  const n = fakeChat(STOP);
  const r = await runLLMCall(brain, "continent-vs-card", 0, { chat: n, difficulty: "normal" });
  assert.equal(r.out.type, "stop");
});

test("Warlord cards: no 'hold' when a Red Star is buyable; code buys when no trade is worth weighing; trades must beat the star progress", async () => {
  // full-turn: 5 cards worth 9 coins → a 25-troop trade is worth weighing against the star.
  reset();
  const spec = readLLMSituation("full-turn");
  const chat = fakeChat();
  await runLLMCall(brain, "full-turn", 0, { spec, chat, difficulty: "hard" });
  const plan = chat.calls.find(c => c.purpose === "turn plan").request;
  assert.deepEqual(enumOf(plan, "cards"), ["buy_red_star", "trade_for_troops"]);
  // Commander: still offered "hold".
  reset();
  const n = fakeChat();
  await runLLMCall(brain, "full-turn", 0, { spec, chat: n, difficulty: "normal" });
  assert.ok(enumOf(n.calls[0].request, "cards").includes("hold_cards"));

  // Cheap cards (5 coins → 10 troops): no trade worth weighing, so code buys the star without asking.
  reset();
  const cheap = structuredClone(spec);
  for ( const c of cheap.view.hand ) c.coins = 1;
  const c2 = fakeChat();
  const r = await runLLMCall(brain, "full-turn", 0, { spec: cheap, chat: c2, difficulty: "hard" });
  assert.equal(r.out.buyRedStars?.length, 4);
  assert.equal(r.out.why.veto, "buyStar");
  // The turn plan still runs (for the scar card and placement), without a card question.
  const tp = c2.calls.find(c => c.purpose === "turn plan").request;
  assert.ok(!tp.schema.schema.properties.cards, "no card question");
  assert.match(userOf(tp), /your officers spend 4 cards on 1 Red Star/);

  // Trade floors by how close the hand is to a star (no HQ need).
  assert.deepEqual([1, 2, 3, 4, 7].map(warlordTradeFloor), [4, 7, 13, 21, 21]);
  reset();
  const three = structuredClone(spec);
  three.view.hand = three.view.hand.slice(2);   // 3 cards, 7 coins → 17 troops: over 13, offered
  const ctx = makeLLMContext(three, { difficulty: "hard" });
  const calm = { hqNeed: 0, hqWorst: 0 };
  assert.ok(cardMenu(ctx, LLM_PROFILES.hard, knobsOf(ctx), calm).options.some(o => o.kind === "trade"));
  ctx.view.hand = ctx.view.hand.map(c => ({ ...c, coins: 1 }));   // 3 coins → 4 troops: not worth a near-star
  assert.ok(!cardMenu(ctx, LLM_PROFILES.hard, knobsOf(ctx), calm).options.some(o => o.kind === "trade"));
});

/** hq-under-threat with a beatable threat: Balkania 3 in Western Europe, no cards; the bot places `reserve`. */
function guardSpec(reserve = 16) {
  const spec = readSituation("hq-under-threat");
  spec.pieces.western_europe.balkania = 3;
  spec.factions.balkania.hand = { count: 0, coins: 0 };
  spec.calls[1].reserve = reserve;
  spec.calls[1].args.reserve = reserve;
  return spec;
}

test("Warlord sanity layer: a placement that leaves a defensible HQ to fall is corrected; a hopeless one is left alone", async () => {
  const away = reserve => () => req => ({
    thinking: "Brazil.", ...(req.schema.schema.properties.cards ? { cards: enumOf(req, "cards")[0] } : {}),
    placements: [{ front: "brazil", troops: reserve - 2 }, { front: "east_africa", troops: 2 }], say: ""
  });
  reset();
  const spec = guardSpec(16);
  const chat = fakeChat(away(16));
  const { out, ctx } = await runLLMCall(brain, "hq-under-threat", 1, { spec, chat, difficulty: "hard" });
  const hq = out.placements.find(p => p.territory === "north_africa");
  assert.ok(hq?.count > 0, "troops moved to the HQ");
  assert.equal(out.why.veto, "hqPlacement");
  assert.equal(out.placements.reduce((n, p) => n + p.count, 0), 16);
  assert.ok(worstThreat(ctx, "north_africa", hq.count, { depth: 2 }).p <= 0.3, "safe afterwards");
  // Commander: the model's placement stands.
  reset();
  const n = await runLLMCall(brain, "hq-under-threat", 1, { spec, chat: fakeChat(away(16)), difficulty: "normal" });
  assert.ok(!n.out.placements.some(p => p.territory === "north_africa"));
  // Hopeless (the original fixture: Balkania with cards, 7 to place): left to the model.
  reset();
  const h = await runLLMCall(brain, "hq-under-threat", 1, { chat: fakeChat(away(7)), difficulty: "hard" });
  assert.equal(h.out.why.veto, undefined);
});

test("Warlord sanity layer: the end of turn reinforces an HQ in danger instead of no maneuver; staff pick marked", async () => {
  const spec = guardSpec();
  spec.pieces.south_africa.saharan = 12;
  const callOverride = { fn: "planManeuver", phase: "maneuver", log: { recruited: true }, args: {} };
  const answer = maneuver => () => req => ({ thinking: "x", maneuver, ...(req.schema.schema.properties.draw ? { draw: enumOf(req, "draw")[0] } : {}), say: "" });
  reset();
  const chat = fakeChat(answer("no_maneuver"));
  const { out } = await runLLMCall(brain, "hq-under-threat", 1, { spec, chat, difficulty: "hard", callOverride });
  assert.deepEqual([out?.from, out?.to, out?.why.veto], ["south_africa", "north_africa", "hqManeuver"]);
  assert.match(userOf(chat.calls[0].request), /from_south_africa_to_north_africa: [^\n]*staff pick/);
  reset();
  const n = await runLLMCall(brain, "hq-under-threat", 1, { spec, chat: fakeChat(answer("no_maneuver")), difficulty: "normal", callOverride });
  assert.equal(n.out, null, "Commander: no maneuver stands");
});

test("A/B patch: WARLORD_CLASSIC restores the Warlord before §11 (no values, no vetoes, old floors), page-local and clearable", async () => {
  try {
    setLLMProfilePatch({ hard: WARLORD_CLASSIC });
    reset();
    const chat = fakeChat(STOP);
    const { out } = await runLLMCall(brain, "leader-one-star", 1, { chat, difficulty: "hard" });
    assert.equal(out.type, "stop", "no stop-the-leader override");
    const u = userOf(chat.calls[0].request);
    assert.doesNotMatch(u, /Net value|THE RACE|Staff notes/);
    assert.match(u, /expected losses/, "still the Warlord's full odds");
    assert.doesNotMatch(systemOf(chat.calls[0].request), /winning comes first/);
  } finally {
    setLLMProfilePatch(null);
  }
  reset();
  const chat = fakeChat(STOP);
  const { out } = await runLLMCall(brain, "leader-one-star", 1, { chat, difficulty: "hard" });
  assert.equal(out.why.veto, "stopLeader", "patch cleared");
});

test("Warlord turn plan: staff placement suggestion and race facts", async () => {
  reset();
  const chat = fakeChat();
  await runLLMCall(brain, "hq-under-threat", 1, { chat, difficulty: "hard" });
  const u = userOf(chat.calls[0].request);
  assert.match(u, /Staff suggestion for your 7 troops \(the code's tuned split\): \d+ on /);
  assert.match(u, /THE RACE/);
});
