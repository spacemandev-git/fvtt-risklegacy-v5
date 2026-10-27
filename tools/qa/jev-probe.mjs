#!/usr/bin/env node
/**
 * Live probe of the bots' brain against the real Jev API (owner: bots-brain; BOTS.md §8).
 *
 * Runs brain decisions on the fixture situations in tools/fixtures/bots/*.json and prints every exact request's
 * answers (Noul, Choice probabilities, Score level probabilities), the resulting decision and its `why`, and the
 * token totals. Calls https://api.typesafe.ai/v1/systemone directly from Node (no relay needed outside a browser).
 *
 *   node tools/qa/jev-probe.mjs                         every situation, at the difficulty in its file
 *   node tools/qa/jev-probe.mjs leader-one-star --difficulty hard
 *   node tools/qa/jev-probe.mjs --state                 also print each request's state
 *   node tools/qa/jev-probe.mjs --experiment value-odds compare wordings / states (see EXPERIMENTS)
 *   node tools/qa/jev-probe.mjs --dry                   no network: print requests only
 *
 * The API key is read from ~/.config/risklegacy/typesafe-key (or $TYPESAFE_API_KEY) and is never printed.
 * Only fixture game states are sent (no player names).
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
const imp = rel => import(pathToFileURL(path.join(ROOT, rel)).href);
const brain = await imp("module/bots/brain/index.mjs");
const fixtures = await imp("tools/fixtures/bots/build.mjs");
const { clearTurnMemos } = await imp("module/bots/brain/util.mjs");
const { clearStakes } = await imp("module/bots/brain/decide/battle.mjs");
const Q = await imp("module/bots/jev/questions.mjs");
const C = await imp("module/bots/brain/context.mjs");
const cand = await imp("module/bots/brain/candidates.mjs");
const feat = await imp("module/bots/brain/features.mjs");
const prof = await imp("module/bots/brain/profiles.mjs");

const API = "https://api.typesafe.ai/v1/systemone";
const PRICE_PER_MILLION = 0.042;

/* -------------------------------------------- */
/*  Arguments                                   */
/* -------------------------------------------- */

const argv = process.argv.slice(2);
const flag = name => argv.includes(`--${name}`);
const option = (name, fallback = null) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : fallback;
};
const optionValues = new Set(["difficulty", "seed", "model", "experiment"].map(n => option(n)).filter(Boolean));
const names = argv.filter(a => !a.startsWith("--") && !optionValues.has(a));
const MODEL = option("model", "jev-latest");
const DRY = flag("dry");
const SHOW_STATE = flag("state");
const SEED = Number(option("seed", 7));

/* -------------------------------------------- */
/*  Transport                                   */
/* -------------------------------------------- */

function readKey() {
  if ( process.env.TYPESAFE_API_KEY ) return process.env.TYPESAFE_API_KEY.trim();
  const file = path.join(os.homedir(), ".config/risklegacy/typesafe-key");
  return fs.readFileSync(file, "utf8").trim();
}
const KEY = DRY ? null : readKey();
const totals = { requests: 0, input: 0, output: 0, ms: 0 };

/** One request to Jev. Errors throw (never become answers). */
async function systemOne(request) {
  if ( DRY ) return { answers: {}, model: "dry", usage: { input_tokens: 0, output_tokens: 0 } };
  for ( let attempt = 0; ; attempt++ ) {
    const t0 = performance.now();
    const res = await fetch(API, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${KEY}` },
      body: JSON.stringify({ model: MODEL, ...request }),
      signal: AbortSignal.timeout(20000)
    });
    const ms = performance.now() - t0;
    if ( (res.status === 429 || res.status >= 500) && attempt < 2 ) {
      await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
      continue;
    }
    const body = await res.json().catch(() => null);
    if ( !res.ok ) throw new Error(`Jev ${res.status}: ${JSON.stringify(body?.detail ?? body).slice(0, 400)}`);
    totals.requests++;
    totals.input += body.usage?.input_tokens ?? 0;
    totals.output += body.usage?.output_tokens ?? 0;
    totals.ms += ms;
    for ( const name of Object.keys(request.questions) ) {
      if ( !body.answers?.[name] ) throw new Error(`Jev answer missing for ${name}`);
    }
    return { ...body, ms };
  }
}

/* -------------------------------------------- */
/*  Printing                                    */
/* -------------------------------------------- */

const pct = x => `${Math.round((Number(x) || 0) * 100)}`.padStart(3);
function answerLine(name, q, a) {
  if ( !a ) return `    ${name}: (no answer)`;
  if ( a.type === "noul" ) return `    ${name}: noul ${a.noul.toFixed(3)}`;
  if ( a.type === "choice" ) {
    const ps = Object.entries(a.probabilities ?? {}).sort((x, y) => y[1] - x[1]).map(([k, p]) => `${k} ${pct(p)}%`).join(" | ");
    return `    ${name}: choice ${a.choice}  [${ps}]`;
  }
  if ( a.type === "score" ) {
    const n = Array.isArray(q?.criteria) ? q.criteria.length : Object.keys(a.probabilities ?? {}).length;
    const ps = Array.from({ length: n }, (_, i) => pct(a.probabilities?.[String(i)] ?? 0)).join(" ");
    return `    ${name}: score ${Number(a.score).toFixed(2)}  [${ps}]%`;
  }
  return `    ${name}: ${JSON.stringify(a)}`;
}

function printExchange(purpose, request, response) {
  const tokens = response?.usage?.input_tokens ?? 0;
  console.log(`  ↳ request "${purpose}": ${Object.keys(request.questions).length} questions, ${tokens} input tokens, ${Math.round(response?.ms ?? 0)} ms`);
  if ( SHOW_STATE ) console.log(JSON.stringify(request.state, null, 1).split("\n").map(l => `      ${l}`).join("\n"));
  for ( const [name, q] of Object.entries(request.questions) ) console.log(answerLine(name, q, response?.answers?.[name]));
}

/* -------------------------------------------- */
/*  Decisions on fixtures                       */
/* -------------------------------------------- */

async function runSituation(name, difficulty) {
  const spec = fixtures.readSituation(name);
  const diff = difficulty ?? spec.difficulty;
  clearTurnMemos();
  clearStakes();
  console.log(`\n=== ${name} (${diff}) — ${spec.description}`);
  let situation = null;
  for ( const call of spec.calls ) {
    const ask = async (purpose, request) => {
      const response = await systemOne(request);
      printExchange(purpose, request, response);
      return response;
    };
    const ctx = fixtures.makeContext(spec, { call, ask, seed: SEED, difficulty: diff });
    if ( situation ) ctx.situation = situation;
    const args = fixtures.resolveArgs(ctx, call.args ?? {});
    const t0 = performance.now();
    console.log(`- ${call.fn}`);
    const out = await brain[call.fn](ctx, args);
    if ( call.fn === "assessSituation" ) situation = out;
    const shown = { ...out };
    delete shown.leaderProbs;
    delete shown.stars;
    console.log(`  → ${JSON.stringify(shown)}  (${Math.round(performance.now() - t0)} ms incl. requests)`);
  }
}

/* -------------------------------------------- */
/*  Wording experiments (same state, variants)  */
/* -------------------------------------------- */

/** Target-value requests for a situation's candidate plans, built with the brain's own builders. */
function valueSetup(name, difficulty) {
  const spec = fixtures.readSituation(name);
  const ctx = fixtures.makeContext(spec, { difficulty: difficulty ?? spec.difficulty, call: { phase: "attack" } });
  const profile = prof.profileOf(ctx);
  const plans = cand.movePlans(ctx, profile, {});
  const seen = new Set();
  const top = plans.filter(p => (seen.has(p.end) ? false : seen.add(p.end))).slice(0, 6);
  const list = feat.standings(ctx);
  return { ctx, profile, top, list, spec };
}

const EXPERIMENTS = {
  /** Value levels: the current top two levels vs a version that says what separates "big swing" from "decides". */
  async "value-levels"(sit = ["hq-win-vs-continent", "leader-one-star", "continent-vs-card", "knockout-cards", "early-expansion"]) {
    const alt = Q.VALUE_LEVELS.map(l => l.text);
    alt[3] = "A big swing in the Red Star race, but nobody wins yet: a Red Star changes hands or a faction is knocked out.";
    alt[4] = "It decides the war: the faction reaches 4 Red Stars now, or a rival one Red Star from winning loses a Red Star.";
    for ( const name of [].concat(sit) ) {
      const { ctx, top, list } = valueSetup(name);
      const me = ctx.view.factionNames[ctx.me];
      const targets = Object.fromEntries(top.map(p => [p.end, C.targetFacts(ctx, p, list)]));
      const cur = Q.targetValueQuestions({ me, keys: top.map(p => p.end) });
      const questions = { ...cur };
      for ( const p of top ) questions[`alt_${p.end}`] = { ...cur[`value_${p.end}`], criteria: alt };
      const state = { you: { faction: me }, factions: C.factionsBlock(ctx, list, C.factionKeys(ctx, list), "standings"), rules: C.PRIMER.cards, targets };
      const res = await systemOne({ state, questions });
      console.log(`\n=== value-levels: ${name}`);
      for ( const p of top ) {
        const a = res.answers[`value_${p.end}`];
        const b = res.answers[`alt_${p.end}`];
        console.log(`   ${p.end.padEnd(22)} ${cand.tagsOf(p.endFx).padEnd(28)} code=${cand.codeValueLevel(ctx, p.endFx).toFixed(1)}  current ${a.score.toFixed(2)}  alt ${b.score.toFixed(2)}`);
      }
    }
  },

  /** Battle stakes: instruction wording, and stating what the outcome means for the asking faction. */
  async stakes(sit = ["bystander-missile", "missile-decisive", "missile-trivial"]) {
    for ( const name of [].concat(sit) ) {
      const spec = fixtures.readSituation(name);
      const ctx = fixtures.makeContext(spec);
      const battle = spec.calls[0].args.battle;
      const fx = feat.takeEffects(ctx, battle.from, battle.to, { who: battle.attacker });
      const list = feat.standings(ctx);
      const me = ctx.view.factionNames[ctx.me];
      const facts = C.battleFacts(ctx, battle, fx, list);
      const consequence = [];
      if ( fx.winNow && battle.attacker !== ctx.me ) consequence.push(`${me} loses the war if the attacker takes it`);
      if ( fx.hq === ctx.me && battle.defender === ctx.me ) consequence.push(`${me} loses its HQ (a Red Star) if the attacker takes it`);
      const variants = {
        a_matter: { type: "score", instructions: `How much does the outcome of \`battle\` matter for ${me}'s chance of winning the war?`, criteria: Q.STAKES_LEVELS.map(l => l.text) },
        b_at_stake: { type: "score", instructions: `How much is at stake for ${me} in \`battle\`?`, criteria: Q.STAKES_LEVELS.map(l => l.text) }
      };
      for ( const [label, state] of [["facts", { how_to_win: C.PRIMER.stars, battle: facts }],
        ["facts + consequence for the asker", { how_to_win: C.PRIMER.stars, battle: { ...facts, ...(consequence.length ? { what_it_means_for_the_asker: consequence } : {}) } }]] ) {
        const res = await systemOne({ state, questions: variants });
        console.log(`\n=== stakes: ${name} [${label}]`);
        for ( const [n, q] of Object.entries(variants) ) console.log(answerLine(n, q, res.answers[n]));
      }
    }
  },

  /** Join the War: start-score wording and how enemy proximity is stated. */
  async join(sit = ["join-the-war"]) {
    for ( const name of [].concat(sit) ) {
      const spec = fixtures.readSituation(name);
      const ctx = fixtures.makeContext(spec);
      const legal = (await imp("module/rules/_module.mjs")).legalStartingTerritories(ctx.state, ctx.me, { joining: true });
      const all = cand.startCandidates(ctx, legal, true);
      const cands = [...all.slice(0, 6), ...all.filter(c => c.facts.weakHq).slice(0, 2)];
      const me = ctx.view.factionNames[ctx.me];
      const facts = c => C.startFacts(ctx, c, true);
      const nearest = c => {
        const f = { ...facts(c) };
        delete f.enemy_troops_within_2_steps;
        const near = Object.values(ctx.state.territories).filter(t => t.owner && t.owner !== ctx.me);
        const d = feat.distancesFrom(ctx.state, c.id);
        const n = near.filter(t => (d[t.id] ?? 9) <= 2).sort((a, b) => b.troops - a.troops)[0];
        f.strongest_enemy_stack_within_2_steps = n ? `${n.troops} ${ctx.view.factionNames[n.owner]} troops in ${n.name}, ${d[n.id]} step${d[n.id] > 1 ? "s" : ""} away` : "none";
        return f;
      };
      const base = { rules: C.PRIMER.start, you: { faction: me, situation: "knocked out: rejoins the war with 4 troops and no HQ" } };
      for ( const [label, build, q] of [
        ["current", facts, k => Q.startQuestions({ me, keys: k, joining: true })],
        ["stack named", nearest, k => Q.startQuestions({ me, keys: k, joining: true })],
        ["stack named, no '4 troops' in question", nearest, k => Object.fromEntries(Object.entries(Q.startQuestions({ me, keys: k, joining: true }))
          .map(([n, x]) => [n, { ...x, instructions: x.instructions.replace(" with 4 troops", "") }]))]
      ] ) {
        const keys = cands.map(c => c.id);
        const req = { state: { ...base, candidates: Object.fromEntries(cands.map(c => [c.id, build(c)])) }, questions: q(keys) };
        const res = await systemOne(req);
        console.log(`\n=== join [${label}]`);
        for ( const c of cands ) console.log(`   ${c.id.padEnd(20)} pre=${c.pre.toFixed(1).padStart(5)}  ${answerLine("", req.questions[`start_${c.id}`], res.answers[`start_${c.id}`]).trim()}`);
      }
    }
  },

  /** Does stating the odds in `targets` drag the value judgment (which should ignore odds; code multiplies by P)? */
  async "value-odds"(sit = ["hq-win-vs-continent", "leader-one-star", "continent-vs-card"]) {
    for ( const name of [].concat(sit) ) {
      const { ctx, top, list } = valueSetup(name);
      const withOdds = Object.fromEntries(top.map(p => [p.end, C.targetFacts(ctx, p, list)]));
      const noOdds = Object.fromEntries(top.map(p => {
        const f = { ...C.targetFacts(ctx, p, list) };
        delete f.chance_to_take; delete f.expected_losses;
        return [p.end, f];
      }));
      const me = ctx.view.factionNames[ctx.me];
      const qs = Q.targetValueQuestions({ me, keys: top.map(p => p.end) });
      const base = { you: { faction: me }, factions: C.factionsBlock(ctx, list, C.factionKeys(ctx, list), "standings"), rules: C.PRIMER.cards };
      console.log(`\n=== value-odds: ${name}`);
      for ( const [label, targets] of [["with odds", withOdds], ["without odds", noOdds]] ) {
        const req = { state: { ...base, targets }, questions: qs };
        const res = await systemOne(req);
        console.log(` [${label}]`);
        for ( const p of top ) {
          console.log(`   ${p.end.padEnd(22)} P=${pct(p.P)}%  code=${cand.codeValueLevel(ctx, p.endFx).toFixed(1)}  ${answerLine("", qs[`value_${p.end}`], res.answers[`value_${p.end}`]).trim()}`);
        }
      }
    }
  },

  /** Leader Choice: option order sensitivity, and criteria with/without the state path. */
  async "leader-order"(sit = ["leader-one-star", "hq-win-vs-continent", "red-star-vs-troops"]) {
    for ( const name of [].concat(sit) ) {
      const spec = fixtures.readSituation(name);
      const ctx = fixtures.makeContext(spec);
      const list = feat.standings(ctx);
      const keys = C.factionKeys(ctx, list);
      const state = { how_to_win: C.PRIMER.stars, factions: C.factionsBlock(ctx, list, keys, "full") };
      const fs1 = list.map(s => ({ key: keys[s.id], name: s.name }));
      const base = Q.situationQuestions({ me: ctx.view.factionNames[ctx.me], factions: fs1, hasHq: false, reversed: true });
      const plain = {
        type: "choice", instructions: "Which faction is most likely to win this war?",
        criteria: Object.fromEntries(fs1.map(f => [f.key, f.name]))
      };
      const questions = { ...base, plain, plain_reversed: { ...plain, criteria: Object.fromEntries([...fs1].reverse().map(f => [f.key, f.name])) } };
      const res = await systemOne({ state, questions });
      console.log(`\n=== leader-order: ${name}  (code closeness: ${list.map(s => `${s.name} ${s.closeness.toFixed(2)}`).join(", ")})`);
      for ( const [n, q] of Object.entries(questions) ) console.log(answerLine(n, q, res.answers[n]));
    }
  },

  /** HQ danger: Score vs the code capture chance across situations. */
  async "hq-danger"(sit = ["hq-under-threat", "leader-one-star", "placement-exposure", "red-star-vs-troops", "hq-win-vs-continent"]) {
    for ( const name of [].concat(sit) ) {
      const spec = fixtures.readSituation(name);
      const ctx = fixtures.makeContext(spec);
      const d = feat.hqDanger(ctx, ctx.me).sort((a, b) => b.worst - a.worst)[0];
      if ( !d ) continue;
      const list = feat.standings(ctx);
      const keys = C.factionKeys(ctx, list);
      const state = { how_to_win: C.PRIMER.stars, factions: C.factionsBlock(ctx, list, keys, "standings"), your_hq: C.hqBlock(ctx, d) };
      const questions = Q.situationQuestions({
        me: ctx.view.factionNames[ctx.me], factions: list.map(s => ({ key: keys[s.id], name: s.name })),
        threatKeys: d.threats.slice(0, 3).map(t => ({ key: keys[t.faction], name: ctx.view.factionNames[t.faction] })), hasHq: true
      });
      const res = await systemOne({ state, questions });
      console.log(`\n=== hq-danger: ${name} (worst code capture chance ${pct(d.worst)}%)`);
      for ( const [n, q] of Object.entries(questions) ) if ( n !== "leader" ) console.log(answerLine(n, q, res.answers[n]));
    }
  }
};

/* -------------------------------------------- */
/*  Main                                        */
/* -------------------------------------------- */

const experiment = option("experiment");
try {
  if ( experiment ) {
    if ( !EXPERIMENTS[experiment] ) throw new Error(`unknown experiment ${experiment}: ${Object.keys(EXPERIMENTS).join(", ")}`);
    await EXPERIMENTS[experiment](names.length ? names : undefined);
  }
  else {
    const list = names.length ? names : fixtures.situationNames();
    for ( const name of list ) await runSituation(name, option("difficulty"));
  }
}
finally {
  const cost = (totals.input / 1e6) * PRICE_PER_MILLION;
  console.log(`\nTotals: ${totals.requests} requests, ${totals.input} input tokens, ${totals.output} output tokens, ` +
    `avg ${totals.requests ? Math.round(totals.ms / totals.requests) : 0} ms, ≈ $${cost.toFixed(5)}`);
  const log = path.join(os.tmpdir(), "rl-jev-probe-tokens.log");
  fs.appendFileSync(log, `${new Date().toISOString()} ${argv.join(" ")} requests=${totals.requests} input=${totals.input} output=${totals.output}\n`);
}
