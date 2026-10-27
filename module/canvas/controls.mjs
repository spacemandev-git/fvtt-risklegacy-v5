import { PIECES, SYSTEM_ID } from "../config.mjs";
import { canActFor, getBoardScene, getBoardVariant, getFactions, pieceKind } from "../state/_module.mjs";
import { boardForScene, centerOf, isBoardScene, piecesByTerritory, territoryAt } from "./geometry.mjs";
import { arrangeTerritory, clearPieces, mergePieces, setTroops, splitPiece } from "./pieces.mjs";
import { buildBoardScene } from "./scene.mjs";
import { pickTerritory } from "./interaction.mjs";

/**
 * Scene controls (the "Risk Legacy" group, layer `rlBoard`) and the token HUD buttons for pieces.
 */

/** @returns {object} game.risklegacy.apps or {} */
const apps = () => game.risklegacy?.apps ?? {};

/**
 * The Risk Legacy scene-control group. Returned by RLBoardLayer.prepareSceneControls.
 * @returns {object} SceneControl
 */
export function sceneControl() {
  const isGM = game.user.isGM;
  const setting = key => game.settings.get(SYSTEM_ID, key);
  return {
    name: "rlBoard",
    order: 2,
    title: "RL.Canvas.Controls.group",
    icon: "fa-solid fa-earth-europe",
    layer: "rlBoard",
    visible: true,
    activeTool: "inspect",
    onChange: (event, active) => {
      if ( active ) canvas.rlBoard?.activate();
    },
    onToolChange: () => {},
    tools: {
      inspect: {
        name: "inspect", order: 1, title: "RL.Canvas.Controls.inspect", icon: "fa-solid fa-magnifying-glass"
      },
      arrange: {
        name: "arrange", order: 2, title: "RL.Canvas.Controls.arrange", icon: "fa-solid fa-broom", button: true,
        onChange: () => runTool(() => arrangeTerritory({ animate: true }))
      },
      counts: {
        name: "counts", order: 3, title: "RL.Canvas.Controls.counts", icon: "fa-solid fa-hashtag", toggle: true,
        active: setting("canvas.showCounts"),
        onChange: (event, active) => game.settings.set(SYSTEM_ID, "canvas.showCounts", !!active)
      },
      tooltip: {
        name: "tooltip", order: 4, title: "RL.Canvas.Controls.tooltip", icon: "fa-solid fa-circle-info", toggle: true,
        active: setting("canvas.showTooltip"),
        onChange: (event, active) => game.settings.set(SYSTEM_ID, "canvas.showTooltip", !!active)
      },
      setTroops: {
        name: "setTroops", order: 5, title: "RL.Canvas.Controls.setTroops", icon: "fa-solid fa-chess-pawn",
        button: true, visible: isGM, onChange: () => runTool(gmSetTroops)
      },
      rebuild: {
        name: "rebuild", order: 6, title: "RL.Canvas.Controls.rebuild", icon: "fa-solid fa-map", button: true,
        visible: isGM, onChange: () => runTool(gmRebuild)
      },
      clear: {
        name: "clear", order: 7, title: "RL.Canvas.Controls.clear", icon: "fa-solid fa-trash", button: true,
        visible: isGM, onChange: () => runTool(gmClear)
      }
    }
  };
}

async function runTool(fn) {
  try {
    await fn();
  } catch(err) {
    console.error(`${SYSTEM_ID} | board tool failed`, err);
    ui.notifications.error(err.message);
  }
}

/* -------------------------------------------- */
/*  Dialog helpers (apps' shared dialogs when present, DialogV2 otherwise)          */
/* -------------------------------------------- */

async function confirm({ title, content, destructive = false }) {
  if ( typeof apps().confirmAction === "function" ) return apps().confirmAction({ title, content, destructive });
  return foundry.applications.api.DialogV2.confirm({
    window: { title }, content: `<p>${content}</p>`, classes: ["risklegacy"], rejectClose: false
  });
}

async function chooseOption({ title, content, options }) {
  if ( typeof apps().chooseOption === "function" ) return apps().chooseOption({ title, content, options });
  const select = options.map(o => `<option value="${o.value}">${foundry.utils.escapeHTML(o.label)}</option>`).join("");
  return foundry.applications.api.DialogV2.prompt({
    window: { title }, classes: ["risklegacy"], rejectClose: false,
    content: `<p>${content ?? ""}</p><select name="choice">${select}</select>`,
    ok: { callback: (event, button) => button.form.elements.choice.value }
  });
}

async function chooseNumber({ title, label, min = 0, max = 99, value = 0 }) {
  if ( typeof apps().chooseNumber === "function" ) return apps().chooseNumber({ title, label, min, max, value });
  const result = await foundry.applications.api.DialogV2.prompt({
    window: { title }, classes: ["risklegacy"], rejectClose: false,
    content: `<label>${label} <input type="number" name="n" min="${min}" max="${max}" value="${value}" autofocus></label>`,
    ok: { callback: (event, button) => button.form.elements.n.valueAsNumber }
  });
  return Number.isFinite(result) ? result : null;
}

/* -------------------------------------------- */
/*  GM tools                                    */
/* -------------------------------------------- */

/** Pick a territory, a faction and a count; set that faction's troops there. */
async function gmSetTroops() {
  const territory = await pickTerritory({ prompt: "RL.Canvas.Controls.setTroopsPrompt" });
  if ( !territory ) return;
  const scene = getBoardScene();
  const name = boardForScene(scene)?.territories?.[territory]?.name ?? territory;
  const present = {};
  for ( const p of piecesByTerritory(scene).get(territory) ?? [] ) {
    present[p.faction] = (present[p.faction] ?? 0) + (PIECES[p.kind]?.value ?? 0);
  }
  const factions = getFactions();
  if ( !factions.length ) return ui.notifications.warn("RL.Canvas.Error.noFactions", { localize: true });
  const owner = Object.entries(present).sort((a, b) => b[1] - a[1])[0]?.[0];
  const ordered = [...factions].sort((a, b) => (b.id === owner) - (a.id === owner));
  const faction = await chooseOption({
    title: game.i18n.format("RL.Canvas.Controls.setTroopsTitle", { name }),
    content: game.i18n.localize("RL.Canvas.Controls.chooseFaction"),
    options: ordered.map(a => ({ value: a.id, label: a.name, img: a.img, hint: present[a.id] ? String(present[a.id]) : "" }))
  });
  if ( !faction ) return;
  const count = await chooseNumber({
    title: game.i18n.format("RL.Canvas.Controls.setTroopsTitle", { name }),
    label: game.i18n.localize("RL.Canvas.Controls.troops"), min: 0, max: 99, value: present[faction] ?? 0
  });
  if ( count === null || count === undefined ) return;
  await setTroops({ faction, territory, count });
}

async function gmRebuild() {
  const ok = await confirm({
    title: game.i18n.localize("RL.Canvas.Controls.rebuild"),
    content: game.i18n.localize("RL.Canvas.Controls.rebuildConfirm")
  });
  if ( !ok ) return;
  await buildBoardScene({ variant: getBoardVariant() });
  ui.notifications.info("RL.Canvas.Notify.rebuilt", { localize: true });
}

async function gmClear() {
  const ok = await confirm({
    title: game.i18n.localize("RL.Canvas.Controls.clear"),
    content: game.i18n.localize("RL.Canvas.Controls.clearConfirm"),
    destructive: true
  });
  if ( ok ) await clearPieces({});
}

/* -------------------------------------------- */
/*  Token HUD                                   */
/* -------------------------------------------- */

/**
 * Add split/merge buttons to the token HUD of piece tokens.
 * @param {foundry.applications.hud.TokenHUD} hud
 * @param {HTMLElement} element
 */
export function onRenderTokenHUD(hud, element) {
  const doc = hud.document;
  const kind = pieceKind(doc);
  if ( !kind || !isBoardScene(doc?.parent) ) return;
  if ( !canActFor(game.user, doc.actorId) && !doc.isOwner ) return;
  const column = element.querySelector(".col.right") ?? element;
  const add = (action, icon, label, handler) => {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `control-icon rl-hud-${action}`;
    button.dataset.tooltip = "";
    button.setAttribute("aria-label", game.i18n.localize(label));
    button.innerHTML = `<i class="${icon}" inert></i>`;
    button.addEventListener("click", async event => {
      event.preventDefault();
      event.stopPropagation();
      button.disabled = true;
      try {
        await handler();
      } catch(err) {
        console.error(`${SYSTEM_ID} | ${action} failed`, err);
      }
      hud.close();
    });
    column.append(button);
  };
  if ( kind === "triple" ) add("split", "fa-solid fa-arrows-split-up-and-left", "RL.Canvas.HUD.split", () => splitPiece({ token: doc.id }));
  if ( kind === "troop" ) {
    const territory = territoryAt(centerOf(doc), doc.parent);
    const singles = (piecesByTerritory(doc.parent).get(territory) ?? [])
      .filter(p => (p.faction === doc.actorId) && (p.kind === "troop")).length;
    if ( singles >= 3 ) add("merge", "fa-solid fa-object-group", "RL.Canvas.HUD.merge", () => mergePieces({ token: doc.id }));
  }
}
