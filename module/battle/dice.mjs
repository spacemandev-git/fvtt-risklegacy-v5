/**
 * Rolling combat dice: one Foundry Roll ("Nd6 + Md6": black attack dice, red defence dice), shown with Dice So Nice
 * when it is active. The rolls are not attached to the chat message (the battle card renders its own dice), so
 * Dice So Nice is driven explicitly with `showForRoll` and we wait for the animation before revealing the result.
 */

/** Dice So Nice appearance of the black attack dice and the red defence dice (rulebook p.5). */
export const ATTACK_APPEARANCE = { foreground: "#ffffff", background: "#141414", outline: "#000000", edge: "#2b2b2b", texture: "none" };
export const DEFEND_APPEARANCE = { foreground: "#ffffff", background: "#b5121b", outline: "#4a0000", edge: "#8e0d12", texture: "none" };

/** Longest we wait for a Dice So Nice animation before carrying on. */
const DSN_TIMEOUT = 12_000;

/** @returns {boolean} whether Dice So Nice is active on this client */
export function diceSoNiceActive() {
  return !!(game.modules.get("dice-so-nice")?.active && game.dice3d);
}

/**
 * Roll the dice of one combat roll.
 * @param {object} options
 * @param {number} options.attackDice           1..3
 * @param {number} options.defendDice           1..2
 * @param {boolean} [options.rerollOnes]        re-roll attack 1s until they aren't 1s (Mutants vs Bringer)
 * @param {boolean} [options.show=true]         animate with Dice So Nice
 * @param {ChatMessage} [options.message]       the battle message (for Dice So Nice visibility)
 * @param {User} [options.user]                 the user the throw is shown for
 * @returns {Promise<{attack: {slot, natural}[], defend: {slot, natural}[], rerolled: number}>}
 */
export async function rollCombatDice({ attackDice, defendDice, rerollOnes = false, show = true, message = null, user = null }) {
  const roll = new Roll(`${attackDice}d6 + ${defendDice}d6`, {}, { risklegacy: "battle" });
  const [attackTerm, defendTerm] = roll.dice;
  attackTerm.options.appearance = { ...ATTACK_APPEARANCE };
  defendTerm.options.appearance = { ...DEFEND_APPEARANCE };
  await roll.evaluate({ allowInteractive: false });
  const attack = attackTerm.results.filter(r => r.active !== false).map(r => r.result);
  const defend = defendTerm.results.filter(r => r.active !== false).map(r => r.result);

  // Mutants vs Bringer of Nuclear Fire: re-roll 1s on the attack dice until they are no longer 1s.
  const rerolls = [];
  if ( rerollOnes ) {
    for ( let i = 0; i < attack.length; i++ ) {
      let guard = 0;
      while ( (attack[i] === 1) && (guard++ < 50) ) {
        const again = new Roll("1d6");
        again.dice[0].options.appearance = { ...ATTACK_APPEARANCE };
        await again.evaluate({ allowInteractive: false });
        rerolls.push(again);
        attack[i] = again.total;
      }
    }
  }

  if ( show ) {
    await showDice(roll, { message, user });
    for ( const r of rerolls ) await showDice(r, { message, user });
  }
  return {
    attack: attack.map((natural, slot) => ({ slot, natural })),
    defend: defend.map((natural, slot) => ({ slot, natural })),
    rerolled: rerolls.length
  };
}

/**
 * Show a roll with Dice So Nice on every client and wait for the animation (bounded by a timeout).
 * @param {Roll} roll
 * @param {object} [options]
 */
export async function showDice(roll, { message = null, user = null } = {}) {
  if ( !diceSoNiceActive() ) return;
  try {
    const shown = game.dice3d.showForRoll(roll, user ?? game.user, true, null, false, message?.id ?? null,
      message?.speaker ?? null);
    await Promise.race([shown, new Promise(resolve => setTimeout(resolve, DSN_TIMEOUT))]);
  } catch(err) {
    console.warn("risklegacy | Dice So Nice could not show the battle roll", err);
  }
}
