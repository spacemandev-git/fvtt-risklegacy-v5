import { test } from "node:test";
import assert from "node:assert/strict";
import { TROOP_TRADE } from "../../config.mjs";
import {
  checkBuyRedStars, checkRecruit, checkTrade, joinWarTroops, recruitBreakdown, troopsForCoins
} from "../_module.mjs";
import { fill, makeState, someTerritories } from "./helpers.mjs";

/** n territories (outside the given continents) with 1 troop each for faction f. */
const spread = (n, f = "a", exclude = []) => Object.fromEntries(someTerritories(n, exclude).map(id => [id, { [f]: 1 }]));
const SA = ["venezuela", "brazil", "peru", "argentina"];
const AU = ["indonesia", "new_guinea", "western_australia", "eastern_australia"];

test("recruit: minimum of 3", () => {
  for ( const n of [1, 2, 5, 8] ) {
    const s = makeState({ factions: { a: {} }, pieces: spread(n) });
    const r = recruitBreakdown(s, "a");
    assert.equal(r.territories, n);
    assert.equal(r.base, 3, `${n} territories`);
    assert.equal(r.minimumApplied, n < 9);
  }
});

test("recruit: (territories + population) / 3 rounded down", () => {
  const cases = [[9, 3], [11, 3], [12, 4], [14, 4], [15, 5], [20, 6]];
  for ( const [n, expected] of cases ) {
    const s = makeState({ factions: { a: {} }, pieces: spread(n, "a", [...SA, ...AU]) });
    assert.equal(recruitBreakdown(s, "a").base, expected, `${n} territories`);
  }
});

test("recruit: population of controlled cities counts", () => {
  const pieces = spread(10, "a", [...SA, ...AU]);
  const [t1, t2, t3] = Object.keys(pieces);
  const s = makeState({
    factions: { a: {} }, pieces,
    marks: { [t1]: { city: "major" }, [t2]: { city: "minor" }, [t3]: { city: "minor" } }
  });
  const r = recruitBreakdown(s, "a");
  assert.equal(r.population, 4);
  assert.equal(r.sum, 14);
  assert.equal(r.base, 4);
  // A city you don't control doesn't count.
  const s2 = makeState({ factions: { a: {} }, pieces, marks: { egypt: { city: "capital" } } });
  assert.equal(recruitBreakdown(s2, "a").population, 0);
});

test("recruit: World Capital population is 5", () => {
  const pieces = spread(10, "a", [...SA, ...AU]);
  const s = makeState({ factions: { a: {} }, pieces, marks: { [Object.keys(pieces)[0]]: { city: "capital" } } });
  assert.equal(recruitBreakdown(s, "a").base, 5);
});

test("recruit: balkania_1 rounds up", () => {
  const pieces = spread(10, "a", [...SA, ...AU]);
  const plain = makeState({ factions: { a: {} }, pieces });
  const balk = makeState({ factions: { a: { key: "balkania", powers: ["balkania_1"] } }, pieces });
  assert.equal(recruitBreakdown(plain, "a").base, 3);
  const r = recruitBreakdown(balk, "a");
  assert.equal(r.roundedUp, true);
  assert.equal(r.base, 4);
  // Exact multiples don't change; the minimum still applies.
  assert.equal(recruitBreakdown(makeState({ factions: { a: { powers: ["balkania_1"] } }, pieces: spread(12, "a", [...SA, ...AU]) }), "a").base, 4);
  assert.equal(recruitBreakdown(makeState({ factions: { a: { powers: ["balkania_1"] } }, pieces: spread(4, "a", [...SA, ...AU]) }), "a").base, 3);
});

test("recruit: continent bonus only for a whole continent", () => {
  const s = makeState({ factions: { a: {} }, pieces: fill("south_america", "a") });
  const r = recruitBreakdown(s, "a");
  assert.deepEqual(r.continents.map(c => [c.id, c.value, c.total]), [["south_america", 2, 2]]);
  assert.equal(r.total, 3 + 2);
  // 3 of 4, the last unoccupied: no bonus
  const s2 = makeState({ factions: { a: {} }, pieces: { venezuela: { a: 1 }, brazil: { a: 1 }, peru: { a: 1 } } });
  assert.equal(recruitBreakdown(s2, "a").continentTotal, 0);
  // two continents
  const s3 = makeState({ factions: { a: {} }, pieces: { ...fill("south_america", "a"), ...fill("australia", "a") } });
  assert.equal(recruitBreakdown(s3, "a").total, 3 + 2 + 2);
  // Asia (12) + Europe (7): 19 territories → 6 + 7 + 5
  const s4 = makeState({ factions: { a: {} }, pieces: { ...fill("asia", "a"), ...fill("europe", "a") } });
  assert.equal(recruitBreakdown(s4, "a").total, 6 + 7 + 5);
});

test("recruit: continent ±1 mark and the namer's +1", () => {
  const pieces = fill("south_america", "a");
  const minus = makeState({ factions: { a: {} }, pieces, continents: { south_america: { modifier: -1 } } });
  assert.equal(recruitBreakdown(minus, "a").continentTotal, 1);
  const plus = makeState({ factions: { a: {} }, pieces, continents: { south_america: { modifier: 1 } } });
  assert.equal(recruitBreakdown(plus, "a").continentTotal, 3);
  // Named by this faction's player: +1 for them only ("Awesometonia gives a bonus of 2 … you and you alone +1").
  const named = makeState({
    factions: { a: { playerId: "u1" }, b: { playerId: "u2" } }, pieces,
    continents: { south_america: { name: "Awesometonia", namedById: "u1" } }
  });
  const r = recruitBreakdown(named, "a");
  assert.equal(r.continents[0].namerBonus, 1);
  assert.equal(r.continentTotal, 3);
  const other = makeState({
    factions: { a: { playerId: "u2" } }, pieces,
    continents: { south_america: { name: "Awesometonia", namedById: "u1" } }
  });
  assert.equal(recruitBreakdown(other, "a").continentTotal, 2);
  // namer's bonus stacks with the mark
  const both = makeState({
    factions: { a: { playerId: "u1" } }, pieces,
    continents: { south_america: { namedById: "u1", modifier: -1 } }
  });
  assert.equal(recruitBreakdown(both, "a").continentTotal, 2);
});

test("recruit: primitive ignores population; aliens_knockout counts ruins; Bad Intel denies a continent", () => {
  const pieces = { ...fill("south_america", "a"), ...spread(8, "a", [...SA, ...AU]) };
  const [first] = Object.keys(pieces);
  const marks = { [first]: { city: "major" } };
  assert.equal(recruitBreakdown(makeState({ factions: { a: {} }, pieces, marks }), "a").sum, 14);
  const prim = recruitBreakdown(makeState({ factions: { a: { powers: ["primitive"] } }, pieces, marks }), "a");
  assert.equal(prim.population, 0);
  assert.equal(prim.populationIgnored, true);
  assert.equal(prim.sum, 12);

  const ruins = makeState({
    factions: { a: { key: "aliens", powers: ["aliens_knockout"] } }, pieces: spread(3),
    marks: { [someTerritories(1)[0]]: { marks: ["ruins"] } }
  });
  const rr = recruitBreakdown(ruins, "a");
  assert.equal(rr.extraTotal, 1);
  assert.equal(rr.total, 4);

  const denied = recruitBreakdown(makeState({ factions: { a: {} }, pieces }), "a", { denied: ["south_america"] });
  assert.equal(denied.continentTotal, 0);
  assert.equal(denied.continents[0].denied, true);
  // default comes from the turn flags
  const flagged = makeState({
    factions: { a: {} }, pieces, turn: { faction: "a", log: { flags: { deniedContinents: ["south_america"] } } }
  });
  assert.equal(recruitBreakdown(flagged, "a").continentTotal, 0);
});

test("recruit: checkRecruit gating", () => {
  const pieces = spread(3);
  const ok = makeState({ factions: { a: {} }, pieces, turn: { faction: "a", phase: "start" } });
  const r = checkRecruit(ok, "a");
  assert.equal(r.ok, true);
  assert.equal(r.data.advance, "recruit");
  assert.equal(r.data.breakdown.total, 3);
  const twice = makeState({ factions: { a: {} }, pieces, turn: { faction: "a", phase: "recruit", log: { recruited: true } } });
  assert.equal(checkRecruit(twice, "a").reason, "RL.Rules.recruit.already");
  const none = makeState({ factions: { a: {} }, turn: { faction: "a", phase: "start" } });
  assert.equal(checkRecruit(none, "a").reason, "RL.Rules.recruit.mustJoin");
  const late = makeState({ factions: { a: {} }, pieces, turn: { faction: "a", phase: "attack" } });
  assert.equal(checkRecruit(late, "a").ok, false);
});

test("trade chart", () => {
  assert.equal(troopsForCoins(0), 0);
  assert.equal(troopsForCoins(1), 0);
  const expected = { 2: 2, 3: 4, 4: 7, 5: 10, 6: 13, 7: 17, 8: 21, 9: 25, 10: 30 };
  for ( const [coins, troops] of Object.entries(expected) ) assert.equal(troopsForCoins(Number(coins)), troops);
  assert.deepEqual(TROOP_TRADE, expected);
  assert.equal(troopsForCoins(11), 0, "more than 10 isn't allowed");
  assert.equal(troopsForCoins(2.5), 0);
});

test("trade: checkTrade", () => {
  const base = { factions: { a: { hand: { count: 4, coins: 12 } } }, pieces: spread(3), turn: { faction: "a", phase: "recruit" } };
  const s = makeState(base);
  assert.equal(checkTrade(s, "a", 5).data.troops, 10);
  assert.equal(checkTrade(s, "a", 1).reason, "RL.Rules.trade.tooFew");
  assert.equal(checkTrade(s, "a", 11).reason, "RL.Rules.trade.tooMany");
  // alien_collaborator: +1 to the total (capped at 10)
  const ac = makeState({ ...base, factions: { a: { powers: ["alien_collaborator"], hand: { count: 4, coins: 12 } } } });
  assert.equal(checkTrade(ac, "a", 5).data.troops, 13);
  assert.equal(checkTrade(ac, "a", 1).data.troops, 2);
  assert.equal(checkTrade(ac, "a", 10).data.troops, 30);
  // once per turn; not after step 2; not when joining the war; not more than you hold
  const again = makeState({ ...base, turn: { faction: "a", phase: "recruit", log: { tradedForTroops: true } } });
  assert.equal(checkTrade(again, "a", 5).reason, "RL.Rules.trade.already");
  const late = makeState({ ...base, turn: { faction: "a", phase: "attack" } });
  assert.equal(checkTrade(late, "a", 5).reason, "RL.Rules.trade.wrongPhase");
  const joined = makeState({ ...base, turn: { faction: "a", phase: "recruit", log: { joinedWar: true } } });
  assert.equal(checkTrade(joined, "a", 5).reason, "RL.Rules.trade.joinedWar");
  const poor = makeState({ ...base, factions: { a: { hand: { count: 1, coins: 3 } } } });
  assert.equal(checkTrade(poor, "a", 5).reason, "RL.Rules.trade.notEnough");
  // from the start step it auto-advances to recruit
  const start = makeState({ ...base, turn: { faction: "a", phase: "start" } });
  assert.equal(checkTrade(start, "a", 2).data.advance, "recruit");
});

test("red stars: 4 cards each, at the start of the turn", () => {
  const s = makeState({ factions: { a: { hand: { count: 9, coins: 9 } } }, pieces: spread(3), turn: { faction: "a", phase: "start" } });
  assert.equal(checkBuyRedStars(s, "a", 4).data.stars, 1);
  assert.equal(checkBuyRedStars(s, "a", 8).data.stars, 2);
  assert.equal(checkBuyRedStars(s, "a", 3).reason, "RL.Rules.stars.multiple");
  assert.equal(checkBuyRedStars(s, "a", 5).reason, "RL.Rules.stars.multiple");
  assert.equal(checkBuyRedStars(s, "a", 12).reason, "RL.Rules.stars.notEnough");
  const late = makeState({ factions: { a: { hand: { count: 9 } } }, pieces: spread(3), turn: { faction: "a", phase: "recruit" } });
  assert.equal(checkBuyRedStars(late, "a", 4).reason, "RL.Rules.stars.onlyAtStart");
});

test("join the war: half the starting troops", () => {
  assert.equal(joinWarTroops(), 4);
  assert.equal(joinWarTroops(8), 4);
  assert.equal(joinWarTroops(10), 5);
  assert.equal(joinWarTroops(7), 3);
});
