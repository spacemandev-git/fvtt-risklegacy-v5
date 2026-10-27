/**
 * The chat-model brain against its contract: the API surface, heuristic mode, legal decisions on every fixture with a
 * fake chat, strict validation (bad output → LLMError), error propagation and CPU time.
 * Run: node --test module/bots/llm/brain/tests/
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import * as brain from "../index.mjs";
import * as jevBrain from "../../../brain/index.mjs";
import * as rules from "../../../../rules/_module.mjs";
import { LLMError } from "../../client.mjs";
import {
  fakeChat, llmSituationNames, makeLLMContext, readLLMSituation, readSituation, reset, resolveArgs, resolveLLMArgs,
  runLLMCall, situationNames, enumOf, userOf
} from "./helpers.mjs";

/** BOTS.md §5.3 reasons, the Jev brain's additions and this brain's. */
const REASONS = new Set([
  "situation", "buyStar", "buyStarWin", "holdCards", "tradeTroops", "holdScars", "playScar", "recruit", "stageAttack",
  "defendHq", "defendBorder", "winNow", "hqCapture", "breakContinent", "completeContinent", "knockOut", "cardConquest",
  "weakenLeader", "missionProgress", "opportunity", "expand", "stopEnough", "stopOddsPoor", "stopDefend", "holdBack",
  "pressOn", "consolidate", "reinforceHq", "completeMission", "drawCard", "drawCoin", "noDraw", "defendMax",
  "missileSaveHq", "missileWin", "missileStopLeader", "missileHold", "startPosition", "choiceBest", "name", "heuristic",
  ...Object.keys(brain.WHY_REASONS_ADDED)
]);

const API = [
  "assessSituation", "planStartOfTurn", "planScars", "planRecruit", "planPlacement", "nextMove", "moveIn", "planManeuver",
  "planEndOfTurn", "chooseDefenseDice", "preRollScar", "missileDecision", "chooseStartingTerritory", "chooseOption", "pickName"
];

/** Legality and shape of a decision (as the Jev brain's tests check them). */
function checkDecision(fn, out, ctx, args) {
  const { state, me } = ctx;
  if ( (fn === "preRollScar" || fn === "planManeuver") && out === null ) return;
  assert.ok(out && typeof out === "object", `${fn}: decision object`);
  assert.ok(out.why && REASONS.has(out.why.reason), `${fn}: why.reason ${out.why?.reason}`);
  if ( out.why.chance !== undefined ) assert.ok(out.why.chance >= 0 && out.why.chance <= 1, `${fn}: chance in 0..1`);
  if ( out.say !== undefined ) assert.ok(typeof out.say === "string" && out.say.length > 0 && out.say.length <= 160, `${fn}: say capped`);
  switch ( fn ) {
    case "planStartOfTurn":
      if ( out.buyRedStars ) {
        assert.equal(out.buyRedStars.length % 4, 0);
        for ( const id of out.buyRedStars ) assert.ok(ctx.view.hand.some(c => c.id === id));
      }
      break;
    case "planScars":
      for ( const p of out.plays ) {
        assert.ok(args.cards.some(c => c.id === p.cardId), "played card is in hand");
        if ( p.territory ) assert.ok(args.targets.includes(p.territory), "legal scar target");
      }
      break;
    case "planRecruit":
      if ( args.mustJoin ) assert.ok(args.legalJoin.includes(out.join), `join ${out.join} is legal`);
      else {
        assert.equal(out.recruit, true);
        if ( out.tradeForTroops ) {
          const coins = out.tradeForTroops.reduce((n, id) => n + ctx.view.hand.find(c => c.id === id).coins, 0);
          assert.ok(rules.checkTrade(state, me, coins, { ignoreTurn: true }).ok);
        }
      }
      break;
    case "planPlacement": {
      const total = out.placements.reduce((n, p) => n + p.count, 0);
      assert.equal(total, args.reserve, `placements sum ${total} = reserve ${args.reserve}`);
      for ( const p of out.placements ) {
        assert.ok(Number.isInteger(p.count) && p.count >= 1);
        assert.ok(rules.checkPlacement(state, me, p.territory, p.count, { ignoreTurn: true }).ok, `place in ${p.territory}`);
      }
      break;
    }
    case "nextMove":
      if ( out.type === "attack" ) assert.ok(rules.checkAttack(state, me, out.from, out.to, out.dice).ok, "attack is legal");
      else if ( out.type === "expand" ) assert.ok(rules.checkExpand(state, me, out.from, out.to, out.count).ok, "expand is legal");
      else assert.equal(out.type, "stop");
      break;
    case "moveIn":
      assert.ok(out.count >= args.min && out.count <= args.max);
      break;
    case "planManeuver":
      assert.ok(rules.checkManeuver(state, me, out.from, out.to, out.count, { ignoreTurn: true }).ok, "maneuver is legal");
      break;
    case "missileDecision":
      if ( out.fire ) {
        assert.ok(["attack", "defend"].includes(out.side));
        assert.ok(args.battle[out.side].some(d => d.slot === out.index && !d.missile));
      }
      break;
    case "preRollScar":
      assert.ok(args.cards.some(c => c.id === out.cardId));
      break;
    case "chooseStartingTerritory":
      assert.ok(args.legal.includes(out.territory));
      break;
    case "chooseOption":
      assert.ok(args.options.some(o => o.value === out.value && !o.disabled));
      break;
    default: break;
  }
}

/** Every call of every fixture (Jev fixtures + LLM fixtures). */
function allCalls() {
  const out = [];
  for ( const name of situationNames() ) readSituation(name).calls.forEach((c, i) => out.push({ name, i, fn: c.fn, spec: readSituation(name) }));
  for ( const name of llmSituationNames() ) readLLMSituation(name).calls.forEach((c, i) => out.push({ name, i, fn: c.fn, spec: readLLMSituation(name) }));
  return out;
}

test("API: every Jev brain function plus debrief, with the same names", () => {
  for ( const fn of API ) {
    assert.equal(typeof brain[fn], "function", fn);
    assert.equal(typeof jevBrain[fn], "function", `jev ${fn}`);
  }
  assert.equal(typeof brain.debrief, "function");
  assert.equal(typeof brain.pickName({ random: () => 0 }, { kind: "city", used: [] }).name, "string", "pickName is synchronous");
});

test("heuristic mode (chat = null): every fixture call returns the Jev brain's built-in decision", async () => {
  let n = 0;
  for ( const { name, i, fn, spec } of allCalls() ) {
    if ( fn === "debrief" ) continue;
    for ( const difficulty of ["easy", "normal", "hard"] ) {
      reset();
      const call = spec.calls[i];
      const ctx = makeLLMContext(spec, { difficulty, chat: null, call });
      const args = resolveLLMArgs(ctx, call.args ?? {}, spec);
      const out = await brain[fn](ctx, args);
      reset();
      const jctx = makeLLMContext(spec, { difficulty, chat: null, call });
      const expected = await jevBrain[fn]({ ...jctx, ask: null }, resolveLLMArgs(jctx, call.args ?? {}, spec));
      assert.deepEqual(out, expected, `${name}/${fn}/${difficulty}`);
      n++;
    }
  }
  assert.ok(n > 60);
});

test("fake chat: every fixture call at every level returns a legal decision, and requests pass the shape checks", async () => {
  let calls = 0;
  for ( const { name, i, fn, spec } of allCalls() ) {
    for ( const difficulty of ["easy", "normal", "hard"] ) {
      reset();
      const chat = fakeChat();
      const { out, ctx, args } = await runLLMCall(brain, name, i, { spec, difficulty, chat });
      if ( fn === "debrief" ) {
        assert.equal(out.why.reason, "debrief");
        continue;
      }
      checkDecision(fn, out, ctx, args);
      calls += chat.calls.length;
      assert.ok(chat.calls.length <= 1, `${name}/${fn}: one call at most for a single decision`);
      for ( const c of chat.calls ) assert.ok(JSON.stringify(c.request).length < 60000, "well under the context limit");
    }
  }
  assert.ok(calls > 40, `${calls} calls`);
});

test("code-only decisions make no call: defence dice, situation, moveIn, names, winning moves, trivial missiles", async () => {
  reset();
  const chat = fakeChat();
  const { out: sit } = await runLLMCall(brain, "leader-one-star", 0, { chat });
  assert.equal(sit.why.reason, "situation");
  assert.equal(sit.why.heuristic, undefined, "code judgment by design, not a fallback");
  const { out: win } = await runLLMCall(brain, "hq-win-vs-continent", 2, { chat, difficulty: "normal" });
  assert.deepEqual([win.type, win.to, win.why.reason], ["attack", "russia", "winNow"]);
  const { out: trivial } = await runLLMCall(brain, "missile-trivial", 0, { chat });
  assert.equal(trivial.fire, false);
  const { out: decisive } = await runLLMCall(brain, "missile-decisive", 0, { chat });
  assert.deepEqual([decisive.fire, decisive.side, decisive.why.reason], [true, "defend", "missileSaveHq"]);
  const ctx = makeLLMContext(readSituation("leader-one-star"), { chat });
  const dd = await brain.chooseDefenseDice(ctx, { battle: { attacker: "balkania", defender: "enclave", from: "russia", to: "southern_europe", attackDice: 3 }, max: 2 });
  assert.ok([1, 2].includes(dd.dice));
  const mi = await brain.moveIn(ctx, { from: "southern_europe", to: "western_europe", min: 0, max: 5 });
  assert.ok(mi.count >= 0 && mi.count <= 5);
  assert.equal(chat.calls.length, 0);
});

test("bad output: a key outside the menu gets one corrective retry, then LLMError bad_output", async () => {
  reset();
  const chat = fakeChat(() => ({ thinking: "x", steps: ["attack_the_moon"], keep_at_least: 0, stop_when: "keep_going", say: "" }));
  await assert.rejects(runLLMCall(brain, "leader-one-star", 1, { chat }), err => {
    assert.ok(err instanceof LLMError);
    assert.equal(err.code, "bad_output");
    assert.match(err.message, /attack_the_moon/);
    return true;
  });
  assert.equal(chat.calls.length, 2);
  assert.equal(chat.calls[1].purpose, "attack plan (retry)");
  const retry = chat.calls[1].request.messages;
  assert.equal(retry.length, 4);
  assert.equal(retry[2].role, "assistant");
  assert.match(retry[3].content, /broke the rules of the menu/);
  assert.equal(retry[0].content, chat.calls[0].request.messages[0].content, "same system message on the retry");
  // An empty step list is not a stop: it must be the explicit stop_now (one corrective retry).
  reset();
  const empty = fakeChat([{ thinking: "x", steps: [], keep_at_least: 0, stop_when: "keep_going", say: "" }, { thinking: "x", steps: ["stop_now"], keep_at_least: 0, stop_when: "keep_going", say: "" }]);
  const { out } = await runLLMCall(brain, "leader-one-star", 1, { chat: empty });
  assert.equal(out.type, "stop");
  assert.match(userOf(empty.calls[1].request), /to stop attacking now, give \["stop_now"\]/);
  // Empty again on the retry is a clear "no attacks": stop, not an error.
  reset();
  const twice = fakeChat(() => ({ thinking: "x", steps: [], keep_at_least: 0, stop_when: "keep_going", say: "" }));
  const again = await runLLMCall(brain, "leader-one-star", 1, { chat: twice });
  assert.equal(again.out.type, "stop");
  assert.equal(twice.calls.length, 2);
});

test("bad output: placements over the reserve, keep_at_least out of range, unknown join → LLMError; a fixed retry succeeds", async () => {
  // Placement total over the reserve, twice.
  reset();
  const over = req => ({ thinking: "x", placements: [{ front: enumOf(req, "placements.front")[0], troops: 99 }], say: "" });
  let chat = fakeChat(() => over);
  await assert.rejects(runLLMCall(brain, "placement-exposure", 1, { chat }), { name: "LLMError", code: "bad_output" });
  assert.match(userOf(chat.calls[1].request), /more than the 8 you will have/);
  // Fixed on the retry: two calls, a legal decision.
  reset();
  chat = fakeChat([over, undefined]);
  const { out, ctx, args } = await runLLMCall(brain, "placement-exposure", 1, { chat });
  checkDecision("planPlacement", out, ctx, args);
  assert.equal(chat.calls.length, 2);
  // keep_at_least out of range.
  reset();
  chat = fakeChat(() => req => ({ thinking: "x", steps: [enumOf(req, "steps")[0]], keep_at_least: 500, stop_when: "after_these_steps", say: "" }));
  await assert.rejects(runLLMCall(brain, "leader-one-star", 1, { chat }), { code: "bad_output" });
  // An unknown join territory.
  reset();
  chat = fakeChat(() => ({ thinking: "x", join: "the_moon", say: "" }));
  await assert.rejects(runLLMCall(brain, "join-the-war", 0, { chat }), { code: "bad_output" });
  // A non-object answer.
  reset();
  chat = fakeChat(() => () => null);
  await assert.rejects(runLLMCall(brain, "event-choice", 0, { chat }), { code: "bad_output" });
});

test("a failed chat call is an error, never an answer", async () => {
  const boom = async () => { throw new LLMError("network down", { code: "network", retryable: true }); };
  for ( const [name, i] of [["leader-one-star", 1], ["event-choice", 0], ["starting-territory", 0], ["placement-exposure", 1], ["join-the-war", 0]] ) {
    reset();
    await assert.rejects(runLLMCall(brain, name, i, { chat: boom }), { name: "LLMError", code: "network" });
  }
  for ( const name of ["missile-choice", "bunker-choice", "campaign-reward", "debrief"] ) {
    reset();
    const spec = readLLMSituation(name);
    await assert.rejects(runLLMCall(brain, name, 0, { spec, chat: boom }), { code: "network" });
  }
});

test("missiles and scar cards: one short call when code finds a real choice; the answer maps to a legal move", async () => {
  const spec = readLLMSituation("missile-choice");
  for ( const [choice, fire] of [["hold", false], [null, true]] ) {
    reset();
    const chat = fakeChat(() => req => ({ thinking: "x", choice: choice ?? enumOf(req, "choice").find(k => k.startsWith("fire_")), say: "Not today." }));
    const { out, ctx, args } = await runLLMCall(brain, "missile-choice", 0, { spec, chat });
    checkDecision("missileDecision", out, ctx, args);
    assert.equal(out.fire, fire);
    assert.equal(chat.calls.length, 1);
    assert.equal(chat.calls[0].purpose, "missile");
    assert.ok(userOf(chat.calls[0].request).length < 1500, "a short prompt");
    if ( fire ) assert.equal(out.say, "Not today.", "a missile fired is a key moment: the line is kept");
    // Called again for the same roll: the cached answer, no new call.
    const again = await brain.missileDecision(ctx, args);
    assert.deepEqual(again, out);
    assert.equal(chat.calls.length, 1);
  }
  reset();
  const bspec = readLLMSituation("bunker-choice");
  const chat = fakeChat(() => req => ({ thinking: "x", choice: enumOf(req, "choice").find(k => k.startsWith("play_")), say: "" }));
  const { out, ctx, args } = await runLLMCall(brain, "bunker-choice", 0, { spec: bspec, chat });
  checkDecision("preRollScar", out, ctx, args);
  assert.equal(out.cardId, "b1");
  assert.equal(chat.calls.length, 1);
  reset();
  const keep = fakeChat(() => ({ thinking: "x", choice: "keep_card", say: "" }));
  assert.equal((await runLLMCall(brain, "bunker-choice", 0, { spec: bspec, chat: keep })).out, null);
});

test("each decision runs in about 100 ms of CPU or less with a fake chat (cold memo)", async () => {
  const slow = [];
  for ( const { name, i, fn, spec } of allCalls() ) {
    for ( const difficulty of ["normal", "hard"] ) {
      reset();
      const t0 = performance.now();
      await runLLMCall(brain, name, i, { spec, difficulty });
      const ms = performance.now() - t0;
      if ( ms > 120 ) slow.push(`${name}/${fn}/${difficulty}: ${ms.toFixed(0)} ms`);
    }
  }
  assert.deepEqual(slow, []);
});

test("Jev fixtures still resolve with the shared args helper", () => {
  const spec = readSituation("starting-territory");
  const ctx = makeLLMContext(spec, {});
  assert.ok(resolveArgs(ctx, { legal: "auto" }).legal.length > 10);
});
