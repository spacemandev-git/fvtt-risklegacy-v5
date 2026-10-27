import { faction, territory } from "./state.mjs";

/**
 * Faction powers and territory effects (scars and pack marks).
 *
 * Power keys are content-catalog ids (`khan_1`, `well_armed`…). Older data may spell them with hyphens
 * (`well-armed`), so keys are normalised before comparing.
 *
 * Territory effects come from the content catalog (`scars[].effect`, `marks[].effect`, vocabulary in
 * data/content/README.md). The turn controller copies them into `state.effects = {scars, marks, powers}` so the
 * engine stays pure; the built-in table below is the fallback for the ids the rules need.
 */

/** Power keys the engine knows about. */
export const POWERS = Object.freeze({
  khan1: "khan_1", khan2: "khan_2",
  mechaniker1: "mechaniker_1", mechaniker2: "mechaniker_2",
  enclave1: "enclave_1", enclave2: "enclave_2",
  balkania1: "balkania_1", balkania2: "balkania_2",
  saharan1: "saharan_1", saharan2: "saharan_2",
  resourceful: "resourceful", stealthy: "stealthy", wellArmed: "well_armed", mobile: "mobile",
  convincing: "convincing", wellSupplied: "well_supplied",
  emp: "emp", interference: "interference", recon: "recon", badIntel: "bad_intel", rally: "rally",
  bringer: "bringer_of_nuclear_fire",
  alienCollaborator: "alien_collaborator", cautious: "cautious", primitive: "primitive", unpopular: "unpopular",
  shortSighted: "short_sighted", purist: "purist",
  aliensStarter: "aliens_starter", aliensKnockout: "aliens_knockout",
  mutantsStarter: "mutants_starter", mutantsKnockout2: "mutants_knockout_2",
  massHypnosis: "mass_hypnosis"
});

/** Missile powers (cost 1 Missile, once per turn; Rules addition J). */
export const MISSILE_POWERS = Object.freeze(["emp", "interference", "recon", "bad_intel", "rally"]);

/** Built-in territory effects, used when the catalog isn't loaded. */
export const DEFAULT_EFFECTS = Object.freeze({
  scars: {
    bunker: { type: "dieMod", side: "defender", die: "highest", delta: 1 },
    ammo_shortage: { type: "dieMod", side: "defender", die: "highest", delta: -1 },
    mercenary: { type: "endOfTurnTroops", delta: 1 },
    biohazard: { type: "endOfTurnTroops", delta: -1 }
  },
  marks: {
    fallout_zone: {
      type: "all", exempt: ["mutants"], effects: [
        { type: "enterLoss", fraction: 0.5, round: "up" },
        { type: "endOfTurnTroops", delta: -1 },
        { type: "noPlaceTroops" },
        { type: "noManeuverThrough" },
        { type: "unmodifiable" },
        { type: "destroyTerritoryCard" }
      ]
    }
  },
  powers: {
    convincing: { type: "scarModifier", scar: "mercenary", delta: 1 },
    mutants_knockout_2: { type: "reverseScar", scars: ["biohazard", "mercenary"] }
  }
});

const norm = key => String(key ?? "").trim().toLowerCase().replace(/-/g, "_");

/**
 * Does the faction have this power sticker on its card?
 * @param {object} state      BoardState
 * @param {string} factionId
 * @param {string} key        power key (catalog id)
 * @returns {boolean}
 */
export function hasPower(state, factionId, key) {
  const powers = faction(state, factionId)?.powers;
  if ( !powers?.length ) return false;
  const k = norm(key);
  return powers.some(p => norm(p) === k);
}

/** Look up a catalog effect for a scar / mark / power id. */
export function effectOf(state, category, id) {
  if ( !id ) return null;
  const custom = state?.effects?.[category];
  if ( custom && (id in custom) ) return custom[id] ?? null;
  return DEFAULT_EFFECTS[category]?.[id] ?? null;
}

/** Flatten an effect (`all` → its sub-effects), carrying `exempt` and the source id down. */
function flatten(effect, source, exempt = []) {
  if ( !effect ) return [];
  if ( effect.type === "all" ) {
    const ex = [...exempt, ...(effect.exempt ?? [])];
    return (effect.effects ?? []).flatMap(e => flatten(e, source, ex));
  }
  return [{ ...effect, source, exempt: [...exempt, ...(effect.exempt ?? [])] }];
}

/**
 * Every effect on a territory (its scar and pack marks), flattened. When `factionId` is given, effects that faction
 * is exempt from (catalog `exempt: [factionKey]`) are left out.
 * @returns {object[]} effects with `source` (`scar:<id>` / `mark:<id>`) and `id`
 */
export function territoryEffects(state, territoryId, factionId = null) {
  const t = territory(state, territoryId);
  if ( !t ) return [];
  const out = [];
  if ( t.scar ) out.push(...flatten(effectOf(state, "scars", t.scar), `scar:${t.scar}`).map(e => ({ ...e, id: t.scar, kind: "scar" })));
  for ( const m of t.marks ?? [] ) {
    out.push(...flatten(effectOf(state, "marks", m), `mark:${m}`).map(e => ({ ...e, id: m, kind: "mark" })));
  }
  if ( !factionId ) return out;
  const key = faction(state, factionId)?.key;
  return out.filter(e => !key || !e.exempt?.includes(key));
}

/** Does the territory carry an effect of this type that applies to the faction? */
export function territoryHas(state, territoryId, type, factionId = null) {
  return territoryEffects(state, territoryId, factionId).some(e => e.type === type);
}

/** Power effects (catalog `powers[].effect`) of the faction's powers, keyed by power key. */
export function powerEffects(state, factionId) {
  const out = {};
  for ( const key of faction(state, factionId)?.powers ?? [] ) {
    const effect = effectOf(state, "powers", norm(key));
    if ( effect ) out[norm(key)] = effect;
  }
  return out;
}
