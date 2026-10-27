/**
 * Every decision function: heuristic mode (ask = null), a fake ask with shape-checked requests, canned answers
 * driving the decision, error propagation and timing. Run: node --test module/bots/brain/tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../index.mjs";
import { PROFILES } from "../profiles.mjs";
import * as rules from "../../../rules/_module.mjs";
import { REASONS, fakeAsk, makeContext, readSituation, reset, resolveArgs, runCall, situationNames } from "./helpers.mjs";

/** Legality and shape of a decision for a call. */
function checkDecision(fn, out, ctx, args) {
  const { state, me } = ctx;
  if ( fn === "preRollScar" && out === null ) return;
  if ( fn === "planManeuver" && out === null ) return;
  assert.ok(out && typeof out === "object", `${fn}: decision object`);
  assert.ok(out.why && REASONS.has(out.why.reason), `${fn}: why.reason ${out.why?.reason}`);
  if ( out.why.chance !== undefined ) assert.ok(out.why.chance >= 0 && out.why.chance <= 1, `${fn}: chance in 0..1`);
  switch ( fn ) {
    case "assessSituation":
      assert.ok(out.leader === null || state.factions[out.leader]);
      assert.ok(out.hqDanger >= 0 && out.hqDanger <= 3);
      for ( const p of Object.values(out.threats) ) assert.ok(p >= 0 && p <= 1);
      break;
    case "planStartOfTurn":
      if ( out.buyRedStars ) {
        assert.equal(out.buyRedStars.length, 4);
        for ( const id of out.buyRedStars ) assert.ok(ctx.view.hand.some(c => c.id === id));
      }
      break;
    case "planRecruit":
      if ( args.mustJoin ) assert.ok(args.legalJoin.includes(out.join), `join ${out.join} is legal`);
      else {
        assert.equal(out.recruit, true);
        if ( out.tradeForTroops ) {
          const coins = out.tradeForTroops.reduce((n, id) => n + ctx.view.hand.find(c => c.id === id).coins, 0);
          assert.ok(rules.checkTrade(state, me, coins, { ignoreTurn: true }).ok);
        }
      }
      break;
    case "planPlacement": {
      const total = out.placements.reduce((n, p) => n + p.count, 0);
      assert.ok(total <= args.reserve && total === args.reserve, `placements sum ${total} = reserve ${args.reserve}`);
      for ( const p of out.placements ) {
        assert.ok(Number.isInteger(p.count) && p.count >= 1);
        assert.ok(rules.checkPlacement(state, me, p.territory, p.count, { ignoreTurn: true }).ok, `place in ${p.territory}`);
      }
      break;
    }
    case "nextMove":
      if ( out.type === "attack" ) assert.ok(rules.checkAttack(state, me, out.from, out.to, out.dice).ok, "attack is legal");
      else if ( out.type === "expand" ) assert.ok(rules.checkExpand(state, me, out.from, out.to, out.count).ok, "expand is legal");
      else assert.equal(out.type, "stop");
      break;
    case "missileDecision":
      if ( out.fire ) {
        assert.ok(["attack", "defend"].includes(out.side));
        const dice = args.battle[out.side];
        assert.ok(dice.some(d => d.slot === out.index && !d.missile));
      }
      break;
    case "chooseStartingTerritory":
      assert.ok(args.legal.includes(out.territory));
      break;
    case "chooseOption":
      assert.ok(args.options.some(o => o.value === out.value && !o.disabled));
      break;
    default: break;
  }
}

/** Every call of every situation file. */
function allCalls() {
  const out = [];
  for ( const name of situationNames() ) readSituation(name).calls.forEach((c, i) => out.push([name, i, c.fn]));
  return out;
}

test("heuristic mode (ask = null): every fixture call returns a legal decision with a known why", async () => {
  for ( const [name, i, fn] of allCalls() ) {
    for ( const difficulty of ["easy", "normal", "hard"] ) {
      reset();
      const { out, ctx, args } = await runCall(brain, name, i, { difficulty, ask: null });
      checkDecision(fn, out, ctx, args);
    }
  }
});

test("with Jev (fake ask): requests pass the shape checks and decisions stay legal", async () => {
  let requests = 0;
  for ( const [name, i, fn] of allCalls() ) {
    for ( const difficulty of ["easy", "normal", "hard"] ) {
      reset();
      const ask = fakeAsk();
      const { out, ctx, args } = await runCall(brain, name, i, { difficulty, ask });
      checkDecision(fn, out, ctx, args);
      requests += ask.calls.length;
      for ( const c of ask.calls ) assert.ok(JSON.stringify(c.request).length < 64000, "well under the context limit");
    }
  }
  assert.ok(requests > 20);
});

test("situation: Jev's leader, HQ danger and threats feed the result", async () => {
  reset();
  const ask = fakeAsk({ leader: { choice: "enclave_of_the_bear" }, hq_danger: { level: 0 }, "attacks_hq_*": 0.9 });
  const { out } = await runCall(brain, "leader-one-star", 0, { ask });
  assert.equal(out.leader, "enclave");
  assert.equal(out.hqDanger, 0);
  assert.equal(out.threats.khan, 0.9);
  assert.equal(ask.calls.length, 1);
  assert.equal(ask.calls[0].purpose, "situation");
  // The hard bot asks the leader Choice twice, in reversed order, in the same request.
  reset();
  const hardAsk = fakeAsk();
  await runCall(brain, "leader-one-star", 0, { ask: hardAsk, difficulty: "hard" });
  const q = hardAsk.calls[0].request.questions;
  assert.deepEqual(Object.keys(q.leader_reversed.criteria), Object.keys(q.leader.criteria).reverse());
});

test("attack: Jev's value judgments decide between two HQ attacks; a win-now move needs no question", async () => {
  // With Balkania on 2 Red Stars its two HQs (Egypt, Russia) are "a big swing", not decisive, so Jev's rating decides.
  // Rated high, Egypt (82%) is attacked. Rated worthless, it isn't: the only other HQ attack (Russia) is a long shot
  // out of Enclave's own HQ, so the bot holds its HQ instead.
  const outs = {};
  for ( const [best, other] of [["egypt", "russia"], ["russia", "egypt"]] ) {
    reset();
    const ask = fakeAsk({ [`value_${best}`]: { level: 3 }, [`value_${other}`]: { level: 0 }, "value_*": { level: 1 } });
    const spec = readSituation("leader-one-star");
    spec.factions.balkania.redStarTokens = 0;
    const call = spec.calls[1];
    const ctx = makeContext(spec, { ask, call });
    outs[best] = await brain[call.fn](ctx, resolveArgs(ctx, call.args ?? {}));
  }
  assert.deepEqual([outs.egypt.type, outs.egypt.to], ["attack", "egypt"]);
  assert.notEqual(outs.russia.to, "egypt");
  // On 3 Red Stars both captures are decisive, which is code's call: the likelier one wins whatever Jev says.
  reset();
  const decisiveAsk = fakeAsk({ value_russia: { level: 3 }, value_egypt: { level: 0 }, "value_*": { level: 1 } });
  const { out: decisive } = await runCall(brain, "leader-one-star", 1, { ask: decisiveAsk });
  assert.equal(decisive.why.value, "decisive");
  assert.equal(decisive.to, "egypt");
  reset();
  const ask = fakeAsk();
  const { out } = await runCall(brain, "hq-win-vs-continent", 2, { ask, difficulty: "normal" });
  assert.deepEqual([out.type, out.to, out.why.reason], ["attack", "russia", "winNow"]);
  assert.equal(ask.calls.length, 0);
});

test("attack: nothing worth doing stops without asking", async () => {
  reset();
  const ask = fakeAsk();
  const { out } = await runCall(brain, "nothing-good", 0, { ask });
  assert.equal(out.type, "stop");
  assert.equal(out.why.reason, "stopOddsPoor");
  assert.equal(ask.calls.length, 0);
});

test("missiles: stakes from Jev decide a qualifying swing; a trivial battle never asks", async () => {
  for ( const [level, fire] of [[4, true], [0, false]] ) {
    reset();
    const ask = fakeAsk({ stakes: { level } });
    const { out } = await runCall(brain, "missile-decisive", 0, { ask });
    assert.equal(out.fire, fire);
    if ( fire ) assert.deepEqual([out.side, out.index, out.why.reason], ["defend", 0, "missileSaveHq"]);
  }
  reset();
  const ask = fakeAsk({ stakes: { level: 4 } });
  const { out } = await runCall(brain, "missile-trivial", 0, { ask });
  assert.equal(out.fire, false);
  assert.equal(ask.calls.length, 0);
});

test("prompts: chooseOption follows Jev; starting territory follows Jev's levels", async () => {
  reset();
  const ask = fakeAsk({ best: { choice: "fortify_one_of_your_cities" }, best_reversed: { choice: "fortify_one_of_your_cities" } });
  const { out } = await runCall(brain, "event-choice", 0, { ask, difficulty: "hard" });
  assert.equal(out.value, "fortify");
  assert.ok(ask.calls[0].request.questions.best_reversed, "hard asks reversed");
  reset();
  const spec = readSituation("starting-territory");
  const ctx = makeContext(spec, { ask: fakeAsk((name) => (name === "start_japan" ? { level: 4 } : { level: 0 })) });
  const args = resolveArgs(ctx, { legal: "auto" });
  // Put Japan among the candidates by offering a short legal list.
  const r = await brain.chooseStartingTerritory(ctx, { legal: ["japan", "ontario", "argentina"] });
  assert.equal(r.territory, "japan");
  assert.ok(args.legal.length > 10);
});

test("cards: Jev's card judgment (profile cards/trade \"maths\"), from the Choice to the recruit trade", async () => {
  // No shipped profile uses it since tournament tuning (BOTS.md §5.4), but the path stays available to profiles.
  const saved = { cards: PROFILES.hard.cards, trade: PROFILES.hard.trade };
  Object.assign(PROFILES.hard, { cards: "maths", trade: "maths" });
  try {
  reset();
  const ask = fakeAsk({ cards: { choice: "trade_for_troops" }, cards_reversed: { choice: "trade_for_troops" } });
  const { out: sit } = await runCall(brain, "red-star-vs-troops", 0, { ask });
  assert.equal(sit.cards.choice, "trade_for_troops");
  const { out: start } = await runCall(brain, "red-star-vs-troops", 1, { situation: sit });
  assert.equal(start.buyRedStars, null);
  const { out: rec } = await runCall(brain, "red-star-vs-troops", 2, { situation: sit });
  assert.equal(rec.why.reason, "tradeTroops");
  assert.equal(rec.why.count, 30);
  reset();
  const buyAsk = fakeAsk({ cards: { choice: "buy_red_stars" }, cards_reversed: { choice: "buy_red_stars" } });
  const { out: sit2 } = await runCall(brain, "red-star-vs-troops", 0, { ask: buyAsk });
  const { out: start2 } = await runCall(brain, "red-star-vs-troops", 1, { situation: sit2 });
  assert.equal(start2.buyRedStars.length, 4);
  // A purchase that wins is always made (code rule).
  reset();
  const spec = readSituation("red-star-vs-troops");
  spec.factions.khan.redStarTokens = 2;   // 3 Red Stars with the HQ
  const ctx = makeContext(spec, { difficulty: "easy" });
  assert.equal((await brain.planStartOfTurn(ctx)).why.reason, "buyStarWin");
  } finally {
    Object.assign(PROFILES.hard, saved);
  }
});

test("other decisions: moveIn, maneuver, end of turn, defence dice, scars, names", async () => {
  reset();
  const ctx = makeContext(readSituation("leader-one-star"), { call: { phase: "maneuver" } });
  const mi = await brain.moveIn(ctx, { from: "southern_europe", to: "western_europe", min: 1, max: 5 });
  assert.ok(mi.count >= 1 && mi.count <= 5 && REASONS.has(mi.why.reason));
  const mSpec = readSituation("placement-exposure");
  mSpec.pieces.eastern_australia.khan.troops = 8;   // troops to spare above the HQ floor
  const m = await brain.planManeuver(makeContext(mSpec, { call: { phase: "maneuver" } }));
  assert.ok(m && rules.checkManeuver(makeContext(mSpec).state, "khan", m.from, m.to, m.count, { ignoreTurn: true }).ok);
  const end1 = await brain.planEndOfTurn(ctx, { missionStatus: { status: "complete", canComplete: true, reward: 1 }, drawOptions: { canDraw: true, territoryCardIds: ["x"] } });
  assert.equal(end1.completeMission, true);
  const end2 = await brain.planEndOfTurn(ctx, {
    drawOptions: { canDraw: true, territoryCardIds: ["r1", "r2"], coinAllowed: false, row: [{ cardId: "r1", territory: "southern_europe", slot: 1, value: 2 }, { cardId: "r2", territory: "great_britain", slot: 3, value: 5 }] }
  });
  assert.deepEqual(end2.draw, { cardId: "r2" });
  assert.equal((await brain.planEndOfTurn(ctx, { drawOptions: { canDraw: false } })).why.reason, "noDraw");
  const dd = await brain.chooseDefenseDice(ctx, { battle: { attacker: "balkania", defender: "enclave", from: "russia", to: "southern_europe", attackDice: 3 }, max: 2 });
  assert.ok([1, 2].includes(dd.dice));
  const scars = await brain.planScars(ctx, { cards: [{ id: "s1", scar: "mercenary", name: "Mercenary", target: "territory" }], targets: ["southern_europe", "egypt"] });
  assert.deepEqual(scars.plays, [{ cardId: "s1", territory: "southern_europe" }]);
  const pre = await brain.preRollScar(ctx, { battle: { attacker: "balkania", defender: "enclave", from: "russia", to: "southern_europe", attackDice: 3 }, cards: [{ id: "b1", scar: "bunker", name: "Bunker" }] });
  assert.equal(pre?.cardId, "b1");
  const n1 = brain.pickName(ctx, { kind: "city", used: [] });
  const n2 = brain.pickName(ctx, { kind: "city", used: [n1.name] });
  assert.ok(n1.name && n2.name && n1.name !== n2.name && n1.why.reason === "name");
});

test("a failed Jev call is an error, never an answer", async () => {
  const boom = async () => { throw Object.assign(new Error("relay down"), { name: "JevError" }); };
  for ( const [name, i] of [["leader-one-star", 0], ["leader-one-star", 1], ["missile-decisive", 0], ["event-choice", 0], ["starting-territory", 0], ["hq-under-threat", 1]] ) {
    reset();
    await assert.rejects(runCall(brain, name, i, { ask: boom }), /relay down/);
  }
});

test("each decision runs in about 50 ms of CPU or less (heuristic mode, cold memo)", async () => {
  const slow = [];
  for ( const [name, i, fn] of allCalls() ) {
    for ( const difficulty of ["normal", "hard"] ) {
      reset();
      const t0 = performance.now();
      await runCall(brain, name, i, { difficulty });
      const ms = performance.now() - t0;
      if ( ms > 60 ) slow.push(`${name}/${fn}/${difficulty}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test("Jev states use names, never faction actor ids", async () => {
  const ids = { khan: "Xk9QzP2mLr7Tb4Ua", balkania: "Yb3WnE8rTq1Vc6Hs", saharan: "Zs5RtY7uIo2Pa9Df", enclave: "Wq4ErT6yUi8Op0Lk", mechaniker: "Vm1NbV3cXz5As7Gh" };
  const swap = v => (typeof v === "string" && ids[v] ? ids[v] : v);
  const remap = spec => {
    const s = structuredClone(spec);
    s.me = swap(s.me);
    s.factions = Object.fromEntries(Object.entries(s.factions).map(([k, f]) => [swap(k), f]));
    s.pieces = Object.fromEntries(Object.entries(s.pieces).map(([t, byF]) => [t, Object.fromEntries(Object.entries(byF).map(([k, v]) => [swap(k), v]))]));
    if ( s.turn ) s.turn.faction = swap(s.turn.faction);
    for ( const c of s.calls ) if ( c.args?.battle ) for ( const k of ["attacker", "defender"] ) c.args.battle[k] = swap(c.args.battle[k]);
    return s;
  };
  let checked = 0;
  for ( const name of situationNames() ) {
    const spec = remap(readSituation(name));
    for ( const call of spec.calls ) {
      for ( const difficulty of ["easy", "hard"] ) {
        reset();
        const ask = fakeAsk();
        const ctx = makeContext(spec, { call, ask, difficulty });
        await brain[call.fn](ctx, resolveArgs(ctx, call.args ?? {}));
        for ( const c of ask.calls ) {
          const text = JSON.stringify(c.request);
          for ( const id of Object.values(ids) ) assert.ok(!text.includes(id), `${name}/${call.fn}: id ${id} leaked`);
          checked++;
        }
      }
    }
  }
  assert.ok(checked > 20);
});
