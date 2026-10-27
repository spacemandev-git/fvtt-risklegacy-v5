/**
 * Asking Jev and reading its answers. `ask()` never catches: a failed call (JevError) propagates to the driver, which
 * applies the bots.onError policy (BOTS.md §4.3). In heuristic mode (`ctx.ask === null`) it returns null and every
 * reader falls back to the code judgment it is given.
 */
import { assertQuestions } from "../jev/questions.mjs";
import { argmax, sampleIndex } from "./util.mjs";

/**
 * Send one request. Returns the answers object, or null in heuristic mode.
 * @param {object} ctx        BotContext
 * @param {string} purpose    log label ("situation", "attack values"…)
 * @param {object} state      Jev state
 * @param {object} questions  {name: question} from module/bots/jev/questions.mjs
 */
export async function ask(ctx, purpose, state, questions) {
  if ( typeof ctx.ask !== "function" ) return null;
  assertQuestions(questions);
  const res = await ctx.ask(purpose, { state, questions });
  return res?.answers ?? {};
}

/** Noul probability, or `fallback`. */
export function noulOf(answers, name, fallback) {
  const a = answers?.[name];
  return (a && (typeof a.noul === "number")) ? a.noul : fallback;
}

/**
 * A Score answer as {expected, level, probs}; `fallback` (a level, may be fractional) when absent.
 * @param {number} levels  number of levels the question had
 */
export function scoreOf(answers, name, levels, fallback) {
  const a = answers?.[name];
  if ( !a || (a.type && a.type !== "score") ) {
    const lv = Math.max(0, Math.min(levels - 1, Number(fallback) || 0));
    return { expected: lv, level: Math.round(lv), probs: null, fromJev: false };
  }
  const probs = Array.from({ length: levels }, (_, i) => Number(a.probabilities?.[String(i)] ?? 0));
  const total = probs.reduce((x, y) => x + y, 0);
  const expected = total > 0 ? probs.reduce((s, p, i) => s + (p * i), 0) / total
    : Math.max(0, Math.min(levels - 1, Number(a.score) || 0));
  return { expected, level: total > 0 ? argmax(probs) : Math.round(expected), probs: total > 0 ? probs.map(p => p / total) : null, fromJev: true };
}

/**
 * A Score's level as the bot reads it: sampled with the temperature for the easy bot, else the expected position.
 * @returns {number} level (fractional when not sampled)
 */
export function readScore(score, profile, random) {
  if ( profile.temperature > 0 && score.probs ) return sampleIndex(score.probs, profile.temperature, random);
  return score.expected;
}

/**
 * Choice probabilities over `keys`, averaging a reversed-order copy (`name_reversed`) when present.
 * @returns {Record<string, number>|null}
 */
export function choiceProbs(answers, name, keys) {
  const a = answers?.[name];
  if ( !a?.probabilities ) return null;
  const b = answers?.[`${name}_reversed`];
  const out = {};
  for ( const k of keys ) {
    const p1 = Number(a.probabilities[k] ?? 0);
    out[k] = b?.probabilities ? (p1 + Number(b.probabilities[k] ?? 0)) / 2 : p1;
  }
  const total = Object.values(out).reduce((x, y) => x + y, 0);
  if ( total > 0 ) for ( const k of keys ) out[k] /= total;
  return out;
}

/** Pick a key from Choice probabilities: sampled (temperature) or argmax. */
export function pickChoice(probs, keys, profile, random) {
  const ws = keys.map(k => probs?.[k] ?? 0);
  if ( profile.temperature > 0 ) return keys[sampleIndex(ws, profile.temperature, random)];
  return keys[argmax(ws)];
}
