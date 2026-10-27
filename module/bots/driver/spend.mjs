/**
 * Chat-model spending per war (BOTS-LLM.md §7): every response's `usage.cost` is added to the world setting
 * `bots.llmSpent = {war, usd, calls}` (reset when the war id changes), and a chat call is refused with
 * `LLMError {code: "spend_limit"}` once the spend reaches `bots.llmSpendLimit` (0 = no cap). The driver's error
 * dialog then lets the GM pause, use built-in judgment, or raise the cap and Retry.
 *
 * Writes are serialized (one world-setting update at a time); amounts not yet written are counted in memory, so the
 * cap holds while several decisions run at once.
 */
import { LLMError } from "../llm/client.mjs";
import { SETTINGS, getSetting, setSetting } from "../settings.mjs";
import { getWar } from "./util.mjs";

let pendingUsd = 0;
let pendingCalls = 0;
let chain = Promise.resolve();

const round = n => Math.round((Number(n) || 0) * 1e6) / 1e6;
const read = key => {
  try {
    return getSetting(key);
  } catch(err) {
    return undefined;
  }
};
const warId = () => getWar()?.id ?? "";

/**
 * This war's chat-model spend so far, and the cap.
 * @returns {{war: string, usd: number, calls: number, limit: number}}
 */
export function llmSpend() {
  const war = warId();
  const saved = read(SETTINGS.llmSpent) ?? {};
  const same = saved.war === war;
  return {
    war,
    usd: round((same ? Number(saved.usd) || 0 : 0) + pendingUsd),
    calls: (same ? Number(saved.calls) || 0 : 0) + pendingCalls,
    limit: Math.max(0, Number(read(SETTINGS.llmSpendLimit)) || 0)
  };
}

/** Throws LLMError {code: "spend_limit"} when this war's spend has reached the cap. */
export function checkSpend(purpose = "") {
  const s = llmSpend();
  if ( (s.limit > 0) && (s.usd >= s.limit) ) {
    throw new LLMError(`Chat-model spending for this war reached the cap: $${s.usd.toFixed(4)} of $${s.limit.toFixed(2)}.`,
      { code: "spend_limit", retryable: false, purpose, detail: { usd: s.usd, limit: s.limit, calls: s.calls } });
  }
}

/**
 * Add the cost of some exchanges (the driver's record.llm entries) to this war's spend.
 * @param {object[]} exchanges
 * @returns {Promise<void>} resolves once written
 */
export function addSpendFrom(exchanges = []) {
  const billed = exchanges.filter(x => x?.response);
  const usd = billed.reduce((sum, x) => sum + (Number(x.response.cost) || 0), 0);
  return addSpend(usd, billed.length);
}

/** @returns {Promise<void>} */
export function addSpend(usd, calls = 1) {
  usd = Number(usd) || 0;
  calls = Number(calls) || 0;
  if ( !usd && !calls ) return chain;
  pendingUsd += usd;
  pendingCalls += calls;
  chain = chain.then(async () => {
    if ( !game.user?.isGM ) return;
    const war = warId();
    const saved = read(SETTINGS.llmSpent) ?? {};
    const base = saved.war === war ? saved : { war, usd: 0, calls: 0 };
    const takeUsd = pendingUsd;
    const takeCalls = pendingCalls;
    await setSetting(SETTINGS.llmSpent, { war, usd: round((Number(base.usd) || 0) + takeUsd), calls: (Number(base.calls) || 0) + takeCalls });
    pendingUsd -= takeUsd;
    pendingCalls -= takeCalls;
  }).catch(err => console.warn("risklegacy | bots: could not record chat-model spend", err));
  return chain;
}

/** [GM] Forget this war's spend (tests, or the GM starting over). */
export async function resetSpend() {
  await chain;
  pendingUsd = 0;
  pendingCalls = 0;
  if ( game.user?.isGM ) await setSetting(SETTINGS.llmSpent, { war: warId(), usd: 0, calls: 0 });
}
