import { faction, territory } from "./state.mjs";
import { powerEffects, territoryEffects } from "./powers.mjs";

/**
 * Board effects that trigger on the faction's own turn.
 */

/**
 * End-of-turn troop changes from scars and marks in territories the faction controls (Mercenary +1, Bio-hazard −1,
 * Fallout Zone −1), including power modifiers (`convincing`: +1 more on Mercenary; `mutants_knockout_2`: Bio-hazard
 * and Mercenary reversed). Rulebook p.12: "after any maneuvers, but before collecting a Resource or Mission card".
 * A territory never loses more troops than it holds.
 * @param {object} state
 * @param {string} factionId
 * @returns {{territory: string, delta: number, sources: {id: string, delta: number}[]}[]}
 */
export function endOfTurnEffects(state, factionId) {
  const f = faction(state, factionId);
  if ( !f ) return [];
  const mods = Object.values(powerEffects(state, factionId));
  const out = [];
  for ( const id of f.territories ?? [] ) {
    const t = territory(state, id);
    const sources = [];
    for ( const e of territoryEffects(state, id, factionId) ) {
      if ( e.type !== "endOfTurnTroops" ) continue;
      let delta = e.delta ?? 0;
      for ( const m of mods ) {
        if ( (m.type === "scarModifier") && (m.scar === e.id) ) delta += m.delta ?? 0;
        if ( (m.type === "reverseScar") && (m.scars ?? []).includes(e.id) ) delta = -delta;
      }
      if ( delta ) sources.push({ id: e.id, delta });
    }
    let delta = sources.reduce((n, s) => n + s.delta, 0);
    if ( delta < 0 ) delta = Math.max(delta, -(t?.troops ?? 0));
    if ( delta ) out.push({ territory: id, delta, sources });
  }
  return out;
}
