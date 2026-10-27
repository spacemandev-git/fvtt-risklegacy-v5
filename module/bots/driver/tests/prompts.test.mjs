// node --test module/bots/driver/tests/
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  draftAnswer, draftOptions, eventAnswer, eventChoice, falloutPick, numberOptions, rewardOptions, seaLineCandidates,
  textOf, usedNames, validValue
} from "../prompts.mjs";

test("validValue keeps an enabled option, else the first enabled one", () => {
  const options = [{ value: "troops", disabled: true }, { value: "maneuver" }, { value: 3 }];
  assert.equal(validValue(options, "maneuver"), "maneuver");
  assert.equal(validValue(options, "troops"), "maneuver");
  assert.equal(validValue(options, "3"), 3);
  assert.equal(validValue(options, "nonsense"), "maneuver");
  assert.equal(validValue([{ value: "x", disabled: true }], "x"), null);
  assert.equal(validValue([], "x"), null);
});

test("event steps map to chooseOption and back", () => {
  const option = { type: "option", event: "Control the People", prompt: "Choose", detail: "<b>more</b>",
    options: [{ value: "troops", label: "+5 troops", hint: "", disabled: true }, { value: "maneuver", label: "Maneuver" }] };
  const a = eventChoice(option);
  assert.equal(a.kind, "event.option");
  assert.equal(a.title, "Control the People");
  assert.equal(a.text, "Choose more");
  assert.equal(eventAnswer(option, a, "troops"), "maneuver");

  const pick = { type: "territory", event: "Fortify", prompt: "City", allowed: ["egypt", "peru"] };
  const b = eventChoice(pick, id => id.toUpperCase());
  assert.deepEqual(b.options.map(o => [o.value, o.label, o.territory]), [["egypt", "EGYPT", "egypt"], ["peru", "PERU", "peru"]]);
  assert.equal(eventAnswer(pick, b, "peru"), "peru");
  assert.equal(eventAnswer(pick, b, "japan"), "egypt");

  const num = { type: "number", event: "Control the People", min: 1, max: 4, value: 4, label: "troops" };
  const c = eventChoice(num);
  assert.deepEqual(c.options.map(o => o.value), [1, 2, 3, 4]);
  assert.equal(eventAnswer(num, c, "3"), 3);
  assert.equal(typeof eventAnswer(num, c, 2), "number");
});

test("numberOptions is bounded", () => {
  assert.equal(numberOptions(1, 100).length, 30);
  assert.deepEqual(numberOptions(2, 1).map(o => o.value), [2]);
});

test("draft options and answers use the DraftPrompt's shapes", () => {
  const entries = { t1: { name: "Turn 1", type: "turnOrder", value: 1, text: "Go first" }, c3: { name: "3 coins", type: "coin", value: 3 } };
  const data = { factions: ["f1"], cards: ["t1", "c3"], heldTypes: ["coin"], hasFaction: false };
  const options = draftOptions(data, id => ({ name: `Faction ${id}` }), id => entries[id]);
  assert.deepEqual(options.map(o => [o.value, !!o.disabled]), [["faction:f1", false], ["draft:t1", false], ["draft:c3", true]]);
  assert.deepEqual(draftAnswer("faction:f1"), { type: "faction", id: "f1" });
  assert.deepEqual(draftAnswer("draft:t1", id => entries[id]), { type: "turnOrder", id: "t1" });
  assert.equal(draftAnswer(null), null);
});

test("rewardOptions keeps the available rewards", () => {
  const available = { nameContinent: { ok: false }, cancelScar: { ok: true, territories: ["egypt"] }, fortifyCity: { ok: true } };
  assert.deepEqual(rewardOptions(available, { cancelScar: { label: "Cancel a scar" } }).map(o => [o.value, o.label]),
    [["cancelScar", "Cancel a scar"], ["fortifyCity", "fortifyCity"]]);
});

test("falloutPick spares own troops and HQ", () => {
  const state = { territories: {
    a: { pieces: { me: { troops: 5 } }, hq: "me" },
    b: { pieces: { them: { troops: 4 } }, hq: null }
  } };
  assert.equal(falloutPick(state, "me", ["a", "b"]), "b");
  assert.equal(falloutPick(state, "me", ["a"]), "a");
});

test("seaLineCandidates prefers own coast to an enemy, never adjacent pairs", () => {
  const state = { territories: {
    mine: { owner: "me" }, enemy: { owner: "them", hq: "them" }, empty: { owner: null }, near: { owner: "them" }
  } };
  const adjacent = (x, y) => [x, y].sort().join() === ["mine", "near"].sort().join();
  const pairs = seaLineCandidates(state, "me", ["mine", "enemy", "empty", "near"], adjacent);
  assert.ok(pairs.every(p => !adjacent(p.a, p.b)));
  assert.deepEqual([pairs[0].a, pairs[0].b], ["mine", "enemy"]);
  const toIsland = seaLineCandidates(state, "me", ["mine", "enemy", "alien_island"], () => false, { b: "alien_island", exclude: ["enemy"] });
  assert.deepEqual(toIsland.map(p => p.a), ["mine"]);
});

test("usedNames collects cities, continents, signatures and the world name", () => {
  const sys = { territories: { a: { city: { name: "Jevburg" } }, b: {} }, continents: { x: { name: "Jevland" } },
    victors: [{ winner: { player: "Ana" } }], worldName: "Terra" };
  assert.deepEqual(usedNames(sys).sort(), ["Ana", "Jevburg", "Jevland", "Terra"]);
  assert.equal(textOf("<p>Hello <b>you</b></p>"), "Hello you");
});
