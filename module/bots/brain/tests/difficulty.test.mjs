/**
 * Difficulty makes a visible difference (BOTS.md §5.2), checked with seeded randomness and canned Jev answers.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../index.mjs";
import { movePlans } from "../candidates.mjs";
import { PROFILES } from "../profiles.mjs";
import { fakeAsk, makeContext, readSituation, reset, runCall } from "./helpers.mjs";

/** Me (a) with 4 troops in Brazil next to 2 of b's troops in Peru: a 66% attack worth "a solid gain". */
function oddsSpec() {
  return {
    me: "a", factions: { a: { name: "Alpha", redStarTokens: 1 }, b: { name: "Beta", redStarTokens: 1 } },
    pieces: { brazil: { a: 4 }, venezuela: { a: { troops: 3, hq: true } }, argentina: { a: 1 }, peru: { b: 2 }, north_africa: { b: { troops: 9, hq: true } } },
    turn: { faction: "a", phase: "attack", log: { recruited: true } }
  };
}

test("attack thresholds: normal takes a 66% attack that easy (≥ 75%) refuses", async () => {
  const answers = { "value_*": { level: 2 } };
  reset();
  const normal = await brain.nextMove(makeContext(oddsSpec(), { difficulty: "normal", ask: fakeAsk(answers) }));
  assert.deepEqual([normal.type, normal.to], ["attack", "peru"]);
  reset();
  const easy = await brain.nextMove(makeContext(oddsSpec(), { difficulty: "easy", ask: fakeAsk(answers) }));
  assert.notEqual(easy.to, "peru");
});

test("easy samples Jev's distribution with a temperature; normal and hard take the argmax", async () => {
  const probs = { add_2_troops_to_each_of_up_to_two_of_your_cities: 0.55, fortify_one_of_your_cities: 0.45 };
  const picks = { easy: new Set(), normal: new Set(), hard: new Set() };
  for ( let seed = 1; seed <= 30; seed++ ) {
    for ( const difficulty of ["easy", "normal", "hard"] ) {
      reset();
      const ask = fakeAsk({ best: { probs }, best_reversed: { probs } });
      const { out } = await runCall(brain, "event-choice", 0, { difficulty, ask, seed });
      picks[difficulty].add(out.value);
    }
  }
  assert.equal(picks.easy.size, 2, "easy sometimes takes the less likely option");
  assert.deepEqual([...picks.normal], ["troops"]);
  assert.deepEqual([...picks.hard], ["troops"]);
});

test("easy often stops after its first conquest; normal keeps going", async () => {
  let easyStops = 0;
  let normalStops = 0;
  for ( let seed = 1; seed <= 20; seed++ ) {
    for ( const difficulty of ["easy", "normal"] ) {
      reset();
      const spec = readSituation("leader-one-star");
      spec.turn.log.conquered = 1;
      const out = await brain.nextMove(makeContext(spec, { difficulty, seed }));
      if ( out.type === "stop" ) difficulty === "easy" ? easyStops++ : normalStops++;
    }
  }
  assert.ok(easyStops >= 4 && easyStops <= 16, `easy stopped ${easyStops}/20`);
  assert.equal(normalStops, 0);
});

test("missiles: a bystander missile against the leader's winning attack — hard fires, normal holds", async () => {
  const answers = { stakes: { level: 4 } };
  reset();
  const hard = (await runCall(brain, "bystander-missile", 0, { difficulty: "hard", ask: fakeAsk(answers) })).out;
  assert.equal(hard.fire, true);
  assert.equal(hard.why.reason, "missileStopLeader");
  reset();
  const normal = (await runCall(brain, "bystander-missile", 0, { difficulty: "normal", ask: fakeAsk(answers) })).out;
  assert.equal(normal.fire, false);
  // Easy fires only when losing the battle would hand someone the win (true here) — and never asks Jev.
  reset();
  const ask = fakeAsk(answers);
  const easy = (await runCall(brain, "bystander-missile", 0, { difficulty: "easy", ask })).out;
  assert.equal(easy.fire, true);
  assert.equal(ask.calls.length, 0);
});

test("maneuver and scar cards: easy never; normal consolidates and plays a Mercenary; hard also targets the leader", async () => {
  const man = {};
  const scars = {};
  for ( const difficulty of ["easy", "normal", "hard"] ) {
    reset();
    const spec = readSituation("placement-exposure");
    spec.pieces.eastern_australia.khan.troops = 8;   // troops to spare above the HQ floor
    man[difficulty] = await brain.planManeuver(makeContext(spec, { difficulty, call: { phase: "maneuver" } }));
    const ctx = makeContext(readSituation("leader-one-star"), { difficulty });
    scars[difficulty] = await brain.planScars(ctx, {
      cards: [{ id: "m", scar: "mercenary", name: "Mercenary", target: "territory" }, { id: "b", scar: "biohazard", name: "Bio-hazard", target: "territory" }],
      targets: Object.keys(ctx.state.territories)
    });
  }
  assert.equal(man.easy, null);
  assert.ok(man.normal && man.hard);
  for ( const d of ["normal", "hard"] ) {
    if ( man[d].from === "eastern_australia" ) assert.ok(8 - man[d].count >= PROFILES[d].attack.hqFloor, `${d} keeps its HQ floor`);
  }
  assert.equal(scars.easy.plays.length, 0);
  assert.deepEqual(scars.normal.plays.map(p => p.cardId), ["m"]);
  assert.deepEqual(scars.hard.plays.map(p => p.cardId).sort(), ["b", "m"]);
  assert.ok(scars.hard.plays.find(p => p.cardId === "b").territory === "russia" || scars.hard.plays.find(p => p.cardId === "b").territory === "egypt");
});

test("placement: easy makes one pile; normal splits HQ defence and staging; hard plans multi-step chains", async () => {
  for ( const name of ["hq-under-threat", "placement-exposure", "leader-one-star", "red-star-vs-troops"] ) {
    reset();
    const out = await brain.planPlacement(makeContext(readSituation(name), { difficulty: "easy", call: { phase: "recruit", reserve: 9, log: { recruited: true } } }), { reserve: 9 });
    assert.equal(out.placements.length, 1, `easy one pile in ${name}`);
  }
  reset();
  const normal = await brain.planPlacement(makeContext(readSituation("red-star-vs-troops"), { difficulty: "normal", call: { phase: "recruit", reserve: 33, log: { recruited: true } } }), { reserve: 33 });
  assert.ok(normal.placements.length >= 2, JSON.stringify(normal.placements));
  assert.ok(normal.placements.some(p => p.territory === "china"), "normal reinforces its HQ");
  const ctx = makeContext(readSituation("red-star-vs-troops"), { difficulty: "hard", call: { phase: "recruit" } });
  assert.ok(movePlans(ctx, PROFILES.hard, { extra: { afghanistan: 33 }, from: "afghanistan", ignoreTurn: true }).some(p => p.chain && p.endFx.winNow));
  assert.ok(!movePlans(ctx, PROFILES.normal, { extra: { afghanistan: 33 }, from: "afghanistan", ignoreTurn: true }).some(p => p.chain));
});

test("context and candidates grow with difficulty", async () => {
  const sizes = {};
  for ( const difficulty of ["easy", "normal", "hard"] ) {
    reset();
    const sitAsk = fakeAsk();
    await runCall(brain, "hq-win-vs-continent", 0, { difficulty, ask: sitAsk });
    const placeAsk = fakeAsk();
    await runCall(brain, "early-expansion", 0, { difficulty, ask: placeAsk });
    const st = sitAsk.calls[0].request.state;
    const anyFaction = Object.values(st.factions)[0];
    sizes[difficulty] = {
      situationQuestions: Object.keys(sitAsk.calls[0].request.questions).length,
      standings: Object.keys(anyFaction).length,
      cards: "resource_cards" in anyFaction,
      values: Object.keys(placeAsk.calls[0]?.request.questions ?? {}).length
    };
  }
  assert.ok(sizes.easy.standings < sizes.normal.standings && sizes.normal.standings < sizes.hard.standings, JSON.stringify(sizes));
  assert.equal(sizes.easy.cards, false);
  assert.equal(sizes.hard.cards, true);
  assert.ok(sizes.easy.situationQuestions < sizes.normal.situationQuestions && sizes.normal.situationQuestions < sizes.hard.situationQuestions, JSON.stringify(sizes));
  assert.ok(sizes.easy.values <= 4 && sizes.normal.values <= 6 && sizes.hard.values <= 8, JSON.stringify(sizes));
});

test("HQ floor: normal and hard never move their HQ below the floor; easy may", async () => {
  // placement-exposure: Khan's HQ (Eastern Australia) holds 4 troops, Indonesia next door is exposed.
  for ( const difficulty of ["normal", "hard"] ) {
    reset();
    const ctx = makeContext(readSituation("placement-exposure"), { difficulty, call: { phase: "maneuver" } });
    const m = await brain.planManeuver(ctx);
    const floor = PROFILES[difficulty].attack.hqFloor;
    if ( m?.from === "eastern_australia" ) assert.ok(4 - m.count >= floor, `${difficulty} maneuver keeps ${floor} in the HQ`);
    const mi = await brain.moveIn(ctx, { from: "eastern_australia", to: "new_guinea", min: 0, max: 3 });
    assert.ok(4 - mi.count >= Math.min(floor, 4) || mi.count === 0, `${difficulty} moveIn keeps the HQ floor`);
  }
});
