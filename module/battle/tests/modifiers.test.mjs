/**
 * Unit tests for the pure combat modifiers. Run: `node --test module/battle/tests/`
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applySources, clampDie, collectSources, computeModifiers, enterLossDue, enterLossFor, flattenEffect,
  normalizeKey, resolveDice
} from "../modifiers.mjs";

/* -------------------------------------------- */
/*  Fixtures                                    */
/* -------------------------------------------- */

const ATT = "attackerId";
const DEF = "defenderId";

/** A minimal BoardState for one battle: attacker in `east_africa`, defender in `egypt`. */
function makeState({ territory = {}, attacker = {}, defender = {}, log = {} } = {}) {
  return {
    territories: {
      east_africa: { id: "east_africa", owner: ATT, troops: 5, scar: null, marks: [], fortified: false, hq: null },
      egypt: { id: "egypt", owner: DEF, troops: 3, scar: null, marks: [], fortified: false, hq: null, ...territory }
    },
    factions: {
      [ATT]: { id: ATT, key: "enclave", powers: [], startingTerritory: "east_africa", missiles: 0, ...attacker },
      [DEF]: { id: DEF, key: "mechaniker", powers: [], startingTerritory: "north_africa", missiles: 0, ...defender }
    },
    turn: { faction: ATT, log: { firstAttackTarget: "", protected: [], flags: {}, ...log } }
  };
}

const dice = (...values) => values.map((natural, slot) => ({ slot, natural }));
const values = arr => arr.map(d => d.value);
const battleOf = (attack, defend, extra = {}) => ({
  attacker: ATT, defender: DEF, from: "east_africa", to: "egypt", attack: dice(...attack), defend: dice(...defend), ...extra
});

/* -------------------------------------------- */
/*  Die rules                                   */
/* -------------------------------------------- */

test("clampDie keeps dice within 1..6", () => {
  assert.equal(clampDie(7), 6);
  assert.equal(clampDie(0), 1);
  assert.equal(clampDie(-3), 1);
  assert.equal(clampDie(4), 4);
});

test("tie rule: a bunker modifies only one of two tied dice", () => {
  const state = makeState({ territory: { scar: "bunker" } });
  const out = computeModifiers(state, battleOf([3], [5, 5]));
  assert.deepEqual(values(out.defend), [6, 5]);
  assert.equal(out.defend[0].mods.length, 1);
  assert.equal(out.defend[1].mods.length, 0);
});

test("tie rule: highest and lowest sources pick different tied dice", () => {
  // Bunker (+1 higher) and Enclave power 1 (−1 lower) on a 5-5 defence.
  const state = makeState({ territory: { scar: "bunker" }, attacker: { powers: ["enclave_1"] } });
  const out = computeModifiers(state, battleOf([4, 4], [5, 5]));
  assert.deepEqual(values(out.defend), [6, 4]);
});

test("clamping: modifiers never push a die above 6 or below 1", () => {
  const fortBunker = makeState({ territory: { scar: "bunker", fortified: true } });
  assert.deepEqual(values(computeModifiers(fortBunker, battleOf([2], [6, 3])).defend), [6, 4]);
  const ammo = makeState({ territory: { scar: "ammo_shortage" } });
  assert.deepEqual(values(computeModifiers(ammo, battleOf([2], [1])).defend), [1]);
});

test("deltas on one die are summed before clamping (order independent)", () => {
  // Natural 6 with fortification (+1) and ammo shortage (−1): 6 + 1 − 1 = 6, not min(6+1,6) − 1 = 5.
  const state = makeState({ territory: { scar: "ammo_shortage", fortified: true } });
  assert.deepEqual(values(computeModifiers(state, battleOf([3], [6, 2])).defend), [6, 3]);
});

test("fortification adds 1 to both defence dice", () => {
  const state = makeState({ territory: { fortified: true } });
  const out = computeModifiers(state, battleOf([6, 5, 4], [4, 2]));
  assert.deepEqual(values(out.defend), [5, 3]);
  assert.equal(out.rules.fortified, true);
  assert.equal(out.rules.fortifiedBy, "fortification");
});

/* -------------------------------------------- */
/*  Missiles                                    */
/* -------------------------------------------- */

test("missile: the die becomes an unmodifiable 6", () => {
  const state = makeState({ territory: { scar: "ammo_shortage" } });
  const battle = battleOf([2], [5, 1]);
  battle.defend[1].missile = true;  // the natural 1 becomes a 6
  const out = computeModifiers(state, battle);
  // Ammo shortage −1 hits the natural higher die (the 5); the missile die stays a 6 with no modifiers.
  assert.deepEqual(values(out.defend), [6, 4]);
  const missileDie = out.defend.find(d => d.missile);
  assert.equal(missileDie.value, 6);
  assert.equal(missileDie.mods.length, 0);
});

test("missile on a modified die drops its modifiers", () => {
  const state = makeState({ territory: { scar: "ammo_shortage" } });
  const battle = battleOf([2], [6, 3]);
  battle.defend[0].missile = true;  // the ammo-shortage die
  const out = computeModifiers(state, battle);
  assert.deepEqual(values(out.defend), [6, 3]);
  assert.equal(out.defend[0].mods.length, 0);
});

test("re-sorting: dice are re-ordered after modifiers and missiles", () => {
  // Attack 5, 2 → missile on the 2 → 6, 5: the missile die is now the highest.
  const battle = battleOf([5, 2], [5, 4]);
  battle.attack[1].missile = true;
  const out = computeModifiers(makeState(), battle);
  assert.deepEqual(values(out.attack), [6, 5]);
  assert.equal(out.attack[0].slot, 1);
  const res = resolveDice({ ...out });
  assert.equal(res.defenderLosses, 2);
  assert.equal(res.attackerLosses, 0);
});

test("re-sorting: an ammo-shortage die can drop below the other die", () => {
  const state = makeState({ territory: { scar: "ammo_shortage" } });
  const out = computeModifiers(state, battleOf([5, 4], [4, 4]));
  // −1 on the first 4 (natural order) → 4, 3: re-sorted high → low.
  assert.deepEqual(values(out.defend), [4, 3]);
  const res = resolveDice(out);
  // 5 vs 4: attacker wins; 4 vs 3: attacker wins.
  assert.equal(res.defenderLosses, 2);
});

/* -------------------------------------------- */
/*  Resolution                                  */
/* -------------------------------------------- */

test("resolution: the defender wins ties and extra dice are ignored", () => {
  const out = computeModifiers(makeState(), battleOf([5, 4, 1], [5, 3]));
  const res = resolveDice(out);
  assert.equal(res.attackerLosses, 1);   // 5 vs 5 → defender
  assert.equal(res.defenderLosses, 1);   // 4 vs 3 → attacker
  assert.deepEqual(res.ignored.attack, [2]);
  assert.equal(res.pairs.length, 2);
});

test("resolution: one defence die compares against the highest attack die only", () => {
  const res = resolveDice(computeModifiers(makeState(), battleOf([2, 6, 1], [5])));
  assert.equal(res.defenderLosses, 1);
  assert.equal(res.attackerLosses, 0);
  assert.deepEqual(res.ignored.attack.sort(), [0, 2]);
});

test("resolution: two defence dice against one attack die", () => {
  const res = resolveDice(computeModifiers(makeState(), battleOf([4], [6, 1])));
  assert.equal(res.attackerLosses, 1);
  assert.equal(res.defenderLosses, 0);
  assert.deepEqual(res.ignored.defend, [1]);
});

/* -------------------------------------------- */
/*  Scars and powers                            */
/* -------------------------------------------- */

test("well-supplied ignores Ammo Shortage when defending", () => {
  const state = makeState({ territory: { scar: "ammo_shortage" }, defender: { powers: ["well-supplied"] } });
  const out = computeModifiers(state, battleOf([3], [5, 2]));
  assert.deepEqual(values(out.defend), [5, 2]);
  assert.equal(out.notes[0].key, "RL.Battle.Note.ignoreScar");
});

test("mechaniker_1: the starting HQ is fortified when defending", () => {
  const state = makeState({ defender: { powers: ["mechaniker_1"], startingTerritory: "egypt" } });
  const out = computeModifiers(state, battleOf([3], [4, 2]));
  assert.deepEqual(values(out.defend), [5, 3]);
  assert.equal(out.rules.fortifiedBy, "mechaniker_1");
  assert.equal(out.rules.fortified, false, "a virtual fortification is never worn down");
  const elsewhere = makeState({ defender: { powers: ["mechaniker_1"], startingTerritory: "north_africa" } });
  assert.deepEqual(values(computeModifiers(elsewhere, battleOf([3], [4, 2])).defend), [4, 2]);
});

test("mechaniker_1 + a real fortification only adds +1 once", () => {
  const state = makeState({
    territory: { fortified: true }, defender: { powers: ["mechaniker_1"], startingTerritory: "egypt" }
  });
  assert.deepEqual(values(computeModifiers(state, battleOf([3], [4, 2])).defend), [5, 3]);
});

test("enclave_1 applies only in the first territory attacked this turn", () => {
  const first = makeState({ attacker: { powers: ["enclave_1"] }, log: { firstAttackTarget: "egypt" } });
  assert.deepEqual(values(computeModifiers(first, battleOf([3], [5, 4])).defend), [5, 3]);
  const later = makeState({ attacker: { powers: ["enclave_1"] }, log: { firstAttackTarget: "libya" } });
  assert.deepEqual(values(computeModifiers(later, battleOf([3], [5, 4])).defend), [5, 4]);
  // A defender's own enclave_1 does nothing.
  const wrongSide = makeState({ defender: { powers: ["enclave_1"] }, log: { firstAttackTarget: "egypt" } });
  assert.deepEqual(values(computeModifiers(wrongSide, battleOf([3], [5, 4])).defend), [5, 4]);
});

test("enclave_1 with a single defence die modifies that die", () => {
  const state = makeState({ attacker: { powers: ["enclave_1"] } });
  assert.deepEqual(values(computeModifiers(state, battleOf([3], [5])).defend), [4]);
});

test("well-armed adds 1 to all attack dice against an HQ", () => {
  const hq = makeState({ territory: { hq: DEF }, attacker: { powers: ["well_armed"] } });
  assert.deepEqual(values(computeModifiers(hq, battleOf([6, 3, 3], [5])).attack), [6, 4, 4]);
  const noHq = makeState({ attacker: { powers: ["well_armed"] } });
  assert.deepEqual(values(computeModifiers(noHq, battleOf([6, 3, 3], [5])).attack), [6, 3, 3]);
});

test("enclave_2: natural three of a kind and one defender defeated conquers", () => {
  const state = makeState({ attacker: { powers: ["enclave_2"] } });
  const win = resolveDice(computeModifiers(state, battleOf([4, 4, 4], [3, 5])));
  assert.equal(win.defenderLosses, 1);
  assert.equal(win.conquerAll, true);
  const noKill = resolveDice(computeModifiers(state, battleOf([2, 2, 2], [3, 5])));
  assert.equal(noKill.conquerAll, false);
  const notTriple = resolveDice(computeModifiers(state, battleOf([4, 4, 3], [3, 1])));
  assert.equal(notTriple.conquerAll, false);
});

test("mechaniker_2: two natural 6s protect the territory (missile 6s don't count)", () => {
  const state = makeState({ defender: { powers: ["mechaniker_2"] } });
  assert.equal(resolveDice(computeModifiers(state, battleOf([6, 5], [6, 6]))).protect, true);
  const battle = battleOf([6, 5], [6, 2]);
  battle.defend[1].missile = true;
  assert.equal(resolveDice(computeModifiers(state, battle)).protect, false);
});

test("unnatural_strength: attacking 6s beat defending 6s", () => {
  const state = makeState({ attacker: { powers: ["unnatural_strength"] } });
  const res = resolveDice(computeModifiers(state, battleOf([6, 4], [6, 4])));
  assert.equal(res.defenderLosses, 1);  // 6 vs 6 → attacker
  assert.equal(res.attackerLosses, 1);  // 4 vs 4 → defender
});

test("unstable_cloning: natural doubles on defence", () => {
  const state = makeState({ defender: { powers: ["unstable_cloning"] } });
  assert.equal(resolveDice(computeModifiers(state, battleOf([6, 5], [3, 3]))).clone, true);
  assert.equal(resolveDice(computeModifiers(state, battleOf([6, 5], [3, 2]))).clone, false);
});

test("EMP: no modifiers apply in that territory this turn", () => {
  const state = makeState({ territory: { scar: "bunker", fortified: true }, log: { flags: { emp: ["egypt"] } } });
  const out = computeModifiers(state, battleOf([3], [5, 4]));
  assert.deepEqual(values(out.defend), [5, 4]);
  assert.deepEqual(out.rules.unmodifiable, ["attack", "defend"]);
});

test("catalog scars: dieMod effects come from the lookup", () => {
  const lookup = (category, id) => (category === "scars" && id === "sniper_nest"
    ? { id, name: "Sniper Nest", effect: { type: "dieMod", side: "attacker", die: "lowest", delta: -1 } } : null);
  const state = makeState({ territory: { scar: "sniper_nest" } });
  const out = computeModifiers(state, battleOf([5, 3], [4]), { lookup });
  assert.deepEqual(values(out.attack), [5, 2]);
  assert.equal(out.sources[0].label, "Sniper Nest");
});

test("catalog marks: the Fallout Zone makes dice unmodifiable except for exempt factions", () => {
  const fallout = {
    id: "fallout_zone", name: "Fallout Zone",
    effect: { type: "all", exempt: ["mutants"], effects: [
      { type: "enterLoss", fraction: 0.5, round: "up" }, { type: "unmodifiable" }
    ] }
  };
  const lookup = (category, id) => (category === "marks" && id === "fallout_zone" ? fallout : null);
  const state = makeState({ territory: { marks: ["fallout_zone"], fortified: true } });
  const out = computeModifiers(state, battleOf([5], [4, 2]), { lookup });
  assert.deepEqual(values(out.defend), [4, 2]);
  const mutants = makeState({ territory: { marks: ["fallout_zone"], fortified: true }, defender: { key: "mutants" } });
  const outM = computeModifiers(mutants, battleOf([5], [4, 2]), { lookup });
  assert.deepEqual(values(outM.defend), [5, 3]);
  assert.deepEqual(outM.rules.unmodifiable, ["attack"]);
  // Entering loss: half of the troops moved in, rounded up, counted on the running total.
  assert.deepEqual(enterLossFor(state.territories.egypt, "enclave", lookup).fraction, 0.5);
  assert.equal(enterLossFor(state.territories.egypt, "mutants", lookup), null);
  assert.equal(enterLossDue(3, 0, { fraction: 0.5, round: "up" }), 2);
  assert.equal(enterLossDue(7, 2, { fraction: 0.5, round: "up" }), 2);
});

test("helpers: key normalization and effect flattening", () => {
  assert.equal(normalizeKey("Well-Armed"), "well_armed");
  assert.equal(flattenEffect({ type: "all", exempt: ["x"], effects: [{ type: "a" }, { type: "all", effects: [{ type: "b" }] }] })
    .map(e => `${e.effect.type}:${e.exempt.join()}`).join(" "), "a:x b:x");
});

test("applySources leaves dice without sources unchanged and sorted", () => {
  const out = applySources(dice(2, 6, 4), [], "attack");
  assert.deepEqual(values(out), [6, 4, 2]);
  assert.deepEqual(out.map(d => d.slot), [1, 2, 0]);
});

test("collectSources reports Bunker with its config label", () => {
  const { sources } = collectSources(makeState({ territory: { scar: "bunker" } }), battleOf([1], [1]));
  assert.deepEqual(sources, [{ source: "bunker", label: "RL.Scar.bunker", side: "defend", die: "highest", delta: 1 }]);
});
