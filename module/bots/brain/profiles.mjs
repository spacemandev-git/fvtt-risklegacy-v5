/**
 * Difficulty profiles (BOTS.md §5.2): how much context each level sends to Jev, how many candidates it weighs, how it
 * picks (sampling vs argmax), its odds thresholds and which judgments it asks for. Utilities are in troop-equivalents:
 * `gain` maps a target-value level (0..4, see questions.mjs VALUE_LEVELS) to the troops it is worth.
 */

export const PROFILES = {
  easy: {
    id: "easy",
    candidates: 4,
    chains: false,
    temperature: 1.6,          // > 1: samples Jev's distributions and the utilities, so it makes plausible mistakes
    context: "self",           // itself + candidates
    reversedChoices: false,
    gain: [0, 1.5, 4, 8, 20],
    attack: {
      minChance: 0.75,         // never attacks below this
      maxTargets: 3,           // at most 3 targets per turn
      stopAfterConquest: 0.5,  // chance to stop after its first conquest
      minUtility: 0.3,
      lossWeight: 1,
      hqGarrisonP: null,       // doesn't keep an HQ garrison
      hqFloor: 1,              // will empty its HQ
      cardValue: 0,            // doesn't count the resource card a conquest earns
      winNowMin: 0.6
    },
    expand: { max: 3, minSource: 3 },
    placement: "pile",         // one pile on a top-2 front
    hqSafeP: null,
    maneuver: "never",
    cards: "alwaysBuy",
    trade: "never",
    missiles: "winOnly",       // only if losing would hand someone the win
    scars: "never",
    maxValueRequests: 2,       // attack-value requests per turn (beyond the placement request)
    askExposure: false,
    askThreats: false
  },
  normal: {
    id: "normal",
    candidates: 6,
    chains: false,
    temperature: 0,
    context: "standings",
    reversedChoices: false,
    gain: [0, 2, 5, 10, 25],
    attack: {
      minChance: 0.55,
      maxTargets: 8,
      stopAfterConquest: 0,
      minUtility: 0.5,
      lossWeight: 1,
      hqGarrisonP: null,
      hqFloor: 3,              // troops it always leaves in its HQ (unless the move wins the war)
      cardValue: 2.5,          // the turn's first conquest earns a resource card (4 cards = a Red Star)
      winNowMin: 0.4
    },
    expand: { max: 5, minSource: 3, giftCost: true },
    placement: "stage",        // the planned attack's staging territory, + HQ when in danger
    hqSafeP: 0.35,
    maneuver: "consolidate",
    cards: "buy",
    trade: "hqDanger",
    missiles: { minStakes: 3, minSwing: 0.25 },
    scars: "hq",
    maxValueRequests: 3,
    askExposure: true,
    askThreats: true
  },
  // The hard bot is the normal bot's risk discipline plus more information and tactics. Tournament tuning (BOTS.md
  // §5.4) found that every way it took more risk than the normal bot (lower odds floors, a worst-case HQ garrison, a
  // reserve split over many fronts, trading cards away on Jev's card judgment) made it lose more often, not less.
  hard: {
    id: "hard",
    candidates: 8,
    chains: true,
    chainDepth: 3,
    temperature: 0,
    context: "full",           // + hand counts, forecast recruits, missions, power text
    reversedChoices: true,     // order-sensitive Choices asked twice, reversed, and averaged
    gain: [0, 2, 6, 12, 30],
    attack: {
      minChance: 0.55,
      minChanceHigh: 0.4,      // floor for "a big swing" (an HQ capture, a knock-out)
      maxTargets: 12,
      stopAfterConquest: 0,
      minUtility: 0.5,
      lossWeight: 1,
      hqGarrisonP: null,
      hqFloor: 4,              // never fewer troops than this in its HQ (unless the move wins the war): threats
                               // beyond next turn aren't forecast, and an emptied HQ is a free Red Star for a rival
      cardValue: 3,
      winNowMin: 0.25
    },
    expand: { max: 6, minSource: 3, giftCost: true },
    placement: "stage",        // the planned attack's staging territory, + HQ when in danger
    hqSafeP: 0.35,
    maneuver: "reinforce",
    cards: "buy",
    trade: "hqDanger",
    missiles: { evThreshold: 0.6, bystander: true },
    scars: "strategic",
    maxValueRequests: 4,
    askExposure: true,
    askThreats: true
  }

};

/** The profile for a difficulty (normal when unknown). */
export function profileOf(ctx) {
  return PROFILES[ctx?.difficulty] ?? PROFILES.normal;
}

/** Troop-equivalent gain for a (fractional) value level, interpolated. */
export function gainOf(profile, level) {
  const g = profile.gain;
  const x = Math.max(0, Math.min(g.length - 1, Number(level) || 0));
  const i = Math.floor(x);
  if ( i >= g.length - 1 ) return g.at(-1);
  return g[i] + ((g[i + 1] - g[i]) * (x - i));
}
