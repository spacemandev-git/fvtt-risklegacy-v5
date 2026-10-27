import { test } from "node:test";
import assert from "node:assert/strict";
import {
  canJoinWar, checkJoinWar, checkMoveHQ, checkPlacement, checkStartingTerritory, hqPlacements,
  legalStartingTerritories, placementTargets
} from "../_module.mjs";
import { loadBoard, makeState } from "./helpers.mjs";

const ALL = Object.keys(loadBoard().board.territories);

test("starting territories: unoccupied and unmarked", () => {
  const s = makeState({ factions: { a: {}, b: {} } });
  assert.equal(legalStartingTerritories(s, "a").length, ALL.length);
  const marked = makeState({
    factions: { a: {}, b: {} },
    pieces: { egypt: { b: 3 } },
    marks: {
      peru: { scar: "bunker" }, brazil: { city: "minor" }, japan: { marks: ["mercenary_mark"] },
      ural: { cardDestroyed: true }
    }
  });
  assert.equal(checkStartingTerritory(marked, "a", "egypt").reason, "RL.Rules.start.occupied");
  assert.equal(checkStartingTerritory(marked, "a", "peru").reason, "RL.Rules.start.marked");
  assert.equal(checkStartingTerritory(marked, "a", "brazil").reason, "RL.Rules.start.marked");
  assert.equal(checkStartingTerritory(marked, "a", "japan").reason, "RL.Rules.start.marked");
  assert.equal(checkStartingTerritory(marked, "a", "ural").ok, true, "a destroyed card's x is not a mark");
  assert.equal(checkStartingTerritory(marked, "a", "nowhere").reason, "RL.Rules.unknownTerritory");
});

test("starting territories: your own Major City, even with a scar", () => {
  const s = makeState({
    factions: { a: { playerId: "u1" }, b: { playerId: "u2" } },
    marks: {
      brazil: { city: "major", founderId: "u1", scar: "ammo_shortage" },
      peru: { city: "major", founderId: "u2" },
      egypt: { city: "minor", founderId: "u1" },
      china: { city: "capital", founderId: "u1" }
    }
  });
  const r = checkStartingTerritory(s, "a", "brazil");
  assert.equal(r.ok, true);
  assert.equal(r.data.via, "majorCity");
  assert.equal(checkStartingTerritory(s, "a", "peru").ok, false, "someone else's Major City");
  assert.equal(checkStartingTerritory(s, "b", "peru").ok, true);
  assert.equal(checkStartingTerritory(s, "a", "egypt").ok, false, "Minor Cities are never legal starts");
  assert.equal(checkStartingTerritory(s, "a", "china").ok, false, "the World Capital isn't a Major City");
  // occupied Major City is not legal
  const occ = makeState({
    factions: { a: { playerId: "u1" }, b: {} }, pieces: { brazil: { b: 1 } },
    marks: { brazil: { city: "major", founderId: "u1" } }
  });
  assert.equal(checkStartingTerritory(occ, "a", "brazil").ok, false);
  // founder matched by name when there is no user id
  const byName = makeState({
    factions: { a: { playerId: "", playerName: "Rob" } },
    marks: { brazil: { city: "major", founder: "rob" } }
  });
  assert.equal(checkStartingTerritory(byName, "a", "brazil").ok, true);
});

test("starting territories: HQ not adjacent to another HQ at game start", () => {
  const s = makeState({ factions: { a: {}, b: {} }, pieces: { alaska: { b: { troops: 8, hq: true } } } });
  assert.equal(checkStartingTerritory(s, "a", "kamchatka").reason, "RL.Rules.start.adjacentHQ");
  assert.equal(checkStartingTerritory(s, "a", "alberta").reason, "RL.Rules.start.adjacentHQ");
  assert.equal(checkStartingTerritory(s, "a", "ontario").ok, true);
  // alaska itself and its 3 neighbours are out
  assert.equal(legalStartingTerritories(s, "a").length, ALL.length - 4);
  // joining the war places no HQ: adjacency doesn't matter
  assert.equal(checkStartingTerritory(s, "a", "kamchatka", { joining: true }).ok, true);
  assert.equal(legalStartingTerritories(s, "a", { joining: true }).length, ALL.length - 1);
});

test("join the war: gating and legality", () => {
  const s = makeState({
    factions: { a: {}, b: {} }, pieces: { alaska: { b: 5 } },
    turn: { faction: "a", phase: "start" }
  });
  const r = checkJoinWar(s, "a", "kamchatka");
  assert.equal(r.ok, true);
  assert.equal(r.data.advance, "recruit");
  assert.equal(checkJoinWar(s, "a", "alaska").reason, "RL.Rules.start.occupied");
  // a faction that still controls a territory recruits instead
  const owns = makeState({ factions: { a: {} }, pieces: { peru: { a: 1 } }, turn: { faction: "a", phase: "start" } });
  assert.equal(checkJoinWar(owns, "a", "kamchatka").reason, "RL.Rules.join.controlsTerritory");
  const done = makeState({ factions: { a: {} }, turn: { faction: "a", phase: "recruit", log: { joinedWar: true } } });
  assert.equal(checkJoinWar(done, "a", "kamchatka").reason, "RL.Rules.join.already");
});

test("join the war: eliminated when there's no legal starting territory", () => {
  // Every territory occupied by b → a can't join.
  const pieces = Object.fromEntries(ALL.map(id => [id, { b: 1 }]));
  const s = makeState({ factions: { a: {}, b: {} }, pieces });
  assert.equal(canJoinWar(s, "a"), false);
  // One empty but scarred territory: still nowhere to go.
  delete pieces.peru;
  const s2 = makeState({ factions: { a: {}, b: {} }, pieces, marks: { peru: { scar: "bunker" } } });
  assert.equal(canJoinWar(s2, "a"), false);
  const s3 = makeState({ factions: { a: {}, b: {} }, pieces });
  assert.deepEqual(legalStartingTerritories(s3, "a", { joining: true }), ["peru"]);
});

test("placement: own territories, in step 2, from the reserve", () => {
  const turn = { faction: "a", phase: "recruit", log: { recruited: true } };
  const s = makeState({ factions: { a: { reserve: 5 }, b: {} }, pieces: { peru: { a: 1 }, brazil: { b: 2 } }, turn });
  assert.equal(checkPlacement(s, "a", "peru", 5).ok, true);
  assert.equal(checkPlacement(s, "a", "peru", 6).reason, "RL.Rules.place.tooMany");
  assert.equal(checkPlacement(s, "a", "peru", 0).reason, "RL.Rules.badCount");
  assert.equal(checkPlacement(s, "a", "brazil", 1).reason, "RL.Rules.place.notControlled");
  assert.equal(checkPlacement(s, "a", "argentina", 1).reason, "RL.Rules.place.notControlled");
  assert.deepEqual(placementTargets(s, "a"), ["peru"]);
  // not before recruiting, not after step 2, not with an empty reserve
  const early = makeState({ factions: { a: { reserve: 5 } }, pieces: { peru: { a: 1 } }, turn: { faction: "a", phase: "start" } });
  assert.equal(checkPlacement(early, "a", "peru", 1).reason, "RL.Rules.place.recruitFirst");
  const late = makeState({ factions: { a: { reserve: 5 } }, pieces: { peru: { a: 1 } }, turn: { ...turn, phase: "attack" } });
  assert.equal(checkPlacement(late, "a", "peru", 1).reason, "RL.Rules.place.wrongPhase");
  const empty = makeState({ factions: { a: { reserve: 0 } }, pieces: { peru: { a: 1 } }, turn });
  assert.equal(checkPlacement(empty, "a", "peru", 1).reason, "RL.Rules.place.noReserve");
  // ignoreTurn checks only the board
  assert.equal(checkPlacement(empty, "a", "peru", 3, { ignoreTurn: true }).ok, true);
  // not your turn
  const theirs = makeState({ factions: { a: { reserve: 5 }, b: {} }, pieces: { peru: { a: 1 } }, turn: { ...turn, faction: "b" } });
  assert.equal(checkPlacement(theirs, "a", "peru", 1).reason, "RL.Rules.turn.notYourTurn");
});

test("placement: stealthy, cautious, Fallout Zone", () => {
  const turn = { faction: "a", phase: "recruit", log: { recruited: true } };
  const pieces = { peru: { a: 1 }, brazil: { a: 1 }, venezuela: { a: 1 }, egypt: { b: 1 } };
  const stealthy = makeState({ factions: { a: { reserve: 6, powers: ["stealthy"] }, b: {} }, pieces, turn, marks: { japan: { scar: "bunker" } } });
  const r = checkPlacement(stealthy, "a", "china", 3);
  assert.equal(r.ok, true);
  assert.equal(r.data.stealthy, true);
  assert.equal(checkPlacement(stealthy, "a", "japan", 1).ok, false, "unmarked only");
  assert.equal(checkPlacement(stealthy, "a", "egypt", 1).ok, false, "unoccupied only");
  const used = makeState({
    factions: { a: { reserve: 6, powers: ["stealthy"] }, b: {} }, pieces,
    turn: { ...turn, log: { recruited: true, flags: { stealthy: "china" } } }
  });
  assert.equal(checkPlacement(used, "a", "india", 1).ok, false, "one territory per turn");

  const cautious = makeState({
    factions: { a: { reserve: 6, powers: ["cautious"] } }, pieces,
    turn: { ...turn, log: { recruited: true, flags: { placedIn: ["peru", "brazil"] } } }
  });
  assert.equal(checkPlacement(cautious, "a", "peru", 1).ok, true);
  assert.equal(checkPlacement(cautious, "a", "venezuela", 1).reason, "RL.Rules.place.cautious");

  const fallout = makeState({
    factions: { a: { reserve: 3 }, m: { key: "mutants", reserve: 3 } },
    pieces: { peru: { a: 2 }, egypt: { m: 2 } }, marks: { peru: { marks: ["fallout_zone"] }, egypt: { marks: ["fallout_zone"] } },
    turn
  });
  assert.equal(checkPlacement(fallout, "a", "peru", 1).reason, "RL.Rules.place.forbidden");
  assert.equal(checkPlacement(fallout, "m", "egypt", 1, { ignoreTurn: true }).ok, true, "mutants are exempt");
});

test("HQ powers: khan_1 / rally placements, mobile", () => {
  const s = makeState({
    factions: { a: {}, b: {} },
    pieces: {
      alaska: { a: { troops: 3, hq: true } }, alberta: { a: 2 },
      // a captured HQ counts too
      egypt: { a: 2, b: { troops: 0, hq: true } },
      peru: { b: { troops: 4, hq: true } }
    }
  });
  assert.deepEqual(hqPlacements(s, "a", 1).map(p => p.territory).sort(), ["alaska", "egypt"]);
  assert.deepEqual(hqPlacements(s, "a", 2).map(p => p.troops), [2, 2]);
  assert.equal(checkMoveHQ(s, "a", "alaska", "alberta").ok, true);
  assert.equal(checkMoveHQ(s, "a", "alaska", "kamchatka").reason, "RL.Rules.mobile.notControlled");
  assert.equal(checkMoveHQ(s, "a", "alberta", "alaska").reason, "RL.Rules.mobile.noHQ");
});
