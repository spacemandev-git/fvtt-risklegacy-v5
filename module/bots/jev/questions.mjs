/**
 * Every question the bots ask Jev (BOTS.md §4.2), in one place: instructions, criteria, Score levels and the
 * thresholds that read the answers. Builders are pure functions returning `{name: question}`; the brain
 * (module/bots/brain/context.mjs) builds the matching `state`, whose paths the questions refer to in backticks.
 *
 * Design rules followed here:
 *  - one judgment per question, asked from the bot's goal (winning the war); code makes the decision;
 *  - numbers, odds and exact facts are computed in code and stated in the state as plain facts / verbal bands;
 *  - Score levels describe situations; Noul `false` criteria describe a concrete situation;
 *  - per-candidate Scores/Nouls instead of one Choice when candidates are independent (no order bias);
 *  - Choices whose order could matter are asked twice, reversed, by the hard bot (`reversed: true`).
 */

/* -------------------------------------------- */
/*  Thresholds that read the answers            */
/* -------------------------------------------- */

/** Noul: above `yes` reads as yes, below `no` as no, between = unsettled. */
export const NOUL = { yes: 0.7, no: 0.3 };

/** Score levels code compares against (indexes into the level lists below). */
export const READ = {
  dangerRealChance: 2,   // HQ_DANGER_LEVELS index from which the HQ counts as in danger
  dangerLikelyLost: 3,
  stakesHigh: 3,         // STAKES_LEVELS "a lot"
  stakesAll: 4,
  valueBig: 3            // VALUE_LEVELS "a big swing"
};

/* -------------------------------------------- */
/*  Level lists                                 */
/* -------------------------------------------- */

/**
 * How much taking a territory improves the bot's chance of winning. `label` is for narration.
 * There is no "decisive" level here. Whether a take wins the war now, or takes the HQ of a rival on 3 Red Stars, is an
 * exact fact that code computes (candidates.mjs codeValueLevel → DECISIVE). Asked about it, Jev rated every HQ capture
 * near "decisive", even one that only brought the bot to 3 Red Stars, and the hard bot then threw armies at 15–30%
 * odds. So Jev rates the take on levels 0–3 and code adds DECISIVE when its facts say so.
 */
export const VALUE_LEVELS = [
  { label: "nothing that matters", text: "It changes nothing that matters for winning the war." },
  { label: "a small edge", text: "A small edge: a little more territory or troops, or this turn's resource card." },
  { label: "a solid gain", text: "A solid gain: more troops every turn, or a rival loses its continent bonus." },
  { label: "a big swing", text: "A big swing in the Red Star race: a Red Star changes hands or a faction is knocked out." }
];

/** The value level code assigns when a take decides the war (on the same 0..4 scale as the profiles' `gain`). */
export const DECISIVE = { level: 4, label: "decisive", fromCode: 3.8 };

/** Danger to the bot's HQ before its next turn. */
export const HQ_DANGER_LEVELS = [
  { label: "safe", text: "Safe: no opponent can realistically capture the HQ before the next turn." },
  { label: "pressured", text: "Pressured: an opponent could attack the HQ but would probably fail." },
  { label: "at risk", text: "At risk: an opponent has a real chance to capture the HQ before the next turn." },
  { label: "likely lost", text: "Likely lost: an opponent will probably capture the HQ before the next turn." }
];

/** How much a battle matters to the bot. */
export const STAKES_LEVELS = [
  { label: "hardly at all", text: "Hardly at all: nothing important to the faction depends on this battle." },
  { label: "a little", text: "A little: a resource card or a minor territory depends on it." },
  { label: "moderately", text: "Moderately: a continent bonus or a strong position depends on it." },
  { label: "a lot", text: "A lot: a Red Star (an HQ) or a knock-out depends on it." },
  { label: "everything", text: "Everything: the war can be won or lost on this battle." }
];

/** How good a starting territory is (game setup). */
export const START_LEVELS = [
  { label: "poor", text: "Poor: hemmed in next to enemy HQs, with little room to grow." },
  { label: "weak", text: "Weak: cramped or exposed to strong neighbours." },
  { label: "fair", text: "Fair: some room to grow, with some danger nearby." },
  { label: "good", text: "Good: room to expand toward a continent, with few enemies close." },
  { label: "excellent", text: "Excellent: a holdable continent to take, far from enemy HQs." }
];

/** How good a place is to rejoin the war (Join the War, 4 troops, no HQ). */
export const JOIN_LEVELS = [
  { label: "poor", text: "Poor: strong enemy stacks next to it would knock the faction out again." },
  { label: "weak", text: "Weak: exposed, with nothing worth taking nearby." },
  { label: "fair", text: "Fair: fairly safe, but little to gain nearby." },
  { label: "good", text: "Good: safe enough, with empty or weakly held territory to take next turn." },
  { label: "excellent", text: "Excellent: safe, with a weakly held enemy HQ or continent within reach." }
];

const texts = levels => levels.map(l => l.text);
const poss = name => (/s$/i.test(name) ? `${name}'` : `${name}'s`);

/* -------------------------------------------- */
/*  Situation (start of each bot turn)           */
/* -------------------------------------------- */

/**
 * @param {object} p
 * @param {string} p.me                      the bot's faction name
 * @param {{key:string, name:string}[]} p.factions   every faction in the war (keys of `factions`)
 * @param {{key:string, name:string}[]} [p.threatKeys] opponents to ask "will it attack your HQ" about
 * @param {boolean} p.hasHq                  `your_hq` is in the state
 * @param {boolean} [p.reversed]             also ask the leader Choice in reversed order
 * @param {{key:string}[]} [p.cardOptions]   keys of `card_options` (hard bot's card maths)
 */
export function situationQuestions({ me, factions, threatKeys = [], hasHq, reversed = false, cardOptions = null }) {
  const q = {};
  const leaderCriteria = list => Object.fromEntries(list.map(f => [f.key, `${f.name} (\`factions.${f.key}\`)`]));
  const leader = {
    type: "choice",
    instructions: "Which faction is most likely to win this war?",
    criteria: leaderCriteria(factions)
  };
  q.leader = leader;
  if ( reversed ) q.leader_reversed = { ...leader, criteria: leaderCriteria([...factions].reverse()) };
  if ( hasHq ) {
    q.hq_danger = {
      type: "score",
      instructions: `How much danger is ${poss(me)} HQ in (\`your_hq\`) before ${poss(me)} next turn?`,
      criteria: texts(HQ_DANGER_LEVELS)
    };
    for ( const f of threatKeys ) {
      q[`attacks_hq_${f.key}`] = {
        type: "noul",
        instructions: `Is ${f.name} likely to attack ${poss(me)} HQ on its next turn?`,
        criteria: {
          true: `${f.name} has troops in reach of ${poss(me)} HQ and capturing it would help ${f.name} win.`,
          false: `${f.name} cannot reach ${poss(me)} HQ with enough troops, or has a clearly better target elsewhere.`
        }
      };
    }
  }
  if ( cardOptions?.length ) Object.assign(q, cardQuestions({ me, keys: cardOptions.map(o => o.key), reversed }));
  return q;
}

/** Hard bot's card maths: which use of the hand (keys of `card_options`). */
export function cardQuestions({ me, keys, reversed = false }) {
  const criteria = list => Object.fromEntries(list.map(k => [k, `\`card_options.${k}\``]));
  const base = {
    type: "choice",
    instructions: `Which use of ${poss(me)} resource cards this turn gives ${me} the best chance of winning the war?`,
    criteria: criteria(keys)
  };
  const q = { cards: base };
  if ( reversed ) q.cards_reversed = { ...base, criteria: criteria([...keys].reverse()) };
  return q;
}

/* -------------------------------------------- */
/*  Targets and fronts                           */
/* -------------------------------------------- */

/** Per target in `targets`: how much taking it this turn helps the bot win. */
export function targetValueQuestions({ me, keys }) {
  const q = {};
  for ( const k of keys ) {
    q[`value_${k}`] = {
      type: "score",
      instructions: `How much would taking \`targets.${k}\` this turn improve ${poss(me)} chance of winning the war?`,
      criteria: texts(VALUE_LEVELS)
    };
  }
  return q;
}

/** Per front in `fronts`: is an opponent likely to attack it before the bot's next turn. */
export function exposureQuestions({ me, keys }) {
  const q = {};
  for ( const k of keys ) {
    q[`attacked_${k}`] = {
      type: "noul",
      instructions: `Is an opponent likely to attack \`fronts.${k}\` before ${poss(me)} next turn?`,
      criteria: {
        true: "An opponent next to it has enough troops to take it and would gain something by taking it.",
        false: "Every opponent next to it is too weak to take it or has better targets elsewhere."
      }
    };
  }
  return q;
}

/* -------------------------------------------- */
/*  Battles (missiles, scar cards)               */
/* -------------------------------------------- */

/** How much the battle in `battle` matters to the bot. */
export function battleQuestions({ me }) {
  return {
    stakes: {
      type: "score",
      instructions: `How much does the outcome of \`battle\` matter for ${poss(me)} chance of winning the war?`,
      criteria: texts(STAKES_LEVELS)
    }
  };
}

/* -------------------------------------------- */
/*  Starting territory                           */
/* -------------------------------------------- */

export function startQuestions({ me, keys, joining = false }) {
  const q = {};
  for ( const k of keys ) {
    q[`start_${k}`] = joining ? {
      type: "score",
      instructions: `How good a place is \`candidates.${k}\` for ${me} to rejoin the war with 4 troops?`,
      criteria: texts(JOIN_LEVELS)
    } : {
      type: "score",
      instructions: `How good a starting territory is \`candidates.${k}\` for ${me} to win this war?`,
      criteria: texts(START_LEVELS)
    };
  }
  return q;
}

/* -------------------------------------------- */
/*  Multiple-choice prompts                      */
/* -------------------------------------------- */

/**
 * Any prompt with named options (faction pick, events, rewards, power options). Options are keys of `options`.
 * @param {{me:string, keys:string[], reversed?:boolean, faction?:boolean}} p
 */
export function optionQuestions({ me, keys, reversed = false, faction = false }) {
  const criteria = list => Object.fromEntries(list.map(k => [k, `\`options.${k}\``]));
  const base = {
    type: "choice",
    instructions: faction
      ? `Which faction in \`options\` would give ${poss(me)} player the best chance of winning this war?`
      : `Which option in \`prompt\` gives ${me} the best chance of winning the war?`,
    criteria: criteria(keys)
  };
  const q = { best: base };
  if ( reversed ) q.best_reversed = { ...base, criteria: criteria([...keys].reverse()) };
  return q;
}

/* -------------------------------------------- */
/*  Shape check                                  */
/* -------------------------------------------- */

/**
 * Throws when a question set breaks the API limits (BOTS.md §4.1): every question has a type and instructions,
 * Choice 1..255 options, Score 1..10 levels, Noul criteria {true, false} when present.
 */
export function assertQuestions(questions) {
  const names = Object.keys(questions ?? {});
  if ( !names.length ) throw new Error("Jev request without questions");
  for ( const name of names ) {
    const q = questions[name];
    if ( !q || !["noul", "choice", "score"].includes(q.type) ) throw new Error(`Jev question ${name}: bad type`);
    if ( (q.instructions === undefined) || (q.instructions === "") ) throw new Error(`Jev question ${name}: no instructions`);
    if ( q.type === "choice" ) {
      const n = Object.keys(q.criteria ?? {}).length;
      if ( n < 1 || n > 255 ) throw new Error(`Jev question ${name}: ${n} options`);
    }
    if ( q.type === "score" ) {
      const n = Array.isArray(q.criteria) ? q.criteria.length : 0;
      if ( n < 1 || n > 10 ) throw new Error(`Jev question ${name}: ${n} levels`);
    }
    if ( (q.type === "noul") && q.criteria && ((typeof q.criteria.true !== "string") || (typeof q.criteria.false !== "string")) ) {
      throw new Error(`Jev question ${name}: Noul criteria need true and false`);
    }
  }
  return true;
}
