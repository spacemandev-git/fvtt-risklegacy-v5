#!/usr/bin/env node
/**
 * Live probe of the chat-model brain (BOTS-LLM.md §6.4): runs fixtures through module/bots/llm/brain with the real
 * client (module/bots/llm/client.mjs createLLMClient, i.e. askLLM with its retries and bad-output correction) against
 * Nous Portal from Node. The key is read from ~/.config/risklegacy/nous-key inside this process and never printed or
 * written anywhere. Game states only, never player names (the fixtures have none).
 *
 *   node tools/qa/llm-probe.mjs --model z-ai/glm-5.3 --level hard --personality turtle --fixture leader-one-star:1
 *   node tools/qa/llm-probe.mjs --model deepseek/deepseek-v4-flash --level easy,normal,hard --turn
 *   node tools/qa/llm-probe.mjs --models all --levels all --set core --parallel 4
 *
 * Options:
 *   --model / --models   model id(s), comma-separated, or "all" (the four the brain was probed on)
 *   --level / --levels   easy, normal, hard (comma-separated) or "all"
 *   --personality        a shipped personality id (llm/personalities.mjs) or a test one (test_turtle...); default: rotate
 *   --fixture            name[:callIndex] list (Jev fixtures in tools/fixtures/bots/, LLM ones in .../llm/)
 *   --set                core | reactive | holdout (named fixture lists below)
 *   --turn               also play the full-turn fixture as one whole turn (calls and $ per turn)
 *   --turn-fixture       fixture for --turn (default full-turn)
 *   --parallel N         cases run at once (default 3)
 *   --max-usd X          stop when the cumulative probe spend (ledger) reaches X (default 4.5)
 *   --out DIR            where the run's JSON goes (default /tmp/rl-llm-probe)
 *   --show-prompts       print the user messages
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const imp = p => import(path.join(ROOT, p));
const brain = await imp("module/bots/llm/brain/index.mjs");
const { createLLMClient } = await imp("module/bots/llm/client.mjs");
const { PERSONALITIES } = await imp("module/bots/llm/personalities.mjs");
const H = await imp("module/bots/llm/brain/tests/helpers.mjs");

/* -------------------------------------------- */
/*  Arguments                                   */
/* -------------------------------------------- */

const argv = process.argv.slice(2);
const opt = (names, dflt = null) => {
  for ( const n of [].concat(names) ) {
    const i = argv.indexOf(`--${n}`);
    if ( i >= 0 ) return argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : true;
  }
  return dflt;
};
const ALL_MODELS = ["z-ai/glm-5.3", "z-ai/glm-5.3-flash:US", "deepseek/deepseek-v4-flash", "deepseek/deepseek-v4.1-flash:US"];
const SETS = {
  core: ["leader-one-star:1", "red-star-vs-troops:1", "hq-under-threat:1", "event-choice:0", "starting-territory:0", "join-the-war:0"],
  reactive: ["missile-choice:0", "bunker-choice:0", "campaign-reward:0", "debrief:0"],
  holdout: ["knockout-cards:1", "continent-vs-card:0", "placement-exposure:1", "control-the-people:0", "reward-choice:0", "early-expansion:0"]
};
const list = (v, all) => (v === "all" ? all : String(v).split(",").map(s => s.trim()).filter(Boolean));
const models = list(opt(["models", "model"], "z-ai/glm-5.3-flash:US"), ALL_MODELS);
const levels = list(opt(["levels", "level"], "normal"), ["easy", "normal", "hard"]);
let fixtures = [];
if ( opt("set") ) for ( const s of String(opt("set")).split(",") ) fixtures.push(...(SETS[s] ?? []));
if ( opt("fixture") ) fixtures.push(...String(opt("fixture")).split(","));
const doTurn = !!opt("turn");
if ( !fixtures.length && !doTurn ) fixtures = SETS.core;
const turnFixture = opt("turn-fixture", "full-turn");
const personalityArg = opt("personality", null);
const parallel = Math.max(1, Number(opt("parallel", 3)) || 3);
const maxUsd = Number(opt("max-usd", 4.5));
const outDir = opt("out", "/tmp/rl-llm-probe");
const showPrompts = !!opt("show-prompts");
fs.mkdirSync(outDir, { recursive: true });

/* -------------------------------------------- */
/*  Spend ledger and client                     */
/* -------------------------------------------- */

const LEDGER = path.join(outDir, "spend.json");
const ledger = fs.existsSync(LEDGER) ? JSON.parse(fs.readFileSync(LEDGER, "utf8")) : { total: 0, calls: 0, runs: [] };
let runCost = 0;
let runCalls = 0;
const addSpend = cost => {
  runCost += cost;
  runCalls += 1;
  ledger.total += cost;
  ledger.calls += 1;
};
const saveLedger = () => fs.writeFileSync(LEDGER, JSON.stringify(ledger, null, 1));

const KEY_FILE = path.join(os.homedir(), ".config/risklegacy/nous-key");
const apiKey = fs.readFileSync(KEY_FILE, "utf8").trim();
const client = createLLMClient({
  config: () => ({ baseUrl: "https://inference-api.nousresearch.com/v1", apiKey, model: "", timeoutMs: 150_000 })
});

class BudgetStop extends Error {}

/** ctx.chat for one model: the real askLLM, recording every exchange (failed attempts too). */
function chatFor(model, exchanges) {
  return async (purpose, request) => {
    if ( ledger.total >= maxUsd ) throw new BudgetStop(`probe budget reached ($${ledger.total.toFixed(3)} of $${maxUsd})`);
    const before = exchanges.length;
    try {
      return await client.askLLM({ ...request, model }, { purpose, exchanges });
    } finally {
      for ( const e of exchanges.slice(before) ) addSpend(Number(e.response?.cost) || 0);
    }
  };
}

/* -------------------------------------------- */
/*  Cases                                       */
/* -------------------------------------------- */

const personalities = [...PERSONALITIES, ...H.FIXTURE_PERSONALITIES];
const personalityById = id => personalities.find(p => p.id === id) ?? null;
let rotate = 0;
const pickPersonality = () => (personalityArg ? personalityById(personalityArg) : PERSONALITIES[(rotate++) % PERSONALITIES.length]);
if ( personalityArg && !personalityById(personalityArg) ) throw new Error(`unknown personality ${personalityArg}`);

function specOf(name) {
  const llmFile = path.join(H.LLM_FIXTURE_DIR, `${name}.json`);
  return fs.existsSync(llmFile) ? H.readLLMSituation(name) : H.readSituation(name);
}

const short = (v, n = 220) => {
  const s = typeof v === "string" ? v : JSON.stringify(v);
  return s && s.length > n ? `${s.slice(0, n - 1)}…` : s;
};
const usageOf = e => {
  const u = e.response?.usage ?? {};
  return {
    in: u.prompt_tokens ?? 0, out: u.completion_tokens ?? 0,
    reasoning: u.completion_tokens_details?.reasoning_tokens ?? u.reasoning_tokens ?? 0,
    cached: u.prompt_tokens_details?.cached_tokens ?? u.cache_read_input_tokens ?? 0
  };
};

/** Summary of a decision for the console (no ids beyond territory/faction ids). */
function brief(fn, out) {
  if ( !out ) return "null";
  const w = out.why ?? {};
  switch ( fn ) {
    case "nextMove": return out.type === "stop" ? `stop (${w.reason})` : `${out.type} ${out.from}→${out.to}${out.dice ? ` ${out.dice} dice` : ` ×${out.count}`} ${w.chance !== undefined ? `${Math.round(w.chance * 100)}%` : ""} (${w.reason})`;
    case "planPlacement": return out.placements.map(p => `${p.territory}+${p.count}`).join(", ") + ` (${w.reason})`;
    case "planStartOfTurn": return out.buyRedStars ? `buy ${out.buyRedStars.length / 4} Red Star(s)` : `hold (${w.label ?? w.reason})`;
    case "planRecruit": return out.join ? `join ${out.join}` : (out.tradeForTroops ? `trade for ${w.count}` : "recruit");
    case "missileDecision": return out.fire ? `FIRE ${out.side} die ${out.index + 1} (${w.reason})` : "hold";
    case "preRollScar": return `play ${out.cardId}`;
    case "chooseOption": return `${out.value} (${w.label})`;
    case "chooseStartingTerritory": return out.territory;
    case "debrief": return `notes: ${short(out.memory?.notes, 160)} | lessons: ${short(out.memory?.lessons, 120)} | grudges: ${short(out.memory?.grudges, 120)}`;
    default: return short(out, 160);
  }
}

const results = [];
let caseId = 0;
H.reset();

async function runDecision({ model, level, name, index }) {
  const spec = specOf(name);
  const call = spec.calls[index];
  const personality = pickPersonality();
  const exchanges = [];
  // No reset() here: cases run in parallel and share the module memos; a war id per case keeps them apart.
  const ctx = H.makeLLMContext(spec, { difficulty: level, personality, chat: chatFor(model, exchanges), call, warId: `probe-${++caseId}` });
  const args = H.resolveLLMArgs(ctx, call.args ?? {}, spec);
  const t0 = Date.now();
  let out = null;
  let error = null;
  try {
    out = await brain[call.fn](ctx, args);
  } catch(err) {
    if ( err instanceof BudgetStop ) throw err;
    error = `${err.code ?? err.name}: ${err.message}`;
  }
  return { kind: "decision", model, level, personality: personality.id, fixture: `${name}:${index}`, fn: call.fn, out, error, ms: Date.now() - t0, exchanges };
}

async function runTurn({ model, level }) {
  const spec = specOf(turnFixture);
  const personality = pickPersonality();
  const exchanges = [];
  const t0 = Date.now();
  let res = null;
  let error = null;
  try {
    res = await H.playTurn(brain, spec, { difficulty: level, personality, chat: chatFor(model, exchanges), warId: `probe-${++caseId}` });
  } catch(err) {
    if ( err instanceof BudgetStop ) throw err;
    error = `${err.code ?? err.name}: ${err.message}`;
  }
  const out = res ? res.log.filter(l => !["assessSituation"].includes(l.fn)).map(l => ({ fn: l.fn, brief: brief(l.fn, l.out), say: l.out?.say ?? "", thinking: l.out?.why?.thinking ?? "" })) : null;
  return { kind: "turn", model, level, personality: personality.id, fixture: turnFixture, fn: "turn", out, error, ms: Date.now() - t0, exchanges, conquests: res?.conquests ?? 0 };
}

function report(r) {
  const calls = r.exchanges.filter(e => !e.error || e.response);
  const cost = r.exchanges.reduce((n, e) => n + (Number(e.response?.cost) || 0), 0);
  const head = `\n== ${r.fixture} ${r.fn} | ${r.model} | ${r.level} | ${r.personality} | ${r.ms} ms | ${r.exchanges.length} exchange(s) | $${cost.toFixed(4)}`;
  console.log(head);
  if ( r.error ) console.log(`   ERROR ${r.error}`);
  for ( const e of r.exchanges ) {
    const u = usageOf(e);
    console.log(`   · ${e.purpose}${e.attempt > 1 ? ` (attempt ${e.attempt})` : ""}: ${e.ms} ms, in ${u.in}${u.cached ? ` (cached ${u.cached})` : ""}, out ${u.out}${u.reasoning ? ` (reasoning ${u.reasoning})` : ""}, $${(Number(e.response?.cost) || 0).toFixed(4)}${e.error ? ` ERROR ${e.code}: ${short(e.error, 160)}` : ""}`);
    if ( showPrompts ) console.log(e.request.messages.at(-1).content.split("\n").map(l => `      | ${l}`).join("\n"));
    if ( e.response?.parsed ) console.log(`     → ${short(e.response.parsed, 400)}`);
  }
  if ( r.kind === "turn" && r.out ) {
    for ( const d of r.out ) console.log(`   ${d.fn}: ${d.brief}${d.say ? `  «${d.say}»` : ""}`);
    console.log(`   conquests: ${r.conquests}`);
  }
  else if ( r.out !== undefined && !r.error ) {
    console.log(`   DECISION ${brief(r.fn, r.out)}`);
    const t = r.out?.why?.thinking;
    if ( t ) console.log(`   thinking: ${t}`);
    const say = r.out?.say;
    if ( say ) console.log(`   say (${say.length} chars): «${say}»`);
  }
  void calls;
}

/* -------------------------------------------- */
/*  Run                                         */
/* -------------------------------------------- */

const cases = [];
for ( const model of models ) {
  for ( const level of levels ) {
    for ( const f of fixtures ) {
      const [name, i] = f.split(":");
      cases.push({ kind: "decision", model, level, name, index: Number(i ?? 0) });
    }
    if ( doTurn ) cases.push({ kind: "turn", model, level });
  }
}

console.log(`llm-probe: ${cases.length} case(s), models ${models.join(", ")}, levels ${levels.join(", ")}; spend so far $${ledger.total.toFixed(4)} (cap $${maxUsd})`);
let next = 0;
let stopped = null;
async function worker() {
  while ( next < cases.length && !stopped ) {
    const c = cases[next++];
    try {
      const r = c.kind === "turn" ? await runTurn(c) : await runDecision(c);
      results.push(r);
      report(r);
    } catch(err) {
      if ( err instanceof BudgetStop ) stopped = err.message;
      else console.log(`\n!! ${c.kind} ${c.name ?? ""} ${c.model} ${c.level}: ${err.stack}`);
    }
    saveLedger();
  }
}
await Promise.all(Array.from({ length: parallel }, worker));

/* -------------------------------------------- */
/*  Totals                                      */
/* -------------------------------------------- */

console.log("\n== Totals per model × level ==");
const groups = new Map();
for ( const r of results ) {
  const k = `${r.model} | ${r.level}`;
  const g = groups.get(k) ?? { calls: 0, ms: 0, cost: 0, inTok: 0, outTok: 0, cached: 0, errors: 0, decisions: 0, turns: [] };
  for ( const e of r.exchanges ) {
    const u = usageOf(e);
    g.calls += 1;
    g.ms += e.ms ?? 0;
    g.cost += Number(e.response?.cost) || 0;
    g.inTok += u.in;
    g.outTok += u.out;
    g.cached += u.cached;
    if ( e.error ) g.errors += 1;
  }
  if ( r.kind === "turn" ) {
    g.turns.push({ calls: r.exchanges.length, ms: r.exchanges.reduce((n, e) => n + (e.ms ?? 0), 0), cost: r.exchanges.reduce((n, e) => n + (Number(e.response?.cost) || 0), 0), error: r.error });
  }
  else g.decisions += 1;
  if ( r.error ) g.errors += 0;
  groups.set(k, g);
}
for ( const [k, g] of groups ) {
  const turn = g.turns.length ? ` | turn: ${g.turns.map(t => `${t.calls} calls, ${(t.ms / 1000).toFixed(1)} s, $${t.cost.toFixed(4)}${t.error ? " ERROR" : ""}`).join("; ")}` : "";
  console.log(`${k}: ${g.calls} calls, avg ${g.calls ? Math.round(g.ms / g.calls) : 0} ms/call, in ${g.inTok} (cached ${g.cached}) / out ${g.outTok} tokens, $${g.cost.toFixed(4)}, failed attempts ${g.errors}${turn}`);
}
const failures = results.filter(r => r.error);
if ( failures.length ) console.log(`\nFailures: ${failures.map(r => `${r.fixture}/${r.model}/${r.level}: ${short(r.error, 140)}`).join("\n          ")}`);
if ( stopped ) console.log(`\nSTOPPED: ${stopped}`);
console.log(`\nThis run: ${runCalls} exchanges, $${runCost.toFixed(4)}. Probe total: ${ledger.calls} exchanges, $${ledger.total.toFixed(4)}.`);
ledger.runs.push({ at: new Date().toISOString(), argv: argv.join(" "), cost: runCost, calls: runCalls });
saveLedger();
const file = path.join(outDir, `run-${Date.now()}.json`);
fs.writeFileSync(file, JSON.stringify(results.map(r => ({ ...r, exchanges: r.exchanges.map(e => ({ ...e, request: { ...e.request, messages: e.request.messages.map(m => ({ role: m.role, chars: m.content.length, content: m.role === "system" ? undefined : m.content })) } })) })), null, 1));
console.log(`Saved ${file}`);
