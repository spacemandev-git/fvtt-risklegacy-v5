/**
 * Difficulty profiles for the chat-model bots (BOTS-LLM.md §6.3): what each level is allowed to know, how big its
 * menus are, its guardrails and the request settings. The personality changes the style within a level (knobs, §5.2);
 * the level changes the knowledge and the guardrails. Nothing here assumes a particular model.
 *
 * `jev` names the Jev profile (module/bots/brain/profiles.mjs) whose code pre-scores rank the candidates: the shared
 * candidate code (movePlans, frontsOf, startCandidates) reads its gain table, chains flag and expansion rules.
 */

export const LLM_PROFILES = Object.freeze({
  easy: Object.freeze({
    id: "easy",
    jev: "easy",
    context: "self",          // own territories + neighbours, its HQ, Red Star counts
    odds: "band",             // verbal bands only, no numbers
    menu: 5,                  // attack-plan options
    preScore: "light",        // top 3 by code + 2 others (may include poor ones), shuffled
    minChance: 0.1,           // odds floor of the attack menu (before the personality's risk shift)
    chains: false,
    replans: 0,
    fronts: 3,                // placement fronts in the turn plan
    maneuvers: 3,
    starts: 4,                // starting-territory candidates
    strategy: false,
    campaign: null,           // rules only
    memory: "none",           // no memory, no debrief
    hqFloor: 1,               // troops always left in an HQ (code-enforced; 1 = none)
    reasoning: Object.freeze({ effort: "low" }),
    temperature: 0.9,
    maxTokens: 1500
  }),
  normal: Object.freeze({
    id: "normal",
    jev: "normal",
    context: "standings",     // + every faction's stars, troops, territories, continents; threats to its HQ
    odds: "pct",              // exact % with bands
    menu: 6,
    preScore: "ranked",
    minChance: 0.25,          // no option under 25% unless code says it is decisive
    chains: false,
    replans: 1,
    fronts: 4,
    maneuvers: 4,
    starts: 6,
    strategy: true,
    campaign: "short",        // CAMPAIGN_SHORT + a one-line campaign standing
    memory: "notes",          // reads notes + grudges; writes a debrief
    hqFloor: 3,
    reasoning: Object.freeze({ effort: "low" }),
    temperature: 0.6,
    maxTokens: 2500
  }),
  hard: Object.freeze({
    id: "hard",
    jev: "hard",
    context: "full",          // + hand counts and coins, mission, events, powers, view.recent
    odds: "full",             // exact % + expected losses + everything the take changes
    menu: 8,
    preScore: "ranked",
    minChance: 0.25,
    chains: true,             // 2–3-step chains toward HQs, continents and knock-outs
    maxChains: 3,
    replans: 2,
    fronts: 5,
    maneuvers: 5,
    starts: 8,
    strategy: true,
    campaign: "full",         // CAMPAIGN_PRIMER + view.campaign facts
    memory: "all",            // reads notes, grudges, lessons and past games; writes a debrief
    hqFloor: 4,
    reasoning: Object.freeze({ effort: "medium" }),
    // Probe (2026-10-27): at "medium" GLM 5.3 spent 14–31 s on a hard turn plan, over the ~30 s per-turn budget on its
    // own. The attack plan, replans, campaign choices and the debrief keep "medium"; the rest think "low".
    reasoningFor: Object.freeze({
      "turn plan": Object.freeze({ effort: "low" }), "end of turn": Object.freeze({ effort: "low" }),
      missile: Object.freeze({ effort: "low" }), "scar card": Object.freeze({ effort: "low" })
    }),
    temperature: 0.3,
    maxTokens: 5000
  })
});

/** Odds floor for a decisive take (wins the war now, or takes the HQ of a rival on 3 Red Stars). */
export const DECISIVE_MIN_CHANCE = 0.15;

/** Memory caps (BOTS-LLM.md §3: notes about 120 words, at most 6 lessons). */
export const MEMORY_CAPS = Object.freeze({ noteWords: 120, lessons: 6, grudges: 8, games: 12, textChars: 160 });

/** Table talk: hard cap on a line (BOTS-LLM.md §5.4) and routine lines kept per bot turn. */
export const SAY_MAX_CHARS = 160;
export const ROUTINE_SAYS_PER_TURN = 1;

const NEUTRAL_KNOBS = Object.freeze({ risk: 0.5, aggression: 0.5, chattiness: 0.5, vengeance: 0.5, patience: 0.5 });

/** The profile for a context's difficulty (normal when unknown). */
export function llmProfileOf(ctx) {
  return LLM_PROFILES[ctx?.difficulty] ?? LLM_PROFILES.normal;
}

/** The personality knobs (0..1 each), neutral when the bot has no personality. */
export function knobsOf(ctx) {
  const k = ctx?.bot?.personality?.knobs ?? {};
  const out = {};
  for ( const [key, v] of Object.entries(NEUTRAL_KNOBS) ) {
    const x = Number(k[key]);
    out[key] = Number.isFinite(x) ? Math.min(1, Math.max(0, x)) : v;
  }
  return out;
}

/**
 * The attack menu's odds floor: the level's floor shifted by the personality's risk (risk 1 → 10 points lower,
 * risk 0 → 10 points higher). Risky personalities see, and take, thinner odds.
 */
export function oddsFloor(profile, knobs) {
  return Math.min(0.6, Math.max(0.05, profile.minChance + ((0.5 - knobs.risk) * 0.2)));
}

/**
 * The floor under which a planned attack is abandoned or replanned while it runs: a little under the menu floor
 * (the plan was made knowing the odds), shifted by risk the same way.
 */
export function stepFloor(profile, knobs, decisive = false) {
  if ( decisive ) return DECISIVE_MIN_CHANCE;
  return Math.max(0.05, oddsFloor(profile, knobs) - 0.05);
}

/** How many attack options the menu offers: aggressive personalities see up to two more, timid ones two fewer. */
export function menuSize(profile, knobs) {
  return Math.max(3, Math.min(profile.menu + 2, profile.menu + Math.round((knobs.aggression - 0.5) * 4)));
}

/** Default share of the movable troops that follow a conquest forward (aggression), 0.2..0.9. */
export function moveForwardShare(knobs) {
  return 0.2 + (0.7 * knobs.aggression);
}

/**
 * The smallest card trade (in troops) offered in the turn plan, unless the HQ is in danger: 4 (the Jev brain's
 * minimum) plus up to 4 for patient personalities, who hold cards toward a Red Star.
 */
export function minTradeTroops(knobs) {
  return 4 + Math.round(knobs.patience * 4);
}
