/**
 * Exact odds against the reference numbers (context.md §2.6, computed with the system's own dice functions).
 * Run: node --test module/bots/brain/tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { emptyRules } from "../../../battle/modifiers.mjs";
import {
  attackOdds, battleOdds, clearOddsCache, defenceChoices, expectedLeftOnConquest, missileOptions, pathOdds, rollDist
} from "../odds.mjs";
import { makeContext, makeState, readSituation } from "./helpers.mjs";

const near = (a, b, eps = 0.0006, msg = "") => assert.ok(Math.abs(a - b) <= eps, `${msg} ${a} ≉ ${b}`);
const dist = d => Object.fromEntries(d.map(o => [`${o.aLoss},${o.dLoss}`, o.p]));
const FORT = [{ source: "fortification", side: "defend", die: "all", delta: 1 }];

test("one roll, no modifiers: classic 3v2 is 37.2 / 33.6 / 29.3%", () => {
  const d = dist(rollDist(3, 2));
  near(d["0,2"], 0.3717); near(d["1,1"], 0.3358); near(d["2,0"], 0.2926);
  near(dist(rollDist(1, 1))["0,1"], 0.4167);
  near(dist(rollDist(1, 2))["0,1"], 0.2546);
  near(dist(rollDist(2, 1))["0,1"], 0.5787);
  const d22 = dist(rollDist(2, 2));
  near(d22["0,2"], 0.2276); near(d22["1,1"], 0.3241); near(d22["2,0"], 0.4483);
  near(dist(rollDist(3, 1))["0,1"], 0.6597);
});

test("one roll with a fortification (+1 both defence dice) and a bunker (+1 highest)", () => {
  const f = dist(rollDist(3, 2, FORT));
  near(f["0,2"], 0.1890); near(f["1,1"], 0.3133); near(f["2,0"], 0.4977);
  near(dist(rollDist(3, 1, FORT))["0,1"], 0.4938);
  const b = dist(rollDist(3, 2, [{ source: "bunker", side: "defend", die: "highest", delta: 1 }]));
  near(b["0,2"], 0.2392); near(b["1,1"], 0.4084); near(b["2,0"], 0.3524);
});

test("whole battle: P(conquer) table (A in the attacking territory, max dice until A = 1)", () => {
  const table = {
    2: [0.417, 0.106, 0.027, 0.007, 0.002, 0.000, 0.000, 0.000],
    4: [0.916, 0.656, 0.470, 0.315, 0.206, 0.134, 0.054, 0.021],
    6: [0.990, 0.890, 0.769, 0.638, 0.506, 0.397, 0.224, 0.118],
    10: [1.000, 0.990, 0.967, 0.930, 0.873, 0.808, 0.646, 0.480],
    20: [1.000, 1.000, 1.000, 0.999, 0.999, 0.997, 0.987, 0.965]
  };
  const Ds = [1, 2, 3, 4, 5, 6, 8, 10];
  for ( const [A, row] of Object.entries(table) ) {
    row.forEach((p, i) => near(battleOdds({ A: Number(A), D: Ds[i] }).pConquer, p, 0.0006, `A=${A} D=${Ds[i]}`));
  }
  const r = battleOdds({ A: 10, D: 4 });
  near(r.pConquer, 0.9298, 0.0001);
  near(r.eAttackerLosses, 3.160, 0.001);
  // Conquest distribution sums to P(conquer); troops left ≥ 2 (the last roll needs 2+).
  const total = [...r.conquest].reduce((a, b) => a + b, 0);
  near(total, r.pConquer, 1e-9);
  assert.equal(r.conquest[0] + r.conquest[1], 0);
  assert.ok(expectedLeftOnConquest(r) > 2 && expectedLeftOnConquest(r) < 10);
});

test("fortification: matches the reference without wear, and wears out after 3-dice attacks", () => {
  [0.945, 0.662, 0.443, 0.274, 0.092, 0.027].forEach((p, i) => near(battleOdds({ A: 6, D: [1, 2, 3, 4, 6, 8][i], sources: FORT }).pConquer, p, 0.0006));
  const noWear = battleOdds({ A: 20, D: 8, sources: FORT }).pConquer;
  const worn = battleOdds({ A: 20, D: 8, sources: FORT, fortReal: true, fortUsed: 8 }).pConquer;
  const fresh = battleOdds({ A: 20, D: 8, sources: FORT, fortReal: true, fortUsed: 0 }).pConquer;
  near(noWear, 0.704, 0.001);
  assert.ok(worn > fresh && fresh > noWear, `wear helps the attacker: ${noWear} < ${fresh} < ${worn}`);
  near(battleOdds({ A: 20, D: 8, sources: FORT, fortReal: true, fortUsed: 10 }).pConquer, battleOdds({ A: 20, D: 8 }).pConquer, 1e-9);
});

test("special rules: Enclave's natural triple, Mechaniker's double six, cloning, re-rolled ones, stopAt", () => {
  const triple = battleOdds({ A: 10, D: 8, rules: { ...emptyRules(), conquerOnNaturalTriple: true } }).pConquer;
  assert.ok(triple > battleOdds({ A: 10, D: 8 }).pConquer);
  const protect = battleOdds({ A: 10, D: 4, rules: { ...emptyRules(), protectOnDoubleSix: true } });
  assert.ok(protect.pProtected > 0.01 && protect.pConquer < 0.9298);
  const clone = battleOdds({ A: 10, D: 4, rules: { ...emptyRules(), cloneOnNaturalDoubles: true } });
  assert.ok(clone.pConquer < 0.9298);
  // A = 2 vs D = 2 with cloning has a self-loop (attacker wins one pair, defender clones); still a proper distribution.
  const loop = battleOdds({ A: 2, D: 2, rules: { ...emptyRules(), cloneOnNaturalDoubles: true } });
  near(loop.pConquer + loop.pStop + loop.pProtected, 1, 1e-9);
  assert.ok(battleOdds({ A: 6, D: 3, rules: { ...emptyRules(), rerollOnes: true } }).pConquer > battleOdds({ A: 6, D: 3 }).pConquer);
  assert.ok(battleOdds({ A: 10, D: 4, stopAt: 5 }).pConquer < 0.9298);
});

test("attackOdds reads the state's own modifiers (fortified city, bunker)", () => {
  const s = makeState({
    factions: { a: {}, b: {} },
    pieces: { brazil: { a: 8 }, argentina: { b: 3 }, peru: { b: 3 } },
    marks: { argentina: { city: "major", fortified: true }, peru: { scar: "bunker" } },
    turn: { faction: "a", phase: "attack", log: { recruited: true } }
  });
  const plain = battleOdds({ A: 8, D: 3 }).pConquer;
  const fort = attackOdds(s, "a", "brazil", "argentina").pConquer;
  const bunker = attackOdds(s, "a", "brazil", "peru").pConquer;
  assert.ok(fort < bunker && bunker < plain, `${fort} < ${bunker} < ${plain}`);
});

test("pathOdds: expansion costs and chained conquests", () => {
  const s = makeState({
    factions: { a: {}, b: {} },
    pieces: { venezuela: { a: 12 }, peru: { b: 2 }, argentina: { b: 2 } },
    marks: { brazil: { city: "minor" } },
    turn: { faction: "a", phase: "attack", log: { recruited: true } }
  });
  const expand = pathOdds(s, "a", ["venezuela", "brazil"]);
  assert.equal(expand.pReach, 1);
  assert.equal([...expand.dist.keys()][0], 10);   // 11 move, 1 lost to the city
  const chain = pathOdds(s, "a", ["venezuela", "peru", "argentina"]);
  assert.ok(chain.pReach > 0.85 && chain.pReach < 1, `chain ${chain.pReach}`);
  assert.ok(chain.pReach < attackOdds(s, "a", "venezuela", "peru").pConquer);
});

test("defence dice and missiles on a rolled battle", () => {
  const spec = readSituation("missile-decisive");
  const ctx = makeContext(spec);
  const battle = spec.calls[0].args.battle;
  const mo = missileOptions(ctx.state, battle, {});
  assert.equal(mo.base.pConquer, 1);                     // 6,4 beat 5,3: Brazil falls now
  const defend = mo.options.filter(o => o.side === "defend");
  const best = defend.reduce((a, b) => (b.pConquer < a.pConquer ? b : a));
  assert.equal(best.pConquer, 0);                        // the 3 becomes a 6: both pairs go to the defender
  assert.equal(best.index, 0);
  assert.ok(mo.options.some(o => o.side === "attack"));
  const choices = defenceChoices(ctx.state, { attacker: "balkania", defender: "saharan", from: "north_africa", to: "brazil", attackDice: 2 }, 2);
  assert.equal(choices.length, 2);
  assert.ok(choices.every(c => c.pConquer >= 0 && c.pConquer <= 1));
});

test("memoized: a 40 v 40 fortified battle with wear solves well under 50 ms", () => {
  clearOddsCache();
  const t0 = performance.now();
  battleOdds({ A: 40, D: 40, sources: FORT, fortReal: true });
  assert.ok(performance.now() - t0 < 50);
  const t1 = performance.now();
  for ( let A = 2; A < 30; A++ ) for ( let D = 1; D < 20; D++ ) battleOdds({ A, D });
  assert.ok(performance.now() - t1 < 50);
});
