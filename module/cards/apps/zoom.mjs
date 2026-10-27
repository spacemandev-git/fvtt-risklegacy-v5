/**
 * Hover zoom for card images. Any element with `data-zoom` inside the container (an <img>, or any element whose
 * `data-zoom` value is the image URL) shows a large copy of the card beside it while hovered. Landscape cards
 * (scar, mission, draft) set `data-orientation="landscape"`. The preview is one fixed element per document, so it
 * is never clipped by a window. Re-attach after every render (the hovered elements are replaced).
 * @param {HTMLElement|null} container
 */
export function attachZoom(container) {
  if ( !container ) return;
  const stale = container.ownerDocument.getElementById("rl-card-zoom");
  if ( stale ) stale.hidden = true;
  for ( const el of container.querySelectorAll("[data-zoom]") ) {
    el.addEventListener("pointerenter", show);
    el.addEventListener("pointerleave", hide);
  }
}

const SIZE = { portrait: { w: 300, h: 417 }, landscape: { w: 440, h: 315 } };
const GAP = 14;

function zoomElement(doc) {
  let zoom = doc.getElementById("rl-card-zoom");
  if ( !zoom ) {
    zoom = doc.createElement("div");
    zoom.id = "rl-card-zoom";
    zoom.className = "risklegacy rl-zoom";
    zoom.hidden = true;
    zoom.innerHTML = "<img alt=\"\">";
    doc.body.append(zoom);
  }
  return zoom;
}

function show(event) {
  const el = event.currentTarget;
  const src = el.dataset.zoom || el.getAttribute("src");
  if ( !src ) return;
  const doc = el.ownerDocument;
  const view = doc.defaultView;
  const zoom = zoomElement(doc);
  const landscape = el.dataset.orientation === "landscape";
  const size = SIZE[landscape ? "landscape" : "portrait"];
  const scale = Math.min(1, (view.innerHeight - 40) / size.h);
  const w = size.w * scale;
  const h = size.h * scale;
  const r = el.getBoundingClientRect();
  let left = r.right + GAP;
  if ( left + w > view.innerWidth - 8 ) left = r.left - GAP - w;
  if ( left < 8 ) left = Math.max(8, Math.min(view.innerWidth - w - 8, r.left));
  const top = Math.max(8, Math.min(view.innerHeight - h - 8, r.top + (r.height / 2) - (h / 2)));
  zoom.classList.toggle("is-landscape", landscape);
  Object.assign(zoom.style, { left: `${left}px`, top: `${top}px`, width: `${w}px`, height: `${h}px` });
  zoom.querySelector("img").src = src;
  zoom.hidden = false;
}

function hide(event) {
  const zoom = event.currentTarget.ownerDocument.getElementById("rl-card-zoom");
  if ( zoom ) zoom.hidden = true;
}
