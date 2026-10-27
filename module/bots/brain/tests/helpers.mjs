/**
 * Test helpers for the brain: a fake `ask` that shape-checks every request and returns canned or neutral answers.
 */
import assert from "node:assert/strict";
import { assertQuestions } from "../../jev/questions.mjs";
import { clearTurnMemos } from "../util.mjs";
import { clearStakes } from "../decide/battle.mjs";

export * from "../../../../tools/fixtures/bots/build.mjs";

/** BOTS.md §5.3 reasons plus the ones the brain adds (index.mjs WHY_REASONS_ADDED). */
export const REASONS = new Set([
  "situation", "buyStar", "buyStarWin", "holdCards", "tradeTroops", "holdScars", "playScar", "recruit", "stageAttack",
  "defendHq", "defendBorder", "winNow", "hqCapture", "breakContinent", "completeContinent", "knockOut", "cardConquest",
  "weakenLeader", "missionProgress", "opportunity", "expand", "stopEnough", "stopOddsPoor", "stopDefend", "holdBack",
  "pressOn", "consolidate", "reinforceHq", "completeMission", "drawCard", "drawCoin", "noDraw", "defendMax",
  "missileSaveHq", "missileWin", "missileStopLeader", "missileHold", "startPosition", "choiceBest", "name", "heuristic",
  "missileSwing", "defendFewer"
]);

/** Reset module-level memos between tests. */
export function reset() {
  clearTurnMemos();
  clearStakes();
}

/** Shape check of one request (BOTS.md §4.1). */
export function checkRequest(request) {
  assert.ok(request && typeof request === "object", "request object");
  assert.ok(request.state && typeof request.state === "object" && !Array.isArray(request.state), "state is an object");
  assertQuestions(request.questions);
  for ( const [name, q] of Object.entries(request.questions) ) {
    assert.ok(["noul", "choice", "score"].includes(q.type), `${name}: type`);
    assert.ok(typeof q.instructions === "string" && q.instructions.length > 10, `${name}: instructions`);
    if ( q.type === "choice" ) {
      const n = Object.keys(q.criteria).length;
      assert.ok(n >= 1 && n <= 255, `${name}: ${n} options`);
      for ( const k of Object.keys(q.criteria) ) assert.match(k, /^[a-z0-9_]+$/, `${name}: option key ${k}`);
    }
    if ( q.type === "score" ) assert.ok(q.criteria.length >= 1 && q.criteria.length <= 10, `${name}: levels`);
    if ( q.type === "noul" && q.criteria ) assert.ok(q.criteria.true && q.criteria.false, `${name}: noul criteria`);
  }
  // State paths named in instructions/criteria exist (`targets.x`, `fronts.x`, `candidates.x`, `options.x`...).
  const text = JSON.stringify(request.questions);
  for ( const m of text.matchAll(/`([a-z_]+(?:\.[a-z0-9_]+)*)`/g) ) {
    let node = request.state;
    for ( const part of m[1].split(".") ) {
      assert.ok(node && Object.hasOwn(node, part), `state path ${m[1]} missing`);
      node = node[part];
    }
  }
}

/** A neutral answer for a question. */
function neutral(q) {
  if ( q.type === "noul" ) return { type: "noul", noul: 0.5 };
  if ( q.type === "choice" ) {
    const keys = Object.keys(q.criteria);
    return { type: "choice", choice: keys[0], confidence: 0, probabilities: Object.fromEntries(keys.map(k => [k, 1 / keys.length])) };
  }
  const n = q.criteria.length;
  return { type: "score", score: (n - 1) / 2, confidence: 0, probabilities: Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), 1 / n])) };
}

/** Turn a canned value into an answer: number → Noul, {level} → Score, {choice} or {probs} → Choice. */
function canned(value, q) {
  if ( value === undefined || value === null ) return neutral(q);
  if ( typeof value === "number" ) return { type: "noul", noul: value };
  if ( value.level !== undefined ) {
    const n = q.criteria.length;
    const probs = Object.fromEntries(Array.from({ length: n }, (_, i) => [String(i), i === value.level ? 1 : 0]));
    return { type: "score", score: value.level, confidence: 1, probabilities: probs };
  }
  if ( value.choice !== undefined || value.probs ) {
    const keys = Object.keys(q.criteria);
    const probs = value.probs ?? Object.fromEntries(keys.map(k => [k, k === value.choice ? 1 : 0]));
    const full = Object.fromEntries(keys.map(k => [k, probs[k] ?? 0]));
    const choice = keys.reduce((a, b) => (full[b] > full[a] ? b : a), keys[0]);
    return { type: "choice", choice, confidence: 1, probabilities: full };
  }
  return value;
}

/**
 * A fake ctx.ask. `answers`: {questionName | "prefix*": canned} or a function (name, question, purpose) → canned.
 * Every request is shape-checked and recorded in `ask.calls`.
 */
export function fakeAsk(answers = {}) {
  const calls = [];
  const ask = async (purpose, request) => {
    checkRequest(request);
    calls.push({ purpose, request: structuredClone(request) });
    const out = {};
    for ( const [name, q] of Object.entries(request.questions) ) {
      let v;
      if ( typeof answers === "function" ) v = answers(name, q, purpose);
      else {
        v = answers[name];
        if ( v === undefined ) {
          const prefix = Object.keys(answers).find(k => k.endsWith("*") && name.startsWith(k.slice(0, -1)));
          if ( prefix ) v = answers[prefix];
        }
      }
      out[name] = canned(v, q);
    }
    return { answers: out, model: "fake", usage: { input_tokens: Math.round(JSON.stringify(request).length / 4), output_tokens: 1 } };
  };
  ask.calls = calls;
  return ask;
}

/** Run one call of a situation file. */
export async function runCall(brain, name, index = 0, opts = {}) {
  const { readSituation, makeContext, resolveArgs } = await import("../../../../tools/fixtures/bots/build.mjs");
  const spec = readSituation(name);
  const call = { ...spec.calls[index], ...(opts.callOverride ?? {}) };
  const ctx = makeContext(spec, { ...opts, call });
  if ( opts.situation ) ctx.situation = opts.situation;
  const args = resolveArgs(ctx, call.args ?? {});
  const out = await brain[call.fn](ctx, args);
  return { ctx, args, out, call, spec };
}
