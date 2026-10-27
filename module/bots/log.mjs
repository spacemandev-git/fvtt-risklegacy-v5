/**
 * The bots' decision log, kept in memory on the active GM's client (it is a debugging and narration aid, not game
 * state). Every record carries the exact request payloads and answers that fed the decision (Jev exchanges in `jev`,
 * chat-model exchanges in `llm`), so any decision can be replayed against the API. Fires
 * `risklegacy.botDecision(record)` for each new record.
 *
 * @typedef {object} JevExchange
 * @property {string} purpose        what the request was for, e.g. "attack.targets"
 * @property {object} request        the exact body sent to /v1/systemone
 * @property {object|null} response  the API response ({model, answers, usage}), null on error
 * @property {number} ms
 * @property {string} [error]
 *
 * @typedef {object} LLMExchange    one chat-model attempt (llm/client.mjs askLLM, BOTS-LLM.md §4.2)
 * @property {"llm"} engine
 * @property {string} purpose
 * @property {number} attempt
 * @property {{model, messages, schema, reasoning, max_tokens, temperature}} request
 * @property {{content, parsed, reasoning, usage, cost, finish, model}|null} response   null when no answer came back
 * @property {number} ms
 * @property {string} [error]
 * @property {string} [code]
 *
 * @typedef {object} DecisionRecord
 * @property {string} id
 * @property {number} time
 * @property {string} faction        faction actor id
 * @property {string} factionName
 * @property {string} difficulty     easy | normal | hard
 * @property {string} kind           decision kind, e.g. "attack", "placement", "missile" (BOTS.md §5)
 * @property {object} decision       what the brain returned (includes `why`)
 * @property {"jev"|"llm"} engine
 * @property {string|null} model     chat bots: the model used
 * @property {string|null} personality  chat bots: the personality id
 * @property {JevExchange[]} jev
 * @property {LLMExchange[]} llm
 * @property {string|null} say       chat bots: the table-talk line of this decision
 * @property {number} cost           chat bots: US$ of this decision's exchanges
 * @property {number} ms             how long the decision took
 * @property {boolean} heuristic     true when the engine was unavailable and built-in judgments were used
 * @property {string} [error]
 */

const LIMIT = 500;
const records = [];

/** Running totals since the last clearLog() (the record list itself keeps only the newest LIMIT). */
const freshTotals = () => ({
  decisions: 0, requests: 0, inputTokens: 0, outputTokens: 0, ms: 0, errors: 0, heuristic: 0, kinds: {},
  cost: 0, llmRequests: 0, jevRequests: 0
});
let totals = freshTotals();

function count(record) {
  totals.decisions += 1;
  if ( record.heuristic ) totals.heuristic += 1;
  totals.kinds[record.kind] = (totals.kinds[record.kind] ?? 0) + 1;
  for ( const x of record.jev ?? [] ) {
    totals.requests += 1;
    totals.jevRequests += 1;
    totals.ms += x.ms ?? 0;
    totals.inputTokens += x.response?.usage?.input_tokens ?? 0;
    totals.outputTokens += x.response?.usage?.output_tokens ?? 0;
    if ( x.error ) totals.errors += 1;
  }
  // Chat-model exchanges: one per attempt (spend-cap refusals never reached the API and aren't requests).
  for ( const x of record.llm ?? [] ) {
    if ( !x.attempt && !x.response ) {
      if ( x.error ) totals.errors += 1;
      continue;
    }
    totals.requests += 1;
    totals.llmRequests += 1;
    totals.ms += x.ms ?? 0;
    totals.inputTokens += x.response?.usage?.prompt_tokens ?? 0;
    totals.outputTokens += x.response?.usage?.completion_tokens ?? 0;
    totals.cost += Number(x.response?.cost) || 0;
    if ( x.error ) totals.errors += 1;
  }
}

/** @param {Omit<DecisionRecord, "id"|"time">} data */
export function addRecord(data) {
  const record = { id: foundry.utils.randomID(), time: Date.now(), heuristic: false, jev: [], llm: [], ...data };
  records.push(record);
  if ( records.length > LIMIT ) records.splice(0, records.length - LIMIT);
  count(record);
  Hooks.callAll("risklegacy.botDecision", record);
  return record;
}

/** Newest first. */
export function getLog({ faction, kind, limit = 100 } = {}) {
  const out = [];
  for ( let i = records.length - 1; (i >= 0) && (out.length < limit); i-- ) {
    const r = records[i];
    if ( faction && (r.faction !== faction) ) continue;
    if ( kind && (r.kind !== kind) ) continue;
    out.push(r);
  }
  return out;
}

export function clearLog() {
  records.length = 0;
  totals = freshTotals();
}

/**
 * Totals since the last clearLog() (not limited to the records still kept), for the log viewer and tests. `requests`,
 * `inputTokens`, `outputTokens` and `avgMs` cover both engines; `cost` (US$) and `llmRequests` are the chat models'.
 * @returns {{decisions:number, requests:number, jevRequests:number, llmRequests:number, inputTokens:number,
 *   outputTokens:number, avgMs:number, errors:number, heuristic:number, cost:number, kept:number,
 *   kinds:Record<string, number>}}
 */
export function logStats() {
  const { ms, kinds, ...rest } = totals;
  return {
    ...rest, cost: Math.round(rest.cost * 1e6) / 1e6, avgMs: rest.requests ? Math.round(ms / rest.requests) : 0,
    kept: records.length, kinds: { ...kinds }
  };
}
