// node --test module/bots/driver/tests/   (view.recent and the debrief's account, with stubbed Foundry globals)
import { test } from "node:test";
import assert from "node:assert/strict";

const hooks = {};
const factions = {
  bal: { id: "bal", name: "Imperial Balkania", territories: ["ukraine", "ural"], redStars: { total: 1 } },
  khan: { id: "khan", name: "Khan Industries", territories: ["afghanistan", "middle_east"], redStars: { total: 2 } },
  mech: { id: "mech", name: "Die Mechaniker", territories: ["egypt"], redStars: { total: 1 } }
};
const territories = {
  ukraine: { name: "Ukraine", neighbors: ["ural", "afghanistan", "middle_east"], hq: "bal" },
  ural: { name: "Ural", neighbors: ["ukraine", "afghanistan"], hq: null },
  afghanistan: { name: "Afghanistan", neighbors: ["ukraine", "ural", "middle_east"], hq: null },
  middle_east: { name: "Middle East", neighbors: ["ukraine", "afghanistan", "egypt"], hq: "khan" },
  egypt: { name: "Egypt", neighbors: ["middle_east"], hq: "mech" }
};
let snap = { factions, territories, turn: { faction: "khan" } };
const war = { id: "war1", round: 2, system: { turn: { faction: "khan" } } };
const campaignTerritories = {};
globalThis.Hooks = { on: (name, fn) => { hooks[name] = fn; } };
globalThis.game = {
  user: { isGM: true },
  actors: { get: id => factions[id] ? { id, name: factions[id].name } : null },
  risklegacy: {
    state: {
      getWar: () => war,
      getCampaign: () => ({ system: { territories: campaignTerritories } }),
      getCampaignBoard: () => ({ territories: Object.fromEntries(Object.entries(territories).map(([id, t]) => [id, { name: t.name }])) }),
      findEntry: (cat, id) => (cat === "scars" && id === "bunker" ? { name: "Bunker" } : null)
    },
    turn: { snapshot: () => snap }
  }
};

const { registerRecentHooks, recentFor, warAccount } = await import("../recent.mjs");
registerRecentHooks();
const actor = id => ({ id });
const battle = (id, { attacker, defender, from, to, a, d, conquered = false, missiles = [] }) => ({
  id, type: "battle",
  system: { attacker, defender, from, to, status: "resolved", missiles, blitz: { active: false, rounds: [] }, result: { attackerLosses: a, defenderLosses: d, conquered } }
});

test("events since a faction's last turn, as lines in faction names with 'you'", () => {
  hooks["risklegacy.warCreated"](war);
  hooks["risklegacy.turnStarted"](war, actor("bal"));
  // Balkania's own turn: it attacks Afghanistan (not news for Balkania later)
  hooks["risklegacy.battleResolved"](battle("m0", { attacker: "bal", defender: "khan", from: "ural", to: "afghanistan", a: 1, d: 0 }));
  hooks["risklegacy.turnStarted"](war, actor("khan"));
  // Khan's turn: three rolls on Ukraine from the Middle East, the last one takes it (HQ capture), a missile against Balkania
  hooks["risklegacy.battleResolved"](battle("m1", { attacker: "khan", defender: "bal", from: "middle_east", to: "ukraine", a: 1, d: 2 }));
  hooks["risklegacy.missileFired"]({ type: "battle", system: { attacker: "khan", defender: "bal", from: "middle_east", to: "ukraine", missiles: [{ by: "khan", side: "attack", index: 0 }] } }, 1, actor("khan"));
  hooks["risklegacy.battleResolved"](battle("m2", { attacker: "khan", defender: "bal", from: "middle_east", to: "ukraine", a: 0, d: 2 }));
  hooks["risklegacy.battleResolved"](battle("m2", { attacker: "khan", defender: "bal", from: "middle_east", to: "ukraine", a: 0, d: 2 })); // same card again: ignored
  hooks["risklegacy.battleResolved"](battle("m3", { attacker: "khan", defender: "bal", from: "middle_east", to: "ukraine", a: 1, d: 1, conquered: true }));
  hooks["risklegacy.conquered"](actor("khan"), "ukraine", actor("bal"));
  hooks["risklegacy.redStarTokenGained"](actor("mech"), 1, "purchase");
  // A scar next to Balkania's Ural
  campaignTerritories.afghanistan = { scar: "bunker" };
  hooks.createChatMessage({ flags: { "fvtt-risklegacy-v5": { cards: { kind: "scarPlayed" } } }, speaker: { actor: "mech" }, content: "" });
  // Something far away that Balkania doesn't need: Mechaniker attacks Khan in Egypt's neighbourhood
  hooks["risklegacy.battleResolved"](battle("m4", { attacker: "mech", defender: "khan", from: "egypt", to: "middle_east", a: 2, d: 0 }));

  const lines = recentFor("bal", snap);
  const texts = lines.map(l => l.text);
  assert.deepEqual(texts, [
    "Khan Industries attacked your Ukraine from Middle East (3 rolls): you lost 5, they lost 2; Ukraine fell.",
    "Khan Industries fired a missile against you (the battle for Ukraine).",
    "Khan Industries captured your HQ in Ukraine.",
    "Die Mechaniker gained a Red Star (bought with cards): now 1 of 4.",
    "Die Mechaniker played the Bunker scar on Afghanistan (next to you)."
  ]);
  const hq = lines.find(l => l.type === "hqCaptured");
  assert.equal(hq.by, "Khan Industries");
  assert.equal(hq.against, "you");
  assert.equal(hq.toMe, true);
  assert.equal(lines.find(l => l.type === "redStar").toMe, false);
  // Khan, during its own turn, sees what happened since its previous turn start (Balkania's attack on Afghanistan)
  const khan = recentFor("khan", snap).map(l => l.text);
  assert.ok(khan.includes("Imperial Balkania attacked your Afghanistan from Ural: you lost 0, they lost 1; you held Afghanistan."));
  assert.ok(!khan.some(l => /^You /.test(l)));
});

test("the war's account for the debrief: against it, by it, counts and who hit it hardest", () => {
  const acc = warAccount("khan", snap);
  assert.ok(acc.by.includes("You captured Imperial Balkania's HQ in Ukraine."));
  assert.ok(acc.by.includes("You fired a missile against Imperial Balkania (the battle for Ukraine)."));
  assert.equal(acc.counts.conquests, 1);
  assert.equal(acc.counts.hqsCaptured, 1);
  assert.equal(acc.counts.missilesFired, 1);
  assert.equal(acc.counts.timesAttacked, 2);
  assert.deepEqual(acc.attackers, { bal: 1, mech: 1 });
  const bal = warAccount("bal", snap);
  assert.equal(bal.counts.ownHqLost, 1);
  assert.equal(bal.counts.territoriesLost, 1);
});

test("a new war starts over", () => {
  war.id = "war2";
  hooks["risklegacy.warCreated"](war);
  assert.deepEqual(recentFor("bal", snap), []);
});
