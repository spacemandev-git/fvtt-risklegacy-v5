/**
 * Combat dice modifiers and resolution: pure functions, no Foundry runtime access (unit-tested with `node --test`).
 *
 * Rulebook p.11 "Modifying die rolls":
 *   1. A die can never be higher than 6 or lower than 1 (deltas on one die are summed, then clamped).
 *   2. When dice tie, only one of them is modified per Scar, Faction Power or Missile. Each source picks its die
 *      from the natural roll sorted high → low (ties broken by roll order), so "highest"/"lowest" always means one
 *      die. Sources that say "both"/"all" dice (Fortification, Well-Armed) modify every die of that side.
 *   3. Re-evaluate the order after all modifiers: each side is re-sorted by its final values before comparing.
 * A Missile turns a die into an unmodifiable 6 (any modifier on that die is dropped).
 *
 * The data flow is: `collectSources(state, battle)` decides which modifiers apply to this combat (scars, marks,
 * fortification, faction powers, events) → `applySources(dice, sources, side)` computes each die's value →
 * `resolveDice(battle)` compares the pairs and reports casualties and special outcomes.
 * `computeModifiers(state, battle)` (the ARCHITECTURE §5.3 entry point) runs the first two steps.
 */
import { SCARS } from "../config.mjs";

export const DIE_MIN = 1;
export const DIE_MAX = 6;

/** Sides of a battle. `attack` = the attacker's black dice, `defend` = the defender's red dice. */
export const SIDES = ["attack", "defend"];

/** Clamp a die value to 1..6. */
export const clampDie = value => Math.min(DIE_MAX, Math.max(DIE_MIN, Math.round(Number(value) || 0)));

/** Normalize a power/scar key ("well-armed" → "well_armed"). */
export const normalizeKey = key => String(key ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");

/** Catalog `side` ("attacker"|"defender") → battle side ("attack"|"defend"). */
export const sideOf = value => {
  const v = String(value ?? "").toLowerCase();
  if ( ["attacker", "attack", "attacking"].includes(v) ) return "attack";
  if ( ["defender", "defend", "defense", "defence", "defending"].includes(v) ) return "defend";
  return null;
};

/**
 * Combat automation for faction powers, by normalized key. `owner` is the battle role the power's holder must have
 * for it to apply. The effect vocabulary matches data/content/README.md (`dieMod`, `ignoreScar`, `winTies`) plus a
 * few battle-specific types for powers whose catalog effect is null.
 */
export const COMBAT_POWERS = {
  // Enclave of the Bear: −1 to the defender's lower die in the first territory attacked this turn.
  enclave_1: { owner: "attack", effect: { type: "dieMod", side: "defender", die: "lowest", delta: -1, condition: "firstTerritoryAttackedThisTurn" } },
  // Enclave of the Bear: natural three of a kind + at least one defender defeated → conquer, remove all defenders.
  enclave_2: { owner: "attack", effect: { type: "conquerOnNaturalTriple" } },
  // Die Mechaniker: the starting HQ is always treated as fortified when defending it.
  mechaniker_1: { owner: "defend", effect: { type: "fortifyStartingHQ" } },
  // Die Mechaniker: defence of two natural 6s → that territory can't be attacked again this turn.
  mechaniker_2: { owner: "defend", effect: { type: "protectOnDoubleSix" } },
  // Knockout power: +1 to all attack dice when attacking an HQ.
  well_armed: { owner: "attack", effect: { type: "dieMod", side: "attacker", die: "all", delta: 1, condition: "defendingTerritoryHasHQ" } },
  // Knockout power: unaffected by Ammo Shortage when defending.
  well_supplied: { owner: "defend", effect: { type: "ignoreScar", scar: "ammo_shortage", side: "defender" } },
  // Mutants (secret power): attacking 6s beat the defender's 6s.
  unnatural_strength: { owner: "attack", effect: { type: "winTies", side: "attacker", value: 6 } },
  // Mutants (secret power): natural doubles on defence → +1 defending troop if the territory is still held.
  unstable_cloning: { owner: "defend", effect: { type: "cloneOnNaturalDoubles" } },
  // Mutants (knockout): re-roll attack 1s against the Bringer of Nuclear Fire (applied when rolling, see dice.mjs).
  mutants_knockout_1: { owner: "attack", effect: { type: "rerollOnes", against: "bringer_of_nuclear_fire" } }
};

/** Whole-battle rule flags (stored on the battle message as `system.rules`). */
export function emptyRules() {
  return {
    winTies: [],                   // [{side, value}] the side wins ties on dice showing value
    conquerOnNaturalTriple: false, // enclave_2
    protectOnDoubleSix: false,     // mechaniker_2
    cloneOnNaturalDoubles: false,  // unstable_cloning
    rerollOnes: false,             // mutants_knockout_1 (only used at roll time)
    unmodifiable: [],              // sides whose dice can't be modified (EMP, Fallout Zone)
    fortified: false,              // a real, active fortification (worn by 3-troop attacks)
    fortifiedBy: ""                // "fortification" | "mechaniker_1" | ""
  };
}

/**
 * Flatten a catalog effect (`{type: "all", effects, exempt}` composites) into a list of `{effect, exempt}`.
 * @param {object|null} effect
 * @param {string[]} [exempt]
 * @returns {{effect: object, exempt: string[]}[]}
 */
export function flattenEffect(effect, exempt = []) {
  if ( !effect || (typeof effect !== "object") ) return [];
  if ( effect.type === "all" ) {
    const ex = [...exempt, ...(effect.exempt ?? [])];
    return (effect.effects ?? []).flatMap(e => flattenEffect(e, ex));
  }
  return [{ effect, exempt }];
}

/**
 * Evaluate a modifier condition against the battle.
 * @param {string} condition
 * @param {object} ctx  {state, battle, territory}
 * @returns {boolean}
 */
export function testCondition(condition, { state, battle, territory }) {
  if ( !condition ) return true;
  switch ( condition ) {
    case "defendingTerritoryHasHQ":
      return !!territory?.hq;
    case "firstTerritoryAttackedThisTurn": {
      const first = state?.turn?.log?.firstAttackTarget ?? "";
      return !first || (first === battle.to);
    }
    default:
      return false;   // unknown conditions never apply (safe default)
  }
}

/**
 * Decide which modifiers apply to a battle.
 *
 * @param {object} state   a BoardState (module/state/snapshot.mjs) or a subset: {territories, factions, turn}
 * @param {object} battle  {attacker, defender, from, to, attackDice?, activeEvents?: string[]}
 * @param {object} [options]
 * @param {(category: string, id: string) => object|null} [options.lookup]  content catalog lookup (findEntry)
 * @returns {{sources: object[], rules: object, notes: {key: string, data: object}[]}}
 *   sources: [{source, label, side, die, delta}]  (side "attack"|"defend", die "highest"|"lowest"|"all")
 */
export function collectSources(state, battle, { lookup } = {}) {
  const find = (category, id) => {
    if ( !lookup || !id ) return null;
    try { return lookup(category, id) ?? null; } catch(err) { return null; }
  };
  const territory = state?.territories?.[battle.to] ?? {};
  const factions = state?.factions ?? {};
  const roles = { attack: factions[battle.attacker] ?? null, defend: factions[battle.defender] ?? null };
  const keyOf = side => normalizeKey(roles[side]?.key);
  const powersOf = side => new Set((roles[side]?.powers ?? []).map(normalizeKey).filter(Boolean));
  const powers = { attack: powersOf("attack"), defend: powersOf("defend") };
  const ctx = { state, battle, territory };
  const rules = emptyRules();
  const notes = [];
  const sources = [];
  const unmodifiable = new Set();

  /** Effects of the powers held by one side, as [{key, label, effect}] (built-ins first, then the catalog). */
  const powerEffects = side => {
    const out = [];
    for ( const key of powers[side] ) {
      const builtin = COMBAT_POWERS[key];
      if ( builtin ) {
        if ( builtin.owner === side ) out.push({ key, label: `RL.Battle.Mod.${key}`, effect: builtin.effect });
        continue;
      }
      const entry = find("powers", key) ?? find("secretPowers", key);
      if ( !entry?.effect ) continue;
      const owner = entry.owner ? sideOf(entry.owner) : ({ attack: "attack", defend: "defend" })[entry.timing];
      if ( owner !== side ) continue;
      for ( const { effect } of flattenEffect(entry.effect) ) out.push({ key, label: entry.name ?? key, effect });
    }
    return out;
  };
  const effects = { attack: powerEffects("attack"), defend: powerEffects("defend") };

  /** Does a faction holding these power effects ignore this scar on this side? */
  const ignores = (scarId, side) => effects[side].find(({ effect }) => (effect.type === "ignoreScar")
    && (normalizeKey(effect.scar) === scarId) && ((sideOf(effect.side) ?? side) === side));

  /** Add a dieMod effect from a territory feature (scar, mark, event). */
  const addTerritoryMod = (effect, source, label, exempt = []) => {
    const side = sideOf(effect.side);
    if ( !side || !Number(effect.delta) ) return;
    if ( exempt.includes(keyOf(side)) ) return;
    if ( !testCondition(effect.condition, ctx) ) return;
    sources.push({ source, label, side, die: effect.die ?? "highest", delta: Number(effect.delta) });
  };

  // 1. Fortification: +1 to both defence dice (a real fortification, or Die Mechaniker's starting HQ).
  const virtualFort = powers.defend.has("mechaniker_1") && !!roles.defend?.startingTerritory
    && (roles.defend.startingTerritory === battle.to);
  rules.fortified = !!territory.fortified;
  if ( territory.fortified || virtualFort ) {
    rules.fortifiedBy = territory.fortified ? "fortification" : "mechaniker_1";
    sources.push({
      source: rules.fortifiedBy,
      label: territory.fortified ? "RL.Battle.Mod.fortification" : "RL.Battle.Mod.mechaniker_1",
      side: "defend", die: "all", delta: 1
    });
  }

  // 2. The scar on the defending territory (base scars from CONFIG, pack scars from the catalog).
  const scarId = normalizeKey(territory.scar);
  if ( scarId ) {
    const entry = find("scars", scarId);
    const effect = SCARS[scarId]?.effect ?? entry?.effect ?? null;
    const label = SCARS[scarId]?.label ?? entry?.name ?? scarId;
    for ( const { effect: e, exempt } of flattenEffect(effect) ) {
      if ( e.type !== "dieMod" ) continue;
      const side = sideOf(e.side);
      const ignoredBy = side && ignores(scarId, side);
      if ( ignoredBy ) {
        notes.push({ key: "RL.Battle.Note.ignoreScar", data: { power: ignoredBy.label, scar: label } });
        continue;
      }
      addTerritoryMod(e, scarId, label, exempt);
    }
  }

  // 3. Pack marks on the defending territory (Fallout Zone: unmodifiable dice; any dieMod marks).
  for ( const markId of territory.marks ?? [] ) {
    const entry = find("marks", markId);
    for ( const { effect, exempt } of flattenEffect(entry?.effect) ) {
      if ( effect.type === "dieMod" ) addTerritoryMod(effect, markId, entry?.name ?? markId, exempt);
      else if ( effect.type === "unmodifiable" ) {
        for ( const side of SIDES ) if ( !exempt.includes(keyOf(side)) ) unmodifiable.add(side);
        notes.push({ key: "RL.Battle.Note.unmodifiable", data: { source: entry?.name ?? markId } });
      }
    }
  }

  // 4. Events in play with combat effects.
  for ( const eventId of battle.activeEvents ?? [] ) {
    const entry = find("events", eventId);
    for ( const { effect, exempt } of flattenEffect(entry?.effect) ) {
      if ( effect.type === "dieMod" ) addTerritoryMod(effect, eventId, entry?.name ?? eventId, exempt);
    }
  }

  // 5. Faction powers of both sides.
  for ( const side of SIDES ) {
    for ( const { key, label, effect } of effects[side] ) {
      switch ( effect.type ) {
        case "dieMod": {
          const target = sideOf(effect.side);
          if ( !target || !Number(effect.delta) || !testCondition(effect.condition, ctx) ) break;
          sources.push({ source: key, label, side: target, die: effect.die ?? "highest", delta: Number(effect.delta) });
          break;
        }
        case "winTies":
          rules.winTies.push({ side: sideOf(effect.side) ?? side, value: Number(effect.value) || DIE_MAX });
          break;
        case "conquerOnNaturalTriple": rules.conquerOnNaturalTriple = true; break;
        case "protectOnDoubleSix": rules.protectOnDoubleSix = true; break;
        case "cloneOnNaturalDoubles": rules.cloneOnNaturalDoubles = true; break;
        case "rerollOnes":
          if ( !effect.against || powers.defend.has(normalizeKey(effect.against)) ) rules.rerollOnes = true;
          break;
        default: break;
      }
    }
  }

  // 6. EMP (missile power): dice rolled for combat in that territory can't be modified this turn.
  const emp = (state?.turn?.log?.flags?.emp ?? []).includes(battle.to);
  if ( emp ) {
    for ( const side of SIDES ) unmodifiable.add(side);
    notes.push({ key: "RL.Battle.Note.emp", data: {} });
  }

  rules.unmodifiable = SIDES.filter(s => unmodifiable.has(s));
  const finalSources = sources.filter(s => !unmodifiable.has(s.side));
  return { sources: finalSources, rules, notes };
}

/**
 * Compute one side's dice from their natural values, the modifier sources and the missiles fired.
 *
 * @param {{slot: number, natural: number, missile?: boolean, missileBy?: string}[]} dice
 * @param {object[]} sources   from collectSources (all sides; only `side` ones are used)
 * @param {"attack"|"defend"} side
 * @returns {{slot, natural, value, missile, missileBy, mods: {source, label, delta}[]}[]}  sorted high → low
 */
export function applySources(dice, sources, side) {
  const natural = [...dice].map((d, i) => ({ ...d, slot: Number.isInteger(d.slot) ? d.slot : i }))
    .sort((a, b) => (b.natural - a.natural) || (a.slot - b.slot));
  const out = new Map(natural.map(d => [d.slot, {
    slot: d.slot, natural: clampDie(d.natural), value: clampDie(d.natural),
    missile: !!d.missile, missileBy: d.missileBy ?? "", mods: []
  }]));
  for ( const src of sources ) {
    if ( src.side !== side ) continue;
    let targets;
    switch ( src.die ) {
      case "highest": case "higher": targets = natural.slice(0, 1); break;
      case "lowest": case "lower": targets = natural.slice(-1); break;
      case "all": case "both": targets = natural; break;
      default: targets = [];
    }
    for ( const d of targets ) out.get(d.slot).mods.push({ source: src.source, label: src.label, delta: src.delta });
  }
  for ( const die of out.values() ) {
    if ( die.missile ) {
      die.value = DIE_MAX;
      die.mods = [];
    }
    else die.value = clampDie(die.natural + die.mods.reduce((n, m) => n + m.delta, 0));
  }
  return sortDice([...out.values()]);
}

/** Sort dice high → low by final value (ties: missile first, then higher natural, then roll order). */
export function sortDice(dice) {
  return [...dice].sort((a, b) => (b.value - a.value) || (Number(!!b.missile) - Number(!!a.missile))
    || (b.natural - a.natural) || (a.slot - b.slot));
}

/**
 * ARCHITECTURE §5.3: compute the modified dice of a battle.
 *
 * @param {object} state   BoardState
 * @param {object} battle  {attacker, defender, from, to, activeEvents?, attack: [{slot, natural, missile}], defend: [...]}
 * @param {object} [options]  {lookup}
 * @returns {{attack: object[], defend: object[], sources: object[], rules: object, notes: object[]}}
 */
export function computeModifiers(state, battle, options = {}) {
  const { sources, rules, notes } = collectSources(state, battle, options);
  return {
    attack: applySources(battle.attack ?? [], sources, "attack"),
    defend: applySources(battle.defend ?? [], sources, "defend"),
    sources, rules, notes
  };
}

/**
 * Compare the dice of a rolled battle (highest vs highest, second vs second; the defender wins ties unless a
 * `winTies` rule says otherwise; extra dice are ignored) and work out the special outcomes.
 *
 * @param {object} battle  {attack: die[], defend: die[], rules}
 * @returns {{
 *   pairs: {attack: number, defend: number, winner: "attack"|"defend"}[],
 *   attackerLosses: number, defenderLosses: number, ignored: {attack: number[], defend: number[]},
 *   conquerAll: boolean, protect: boolean, clone: boolean
 * }}
 */
export function resolveDice({ attack = [], defend = [], rules = {} }) {
  const a = sortDice(attack);
  const d = sortDice(defend);
  const n = Math.min(a.length, d.length);
  const winTies = rules.winTies ?? [];
  const pairs = [];
  let attackerLosses = 0;
  let defenderLosses = 0;
  for ( let i = 0; i < n; i++ ) {
    let winner;
    if ( a[i].value > d[i].value ) winner = "attack";
    else if ( a[i].value < d[i].value ) winner = "defend";
    else winner = winTies.some(w => (w.side === "attack") && (w.value === a[i].value)) ? "attack" : "defend";
    if ( winner === "attack" ) defenderLosses++;
    else attackerLosses++;
    pairs.push({ attack: a[i].slot, defend: d[i].slot, winner });
  }
  const naturalTriple = (attack.length === 3) && attack.every(x => x.natural === attack[0].natural);
  const naturalDoubles = (defend.length === 2) && (defend[0].natural === defend[1].natural);
  const doubleSix = naturalDoubles && (defend[0].natural === DIE_MAX);
  return {
    pairs, attackerLosses, defenderLosses,
    ignored: { attack: a.slice(n).map(x => x.slot), defend: d.slice(n).map(x => x.slot) },
    conquerAll: !!rules.conquerOnNaturalTriple && naturalTriple && (defenderLosses >= 1),
    protect: !!rules.protectOnDoubleSix && doubleSix,
    clone: !!rules.cloneOnNaturalDoubles && naturalDoubles
  };
}

/**
 * Troops lost when entering a territory with an `enterLoss` effect (Fallout Zone: half, rounded up), counted on
 * everything moved in so far. Returns how many more troops must be removed now.
 * @param {number} movedIn      total troops moved in by the conquest so far
 * @param {number} alreadyLost  troops already removed for this effect
 * @param {{fraction: number, round: "up"|"down"}} effect
 */
export function enterLossDue(movedIn, alreadyLost, effect) {
  const raw = Math.max(0, movedIn) * (Number(effect?.fraction) || 0);
  const total = effect?.round === "down" ? Math.floor(raw) : Math.ceil(raw);
  return Math.max(0, total - Math.max(0, alreadyLost));
}

/**
 * The `enterLoss` effect of a territory for a faction, if any (marks or scar; exempt factions are skipped).
 * @param {object} territory   TerritoryState
 * @param {string} factionKey
 * @param {(category: string, id: string) => object|null} [lookup]
 * @returns {{fraction: number, round: string, source: string}|null}
 */
export function enterLossFor(territory, factionKey, lookup) {
  const key = normalizeKey(factionKey);
  const candidates = [...(territory?.marks ?? []).map(id => ["marks", id])];
  if ( territory?.scar ) candidates.push(["scars", territory.scar]);
  for ( const [category, id] of candidates ) {
    let entry = null;
    try { entry = lookup?.(category, id) ?? null; } catch(err) { entry = null; }
    for ( const { effect, exempt } of flattenEffect(entry?.effect) ) {
      if ( (effect.type === "enterLoss") && !exempt.includes(key) ) return { ...effect, source: entry?.name ?? id };
    }
  }
  return null;
}
