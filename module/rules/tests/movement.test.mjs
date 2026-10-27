import { test } from "node:test";
import assert from "node:assert/strict";
import {
  applyMove, attackTargets, checkAdvance, checkAttack, checkExpand, checkManeuver, classifyMove,
  connectedThroughOwned, defenderMaxDice, expandCost, expandTargets, maneuverTargets, maxAttackDice, revertMove
} from "../_module.mjs";
import { makeState } from "./helpers.mjs";

const ATTACK = { faction: "a", phase: "attack", log: { recruited: true } };

test("expand: into an adjacent unoccupied territory, leaving one behind", () => {
  const s = makeState({ factions: { a: {}, b: {} }, pieces: { peru: { a: 4 }, venezuela: { b: 2 } }, turn: ATTACK });
  const r = checkExpand(s, "a", "peru", "argentina", 3);
  assert.equal(r.ok, true);
  assert.equal(r.data.cost, 0);
  assert.equal(r.data.remaining, 3);
  assert.equal(checkExpand(s, "a", "peru", "argentina", 4).reason, "RL.Rules.leaveOne");
  assert.equal(checkExpand(s, "a", "peru", "egypt", 1).reason, "RL.Rules.notAdjacent");
  assert.equal(checkExpand(s, "a", "argentina", "brazil", 1).reason, "RL.Rules.notYours");
  const enemy = checkExpand(s, "a", "peru", "venezuela", 1);
  assert.equal(enemy.reason, "RL.Rules.expand.occupied");
  assert.equal(enemy.data.attack, true);
  assert.deepEqual(expandTargets(s, "a", "peru").sort(), ["argentina", "brazil"]);
});

test("expand: city territories cost their population; can't expand if you couldn't keep control", () => {
  const marks = { argentina: { city: "minor" }, brazil: { city: "major" } };
  const s = makeState({ factions: { a: {} }, pieces: { peru: { a: 6 } }, marks, turn: ATTACK });
  assert.equal(checkExpand(s, "a", "peru", "argentina", 1).reason, "RL.Rules.expand.cannotHold");
  const minor = checkExpand(s, "a", "peru", "argentina", 2);
  assert.equal(minor.ok, true);
  assert.equal(minor.data.cost, 1);
  assert.equal(minor.data.remaining, 1);
  assert.equal(minor.data.city, true);
  assert.equal(checkExpand(s, "a", "peru", "brazil", 2).ok, false);
  assert.equal(checkExpand(s, "a", "peru", "brazil", 3).data.cost, 2);
  const capital = makeState({ factions: { a: {} }, pieces: { peru: { a: 8 } }, marks: { brazil: { city: "capital" } }, turn: ATTACK });
  assert.equal(checkExpand(capital, "a", "peru", "brazil", 5).ok, false);
  assert.equal(checkExpand(capital, "a", "peru", "brazil", 6).data.remaining, 1);
});

test("expand: fortified cities cost 2 more", () => {
  const s = makeState({
    factions: { a: {} }, pieces: { peru: { a: 8 } }, marks: { argentina: { city: "minor", fortified: true } }, turn: ATTACK
  });
  assert.equal(expandCost(s, "a", "argentina", 4).cost, 3);
  assert.equal(checkExpand(s, "a", "peru", "argentina", 3).ok, false);
  assert.equal(checkExpand(s, "a", "peru", "argentina", 4).data.remaining, 1);
  assert.deepEqual(checkExpand(s, "a", "peru", "argentina", 4).data.parts.map(p => p.source), ["city", "fortification"]);
});

test("expand: unpopular, alien_collaborator, aliens_starter, Fallout Zone", () => {
  const marks = { argentina: { city: "minor" } };
  const pieces = { peru: { a: 8 } };
  const cost = powers => expandCost(makeState({ factions: { a: { powers } }, pieces, marks }), "a", "argentina", 5).cost;
  assert.equal(cost([]), 1);
  assert.equal(cost(["unpopular"]), 2);
  assert.equal(cost(["alien_collaborator"]), 3);
  assert.equal(cost(["aliens_starter"]), 0);
  // unmarked territories: weaknesses don't apply
  assert.equal(expandCost(makeState({ factions: { a: { powers: ["unpopular"] } }, pieces }), "a", "brazil", 2).cost, 0);

  const fallout = makeState({
    factions: { a: {}, m: { key: "mutants" } }, pieces: { peru: { a: 8 }, egypt: { m: 8 } },
    marks: { argentina: { marks: ["fallout_zone"] }, east_africa: { marks: ["fallout_zone"] } }, turn: ATTACK
  });
  assert.equal(checkExpand(fallout, "a", "peru", "argentina", 1).ok, false, "half of 1, rounded up, leaves nobody");
  assert.equal(checkExpand(fallout, "a", "peru", "argentina", 2).data.remaining, 1);
  assert.equal(checkExpand(fallout, "a", "peru", "argentina", 5).data.cost, 3);
  assert.equal(checkExpand(fallout, "m", "egypt", "east_africa", 1, { ignoreTurn: true }).data.cost, 0, "mutants are exempt");
  // the catalog's effects (state.effects) override the built-in table
  const custom = makeState({
    factions: { a: {} }, pieces: { peru: { a: 8 } }, marks: { argentina: { marks: ["fallout_zone"] } },
    effects: { scars: {}, marks: { fallout_zone: null }, powers: {} }
  });
  assert.equal(expandCost(custom, "a", "argentina", 4).cost, 0);
});

test("expand/attack: phase gating and auto-advance", () => {
  const pieces = { peru: { a: 4 }, brazil: { b: 2 } };
  const factions = { a: { reserve: 0 }, b: {} };
  const recruitDone = makeState({ factions, pieces, turn: { faction: "a", phase: "recruit", log: { recruited: true } } });
  assert.equal(checkExpand(recruitDone, "a", "peru", "argentina", 1).data.advance, "attack");
  assert.equal(checkAttack(recruitDone, "a", "peru", "brazil", 3).data.advance, "attack");
  const reserveLeft = makeState({ factions: { a: { reserve: 2 }, b: {} }, pieces, turn: { faction: "a", phase: "recruit", log: { recruited: true } } });
  assert.equal(checkExpand(reserveLeft, "a", "peru", "argentina", 1).reason, "RL.Rules.turn.placeReserveFirst");
  const notRecruited = makeState({ factions, pieces, turn: { faction: "a", phase: "start" } });
  assert.equal(checkAttack(notRecruited, "a", "peru", "brazil", 1).reason, "RL.Rules.turn.recruitFirst");
  const joined = makeState({ factions, pieces, turn: { faction: "a", phase: "recruit", log: { joinedWar: true } } });
  assert.equal(checkAttack(joined, "a", "peru", "brazil", 1).ok, true);
  const afterManeuver = makeState({ factions, pieces, turn: { faction: "a", phase: "maneuver", log: { recruited: true, maneuver: { done: true } } } });
  assert.equal(checkAttack(afterManeuver, "a", "peru", "brazil", 1).reason, "RL.Rules.attack.afterManeuver");
  assert.equal(checkExpand(afterManeuver, "a", "peru", "argentina", 1).reason, "RL.Rules.attack.afterManeuver");
  const end = makeState({ factions, pieces, turn: { faction: "a", phase: "end", log: { recruited: true } } });
  assert.equal(checkAttack(end, "a", "peru", "brazil", 1).ok, false);
  // Saharan Republic (saharan_1) maneuvered early and keeps attacking
  const saharan = makeState({
    factions: { a: { powers: ["saharan_1"] }, b: {} }, pieces,
    turn: { faction: "a", phase: "attack", log: { recruited: true, maneuver: { done: true } } }
  });
  assert.equal(checkAttack(saharan, "a", "peru", "brazil", 1).ok, true);
});

test("attack: legality", () => {
  const s = makeState({
    factions: { a: {}, b: {} },
    pieces: { peru: { a: 4 }, argentina: { a: 1 }, brazil: { b: 2 }, venezuela: { b: 1 }, egypt: { b: 3 } },
    turn: ATTACK
  });
  const r = checkAttack(s, "a", "peru", "brazil", 3);
  assert.equal(r.ok, true);
  assert.equal(r.data.defender, "b");
  assert.equal(r.data.defenderMaxDice, 2);
  assert.equal(r.data.firstAttack, true);
  assert.equal(maxAttackDice(s, "peru"), 3);
  assert.equal(maxAttackDice(s, "argentina"), 0);
  assert.equal(defenderMaxDice(s, "venezuela"), 1);
  assert.equal(checkAttack(s, "a", "argentina", "brazil", 1).reason, "RL.Rules.attack.tooFew");
  assert.equal(checkAttack(s, "a", "peru", "egypt", 1).reason, "RL.Rules.notAdjacent");
  assert.equal(checkAttack(s, "a", "peru", "argentina", 1).reason, "RL.Rules.attack.own");
  assert.equal(checkAttack(s, "a", "brazil", "peru", 1).reason, "RL.Rules.notYours");
  assert.equal(checkAttack(s, "a", "peru", "brazil", 4).reason, "RL.Rules.attack.dice");
  assert.equal(checkAttack(s, "a", "peru", "brazil", 0).reason, "RL.Rules.attack.dice");
  const three = makeState({ factions: { a: {}, b: {} }, pieces: { peru: { a: 3 }, brazil: { b: 2 } }, turn: ATTACK });
  assert.equal(checkAttack(three, "a", "peru", "brazil", 3).reason, "RL.Rules.attack.diceTroops");
  assert.equal(checkAttack(three, "a", "peru", "brazil", 2).ok, true);
  const empty = makeState({ factions: { a: {} }, pieces: { peru: { a: 3 } }, turn: ATTACK });
  assert.equal(checkAttack(empty, "a", "peru", "brazil", 1).reason, "RL.Rules.attack.empty");
  assert.deepEqual(attackTargets(s, "a", "peru").sort(), ["brazil", "venezuela"]);
});

test("attack: protected territories (Die Mechaniker, events) and the first attack (Enclave)", () => {
  const s = makeState({
    factions: { a: {}, b: {} }, pieces: { peru: { a: 4 }, brazil: { b: 2 }, venezuela: { b: 2 } },
    turn: { ...ATTACK, log: { recruited: true, protected: ["brazil"], firstAttackTarget: "venezuela" } }
  });
  assert.equal(checkAttack(s, "a", "peru", "brazil", 1).reason, "RL.Rules.attack.protected");
  const r = checkAttack(s, "a", "peru", "venezuela", 1);
  assert.equal(r.ok, true);
  assert.equal(r.data.firstAttack, false);
});

test("maneuver: connected through own territories", () => {
  const pieces = {
    alaska: { a: 5 }, northwest_territory: { a: 1 }, ontario: { a: 1 }, eastern_canada: { a: 1 },
    greenland: { b: 1 }, iceland: { a: 2 }, peru: { a: 2 }
  };
  const s = makeState({ factions: { a: {}, b: {} }, pieces, turn: { faction: "a", phase: "maneuver", log: { recruited: true } } });
  assert.equal(connectedThroughOwned(s, "a", "alaska", "eastern_canada"), true);
  assert.equal(connectedThroughOwned(s, "a", "alaska", "iceland"), false, "Greenland is enemy");
  assert.equal(connectedThroughOwned(s, "a", "alaska", "peru"), false, "Central America is empty");
  const r = checkManeuver(s, "a", "alaska", "eastern_canada", 4);
  assert.equal(r.ok, true);
  assert.equal(r.data.via, "connected");
  assert.equal(checkManeuver(s, "a", "alaska", "eastern_canada", 5).reason, "RL.Rules.leaveOne");
  assert.equal(checkManeuver(s, "a", "alaska", "iceland", 1).reason, "RL.Rules.maneuver.notConnected");
  assert.equal(checkManeuver(s, "a", "alaska", "greenland", 1).reason, "RL.Rules.maneuver.notYours");
  assert.equal(checkManeuver(s, "a", "alaska", "alaska", 1).reason, "RL.Rules.sameTerritory");
  assert.deepEqual(maneuverTargets(s, "a", "alaska").sort(), ["eastern_canada", "northwest_territory", "ontario"]);
  // one maneuver per turn
  const done = makeState({ factions: { a: {}, b: {} }, pieces, turn: { faction: "a", phase: "maneuver", log: { recruited: true, maneuver: { done: true } } } });
  assert.equal(checkManeuver(done, "a", "alaska", "ontario", 1).reason, "RL.Rules.maneuver.done");
});

test("maneuver: saharan_2 anywhere, short_sighted adjacent only (and overrides saharan_2)", () => {
  const pieces = { alaska: { a: 5 }, alberta: { a: 1 }, peru: { a: 2 }, greenland: { b: 1 } };
  const turn = { faction: "a", phase: "maneuver", log: { recruited: true } };
  const sah = makeState({ factions: { a: { powers: ["saharan_2"] }, b: {} }, pieces, turn });
  const r = checkManeuver(sah, "a", "alaska", "peru", 3);
  assert.equal(r.ok, true);
  assert.equal(r.data.via, "anywhere");
  assert.equal(checkManeuver(sah, "a", "alaska", "greenland", 1).ok, false, "only own territories");
  const shortS = makeState({ factions: { a: { powers: ["short_sighted", "saharan_2"] }, b: {} }, pieces, turn });
  assert.equal(checkManeuver(shortS, "a", "alaska", "peru", 1).reason, "RL.Rules.maneuver.adjacentOnly");
  assert.equal(checkManeuver(shortS, "a", "alaska", "alberta", 1).data.via, "adjacent");
});

test("maneuver: phase gating, saharan_1 any time", () => {
  const pieces = { alaska: { a: 5 }, alberta: { a: 1 } };
  const attack = makeState({ factions: { a: {} }, pieces, turn: ATTACK });
  assert.equal(checkManeuver(attack, "a", "alaska", "alberta", 1).data.advance, "maneuver");
  const recruitLeft = makeState({ factions: { a: { reserve: 3 } }, pieces, turn: { faction: "a", phase: "recruit", log: { recruited: true } } });
  assert.equal(checkManeuver(recruitLeft, "a", "alaska", "alberta", 1).reason, "RL.Rules.turn.placeReserveFirst");
  const recruitDone = makeState({ factions: { a: {} }, pieces, turn: { faction: "a", phase: "recruit", log: { recruited: true } } });
  assert.equal(checkManeuver(recruitDone, "a", "alaska", "alberta", 1).data.advance, "maneuver");
  const saharan = makeState({ factions: { a: { reserve: 3, powers: ["saharan_1"] } }, pieces, turn: { faction: "a", phase: "start" } });
  const r = checkManeuver(saharan, "a", "alaska", "alberta", 1);
  assert.equal(r.ok, true);
  assert.equal(r.data.advance, null);
  assert.equal(r.data.anyTime, true);
  const end = makeState({ factions: { a: { powers: ["saharan_1"] } }, pieces, turn: { faction: "a", phase: "end", log: { recruited: true } } });
  assert.equal(checkManeuver(end, "a", "alaska", "alberta", 1).reason, "RL.Rules.maneuver.wrongPhase");
});

test("maneuver: can't pass through the Fallout Zone", () => {
  const pieces = { alaska: { a: 5 }, alberta: { a: 1 }, ontario: { a: 1 } };
  const s = makeState({
    factions: { a: {} }, pieces, marks: { alberta: { marks: ["fallout_zone"] } },
    turn: { faction: "a", phase: "maneuver", log: { recruited: true } }
  });
  assert.equal(connectedThroughOwned(s, "a", "alaska", "ontario"), false);
  assert.equal(connectedThroughOwned(s, "a", "alaska", "alberta"), true, "into it is not through it");
});

test("advance: more troops into the territory just taken; classifyMove", () => {
  const pieces = { peru: { a: 6 }, brazil: { a: 2 }, argentina: { b: 1 }, venezuela: { a: 1 } };
  const s = makeState({
    factions: { a: {}, b: {} }, pieces,
    turn: { ...ATTACK, log: { recruited: true, flags: { lastAdvance: { from: "peru", to: "brazil", kind: "conquest" } } } }
  });
  assert.equal(checkAdvance(s, "a", "peru", "brazil", 3).ok, true);
  assert.equal(checkAdvance(s, "a", "peru", "brazil", 6).reason, "RL.Rules.leaveOne");
  assert.equal(checkAdvance(s, "a", "venezuela", "brazil", 1).ok, false);
  assert.equal(classifyMove(s, "a", "peru", "brazil"), "advance");
  assert.equal(classifyMove(s, "a", "peru", "venezuela"), "maneuver");
  assert.equal(classifyMove(s, "a", "peru", "argentina"), "attack");
  assert.equal(classifyMove(s, "a", "venezuela", "central_america"), "expand");
  assert.equal(classifyMove(s, "a", "peru", "egypt"), "invalid");
  assert.equal(classifyMove(s, "a", "peru", "peru"), "rearrange");
});

test("applyMove / revertMove keep derived data consistent", () => {
  const s = makeState({ factions: { a: {} }, pieces: { peru: { a: 4 } } });
  const moved = applyMove(s, "a", "peru", "argentina", 2);
  assert.equal(moved.territories.argentina.owner, "a");
  assert.equal(moved.territories.peru.troops, 2);
  assert.deepEqual(moved.factions.a.territories.sort(), ["argentina", "peru"]);
  assert.equal(s.territories.argentina.owner, null, "the original is untouched");
  const back = revertMove(moved, "a", "peru", "argentina", 2);
  assert.equal(back.territories.argentina.owner, null);
  assert.equal(back.territories.peru.troops, 4);
  assert.deepEqual(back.factions.a.territories, ["peru"]);
});
