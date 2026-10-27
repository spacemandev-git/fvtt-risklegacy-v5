/**
 * Exact battle odds: a Markov chain over (attacker troops, defender troops, fortification wear), built on the
 * system's own dice rules (module/battle/modifiers.mjs: applySources → resolveDice), so the numbers match play:
 * modifiers chosen from the natural roll, clamping to 1..6, ties to the defender (unless a winTies rule), re-sorting,
 * fortification +1 and its wear after every 3-dice attack, Enclave's natural triple, Die Mechaniker's double six,
 * unstable cloning, re-rolled ones. Missiles turn one die into an unmodifiable 6 (`missileOptions`).
 *
 * Everything is memoized: per-roll outcome distributions by dice configuration, whole-battle results by
 * (config, A, D, wear). Pure: no Foundry globals.
 */
import { applySources, collectSources, emptyRules, resolveDice } from "../../battle/modifiers.mjs";
import { expandCost, enterLosses } from "../../rules/_module.mjs";

export const FORTIFICATION_BOXES = 10;

/* -------------------------------------------- */
/*  One roll                                    */
/* -------------------------------------------- */

const ROLLS = new Map();

const sigSources = sources => (sources ?? []).map(s => `${s.side}:${s.die}:${s.delta}`).sort().join(",");
const sigRules = r => [
  (r?.winTies ?? []).map(w => `${w.side}${w.value}`).sort().join("+"),
  r?.conquerOnNaturalTriple ? 1 : 0, r?.protectOnDoubleSix ? 1 : 0, r?.cloneOnNaturalDoubles ? 1 : 0,
  r?.rerollOnes ? 1 : 0
].join("/");

/**
 * Outcome distribution of one roll with `a` attack dice and `d` defence dice.
 * @returns {{aLoss:number, dLoss:number, conquerAll:boolean, protect:boolean, clone:boolean, p:number}[]}
 */
export function rollDist(a, d, sources = [], rules = emptyRules()) {
  const key = `${a}v${d}|${sigSources(sources)}|${sigRules(rules)}`;
  const hit = ROLLS.get(key);
  if ( hit ) return hit;
  const attackFaces = rules?.rerollOnes ? [2, 3, 4, 5, 6] : [1, 2, 3, 4, 5, 6];
  const defendFaces = [1, 2, 3, 4, 5, 6];
  // Modifiers depend only on each side's own natural dice: apply them once per side, then pair every combination.
  const tuples = (n, faces) => {
    let out = [[]];
    for ( let i = 0; i < n; i++ ) out = out.flatMap(t => faces.map(f => [...t, f]));
    return out;
  };
  const side = (n, faces, name) => tuples(n, faces).map(t => applySources(t.map((v, slot) => ({ slot, natural: v })), sources, name));
  const atks = side(a, attackFaces, "attack");
  const defs = side(d, defendFaces, "defend");
  const acc = new Map();
  const p = 1 / (atks.length * defs.length);
  for ( const attack of atks ) {
    for ( const defend of defs ) {
      const r = resolveDice({ attack, defend, rules });
      const k = `${r.attackerLosses},${r.defenderLosses},${+r.conquerAll}${+r.protect}${+r.clone}`;
      const e = acc.get(k);
      if ( e ) e.p += p;
      else acc.set(k, { aLoss: r.attackerLosses, dLoss: r.defenderLosses, conquerAll: r.conquerAll, protect: r.protect, clone: r.clone, p });
    }
  }
  const out = [...acc.values()];
  ROLLS.set(key, out);
  return out;
}

/* -------------------------------------------- */
/*  Whole battle                                */
/* -------------------------------------------- */

const BATTLES = new Map();
const MAX_CONFIGS = 400;

/**
 * Odds of a whole attack: the attacker rolls max dice (min(3, A−1)) until it conquers, drops to `stopAt` troops (or
 * 1), or the territory becomes protected; the defender rolls max dice (min(2, D)).
 *
 * @param {object} p
 * @param {number} p.A            troops in the attacking territory (A−1 can roll)
 * @param {number} p.D            defending troops
 * @param {object[]} [p.sources]  modifier sources (collectSources), including the fortification if any
 * @param {object} [p.rules]      battle rule flags (collectSources)
 * @param {boolean} [p.fortReal]  the fortification source is a real fortification that wears (3-dice attacks)
 * @param {number} [p.fortUsed]   boxes already used (0..10)
 * @param {number} [p.stopAt=1]   the attacker stops when it has this many troops left (≥ 1)
 * @param {{a?:number, d?:number}} [p.first]  dice for the first roll only (defence choice)
 * @returns {{pConquer:number, pProtected:number, pStop:number, eAttackerLosses:number, eDefenderLosses:number,
 *            conquest:Float64Array}}  conquest[k] = P(conquer with k troops left in the attacking territory)
 */
export function battleOdds({ A, D, sources = [], rules = emptyRules(), fortReal = false, fortUsed = 0, stopAt = 1, first = null }) {
  A = Math.max(0, Math.floor(A));
  D = Math.max(0, Math.floor(D));
  stopAt = Math.max(1, Math.floor(stopAt));
  const hasFort = sources.some(s => s.source === "fortification");
  const wears = fortReal && hasFort;
  const noFort = wears ? sources.filter(s => s.source !== "fortification") : sources;
  const cfgKey = `${sigSources(sources)}|${sigRules(rules)}|${wears ? 1 : 0}|${stopAt}`;
  let memo = BATTLES.get(cfgKey);
  if ( !memo ) {
    memo = new Map();
    BATTLES.set(cfgKey, memo);
    if ( BATTLES.size > MAX_CONFIGS ) BATTLES.delete(BATTLES.keys().next().value);
  }
  const used0 = wears ? Math.min(FORTIFICATION_BOXES, Math.max(0, fortUsed)) : 0;

  const solve = (a0, d0, used, firstDice = null) => {
    if ( d0 <= 0 ) {
      const conquest = new Float64Array(a0 + 1);
      conquest[a0] = 1;
      return { pConquer: 1, pProtected: 0, pStop: 0, eAttackerLosses: 0, eDefenderLosses: 0, conquest };
    }
    if ( (a0 < 2) || (a0 <= stopAt) ) {
      return { pConquer: 0, pProtected: 0, pStop: 1, eAttackerLosses: 0, eDefenderLosses: 0, conquest: new Float64Array(a0 + 1) };
    }
    const key = `${a0},${d0},${used}`;
    if ( !firstDice ) {
      const hit = memo.get(key);
      if ( hit ) return hit;
    }
    const a = Math.min(3, a0 - 1, firstDice?.a ?? 3);
    const d = Math.min(2, d0, firstDice?.d ?? 2);
    const fortOn = !wears || (used < FORTIFICATION_BOXES);
    const dist = rollDist(a, d, fortOn ? sources : noFort, rules);
    const nextUsed = (wears && fortOn && (a === 3)) ? used + 1 : used;
    const out = { pConquer: 0, pProtected: 0, pStop: 0, eAttackerLosses: 0, eDefenderLosses: 0, conquest: new Float64Array(a0 + 1) };
    let selfLoop = 0;
    for ( const o of dist ) {
      const aL = Math.min(o.aLoss, a0);
      let d1 = o.conquerAll ? 0 : Math.max(0, d0 - o.dLoss);
      const dL = d0 - d1;
      if ( d1 > 0 && o.clone ) d1 += 1;
      const a1 = a0 - aL;
      out.eAttackerLosses += o.p * aL;
      out.eDefenderLosses += o.p * dL;
      if ( d1 > 0 && o.protect ) { out.pProtected += o.p; continue; }
      if ( (a1 === a0) && (d1 === d0) && (nextUsed === used) ) { selfLoop += o.p; continue; }
      const r = solve(a1, d1, nextUsed);
      out.pConquer += o.p * r.pConquer;
      out.pProtected += o.p * r.pProtected;
      out.pStop += o.p * r.pStop;
      out.eAttackerLosses += o.p * r.eAttackerLosses;
      out.eDefenderLosses += o.p * r.eDefenderLosses;
      for ( let k = 0; k < r.conquest.length; k++ ) out.conquest[k] += o.p * r.conquest[k];
    }
    if ( selfLoop > 0 && selfLoop < 1 ) {
      const f = 1 / (1 - selfLoop);
      out.pConquer *= f; out.pProtected *= f; out.pStop *= f; out.eAttackerLosses *= f; out.eDefenderLosses *= f;
      for ( let k = 0; k < out.conquest.length; k++ ) out.conquest[k] *= f;
    }
    if ( !firstDice ) memo.set(key, out);
    return out;
  };
  return solve(A, D, used0, first);
}

/** Expected troops left in the attacking territory, given a conquest (0 when it can't happen). */
export function expectedLeftOnConquest(result) {
  if ( !result.pConquer ) return 0;
  let e = 0;
  for ( let k = 0; k < result.conquest.length; k++ ) e += k * result.conquest[k];
  return e / result.pConquer;
}

/* -------------------------------------------- */
/*  From a BoardState                           */
/* -------------------------------------------- */

/**
 * Sources, rules and fortification facts for an attack in this state (via the system's collectSources).
 * @param {object} state
 * @param {{attacker:string, from:string, to:string, defender?:string, activeEvents?:string[]}} battle
 * @param {Function} [lookup]
 */
export function battleSetup(state, battle, lookup) {
  const to = state.territories?.[battle.to];
  const defender = battle.defender ?? to?.owner ?? null;
  const { sources, rules } = collectSources(state, { ...battle, defender }, { lookup });
  return {
    sources, rules, defender,
    fortReal: rules.fortifiedBy === "fortification",
    fortUsed: to?.fortificationUsed ?? 0
  };
}

/**
 * Whole-attack odds from the current state: `from`'s troops against `to`'s.
 * @param {object} state
 * @param {string} attacker
 * @param {string} from
 * @param {string} to
 * @param {object} [opts]  {lookup, activeEvents, A (override attacker troops), D (override), stopAt, first}
 */
export function attackOdds(state, attacker, from, to, opts = {}) {
  const setup = battleSetup(state, { attacker, from, to, activeEvents: opts.activeEvents }, opts.lookup);
  const A = opts.A ?? state.territories?.[from]?.troops ?? 0;
  const D = opts.D ?? state.territories?.[to]?.troops ?? 0;
  const r = battleOdds({ A, D, ...setup, stopAt: opts.stopAt ?? 1, first: opts.first ?? null });
  return { ...r, A, D, defender: setup.defender, leftOnConquest: expectedLeftOnConquest(r) };
}

/**
 * Odds along a path of attacks and expansions from one stack (hard bot chains). After each step every troop but one
 * moves forward. Fallout-style entry losses and expansion costs come from the rules engine.
 *
 * @param {object} state
 * @param {string} me
 * @param {string[]} path   [from, step1, step2, …]
 * @param {object} [opts]   {lookup, activeEvents, A0 (troops in path[0]), stopAt}
 * @returns {{pReach:number, steps:{to:string, kind:string, pReach:number}[], expectedTroops:number, dist:Map<number,number>}}
 */
export function pathOdds(state, me, path, opts = {}) {
  let dist = new Map([[opts.A0 ?? state.territories?.[path[0]]?.troops ?? 0, 1]]);
  const steps = [];
  const firstTarget = state.turn?.log?.firstAttackTarget || null;
  let chained = state;
  let attackedFirst = firstTarget;
  for ( let i = 1; i < path.length; i++ ) {
    const from = path[i - 1];
    const to = path[i];
    const t = state.territories?.[to];
    const next = new Map();
    if ( t?.owner && (t.owner !== me) ) {
      // Enclave's first-attack bonus only applies to the turn's first target.
      if ( !attackedFirst ) attackedFirst = to;
      else if ( chained.turn?.log?.firstAttackTarget !== attackedFirst ) {
        chained = { ...state, turn: { ...(state.turn ?? {}), log: { ...(state.turn?.log ?? {}), firstAttackTarget: attackedFirst } } };
      }
      const setup = battleSetup(chained, { attacker: me, from, to, activeEvents: opts.activeEvents }, opts.lookup);
      for ( const [A, pA] of dist ) {
        const r = battleOdds({ A, D: t.troops, ...setup, stopAt: opts.stopAt ?? 1 });
        for ( let k = 2; k < r.conquest.length; k++ ) {
          if ( !r.conquest[k] ) continue;
          const moved = k - 1;
          const lost = enterLosses(state, me, to, moved).reduce((n, e) => n + e.troops, 0);
          const arrive = moved - lost;
          if ( arrive >= 1 ) next.set(arrive, (next.get(arrive) ?? 0) + pA * r.conquest[k]);
        }
      }
      steps.push({ to, kind: "attack" });
    }
    else if ( !t?.owner ) {
      for ( const [A, pA] of dist ) {
        const moved = A - 1;
        if ( moved < 1 ) continue;
        const { cost } = expandCost(state, me, to, moved);
        const arrive = moved - cost;
        if ( arrive >= 1 ) next.set(arrive, (next.get(arrive) ?? 0) + pA);
      }
      steps.push({ to, kind: "expand" });
    }
    else break;   // own territory: not a path step
    dist = next;
    steps.at(-1).pReach = [...dist.values()].reduce((a, b) => a + b, 0);
  }
  const pReach = steps.length ? steps.at(-1).pReach : 1;
  let e = 0;
  for ( const [k, p] of dist ) e += k * p;
  return { pReach, steps, expectedTroops: pReach ? e / pReach : 0, dist };
}

/* -------------------------------------------- */
/*  Defence dice and missiles                    */
/* -------------------------------------------- */

/**
 * P(conquer) for each defence dice choice on the next roll (later rolls: max dice).
 * @returns {{dice:number, pConquer:number, eAttackerLosses:number}[]}
 */
export function defenceChoices(state, battle, max, lookup) {
  const setup = battleSetup(state, battle, lookup);
  const A = state.territories?.[battle.from]?.troops ?? 0;
  const D = state.territories?.[battle.to]?.troops ?? 0;
  const out = [];
  for ( let d = 1; d <= Math.max(1, max); d++ ) {
    const r = battleOdds({ A, D, ...setup, first: { a: battle.attackDice ?? 3, d } });
    out.push({ dice: d, pConquer: r.pConquer, eAttackerLosses: r.eAttackerLosses });
  }
  return out;
}

/**
 * The rolled battle's outcome now and with one missile on each eligible die, with the chance that the attack goes on
 * to conquer the territory afterwards (the attacker keeps rolling max dice).
 *
 * @param {object} state     BoardState before the roll is resolved
 * @param {object} battle    battle message data: {attacker, defender, from, to, attack:[die], defend:[die], sources?, rules?}
 * @param {object} [opts]    {lookup, activeEvents}
 * @returns {{base:{aLoss, dLoss, pConquer, conquersNow}, options:{side, index, aLoss, dLoss, pConquer, conquersNow}[], unmodifiable:string[]}}
 */
export function missileOptions(state, battle, opts = {}) {
  const setup = battleSetup(state, battle, opts.lookup);
  const sources = battle.sources ?? setup.sources;
  const rules = battle.rules ? { ...emptyRules(), ...battle.rules } : setup.rules;
  const unmodifiable = rules.unmodifiable ?? [];
  const A = battle.troops?.attacker ?? state.territories?.[battle.from]?.troops ?? 0;
  const D = battle.troops?.defender ?? state.territories?.[battle.to]?.troops ?? 0;
  const strip = d => ({ slot: d.slot, natural: d.natural, missile: !!d.missile, missileBy: d.missileBy ?? "" });
  const attack = (battle.attack ?? []).map(strip);
  const defend = (battle.defend ?? []).map(strip);
  const wearNow = setup.fortReal && (attack.length === 3) && ((setup.fortUsed ?? 0) < FORTIFICATION_BOXES);

  const evaluate = (atk, def) => {
    const r = resolveDice({
      attack: applySources(atk, sources, "attack"),
      defend: applySources(def, sources, "defend"),
      rules
    });
    let d1 = r.conquerAll ? 0 : Math.max(0, D - r.defenderLosses);
    const a1 = Math.max(0, A - r.attackerLosses);
    if ( d1 > 0 && r.clone ) d1 += 1;
    let pConquer;
    if ( d1 <= 0 ) pConquer = 1;
    else if ( r.protect ) pConquer = 0;
    else {
      pConquer = battleOdds({
        A: a1, D: d1, sources: setup.sources, rules: setup.rules, fortReal: setup.fortReal,
        fortUsed: (setup.fortUsed ?? 0) + (wearNow ? 1 : 0)
      }).pConquer;
    }
    return { aLoss: r.attackerLosses, dLoss: D - Math.max(0, r.conquerAll ? 0 : D - r.defenderLosses), pConquer, conquersNow: d1 <= 0 };
  };

  const base = evaluate(attack, defend);
  const options = [];
  for ( const [side, dice] of [["attack", attack], ["defend", defend]] ) {
    if ( unmodifiable.includes(side) ) continue;
    for ( const die of dice ) {
      if ( die.missile ) continue;
      const changed = dice.map(d => (d.slot === die.slot ? { ...d, missile: true } : d));
      const r = side === "attack" ? evaluate(changed, defend) : evaluate(attack, changed);
      options.push({ side, index: die.slot, ...r });
    }
  }
  return { base, options, unmodifiable };
}

/** Drop every memoized result (tests, memory). */
export function clearOddsCache() {
  ROLLS.clear();
  BATTLES.clear();
}
