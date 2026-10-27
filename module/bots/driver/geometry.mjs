/**
 * Board-geometry picks for bots (BOTS.md §6.3): sea lines and the Alien Island point. Code only, no Jev: sample
 * candidates and validate them with the existing helpers (`campaign.placementTargets.coastal`, `campaign.seaLinePoints`,
 * `board.isOpenWater`).
 */
import { seaLineCandidates } from "./prompts.mjs";
import { RL } from "./util.mjs";

/**
 * Two coastal, non-adjacent territories for a pen sea line, preferring one that starts on the bot's own coast and
 * reaches an enemy or an HQ, drawn clear of other land.
 * @param {object} ctx   BotContext
 * @param {{a?: string|null, b?: string|null, exclude?: string[]}} [options]
 * @returns {{a: string, b: string, points: number[][], clean: boolean}|null}
 */
export function chooseSeaLine(ctx, { a = null, b = null, exclude = [] } = {}) {
  const board = RL().state.getCampaignBoard();
  const coastal = RL().campaign.placementTargets?.coastal?.() ?? [];
  if ( !board || (coastal.length < 2) ) return null;
  const adjacent = (x, y) => !!board.areAdjacent?.(x, y);
  let candidates;
  if ( a && b ) candidates = [{ a, b }];
  else if ( a ) candidates = seaLineCandidates(ctx.state, ctx.me, coastal, adjacent, { b: a, exclude }).map(p => ({ a, b: p.a }));
  else candidates = seaLineCandidates(ctx.state, ctx.me, coastal, adjacent, { b, exclude });
  let fallback = null;
  for ( const c of candidates.slice(0, 25) ) {
    let line;
    try {
      line = RL().campaign.seaLinePoints(c.a, c.b);
    } catch(err) {
      continue;
    }
    const answer = { a: c.a, b: c.b, points: line?.points ?? [], clean: !!line?.clean };
    if ( answer.clean ) return answer;
    fallback ??= answer;
  }
  return fallback;
}

/**
 * An open-water point for the Alien Island sticker, as close as possible to the bot's own territories.
 * @param {object} ctx
 * @param {{radius?: number}} [options]
 * @returns {{x: number, y: number}|null}
 */
export function chooseAlienIslandPoint(ctx, { radius = 150 } = {}) {
  const board = RL().state.getCampaignBoard();
  const water = RL().board?.isOpenWater;
  if ( !board || (typeof water !== "function") ) return null;
  const width = board.scene?.width ?? 6000;
  const height = board.scene?.height ?? 4000;
  const mine = (ctx.state?.factions?.[ctx.me]?.territories ?? []).map(id => board.territories?.[id]?.center).filter(Boolean);
  const dist = (x, y) => (mine.length ? Math.min(...mine.map(([cx, cy]) => Math.hypot(cx - x, cy - y))) : 0);
  const r = Number(radius) || 150;
  let best = null;
  for ( let y = r + 60; y < height - r - 60; y += 150 ) {
    for ( let x = r + 60; x < width - r - 60; x += 150 ) {
      let ok;
      try {
        ok = water({ x, y }, r)?.ok;
      } catch(err) {
        ok = false;
      }
      if ( !ok ) continue;
      const d = dist(x, y);
      if ( !best || (d < best.d) ) best = { x, y, d };
    }
  }
  return best ? { x: Math.round(best.x), y: Math.round(best.y) } : null;
}
