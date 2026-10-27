/**
 * Shared dialogs (DialogV2 in the Risk Legacy design). Every function resolves to the chosen value, or `null` when
 * the dialog is cancelled or dismissed. Other areas use these through `game.risklegacy.apps.*` or by importing
 * `module/apps/_module.mjs`.
 *
 * `content` strings are inserted as trusted HTML (they're built by system code). Escape any player-authored text
 * you put in them (`foundry.utils.escapeHTML`).
 */
import { tpl } from "./helpers.mjs";

const { DialogV2 } = foundry.applications.api;
const { FormDataExtended } = foundry.applications.ux;

/** Render a dialog template into an attribute-less <div> (DialogV2 then skips HTML cleaning: trusted markup). */
async function body(template, data) {
  const div = document.createElement("div");
  div.innerHTML = await foundry.applications.handlebars.renderTemplate(tpl(template), data);
  return div;
}

/** Read the dialog's form as a flat object. */
const formData = button => new FormDataExtended(button.form).object;

/** Common window options. */
function frame({ title, icon, width, classes = [] }) {
  return {
    window: { title: title ?? "RL.SystemTitle", icon: icon ?? "" },
    classes: ["risklegacy", "rl-ui-dialog", ...classes],
    position: { width: width ?? 380 }
  };
}

const CANCEL = { action: "cancel", label: "RL.UI.Cancel", type: "button", class: "rl-ui-dialog__cancel" };
const cancelled = result => ((result === "cancel") || (result === undefined) ? null : result);

/* -------------------------------------------- */

/**
 * Ask for a whole number with a big stepper (− [ 7 ] +) and Min / Max shortcuts.
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.label]      field label (key or text)
 * @param {string} [options.hint]       small italic hint under the field
 * @param {string} [options.content]    optional HTML shown above the field (trusted)
 * @param {number} [options.min=0]
 * @param {number} [options.max=99]
 * @param {number} [options.value]      initial value (defaults to max when max is small, else min)
 * @param {number} [options.step=1]
 * @param {string} [options.confirm]    label of the OK button
 * @param {string} [options.icon]
 * @returns {Promise<number|null>}
 */
export async function chooseNumber({ title, label, hint, content, min = 0, max = 99, value, step = 1, confirm, icon } = {}) {
  min = Number(min) || 0;
  max = Math.max(min, Number.isFinite(Number(max)) ? Number(max) : min);
  const clamp = n => Math.min(max, Math.max(min, Math.round(Number(n) || 0)));
  value = clamp(value ?? min);
  const html = await body("dialogs/choose-number.hbs", { label, hint, content, min, max, value, step });
  const result = await DialogV2.wait({
    ...frame({ title, icon, width: 340, classes: ["rl-ui-dialog--number"] }),
    content: html,
    buttons: [CANCEL, {
      action: "ok", label: confirm ?? "RL.UI.Confirm", default: true,
      callback: (event, button) => clamp(formData(button).value)
    }],
    render: (event, dialog) => {
      const input = dialog.element.querySelector("input[name=value]");
      const set = n => {
        input.value = clamp(n);
        input.dispatchEvent(new Event("input"));
      };
      dialog.element.querySelectorAll("[data-step]").forEach(b => b.addEventListener("click", () => {
        set(Number(input.value) + (Number(b.dataset.step) * step));
      }));
      dialog.element.querySelectorAll("[data-set]").forEach(b => b.addEventListener("click", () => {
        set(b.dataset.set === "max" ? max : min);
      }));
      const sync = () => {
        const v = Number(input.value);
        dialog.element.querySelector("[data-step='-1']")?.toggleAttribute("disabled", v <= min);
        dialog.element.querySelector("[data-step='1']")?.toggleAttribute("disabled", v >= max);
      };
      input.addEventListener("input", sync);
      input.addEventListener("change", () => set(input.value));
      sync();
      input.select();
    }
  });
  return cancelled(result);
}

/* -------------------------------------------- */

/**
 * Yes / no confirmation. The destructive variant has hazard tape under the header and a DESTROY button, and the
 * safe choice is the default (Enter cancels).
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.content]      HTML stating the consequence (trusted), shown in a cream callout
 * @param {string} [options.note]         a marker aside after the content, e.g. "(Tough to do, we know.)"
 * @param {boolean} [options.destructive=false]
 * @param {string} [options.yes]          confirm label (default "Confirm" / "Destroy")
 * @param {string} [options.no]           cancel label
 * @param {string} [options.icon]
 * @param {number} [options.width]
 * @returns {Promise<boolean|null>}  true = confirmed, false = declined, null = dismissed
 */
export async function confirmAction({ title, content, note, destructive = false, yes, no, icon, width } = {}) {
  const html = await body("dialogs/confirm.hbs", { content, note, destructive });
  const classes = destructive ? ["rl-ui-dialog--destructive", "rl-hazard-header"] : ["rl-ui-dialog--confirm"];
  const result = await DialogV2.wait({
    ...frame({ title, icon, width: width ?? 420, classes }),
    content: html,
    buttons: [
      { action: "no", label: no ?? "RL.UI.Cancel", default: destructive, class: "rl-ui-dialog__cancel",
        callback: () => false },
      { action: "yes", label: yes ?? (destructive ? "RL.UI.Destroy" : "RL.UI.Confirm"), default: !destructive,
        class: destructive ? "rl-btn--destroy" : "", callback: () => true }
    ]
  });
  return (result === true) || (result === false) ? result : null;
}

/* -------------------------------------------- */

/**
 * Pick one option from tiles (optionally with images). Click a tile to select it, double-click (or Choose) to
 * confirm. With `instant: true` a single click confirms.
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.content]   HTML shown above the tiles (trusted)
 * @param {{value: *, label: string, hint?: string, img?: string, disabled?: boolean, selected?: boolean}[]} options.options
 * @param {string} [options.confirm]   label of the OK button
 * @param {boolean} [options.instant=false]
 * @param {number} [options.columns]   tile columns (default: 1 without images, up to 3 with images)
 * @param {string} [options.icon]
 * @param {number} [options.width]
 * @returns {Promise<*|null>} the chosen option's `value`
 */
export async function chooseOption({ title, content, options = [], confirm, instant = false, columns, icon, width } = {}) {
  const withImages = options.some(o => o.img);
  const firstEnabled = options.findIndex(o => !o.disabled);
  let selected = options.findIndex(o => o.selected && !o.disabled);
  if ( selected < 0 ) selected = firstEnabled;
  const tiles = options.map((o, index) => ({
    ...o, index, label: o.label ?? String(o.value), checked: index === selected
  }));
  columns ??= withImages ? Math.min(3, Math.max(1, options.length)) : 1;
  const html = await body("dialogs/choose-option.hbs", { content, tiles, withImages, columns });
  const result = await DialogV2.wait({
    ...frame({ title, icon, width: width ?? (withImages ? Math.min(640, 140 + (columns * 160)) : 400),
      classes: ["rl-ui-dialog--options"] }),
    content: html,
    buttons: [CANCEL, {
      action: "ok", label: confirm ?? "RL.UI.Choose", default: true, disabled: firstEnabled < 0,
      callback: (event, button) => {
        const index = Number(formData(button).choice);
        return Number.isInteger(index) && options[index] && !options[index].disabled ? { picked: index } : null;
      }
    }],
    render: (event, dialog) => {
      const ok = dialog.element.querySelector("button[data-action=ok]");
      for ( const tile of dialog.element.querySelectorAll(".rl-dlg-option:not(.is-disabled)") ) {
        tile.addEventListener("dblclick", () => ok?.click());
        if ( instant ) tile.addEventListener("click", () => setTimeout(() => ok?.click(), 0));
      }
    }
  });
  const picked = cancelled(result);
  return ((typeof picked === "object") && (picked !== null) && ("picked" in picked)) ? options[picked.picked].value : null;
}

/* -------------------------------------------- */

/**
 * Ask for a line of text. With `hand: true` the field is written "in marker" (city names, signatures, mottos).
 * @param {object} options
 * @param {string} [options.title]
 * @param {string} [options.label]
 * @param {string} [options.value=""]
 * @param {boolean} [options.hand=false]
 * @param {string} [options.placeholder]
 * @param {string} [options.hint]
 * @param {string} [options.content]   HTML above the field (trusted)
 * @param {boolean} [options.required=false]  refuse an empty answer
 * @param {number} [options.maxLength=120]
 * @param {string} [options.confirm]
 * @param {string} [options.icon]
 * @returns {Promise<string|null>} the trimmed text
 */
export async function promptText({ title, label, value = "", hand = false, placeholder, hint, content, required = false,
  maxLength = 120, confirm, icon } = {}) {
  const html = await body("dialogs/prompt-text.hbs", { label, value, hand, placeholder, hint, content, required, maxLength });
  const result = await DialogV2.wait({
    ...frame({ title, icon, width: 400, classes: ["rl-ui-dialog--text", hand ? "rl-ui-dialog--hand" : ""].filter(Boolean) }),
    content: html,
    buttons: [CANCEL, {
      action: "ok", label: confirm ?? "RL.UI.Confirm", default: true,
      callback: (event, button) => ({ text: String(formData(button).text ?? "").trim() })
    }],
    render: (event, dialog) => {
      const input = dialog.element.querySelector("input[name=text]");
      const ok = dialog.element.querySelector("button[data-action=ok]");
      const sync = () => ok?.toggleAttribute("disabled", required && !input.value.trim());
      input?.addEventListener("input", sync);
      sync();
      input?.select();
    }
  });
  const answer = cancelled(result);
  return ((typeof answer === "object") && (answer !== null)) ? answer.text : null;
}
