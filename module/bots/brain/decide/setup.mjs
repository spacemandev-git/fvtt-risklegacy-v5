/**
 * Setup and prompts: starting territory (and Join the War), any multiple-choice prompt, names.
 */
import { JOIN_LEVELS, START_LEVELS, optionQuestions, startQuestions } from "../../jev/questions.mjs";
import { startCandidates } from "../candidates.mjs";
import { PRIMER, factionKeys, factionsBlock, optionFacts, startFacts } from "../context.mjs";
import { standings } from "../features.mjs";
import { ask, choiceProbs, pickChoice, readScore, scoreOf } from "../judge.mjs";
import { profileOf } from "../profiles.mjs";
import { NAMES } from "../names.mjs";
import { factionName, round, softmaxPick, starsText, uniqueSlugs, why } from "../util.mjs";

/** Starting territory (game setup) or a Join-the-War territory. */
export async function chooseStartingTerritory(ctx, { legal = [], joining = false } = {}) {
  const profile = profileOf(ctx);
  if ( !legal.length ) return { territory: null, why: why("startPosition", { territory: null }) };
  if ( legal.length === 1 ) return { territory: legal[0], why: why("startPosition", { territory: legal[0] }) };
  const all = startCandidates(ctx, legal, joining);
  const cands = all.slice(0, profile.candidates);
  // Joining: a spot next to a weakly held enemy HQ always reaches Jev, whatever the code pre-score says.
  if ( joining ) for ( const c of all.filter(x => x.facts.weakHq && !cands.includes(x)).slice(0, 2) ) cands.push(c);
  const pres = cands.map(c => c.pre);
  const lo = Math.min(...pres);
  const hi = Math.max(...pres);
  const codeLevel = c => (hi > lo ? 4 * (c.pre - lo) / (hi - lo) : 2);
  const levels = joining ? JOIN_LEVELS : START_LEVELS;

  const me = factionName(ctx, ctx.me);
  const placed = Object.values(ctx.state.territories).filter(t => t.hq && t.hq !== ctx.me)
    .map(t => `${factionName(ctx, t.hq)} in ${t.name}`);
  const jevState = {
    rules: PRIMER.start,
    you: { faction: me, ...(joining ? { situation: "knocked out: rejoins the war with 4 troops and no HQ" } : {}) },
    ...(profile.context !== "self" ? { enemy_hqs: placed.length ? placed : "none placed yet" } : {}),
    candidates: Object.fromEntries(cands.map(c => [c.id, startFacts(ctx, c, joining)]))
  };
  const answers = await ask(ctx, joining ? "join the war" : "starting territory", jevState,
    startQuestions({ me, keys: cands.map(c => c.id), joining }));
  // Combine in code: Jev's level, with the code pre-score as a smaller prior.
  const scored = cands.map(c => {
    const s = scoreOf(answers, `start_${c.id}`, levels.length, codeLevel(c));
    const lv = readScore(s, profile, ctx.random);
    return { c, lv, u: (answers ? 0.7 * lv : 0) + ((answers ? 0.3 : 1) * codeLevel(c)) };
  });
  const i = Math.max(0, softmaxPick(scored.map(x => x.u), profile.temperature, ctx.random, 0.6));
  const pick = scored[i];
  return {
    territory: pick.c.id,
    why: why("startPosition", {
      territory: pick.c.id, value: levels[Math.max(0, Math.min(levels.length - 1, Math.round(pick.lv)))].label,
      ...(answers ? {} : { heuristic: true })
    })
  };
}

/**
 * Any multiple-choice prompt (faction pick, event steps, rewards, power options...). Jev judges which option best
 * serves the bot's goal of winning; the hard bot asks twice in reversed order and averages; the easy bot samples.
 * @param {{kind:string, title?:string, text?:string, options:{value:any, label:string, hint?:string, disabled?:boolean, territory?:string, faction?:string}[]}} prompt
 */
export async function chooseOption(ctx, { kind = "option", title = "", text = "", options = [] } = {}) {
  const enabled = options.filter(o => !o.disabled);
  if ( !enabled.length ) return { value: options[0]?.value ?? null, why: why("choiceBest", { label: options[0]?.label ?? "" }) };
  if ( enabled.length === 1 ) return { value: enabled[0].value, why: why("choiceBest", { label: enabled[0].label }) };
  const profile = profileOf(ctx);
  const shown = enabled.slice(0, 255);
  const keys = uniqueSlugs(shown.map(o => o.label));
  const isFaction = kind === "faction" || shown.every(o => o.faction);
  const me = ctx.me ? factionName(ctx, ctx.me) : "the player choosing";
  const hasWar = !!ctx.state?.territories && Object.values(ctx.state.factions ?? {}).some(f => f.active);
  const jevState = { prompt: { kind, ...(title ? { title } : {}), ...(text ? { text } : {}) } };
  if ( hasWar && ctx.me ) {
    const list = standings(ctx);
    const mine = list.find(s => s.id === ctx.me);
    jevState.how_to_win = PRIMER.stars;
    jevState.you = { faction: me, ...(mine ? { red_stars: starsText(mine.stars) } : {}) };
    if ( profile.context !== "self" ) jevState.factions = factionsBlock(ctx, list, factionKeys(ctx, list), profile.context === "full" ? "full" : "standings");
  }
  jevState.options = Object.fromEntries(shown.map((o, i) => [keys[i], optionFacts(ctx, o)]));
  const answers = await ask(ctx, `choice: ${kind}`, jevState, optionQuestions({ me, keys, reversed: profile.reversedChoices, faction: isFaction }));
  const probs = choiceProbs(answers, "best", keys);
  if ( !probs ) {
    // Heuristic mode: a code preference where one exists (own territory with most troops), else the first option.
    const own = shown.findIndex(o => o.territory && ctx.state?.territories?.[o.territory]?.owner === ctx.me);
    const k = own >= 0 ? own : 0;
    return { value: shown[k].value, why: why("choiceBest", { label: shown[k].label, heuristic: true }) };
  }
  const key = pickChoice(probs, keys, profile, ctx.random);
  const k = keys.indexOf(key);
  return { value: shown[k].value, why: why("choiceBest", { label: shown[k].label, chance: round(probs[key], 2) }) };
}

/** A name to write on the board (city, signature, world name, continent). Code lists; never asks Jev. */
export function pickName(ctx, { kind = "city", used = [] } = {}) {
  const k = String(kind).toLowerCase();
  const pool = k.includes("world") ? NAMES.world
    : k.includes("continent") ? NAMES.continent
      : (k.includes("signature") || k.includes("player") || k.includes("motto")) ? NAMES.signature
        : NAMES.city;
  const taken = new Set(used.map(u => String(u).trim().toLowerCase()));
  const free = pool.filter(n => !taken.has(n.toLowerCase()));
  const random = typeof ctx?.random === "function" ? ctx.random : Math.random;
  const name = free.length ? free[Math.floor(random() * free.length)] : `${pool[Math.floor(random() * pool.length)]} ${taken.size + 1}`;
  return { name, why: why("name", { kind, label: name }) };
}

