/**
 * Table talk (capping, gating), names, the turn plan's cards / scars / placement scaling, end of turn, and the
 * debrief with memory merging and caps.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../index.mjs";
import { MEMORY_CAPS } from "../../profiles.mjs";
import {
  FIXTURE_PERSONALITIES, enumOf, fakeChat, makeLLMContext, readLLMSituation, readSituation, reset, runLLMCall, userOf
} from "./helpers.mjs";

test("say: capped at 160 characters at a sentence boundary, unquoted, menu keys dropped", () => {
  const long = "We hold the line here. ".repeat(4) + "And then we push north with everything we have left, every last troop, until the board is ours and ours alone forever.";
  const s = brain.capSay(long);
  assert.ok(s.length <= 160);
  assert.match(s, /\.$/);
  assert.equal(brain.capSay("\"Charge!\""), "Charge!");
  assert.equal(brain.capSay("  "), "");
  assert.equal(brain.capSay("I choose attack_egypt_from_southern_europe."), "", "a menu key leaks the plan");
  const words = brain.capSay("a ".repeat(120));
  assert.ok(words.length <= 160 && words.endsWith("…"));
});

test("pickName: the personality's own names, unused first; then the Jev lists", () => {
  const ctx = makeLLMContext(readSituation("leader-one-star"), { personality: "test_turtle" });
  const a = brain.pickName(ctx, { kind: "city", used: [] });
  assert.ok(["Stillwater", "Marrow Keep"].includes(a.name));
  assert.equal(brain.pickName(ctx, { kind: "city", used: ["Stillwater"] }).name, "Marrow Keep");
  assert.equal(brain.pickName(ctx, { kind: "continent", used: [] }).name, "The Long Quiet");
  const fallback = brain.pickName(ctx, { kind: "city", used: ["Stillwater", "Marrow Keep"] });
  assert.ok(fallback.name && !["Stillwater", "Marrow Keep"].includes(fallback.name));
  assert.equal(fallback.why.reason, "name");
});

test("turn plan: cards, scar and placement from one answer; a trade raises the reserve; placements scale to the real reserve", async () => {
  const spec = readLLMSituation("full-turn");
  reset();
  const chat = fakeChat(() => req => ({
    thinking: "Troops now, the Mercenary at home.",
    cards: "trade_for_troops",
    scar_mercenary: enumOf(req, "scar_mercenary").find(k => k.startsWith("mercenary_on_china")),
    placements: [{ front: "mongolia", troops: 20 }, { front: "china", troops: 8 }],
    say: "Seventy percent is a fine number."
  }));
  const ctx = makeLLMContext(spec, { chat });
  const start = await brain.planStartOfTurn(ctx);
  assert.equal(start.buyRedStars, null);
  assert.equal(start.say, "Seventy percent is a fine number.", "the plan's line rides on the first decision");
  assert.equal(start.why.thinking, "Troops now, the Mercenary at home.");
  const scars = await brain.planScars(ctx, { cards: ctx.view.scarCards, targets: ["china", "mongolia"] });
  assert.deepEqual(scars.plays, [{ cardId: "s1", territory: "china" }]);
  assert.equal(scars.say, undefined, "said once");
  const rec = await brain.planRecruit(ctx, {});
  assert.equal(rec.why.reason, "tradeTroops");
  assert.equal(rec.why.count, 25);
  assert.match(userOf(chat.calls[0].request), /you will place 3 troops \(28 in total if you trade\)/);
  ctx.state.turn.log.recruited = true;
  const place = await brain.planPlacement(ctx, { reserve: 28 });
  assert.deepEqual(place.placements, [{ territory: "mongolia", count: 20 }, { territory: "china", count: 8 }]);
  assert.equal(chat.calls.length, 1, "one call for the whole start of the turn");

  // Scaling: the same plan on a smaller real reserve keeps the proportions.
  reset();
  const ctx2 = makeLLMContext(spec, { chat: fakeChat(() => ({ thinking: "x", cards: "hold_cards", scar_mercenary: "keep_mercenary", placements: [{ front: "mongolia", troops: 2 }, { front: "china", troops: 1 }], say: "" })) });
  const p5 = await brain.planPlacement(ctx2, { reserve: 5 });
  assert.deepEqual(p5.placements, [{ territory: "mongolia", count: 4 }, { territory: "china", count: 1 }]);
  reset();
  const ctx3 = makeLLMContext(spec, { chat: fakeChat(() => ({ thinking: "x", cards: "hold_cards", scar_mercenary: "keep_mercenary", placements: [{ front: "mongolia", troops: 2 }, { front: "china", troops: 1 }], say: "" })) });
  const p2 = await brain.planPlacement(ctx3, { reserve: 2 });
  assert.equal(p2.placements.reduce((n, p) => n + p.count, 0), 2);
});

test("turn plan: buying the Red Star that wins is code's call; a lone legal front needs no call", async () => {
  const spec = readLLMSituation("full-turn");
  spec.factions.khan.redStarTokens = 2;
  reset();
  const chat = fakeChat();
  const out = await brain.planStartOfTurn(makeLLMContext(spec, { chat }));
  assert.equal(out.why.reason, "buyStarWin");
  assert.equal(out.buyRedStars.length, 4);
  assert.equal(chat.calls.length, 0);
});

test("end of turn: one call for the maneuver and the draw; no call without a maneuver worth offering", async () => {
  const spec = readLLMSituation("full-turn");
  reset();
  const chat = fakeChat(() => req => ({ thinking: "Shore up.", maneuver: enumOf(req, "maneuver")[0], draw: enumOf(req, "draw").at(-1), say: "" }));
  const ctx = makeLLMContext(spec, { chat, call: { phase: "maneuver", log: { recruited: true, conquered: 1 } } });
  ctx.view.drawOptions = { canDraw: true, territoryCardIds: ["r1", "r2"], coinAllowed: false, row: ctx.view.row };
  const m = await brain.planManeuver(ctx);
  assert.ok(m && m.from && m.to && m.count >= 1);
  assert.equal(m.why.thinking, "Shore up.");
  const end = await brain.planEndOfTurn(ctx, { drawOptions: ctx.view.drawOptions, missionStatus: null });
  assert.deepEqual(end.draw, { cardId: "r2" });
  assert.equal(chat.calls.length, 1);
  assert.match(userOf(chat.calls[0].request), /- no_maneuver: leave the troops where they are/);
  // A verified mission is always completed (code), whatever was answered.
  const done = await brain.planEndOfTurn(ctx, { drawOptions: ctx.view.drawOptions, missionStatus: { status: "complete", canComplete: true, reward: 1 } });
  assert.equal(done.completeMission, true);
  // Nothing worth moving: no call, null.
  reset();
  const quiet = fakeChat();
  const lone = makeLLMContext(readSituation("early-expansion"), { chat: quiet, call: { phase: "maneuver" } });
  assert.equal(await brain.planManeuver(lone), null);
  assert.equal(quiet.calls.length, 0);
});

test("debrief: easy keeps no memory; normal merges notes, lessons, a grudge by User id and the game line", async () => {
  const spec = readLLMSituation("debrief");
  reset();
  const none = fakeChat();
  const easy = await runLLMCall(brain, "debrief", 0, { spec, chat: none, difficulty: "easy" });
  assert.equal(easy.out.memory, null);
  assert.equal(none.calls.length, 0);

  reset();
  const chat = fakeChat(() => req => ({
    thinking: "They took China.",
    summary: "Held on in India after Enclave took China.",
    notes: "Enclave's player rushes Mongolia, then China. Guard China with 6 or more by round 5.",
    lessons: ["Stack China before round 5.", "hit the leader early."],
    grudges: [{ player: enumOf(req, "grudges.player").find(k => k.includes("enclave")), text: "took China in round 7" }],
    say: "Next time, Bear. Next time!"
  }));
  const { out } = await runLLMCall(brain, "debrief", 0, { spec, chat, difficulty: "normal" });
  const m = out.memory;
  assert.match(m.notes, /Guard China/);
  assert.deepEqual(m.lessons, ["Stack China before round 5.", "hit the leader early."], "a duplicate lesson (any case) is kept once");
  assert.deepEqual(m.grudges, [{ user: "user-enclave", text: "took China in round 7", game: 4 }]);
  assert.deepEqual(m.games.at(-1), { game: 4, faction: "Khan Industries", result: "held on", summary: "Held on in India after Enclave took China." });
  assert.equal(m.updated, 4);
  assert.equal(out.say, "Next time, Bear. Next time!");
  assert.equal(out.why.reason, "debrief");
  const u = userOf(chat.calls[0].request);
  assert.match(u, /Enclave of the Bear won the war\. You played Khan Industries\./);
  assert.match(u, /Against you: Enclave of the Bear took China/);
  assert.match(u, /Your notes so far: Enclave's player always rushes Mongolia/);

  // An unknown player key is bad output.
  reset();
  const bad = fakeChat(() => ({ thinking: "x", summary: "s", notes: "n", lessons: [], grudges: [{ player: "the_gm", text: "rude" }], say: "" }));
  await assert.rejects(runLLMCall(brain, "debrief", 0, { spec, chat: bad }), { code: "bad_output" });

  // Heuristic mode: the game line only.
  reset();
  const h = await runLLMCall(brain, "debrief", 0, { spec, chat: null });
  assert.equal(h.out.memory.notes, "Enclave's player always rushes Mongolia.");
  assert.equal(h.out.memory.games.at(-1).result, "held on");
  assert.equal(h.out.why.heuristic, true);
});

test("memory caps: notes about 120 words, 6 lessons, 8 grudges (one per User), 12 games", () => {
  const base = {
    notes: "old",
    lessons: Array.from({ length: 9 }, (_, i) => `lesson ${i}`),
    grudges: Array.from({ length: 12 }, (_, i) => ({ user: `u${i}`, text: `g${i}`, game: 1 })),
    games: Array.from({ length: 15 }, (_, i) => ({ game: i + 1, faction: "X", result: "lost", summary: "" })),
    updated: 15
  };
  const m = brain.mergeMemory(base, {
    notes: "word ".repeat(300), lessons: ["new lesson"], grudges: [{ user: "u3", text: "again" }], game: 16,
    record: { game: 16, faction: "Y", result: "won", summary: "s" }
  });
  assert.ok(m.notes.split(" ").length <= MEMORY_CAPS.noteWords + 1);
  assert.equal(m.lessons.length, MEMORY_CAPS.lessons);
  assert.equal(m.lessons[0], "new lesson");
  assert.equal(m.grudges.length, MEMORY_CAPS.grudges);
  assert.deepEqual(m.grudges[0], { user: "u3", text: "again", game: 16 });
  assert.equal(m.grudges.filter(g => g.user === "u3").length, 1);
  assert.equal(m.games.length, MEMORY_CAPS.games);
  assert.equal(m.games.at(-1).game, 16);
  assert.deepEqual(brain.normalizeMemory(null), { notes: "", grudges: [], lessons: [], games: [], updated: 0 });
});

test("degrades gracefully without seats, campaign, recent or memory", async () => {
  const spec = readLLMSituation("full-turn");
  delete spec.view.campaign;
  delete spec.view.recent;
  reset();
  const chat = fakeChat();
  const ctx = makeLLMContext(spec, { chat, difficulty: "hard", memory: null, seats: undefined });
  delete ctx.view.seats;
  ctx.bot.personality = null;
  const out = await brain.planStartOfTurn(ctx);
  assert.ok(out.why);
  const u = userOf(chat.calls[0].request);
  assert.doesNotMatch(u, /Since your last turn|Past winners|grudges/);
  assert.match(chat.calls[0].request.messages[0].content, /You are a seasoned general/);
  assert.ok(FIXTURE_PERSONALITIES.length === 3);
});
