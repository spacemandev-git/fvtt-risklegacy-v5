import { SYSTEM_PATH } from "../config.mjs";
import { territoryName } from "./chat.mjs";
import { t } from "./util.mjs";

/**
 * The deploy popover: one click on a territory while placing recruited troops opens a compact slider beside the
 * cursor to choose how many troops go there (1..reserve). Enter deploys, Esc cancels, the arrow keys / Home / End /
 * digits adjust. Clicking outside it cancels (so clicking another territory simply re-targets).
 *
 * Exposed as `game.risklegacy.turn.chooseDeployment` / `closeDeployment`; the canvas area's click-to-place uses it.
 */

const TEMPLATE = `${SYSTEM_PATH}/templates/turn/deploy.hbs`;
export const DEPLOY_TEMPLATES = [TEMPLATE];

/** @type {{element: HTMLElement, finish: function(number|null)}|null} the open popover */
let open = null;

/** Close the open popover (resolves it with null). */
export function closeDeployment() {
  open?.finish(null);
}

/**
 * Ask how many troops to deploy into a territory.
 * @param {object} options
 * @param {string} [options.faction]       faction actor id (name and colour in the header)
 * @param {string} options.territory
 * @param {number} options.max             troops available (the reserve)
 * @param {number} [options.min=1]
 * @param {number} [options.value]         initial value (default: max, i.e. everything that's left)
 * @param {{x: number, y: number}} [options.at]  viewport position to open beside (default: the screen centre)
 * @returns {Promise<number|null>}  the count, or null when cancelled
 */
export async function chooseDeployment({ faction, territory, max, min = 1, value, at } = {}) {
  closeDeployment();
  min = Math.max(1, Math.floor(Number(min) || 1));
  max = Math.max(min, Math.floor(Number(max) || min));
  const clamp = n => Math.min(max, Math.max(min, Math.round(Number(n) || 0)));
  const actor = faction ? game.actors.get(faction) : null;
  const html = await foundry.applications.handlebars.renderTemplate(TEMPLATE, {
    title: t("RL.Turn.Deploy.title", { territory: territoryName(territory) }),
    factionName: actor?.name ?? "", min, max, value: clamp(value ?? max),
    half: Math.max(min, Math.ceil(max / 2)), showHalf: max >= 4
  });

  return new Promise(resolve => {
    const element = document.createElement("div");
    element.className = "risklegacy rl-turn-deploy";
    element.setAttribute("role", "dialog");
    element.setAttribute("aria-modal", "false");
    element.innerHTML = html;
    const css = actor?.system?.color?.css;
    if ( css ) element.style.setProperty("--rl-faction", css);
    document.body.append(element);

    const form = element.querySelector("form");
    const range = element.querySelector("input[name=count]");
    const output = element.querySelector(".rl-turn-deploy__value");
    const set = n => {
      range.value = clamp(n);
      sync();
    };
    const sync = () => {
      const v = clamp(range.value);
      output.textContent = String(v);
      element.querySelector("[data-step='-1']")?.toggleAttribute("disabled", v <= min);
      element.querySelector("[data-step='1']")?.toggleAttribute("disabled", v >= max);
      element.querySelectorAll("[data-set]").forEach(b => b.classList.toggle("is-active", clamp(b.dataset.set) === v));
      range.style.setProperty("--rl-turn-fill", `${max > min ? ((v - min) / (max - min)) * 100 : 100}%`);
    };

    let done = false;
    const finish = result => {
      if ( done ) return;
      done = true;
      if ( open?.element === element ) open = null;
      document.removeEventListener("pointerdown", onOutside, true);
      element.remove();
      resolve(result);
    };
    open = { element, finish };

    // Clicking anywhere else cancels (a click on another territory then opens the popover there)
    const onOutside = event => {
      if ( !element.contains(event.target) ) finish(null);
    };
    document.addEventListener("pointerdown", onOutside, true);

    let digits = "";
    let digitTimer = null;
    element.addEventListener("keydown", event => {
      // Keep the keys away from Foundry's keybindings (Esc would also stop the whole placement)
      event.stopPropagation();
      if ( event.key === "Enter" ) {
        event.preventDefault();
        finish(clamp(range.value));
      }
      else if ( event.key === "Escape" ) {
        event.preventDefault();
        finish(null);
      }
      else if ( /^[0-9]$/.test(event.key) ) {
        event.preventDefault();
        clearTimeout(digitTimer);
        digits = (Number(digits + event.key) > max) ? event.key : (digits + event.key);
        digitTimer = setTimeout(() => (digits = ""), 900);
        set(Number(digits));
        range.focus();
      }
      else if ( ["+", "="].includes(event.key) ) set(Number(range.value) + 1);
      else if ( ["-", "_"].includes(event.key) ) set(Number(range.value) - 1);
    });
    element.addEventListener("keyup", event => event.stopPropagation());
    range.addEventListener("input", sync);
    element.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
      set(Number(range.value) + Number(b.dataset.step));
      range.focus();
    }));
    element.querySelectorAll("[data-set]").forEach(b => b.addEventListener("click", () => {
      set(Number(b.dataset.set));
      range.focus();
    }));
    element.querySelector("[data-action=cancel]")?.addEventListener("click", () => finish(null));
    form.addEventListener("submit", event => {
      event.preventDefault();
      finish(clamp(range.value));
    });
    // Double-clicking the number deploys right away
    output.addEventListener("dblclick", () => finish(clamp(range.value)));

    sync();
    position(element, at);
    // Foundry fires canvas clicks on pointerdown: the browser's default mousedown focus change (to <body>) comes
    // after this, so focus the slider once that has happened too.
    range.focus({ preventScroll: true });
    setTimeout(() => {
      if ( !done && !element.contains(document.activeElement) ) range.focus({ preventScroll: true });
    }, 0);
  });
}

/** Put the popover beside the cursor, flipped/clamped to stay on screen. */
function position(element, at) {
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const { width, height } = element.getBoundingClientRect();
  const gap = 18;
  const x = Number.isFinite(at?.x) ? at.x : vw / 2;
  const y = Number.isFinite(at?.y) ? at.y : vh / 2;
  let left = x + gap;
  if ( left + width > vw - 8 ) left = x - gap - width;
  let top = y - (height / 2);
  left = Math.max(8, Math.min(left, vw - width - 8));
  top = Math.max(8, Math.min(top, vh - height - 8));
  element.style.left = `${Math.round(left)}px`;
  element.style.top = `${Math.round(top)}px`;
}
