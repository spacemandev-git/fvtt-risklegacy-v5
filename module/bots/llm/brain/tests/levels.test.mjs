/**
 * What each level may know (BOTS-LLM.md §6.3), the stable system message (prompt caching), no player names, calls per
 * turn and bounded replans, and the personality knobs code uses (§5.2).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../index.mjs";
import { LLM_PROFILES, knobsOf, oddsFloor } from "../../profiles.mjs";
import { attackMenu } from "../menus.mjs";
import { situationOf } from "../turn.mjs";
import {
  FIXTURE_PERSONALITIES, enumOf, fakeChat, makeLLMContext, playTurn, readLLMSituation, readSituation, reset,
  runLLMCall, systemOf, userOf
} from "./helpers.mjs";

/** The full-turn fixture played at a level; returns the calls by purpose. */
async function turnCalls(difficulty, o = {}) {
  reset();
  const chat = o.chat ?? fakeChat(o.script ?? null);
  const res = await playTurn(brain, readLLMSituation("full-turn"), { difficulty, chat, ...o });
  return { chat, ...res, by: p => chat.calls.filter(c => c.purpose === p) };
}

test("context per level: easy sees its own borders and Red Star counts; normal adds standings; hard adds hands, recent events and the campaign", async () => {
  const easy = (await turnCalls("easy")).by("turn plan")[0].request;
  const normal = (await turnCalls("normal")).by("turn plan")[0].request;
  const hard = (await turnCalls("hard")).by("turn plan")[0].request;
  const [ue, un, uh] = [easy, normal, hard].map(userOf);

  // Easy: no numbers in odds, no other faction's troop totals, no hands, no recent events, no campaign.
  assert.doesNotMatch(ue, /\d+%/, "easy: verbal odds only");
  assert.doesNotMatch(ue, /troops on \d+ territor/, "easy: no faction troop totals");
  assert.doesNotMatch(ue, /Factions:/);
  assert.doesNotMatch(ue, /Since your last turn/);
  assert.doesNotMatch(ue, /Campaign/);
  assert.doesNotMatch(ue, /Your grudges/);
  assert.match(ue, /Your territories that touch others/);
  assert.match(ue, /Red Stars: Enclave of the Bear/);

  // Normal: exact odds, standings with troops and continents, HQ threats, a one-line campaign, grudges; no hands or recent.
  assert.match(un, /\d+% \(/);
  assert.match(un, /Factions:\n- Khan Industries \(you\)/);
  assert.match(un, /troops on \d+ territor/);
  assert.doesNotMatch(un, /Enclave of the Bear \(a human player\)[^\n]*\d+ cards? \(/, "normal: no other faction's hand");
  assert.doesNotMatch(un, /Since your last turn/);
  assert.match(un, /Campaign: game 4 of 15; you have won 1 game/);
  assert.doesNotMatch(un, /Past winners/);
  assert.match(un, /Your grudges: Captain Rook Vandal \(the bot playing Imperial Balkania\): took my HQ in game 2/);

  // Hard: + hands and coins, recruits, the mission, recent events, the full campaign.
  assert.match(uh, /3 cards \(5 coins\)/);
  assert.match(uh, /recruits about \d+ next turn/);
  assert.match(uh, /Mission \(anyone may complete it/);
  assert.match(uh, /Since your last turn:\n- Imperial Balkania attacked Afghanistan/);
  assert.match(uh, /Past winners: game 1: Enclave of the Bear; game 2: Imperial Balkania; game 3: Khan Industries \(you\)/);
  assert.match(uh, /Your faction's history/);

  // System messages: rules for all; strategy and the short campaign from normal; the full campaign and lessons for hard.
  const [se, sn, sh] = [easy, normal, hard].map(systemOf);
  assert.doesNotMatch(se, /\nSTRATEGY\n/);
  assert.doesNotMatch(se, /\nTHE CAMPAIGN\n/);
  assert.doesNotMatch(se, /YOUR NOTES/, "easy: no memory");
  assert.match(sn, /\nSTRATEGY\n/);
  assert.match(sn, /YOUR NOTES FROM EARLIER GAMES[^]*Notes: Enclave/);
  assert.doesNotMatch(sn, /Lessons:/, "normal reads notes only");
  assert.match(sh, /Lessons:\n- Keep 4 troops in the HQ\./);
  assert.match(sh, /Past games:\n- [G]ame 3 as Khan Industries: won/);
  assert.ok(sh.length > sn.length && sn.length > se.length);

  // Request settings per level.
  assert.deepEqual([easy.reasoning, easy.temperature, easy.maxTokens], [{ effort: "low" }, 0.9, 1500]);
  assert.deepEqual([normal.reasoning, normal.temperature, normal.maxTokens], [{ effort: "low" }, 0.6, 2500]);
  assert.deepEqual([hard.reasoning, hard.temperature, hard.maxTokens], [{ effort: "low" }, 0.3, 5000], "hard: low for the turn plan (latency)");
  const hardAttack = (await turnCalls("hard")).by("attack plan")[0]?.request;
  if ( hardAttack ) assert.deepEqual(hardAttack.reasoning, { effort: "medium" }, "hard: medium for the attack plan");
});

test("attack menus per level: easy 5 with verbal odds; normal 6 with %; hard 8 with expected losses and pushes; HQ floors stated", async () => {
  for ( const [difficulty, size] of [["easy", 5], ["normal", 6], ["hard", 8]] ) {
    reset();
    const chat = fakeChat();
    await runLLMCall(brain, "leader-one-star", 1, { chat, difficulty, personality: FIXTURE_PERSONALITIES[2] });
    const req = chat.calls[0].request;
    const keys = enumOf(req, "steps");
    assert.ok(keys.length - 1 <= size, `${difficulty}: ${keys.length - 1} options`);
    assert.equal(keys.at(-1), "stop_now", "an explicit stop");
    for ( const k of keys.slice(0, -1) ) assert.match(k, /^(attack|expand_into|push_to)_[a-z0-9_]+$/, "descriptive slugs");
    const u = userOf(req);
    if ( difficulty === "easy" ) assert.doesNotMatch(u, /\d+%|expected losses/);
    if ( difficulty === "normal" ) {
      assert.match(u, /\d+% \(/);
      assert.doesNotMatch(u, /expected losses/);
      assert.match(u, /leave at least 3 troops in each HQ/);
    }
    if ( difficulty === "hard" ) {
      assert.match(u, /expected losses \d/);
      assert.match(u, /leave at least 4 troops in each HQ/);
    }
  }
});

test("system message: identical for every call of one bot in one war (cache-friendly), independent of the board, different per personality", async () => {
  const { chat } = await turnCalls("hard", { script: purpose => (purpose === "attack plan" ? { thinking: "x", steps: ["stop_now"], keep_at_least: 0, stop_when: "after_these_steps", say: "" } : undefined) });
  const spec = readLLMSituation("full-turn");
  // A reactive decision of the same bot in the same war, with a fresh context, shares the system message.
  const ctx2 = makeLLMContext(spec, { difficulty: "hard", chat });
  await brain.chooseOption(ctx2, { kind: "event", title: "Fortify", options: [{ value: "a", label: "Fortify a city" }, { value: "b", label: "Add troops" }] });
  const systems = new Set(chat.calls.map(c => systemOf(c.request)));
  assert.equal(systems.size, 1, "one system message");
  assert.ok(chat.calls.length >= 3);
  const sys = [...systems][0];
  // Rebuilt from scratch (caches cleared) on a different board, for the same bot: the same text.
  reset();
  const other = fakeChat();
  const ctx3 = makeLLMContext(readSituation("event-choice"), { difficulty: "hard", chat: other, memory: spec.llm.memory });
  ctx3.bot.userId = "user-khan";
  ctx3.view.game = 4;
  await brain.chooseOption(ctx3, readSituation("event-choice").calls[0].args);
  assert.equal(systemOf(other.calls[0].request), sys, "the board never reaches the system message");
  for ( const name of ["Irkutsk", "Mongolia", "round 5", "Imperial Might"] ) assert.ok(!sys.includes(name), `no ${name} in the system message`);
  // Another personality: another system message.
  reset();
  const b = fakeChat();
  await runLLMCall(brain, "event-choice", 0, { chat: b, personality: "test_berserker" });
  assert.notEqual(systemOf(b.calls[0].request), sys);
  assert.match(systemOf(b.calls[0].request), /Captain Rook Vandal, "The Red Tide"/);
  assert.match(systemOf(b.calls[0].request), /Charge! Nobody lives forever!/);
});

test("no player names or user ids in any prompt", async () => {
  const { chat } = await turnCalls("hard");
  reset();
  const spec = readLLMSituation("debrief");
  const d = fakeChat();
  await runLLMCall(brain, "debrief", 0, { spec, chat: d });
  for ( const c of [...chat.calls, ...d.calls] ) {
    const text = JSON.stringify(c.request.messages);
    assert.doesNotMatch(text, /Player (khan|enclave|balkania|saharan)/, "fixture player names never appear");
    assert.doesNotMatch(text, /user-[a-z]+/, "user ids never appear");
  }
  // People are "the player of <faction>", bots by their personality name.
  assert.match(JSON.stringify(d.calls[0].request.messages), /the player of Enclave of the Bear/);
  assert.match(JSON.stringify(d.calls[0].request.messages), /Analyst Petra Quill \(the bot playing Imperial Balkania\)/);
});

test("calls per turn: 2 to 5 at every level; the turn plan is made once and read by recruit and placement", async () => {
  for ( const difficulty of ["easy", "normal", "hard"] ) {
    for ( const seed of [1, 2, 3] ) {
      const { chat, log, by } = await turnCalls(difficulty, { diceSeed: seed });
      assert.ok(chat.calls.length >= 2 && chat.calls.length <= 5, `${difficulty}/${seed}: ${chat.calls.length} calls (${chat.calls.map(c => c.purpose)})`);
      assert.equal(by("turn plan").length, 1);
      assert.ok(by("attack plan").length <= 1);
      assert.ok(by("replan").length <= LLM_PROFILES[difficulty].replans, `${difficulty}: replans ${by("replan").length}`);
      assert.ok(by("end of turn").length <= 1);
      const placement = log.find(l => l.fn === "planPlacement").out;
      assert.equal(placement.placements.reduce((n, p) => n + p.count, 0), 3);
    }
  }
});

test("replans: keep_going replans while good options remain, never more than the level allows (easy 0, normal 1, hard 2)", async () => {
  const script = purpose => (purpose === "turn plan"
    ? req => ({ thinking: "x", cards: "hold_cards", scar_mercenary: "keep_mercenary", placements: [{ front: enumOf(req, "placements.front")[0], troops: 1 }], say: "" })
    : (purpose === "attack plan" || purpose === "replan")
      ? req => ({ thinking: "x", steps: [enumOf(req, "steps")[0]], keep_at_least: 0, stop_when: "keep_going", say: "" })
      : undefined);
  const spec = readLLMSituation("full-turn");
  spec.pieces.siberia.khan = 25;
  spec.pieces.india.khan = 15;
  const replans = {};
  for ( const difficulty of ["easy", "normal", "hard"] ) {
    for ( const diceSeed of [1, 2, 3] ) {
      reset();
      const chat = fakeChat(script);
      await playTurn(brain, spec, { difficulty, chat, diceSeed });
      const n = chat.calls.filter(c => c.purpose === "replan").length;
      assert.ok(n <= LLM_PROFILES[difficulty].replans, `${difficulty}: ${n} replans`);
      assert.ok(chat.calls.length <= 5);
      replans[difficulty] = Math.max(replans[difficulty] ?? 0, n);
    }
  }
  assert.deepEqual(replans, { easy: 0, normal: 1, hard: 2 });
  // after_these_steps never replans.
  const once = purpose => ((purpose === "attack plan") ? req => ({ thinking: "x", steps: [enumOf(req, "steps")[0]], keep_at_least: 0, stop_when: "after_these_steps", say: "" }) : undefined);
  assert.equal((await turnCalls("hard", { script: once })).by("replan").length, 0);
});

test("a stop answer stops at once; a plan step is executed with fresh odds and the HQ floor", async () => {
  reset();
  const stop = fakeChat(() => ({ thinking: "Not worth it.", steps: ["stop_now"], keep_at_least: 0, stop_when: "keep_going", say: "" }));
  const { out } = await runLLMCall(brain, "leader-one-star", 1, { chat: stop, difficulty: "hard" });
  assert.equal(out.type, "stop");
  assert.equal(out.why.thinking, "Not worth it.");
  reset();
  const go = fakeChat(() => ({ thinking: "Egypt.", steps: ["attack_egypt_from_southern_europe"], keep_at_least: 0, stop_when: "after_these_steps", say: "" }));
  const { out: a, ctx } = await runLLMCall(brain, "leader-one-star", 1, { chat: go, difficulty: "hard" });
  assert.deepEqual([a.type, a.from, a.to], ["attack", "southern_europe", "egypt"]);
  // The hard bot keeps 4 in its HQ: the odds it acts on are computed with that floor.
  assert.ok(a.why.chance < 0.8, "odds with the HQ floor kept back");
  const again = await brain.nextMove(ctx);
  assert.deepEqual([again.type, again.to], ["attack", "egypt"], "the step continues on the next call, without a new call");
  assert.equal(go.calls.length, 1);
});

test("knobs: risk shifts the odds floor, aggression the menu size and the move-in, chattiness the routine table talk", async () => {
  const spec = readSituation("knockout-cards");
  const call = spec.calls.find(c => c.fn === "nextMove");
  const menuFor = id => {
    reset();
    const ctx = makeLLMContext(spec, { personality: id, call });
    return situationOf(ctx).then(sit => attackMenu(ctx, LLM_PROFILES.normal, knobsOf(ctx), sit));
  };
  const turtle = await menuFor("test_turtle");
  const berserker = await menuFor("test_berserker");
  const kt = FIXTURE_PERSONALITIES[0].knobs;
  const kb = FIXTURE_PERSONALITIES[1].knobs;
  assert.ok(oddsFloor(LLM_PROFILES.normal, kb) < oddsFloor(LLM_PROFILES.normal, kt));
  assert.ok(turtle.every(o => o.decisive || o.kind === "expand" || o.P >= oddsFloor(LLM_PROFILES.normal, kt)));
  assert.ok(berserker.length > turtle.length, `berserker ${berserker.length} options, turtle ${turtle.length}`);
  assert.ok(berserker.some(o => !o.decisive && o.kind === "attack" && o.P < oddsFloor(LLM_PROFILES.normal, kt)), "the risky personality sees thinner odds");

  // Move-in with nothing pressing on either side: the aggressive personality moves more.
  const moved = async id => {
    reset();
    const ctx = makeLLMContext(readSituation("early-expansion"), { personality: id });
    return (await brain.moveIn(ctx, { from: "northern_europe", to: "scandinavia", min: 0, max: 8 })).count;
  };
  assert.ok(await moved("test_berserker") > await moved("test_turtle"));

  // Chattiness: a silent personality drops routine lines; key moments always speak.
  const silent = { ...FIXTURE_PERSONALITIES[2], id: "silent", knobs: { ...FIXTURE_PERSONALITIES[2].knobs, chattiness: 0 } };
  reset();
  const routine = await runLLMCall(brain, "event-choice", 0, { personality: silent, chat: fakeChat(() => req => ({ thinking: "x", choice: enumOf(req, "choice")[0], say: "Fine." })) });
  assert.equal(routine.out.say, undefined, "routine line dropped");
  reset();
  const key = await runLLMCall(brain, "reward-choice", 0, { personality: silent, chat: fakeChat(() => req => ({ thinking: "x", choice: enumOf(req, "choice")[0], say: "To the victor." })) });
  assert.equal(key.out.say, "To the victor.", "a reward is a key moment");
});

test("campaign context for choices with campaign effect: hard gets the facts, normal one line, easy none", async () => {
  const spec = readLLMSituation("campaign-reward");
  const texts = {};
  for ( const difficulty of ["easy", "normal", "hard"] ) {
    reset();
    const chat = fakeChat();
    await runLLMCall(brain, "campaign-reward", 0, { spec, chat, difficulty });
    texts[difficulty] = userOf(chat.calls[0].request);
  }
  assert.doesNotMatch(texts.easy, /Campaign/);
  assert.match(texts.normal, /Campaign: game 4 of 15; you have won 0 games; others: the player of Enclave of the Bear 2/);
  assert.match(texts.hard, /Your faction's history: game 1: held on, started in China/);
  assert.match(texts.hard, /Scars on the board: Ammo Shortage in Japan/);
  assert.doesNotMatch(texts.hard, /Threat next turn/, "the war is over: no threats");
});
