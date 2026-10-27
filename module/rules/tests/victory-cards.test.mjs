import { test } from "node:test";
import assert from "node:assert/strict";
import {
  coinPileStarRecipient, endOfTurnEffects, gameResults, homelandContinent, missionCheck, packTriggers,
  redStarTotal, resourceDrawChoices, resourceDrawEligibility, victoryCheck
} from "../_module.mjs";
import { fill, makeState } from "./helpers.mjs";

test("red stars: tokens + every HQ you control", () => {
  const s = makeState({
    factions: { a: { redStarTokens: 1 }, b: { redStarTokens: 1 }, c: {} },
    pieces: {
      peru: { a: { troops: 3, hq: true } },
      egypt: { a: 2, b: { troops: 0, hq: true } },   // captured: counts for a
      japan: { b: 1, c: { troops: 0, hq: true } }    // captured by b
    }
  });
  assert.equal(redStarTotal(s, "a"), 3);
  assert.equal(redStarTotal(s, "b"), 2);
  assert.equal(redStarTotal(s, "c"), 0);
  assert.equal(victoryCheck(s), null);
});

test("victory: 4 Red Stars, or every other faction eliminated", () => {
  const four = makeState({
    factions: { a: { redStarTokens: 2 }, b: {} },
    pieces: { peru: { a: { troops: 1, hq: true } }, egypt: { a: 1, b: { troops: 0, hq: true } } }
  });
  assert.deepEqual(victoryCheck(four), { winner: "a", reason: "redStars", stars: 4 });
  const last = makeState({ factions: { a: {}, b: { status: "eliminated" }, c: { status: "eliminated" } }, pieces: { peru: { a: 1 } } });
  assert.equal(victoryCheck(last).reason, "lastStanding");
  const knocked = makeState({ factions: { a: {}, b: { status: "knockedOut" } }, pieces: { peru: { a: 1 } } });
  assert.equal(victoryCheck(knocked), null, "knocked out players may still join the war");
  // two reach 4 at once: the current player first
  const both = makeState({
    factions: { a: { redStarTokens: 4 }, b: { redStarTokens: 4 } },
    turn: { faction: "b" }
  });
  assert.equal(victoryCheck(both).winner, "b");
  // factions not in the war don't count
  const absent = makeState({ factions: { a: {}, b: { active: false }, c: { status: "eliminated" } } });
  assert.equal(victoryCheck(absent).winner, "a");
});

test("results: won / held on / eliminated (no troops on the board = eliminated)", () => {
  const s = makeState({
    factions: { a: {}, b: {}, c: { status: "eliminated" }, d: { status: "knockedOut" }, e: { active: false } },
    pieces: { peru: { a: 2 }, egypt: { b: 1 } }
  });
  assert.deepEqual(gameResults(s, "a"), [
    { faction: "a", result: "won" }, { faction: "b", result: "heldOn" },
    { faction: "c", result: "eliminated" }, { faction: "d", result: "eliminated" }
  ]);
});

test("coin pile Red Star: most territories, nobody on a tie", () => {
  const s = makeState({ factions: { a: {}, b: {} }, pieces: { peru: { a: 1 }, brazil: { a: 1 }, egypt: { b: 1 } } });
  assert.equal(coinPileStarRecipient(s), "a");
  const tie = makeState({ factions: { a: {}, b: {} }, pieces: { peru: { a: 1 }, egypt: { b: 1 } } });
  assert.equal(coinPileStarRecipient(tie), null);
});

test("resource draw eligibility", () => {
  const mk = (log, powers = []) => makeState({ factions: { a: { powers } }, pieces: { peru: { a: 2 } }, turn: { faction: "a", phase: "end", log } });
  assert.equal(resourceDrawEligibility(mk({ conquered: 1 }), "a").data.via, "conquest");
  assert.equal(resourceDrawEligibility(mk({ expanded: 6, expandedIntoCity: true }), "a").reason, "RL.Rules.draw.notEligible",
    "expanding, even into a city, never enables the draw by itself");
  assert.equal(resourceDrawEligibility(mk({ expanded: 4 }, ["balkania_2"]), "a").data.via, "balkania_2");
  assert.equal(resourceDrawEligibility(mk({ expanded: 3 }, ["balkania_2"]), "a").ok, false);
  assert.equal(resourceDrawEligibility(mk({ expanded: 1, expandedIntoCity: true }, ["resourceful"]), "a").data.via, "resourceful");
  assert.equal(resourceDrawEligibility(mk({ expanded: 1 }, ["resourceful"]), "a").ok, false);
  assert.equal(resourceDrawEligibility(mk({ conquered: 2, cardDrawn: true }), "a").reason, "RL.Rules.draw.already");
  assert.equal(resourceDrawEligibility(mk({ conquered: 2, missionCompleted: true }), "a").reason, "RL.Rules.draw.missionCompleted");
});

test("resource draw choices from the row", () => {
  const row = [
    { cardId: "c1", territory: "peru", slot: 1 }, { cardId: "c2", territory: "egypt", slot: 2 },
    { cardId: "c3", territory: "japan", slot: 3 }, { cardId: "c4", territory: "brazil", slot: 4 }
  ];
  const s = makeState({ factions: { a: {}, b: {} }, pieces: { peru: { a: 2 }, brazil: { a: 1 }, egypt: { b: 1 } } });
  assert.deepEqual(resourceDrawChoices(s, "a", row), { territoryCardIds: ["c1", "c4"], coinAllowed: false, mustTakeTerritory: true, recon: false });
  // nothing in the row you control: a coin
  const none = makeState({ factions: { a: {}, b: {} }, pieces: { india: { a: 2 } } });
  assert.deepEqual(resourceDrawChoices(none, "a", row), { territoryCardIds: [], coinAllowed: true, mustTakeTerritory: false, recon: false });
  // and no coins left: nothing at all
  assert.equal(resourceDrawChoices(none, "a", row, { coinPileEmpty: true }).coinAllowed, false);
  // Recon: any face-up territory card instead of a coin
  const recon = resourceDrawChoices(none, "a", row, { anyTerritory: true });
  assert.deepEqual(recon.territoryCardIds, ["c1", "c2", "c3", "c4"]);
  assert.equal(recon.coinAllowed, true);
  // ...read from the turn flags by default
  const flagged = makeState({ factions: { a: {} }, pieces: { india: { a: 2 } }, turn: { faction: "a", log: { flags: { recon: true } } } });
  assert.equal(resourceDrawChoices(flagged, "a", row).recon, true);
  // Interference: that card can't be drawn
  assert.deepEqual(resourceDrawChoices(s, "a", row, { excluded: ["c1"] }).territoryCardIds, ["c4"]);
  // Homeland (Rules addition F): homeland cards count as controlled
  assert.deepEqual(resourceDrawChoices(none, "a", row, { homeland: "asia" }).territoryCardIds, ["c3"]);
});

test("homeland: the most frequent starting continent, none on a tie", () => {
  const continentOf = id => ({ peru: "south_america", brazil: "south_america", egypt: "africa" }[id] ?? null);
  assert.equal(homelandContinent([{ startingTerritory: "peru" }, { startingTerritory: "brazil" }, { startingTerritory: "egypt" }], continentOf), "south_america");
  assert.equal(homelandContinent([{ startingTerritory: "peru" }, { startingTerritory: "egypt" }], continentOf), null);
  assert.equal(homelandContinent([], continentOf), null);
});

test("mission checks", () => {
  const s = makeState({
    factions: { a: { playerId: "u1" }, b: {} },
    pieces: { ...fill("south_america", "a"), ...fill("australia", "a"), egypt: { a: 1 }, japan: { b: 1 } },
    marks: { egypt: { city: "minor", scar: "bunker" }, peru: { city: "major" }, japan: { scar: "mercenary" } },
    turn: {
      faction: "a", phase: "end", log: {
        conquered: 4, flags: {
          conquests: [
            { to: "venezuela", seaLine: false, city: false }, { to: "brazil", seaLine: false, city: false },
            { to: "peru", seaLine: false, city: true }, { to: "argentina", seaLine: false, city: false }
          ],
          trade: { coins: 10, cards: [{ type: "territory", value: 4 }, { type: "territory", value: 5 }, { type: "coin", value: 1 }] },
          knockouts: [{ faction: "b", handCount: 3 }],
          startContinents: ["australia"]
        }
      }
    }
  });
  assert.equal(missionCheck(s, "a", { type: "conquerThisTurn", count: 4 }), true);
  assert.equal(missionCheck(s, "a", { type: "conquerThisTurn", count: 9 }), false);
  assert.equal(missionCheck(s, "a", { type: "conquerThisTurn", count: 4, via: "seaLine" }), false);
  assert.equal(missionCheck(s, "a", { type: "conquerContinentThisTurn", count: 1 }), true);
  assert.equal(missionCheck(s, "a", { type: "controlTerritoriesWithCities", count: 2 }), true);
  assert.equal(missionCheck(s, "a", { type: "controlTerritoriesWithCities", count: 1, cityType: "worldCapital" }), false);
  assert.equal(missionCheck(s, "a", { type: "controlAllCities" }), true);
  assert.equal(missionCheck(s, "a", { type: "controlAllScarred", scars: ["bunker", "mercenary"] }), false);
  assert.equal(missionCheck(s, "a", { type: "controlAllScarred", scars: ["bunker"] }), true);
  assert.equal(missionCheck(s, "a", { type: "continentBonusTotal", count: 4 }), true);
  assert.equal(missionCheck(s, "a", { type: "continentBonusTotal", count: 7 }), false);
  assert.equal(missionCheck(s, "a", { type: "controlContinents", count: 2 }), true);
  assert.equal(missionCheck(s, "a", { type: "controlContinents", count: 2, when: "startOfTurn" }), false);
  assert.equal(missionCheck(s, "a", { type: "turnInResources", count: 10 }), true);
  assert.equal(missionCheck(s, "a", { type: "turnInCards", cardType: "territory", count: 2, minResourcesEach: 4 }), true);
  assert.equal(missionCheck(s, "a", { type: "knockOutPlayer", minResourceCards: 3 }), true);
  assert.equal(missionCheck(s, "a", { type: "controlIslands", count: 7 }), null, "not automated");
  assert.equal(missionCheck(s, "a", { type: "all", checks: [{ type: "controlAllCities" }, { type: "controlIslands" }] }), null);
  assert.equal(missionCheck(s, "a", { type: "all", checks: [{ type: "controlAllCities" }, { type: "conquerThisTurn", count: 9 }] }), false);
});

test("end-of-turn scars and marks", () => {
  const s = makeState({
    factions: { a: {}, b: { powers: ["convincing"] }, m: { key: "mutants", powers: ["mutants_knockout_2"] } },
    pieces: {
      peru: { a: 3 }, brazil: { a: 1 }, egypt: { a: 2 },
      japan: { b: 2 }, china: { m: 2 }, india: { m: 2 }, ural: { m: 3 }
    },
    marks: {
      peru: { scar: "mercenary" }, brazil: { scar: "biohazard" }, egypt: { marks: ["fallout_zone"] },
      japan: { scar: "mercenary" }, china: { scar: "biohazard" }, india: { scar: "mercenary" }, ural: { marks: ["fallout_zone"] }
    }
  });
  const a = Object.fromEntries(endOfTurnEffects(s, "a").map(e => [e.territory, e.delta]));
  assert.deepEqual(a, { peru: 1, brazil: -1, egypt: -1 });
  assert.deepEqual(endOfTurnEffects(s, "b").map(e => e.delta), [2], "convincing: one extra troop on Mercenary");
  const m = Object.fromEntries(endOfTurnEffects(s, "m").map(e => [e.territory, e.delta]));
  assert.deepEqual(m, { china: 1, india: -1 }, "reversed for mutants; fallout doesn't affect them");
});

test("pack triggers", () => {
  const nineMinor = Object.fromEntries(["peru", "brazil", "egypt", "japan", "china", "india", "ural", "siberia", "alaska"].map(id => [id, { city: "minor" }]));
  const eight = { ...nineMinor };
  delete eight.alaska;
  assert.deepEqual(packTriggers(makeState({ marks: nineMinor }), { type: "cityFounded", cityType: "minor" }), ["minorcities"]);
  assert.deepEqual(packTriggers(makeState({ marks: eight }), { type: "cityFounded", cityType: "minor" }), []);
  assert.deepEqual(packTriggers(makeState({ marks: eight }), { type: "cityFounded", cityType: "minor", minorCities: 9 }), ["minorcities"]);
  assert.deepEqual(packTriggers(makeState(), { type: "cityFounded", cityType: "worldCapital" }), ["worldcapital"]);
  assert.deepEqual(packTriggers(makeState(), { type: "worldCapitalPlaced" }), ["worldcapital"]);
  assert.deepEqual(packTriggers(makeState(), { type: "factionEliminated" }), ["eliminated"]);
  assert.deepEqual(packTriggers(makeState(), { type: "gameEnded", results: [{ result: "heldOn" }, { result: "eliminated" }] }), ["eliminated"]);
  assert.deepEqual(packTriggers(makeState(), { type: "gameEnded", results: [{ result: "won" }, { result: "heldOn" }] }), []);
  assert.deepEqual(packTriggers(makeState(), { type: "victorSigned", signatureCount: 1 }), []);
  assert.deepEqual(packTriggers(makeState(), { type: "victorSigned", signatureCount: 2 }), ["secondwin"]);
  assert.deepEqual(packTriggers(makeState(), { type: "missilesInRoll", count: 2 }), []);
  assert.deepEqual(packTriggers(makeState(), { type: "missilesInRoll", count: 3 }), ["threemissiles"]);
  assert.deepEqual(packTriggers(makeState(), { type: "recruit", total: 30, missiles: 0 }), []);
  assert.deepEqual(packTriggers(makeState(), { type: "recruit", total: 29, missiles: 1 }), []);
  assert.deepEqual(packTriggers(makeState(), { type: "recruit", total: 30, missiles: 1 }), ["thirtytroops"]);
  const withF = makeState({ factions: { a: { missiles: 2 } } });
  assert.deepEqual(packTriggers(withF, { type: "recruit", faction: "a", total: 31 }), ["thirtytroops"]);
  // already opened packs are not returned
  assert.deepEqual(packTriggers(makeState({ packs: { eliminated: true } }), { type: "factionEliminated" }), []);
  assert.deepEqual(packTriggers(makeState(), { type: "somethingElse" }), []);
});
