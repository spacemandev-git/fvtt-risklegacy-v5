import { FACTIONS, SYSTEM_ID, systemPath } from "../config.mjs";

/**
 * Development fixtures: create the minimum world documents areas need to test in isolation, without going through
 * the campaign wizards. Run from the console or `fvtt-browser.mjs eval`:
 *
 *   await game.risklegacy.dev.createTestCampaign({variant: "original"})
 *
 * Creates (if missing) the campaign actor and the five base faction actors. It does NOT create the scene, the decks,
 * a war or tokens: use the owning area's API for those (canvas.buildBoardScene, cards.buildDecks, turn.createWar…).
 */

const BASE = "assets/unlocks/base/factions/images";
const BASE_FACTIONS = {
  balkania: "Imperial Balkania",
  enclave: "Enclave of the Bear",
  khan: "Khan Industries",
  mechaniker: "Die Mechaniker",
  saharan: "Saharan Republic"
};

/**
 * @param {object} [options]
 * @param {"original"|"advanced"} [options.variant]
 * @returns {Promise<{campaign: Actor, factions: Actor[]}>}
 */
export async function createTestCampaign({ variant = "original" } = {}) {
  if ( !game.user.isGM ) throw new Error("GM only");
  let campaign = game.actors.find(a => a.type === "campaign");
  if ( !campaign ) {
    campaign = await Actor.implementation.create({
      name: "The World", type: "campaign", img: systemPath("assets/icons/star.png"),
      system: { boardVariant: variant, founding: { date: new Date().toISOString().slice(0, 10), signatures: [] } },
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
    });
  }
  await game.settings.set(SYSTEM_ID, "campaignActorId", campaign.id);

  const factions = [];
  for ( const [key, name] of Object.entries(BASE_FACTIONS) ) {
    let actor = game.actors.find(a => (a.type === "faction") && (a.system.key === key));
    actor ??= await Actor.implementation.create({
      name, type: "faction", img: systemPath(`${BASE}/${key}.png`),
      system: {
        key, pack: "base", color: FACTIONS[key].color,
        pieces: {
          troop: systemPath(`${BASE}/${key}_1.png`),
          triple: systemPath(`${BASE}/${key}_3.png`),
          hq: systemPath(`${BASE}/${key}_hq.png`)
        }
      },
      prototypeToken: {
        name, actorLink: true, texture: { src: systemPath(`${BASE}/${key}_1.png`) },
        displayName: CONST.TOKEN_DISPLAY_MODES.NONE, displayBars: CONST.TOKEN_DISPLAY_MODES.NONE,
        lockRotation: true, disposition: CONST.TOKEN_DISPOSITIONS.NEUTRAL
      },
      ownership: { default: CONST.DOCUMENT_OWNERSHIP_LEVELS.OBSERVER }
    });
    factions.push(actor);
  }
  return { campaign, factions };
}
