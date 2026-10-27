import { FORTIFICATION_USES, systemPath } from "../config.mjs";
import { findEntry } from "../state/_module.mjs";

/**
 * Drawing the legacy marks written and stuck on the board (from the campaign actor) into a PIXI container:
 * city stickers with hand-written names, scar stickers, fortification rings with their used boxes marked off,
 * cancelled scars, pack marks, the destroyed-card "x", continent names, ±1 continent stickers, the victors'
 * signatures and the world name; and what changed the map itself: territories added during the campaign (the Alien
 * Island sticker) and sea lines drawn in pen between two sea-line start stickers.
 *
 * Sizes are in scene px for a 6000×4000 board and were matched to the printed bow-tie marks (≈ 82 px wide).
 */

const INK = 0x231f20;
const MARKER_RED = 0xb11116;

/** Sticker art and the geometry of each image (normalized to the image size). */
export const STICKERS = {
  minor: {
    src: "assets/unlocks/base/stickersheet/images/minor_city.png", width: 168,
    band: { x0: 0.06, x1: 0.94, y0: 0.71, y1: 0.885 }, dome: { x: 0.5, y: 0.405, r: 0.455 }
  },
  major: {
    src: "assets/unlocks/base/stickersheet/images/major_city.png", width: 172,
    band: { x0: 0.065, x1: 0.905, y0: 0.72, y1: 0.887 }, dome: { x: 0.5, y: 0.405, r: 0.455 }
  },
  capital: {
    src: "assets/unlocks/secondwin/stickersheet/images/scar_capital.png", width: 200,
    band: { x0: 0.18, x1: 0.85, y0: 0.645, y1: 0.815 }, dome: { x: 0.5, y: 0.36, r: 0.4 }
  },
  scar: { width: 150 },
  fortification: {
    src: "assets/unlocks/base/stickersheet/images/fortification.png",
    // Ring centre and inner radius, and the ten boxes (left end → over the top → right end), in image px of 385×291
    size: [385, 291], center: [185.1, 193.4], inner: 134,
    boxes: [[26.7, 225.5], [24.8, 168.8], [46.9, 108.3], [93.4, 59.4], [156.6, 33.9], [224.8, 36.6], [285.7, 66.5],
      [328.7, 118.7], [346.6, 180.5], [341.3, 237.8]]
  },
  plus: { src: "assets/unlocks/base/stickersheet/images/plus_one.png" },
  minus: { src: "assets/unlocks/base/stickersheet/images/minus_one.png" }
};

/**
 * Art of the territories added to the board during the campaign, by kind (`customTerritories[id].kind`).
 * `center` and `coast` are the island's centre and mean coast radius in image px: the art is scaled so that its coast
 * matches the territory's radius (the territory's Region is a circle of that radius). `outline` is a mask polygon
 * (radius in image px every 360/n degrees, starting east, clockwise on screen) that hugs the coast a few px outside
 * and cuts off the two pieces of the sticker sheet's sea-line tabs that the scan left on the island's sides.
 */
export const TERRITORY_ART = {
  alien_island: {
    src: "assets/unlocks/thirtytroops/rules/images/alien_island.png",
    size: [1080, 1200], center: [544, 587], coast: 511,
    outline: [505, 499, 500, 524, 516, 510, 510, 505, 504, 506, 516, 524, 524, 516, 508, 508, 519, 536, 544, 544,
      544, 544, 544, 536, 542, 549, 550, 550, 537, 531, 532, 531, 516, 524, 524, 524, 512, 501, 503, 528, 536, 538,
      522, 508, 496, 487, 481, 479, 482, 510, 500, 494, 488, 490, 490, 496, 514, 526, 529, 529, 521, 522, 540, 542,
      542, 542, 534, 542, 543, 541, 544, 544, 544, 540, 532, 524, 516, 510, 510, 510, 508, 496, 498, 506, 510, 510,
      508, 495, 486, 484]
  }
};

/** Land and coast of the generic disc drawn for added territories without art (sampled from the printed boards). */
const LAND = 0x8f5520;
const COAST = 0xf3f1ea;

/** Printed sea-line node: light disc, dark ring (scene px). */
const NODE = { radius: 21, ring: 5, fill: 0xeceaef };

/** Pen-drawn sea lines. */
const PEN = { width: 7, alpha: 0.94 };

/** Printed territory names: dark, heavy and condensed; capitals on the original board, as written on the advanced one. */
const FONT_LABEL = ["Big Shoulders Display", "Roboto Condensed", "Arial Narrow", "sans-serif"];
const LABEL_STYLE = {
  original: { upper: true, weight: "800", spacing: 1.5 },
  advanced: { upper: false, weight: "900", spacing: 0.5 }
};

/** Every sticker image the overlay may need (for preloading). */
export function stickerSources() {
  return [STICKERS.minor.src, STICKERS.major.src, STICKERS.capital.src, STICKERS.fortification.src,
    STICKERS.plus.src, STICKERS.minus.src].map(systemPath);
}

/** Load a texture, or null. */
async function texture(src) {
  if ( !src ) return null;
  try {
    return await foundry.canvas.loadTexture(systemPath(src));
  } catch(err) {
    console.warn(`risklegacy | could not load ${src}`, err);
    return null;
  }
}

/**
 * A sprite scaled to a width.
 * @param {PIXI.Texture} tex
 * @param {number} width
 * @param {number} anchorX
 * @param {number} anchorY
 */
function sprite(tex, width, anchorX = 0.5, anchorY = 0.5) {
  const s = new PIXI.Sprite(tex);
  s.anchor.set(anchorX, anchorY);
  s.scale.set(width / tex.width);
  return s;
}

/**
 * Hand-written text ("marker"), shrunk to fit a box.
 * @param {string} text
 * @param {object} options
 * @param {number} options.size       font size (px)
 * @param {number} [options.maxWidth]
 * @param {number} [options.color]
 * @param {string} [options.font]
 * @returns {PIXI.Text}
 */
export function handText(text, { size, maxWidth, color = INK, font = "Gochi Hand", weight = "normal" } = {}) {
  const style = new PIXI.TextStyle({
    fontFamily: [font, "Patrick Hand", "Comic Sans MS", "cursive"], fontSize: size, fill: color,
    fontWeight: weight, padding: 6
  });
  const t = new foundry.canvas.containers.PreciseText(text, style);
  t.resolution = 3;
  if ( maxWidth && (t.width > maxWidth) ) t.scale.set(maxWidth / t.width);
  return t;
}

/**
 * Draw every legacy mark of a campaign.
 * @param {PIXI.Container} container   cleared and refilled
 * @param {object} context
 * @param {object} context.board        board definition
 * @param {Actor} context.campaign
 */
export async function drawMarks(container, { board, campaign }) {
  for ( const c of container.removeChildren() ) c.destroy({ children: true });
  if ( !board || !campaign ) return;
  const sys = campaign.system;
  const land = container.addChild(new PIXI.Container());    // territories added during the campaign
  const ink = container.addChild(new PIXI.Container());     // pen-drawn sea lines and their start stickers
  const under = container.addChild(new PIXI.Container());   // stickers
  const over = container.addChild(new PIXI.Container());    // writing on top

  await drawCustomTerritories(land, board, sys);
  drawSeaLines(ink, board);

  for ( const [id, marks] of Object.entries(sys.territories ?? {}) ) {
    const def = board.territories?.[id];
    if ( !def ) continue;
    await drawTerritoryMarks(under, over, def, marks);
  }
  for ( const [id, cont] of Object.entries(sys.continents ?? {}) ) {
    const def = board.continents?.[id];
    if ( def ) await drawContinent(under, over, def, cont);
  }
  drawVictors(over, board, sys);
  drawWorldName(over, board, sys);
}

/**
 * City, scar, fortification, pack marks and destroyed card of one territory.
 * The bow-tie `mark` is where a city's bottom tab and a scar's top bump meet: cities above, scars below.
 */
async function drawTerritoryMarks(under, over, def, marks) {
  const [mx, my] = def.mark ?? def.center ?? [0, 0];
  const markIds = marks.marks ?? [];

  // Cancelled scar: the white sticker stuck over the lower half
  if ( markIds.includes("cancel_scar") || markIds.includes("scar_cancelled") ) {
    const g = new PIXI.Graphics();
    const r = STICKERS.scar.width / 2;
    g.beginFill(0x000000, 0.18).drawCircle(mx + 3, my + r + 6, r).endFill();
    g.lineStyle(2, 0xd1d3d4, 1).beginFill(0xfbfcfc, 1).drawCircle(mx, my + r + 2, r).endFill();
    under.addChild(g);
  }

  // Scar sticker (lower half)
  if ( marks.scar ) {
    const entry = findEntry("scars", marks.scar);
    const tex = await texture(entry?.stickerImg ?? `assets/unlocks/base/scars/images/scar_${marks.scar}.png`);
    if ( tex ) {
      const s = sprite(tex, STICKERS.scar.width, 0.5, 0);
      s.position.set(mx, my + 2);
      under.addChild(s);
    }
  }

  // City sticker (upper half) with its hand-written name
  const type = marks.city?.type;
  const spec = STICKERS[type];
  if ( spec ) {
    const entry = type === "capital" ? findEntry("stickers", "world_capital") : null;
    const tex = await texture(entry?.img ?? spec.src);
    if ( tex ) {
      const s = sprite(tex, spec.width, 0.5, 1);
      s.position.set(mx, my - 1);
      under.addChild(s);
      const w = spec.width;
      const h = tex.height * (w / tex.width);
      const left = mx - (w / 2);
      const top = my - 1 - h;

      // Fortification ring hugging the dome, used boxes marked off in marker
      if ( marks.fortification?.active ) {
        drawFortification(under, over, {
          x: left + (spec.dome.x * w), y: top + (spec.dome.y * h), r: spec.dome.r * w * 1.03
        }, marks.fortification.used ?? 0);
      }

      // Name on the white band
      if ( marks.city.name ) {
        const band = spec.band;
        const bw = (band.x1 - band.x0) * w;
        const bh = (band.y1 - band.y0) * h;
        const t = handText(marks.city.name, { size: Math.round(bh * 0.95), maxWidth: bw * 0.94 });
        t.anchor.set(0.5, 0.5);
        t.position.set(left + (((band.x0 + band.x1) / 2) * w), top + (((band.y0 + band.y1) / 2) * h) + 1);
        over.addChild(t);
      }
    }
  }

  // Pack marks (fallout zone, ruins, alien island…): small stickers right of the bow-tie
  let i = 0;
  for ( const markId of markIds ) {
    if ( ["cancel_scar", "scar_cancelled"].includes(markId) ) continue;
    const entry = findEntry("marks", markId) ?? findEntry("stickers", markId);
    const tex = await texture(entry?.img);
    if ( !tex ) continue;
    const s = sprite(tex, 76);
    s.position.set(mx + 105 + ((i % 2) * 82), my + 30 - (Math.floor(i / 2) * 82));
    under.addChild(s);
    i++;
  }

  // Destroyed territory card: a small marker "x" next to the printed name
  if ( marks.cardDestroyed && def.label ) {
    const [lx, ly] = def.label;
    const half = Math.max(40, (def.name?.length ?? 8) * 10);
    const t = handText("x", { size: 46, color: MARKER_RED });
    t.anchor.set(0.5, 0.55);
    t.position.set(lx + half + 16, ly - 4);
    over.addChild(t);
  }
}

/**
 * Fortification ring around a city's dome; `used` boxes are blacked out with a marker.
 * @param {{x: number, y: number, r: number}} dome   circle the ring's inner edge hugs
 */
async function drawFortification(under, over, dome, used) {
  const spec = STICKERS.fortification;
  const tex = await texture(spec.src);
  if ( !tex ) return;
  const scale = dome.r / spec.inner;
  const s = new PIXI.Sprite(tex);
  s.anchor.set(spec.center[0] / spec.size[0], spec.center[1] / spec.size[1]);
  s.scale.set(scale * (spec.size[0] / tex.width));
  s.position.set(dome.x, dome.y);
  under.addChild(s);
  const n = Math.min(FORTIFICATION_USES, Math.max(0, used));
  if ( !n ) return;
  const g = new PIXI.Graphics();
  for ( let k = 0; k < n; k++ ) {
    const [bx, by] = spec.boxes[k];
    const x = dome.x + ((bx - spec.center[0]) * scale);
    const y = dome.y + ((by - spec.center[1]) * scale);
    const angle = Math.atan2(by - spec.center[1], bx - spec.center[0]) + (Math.PI / 2);
    const w = 30 * scale;
    const h = 17 * scale;
    g.lineStyle(0).beginFill(INK, 0.88);
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    const pts = [[-w / 2, -h / 2], [w / 2, -h / 2], [w / 2, h / 2], [-w / 2, h / 2]]
      .flatMap(([px, py]) => [x + (px * cos) - (py * sin), y + (px * sin) + (py * cos)]);
    g.drawPolygon(pts).endFill();
  }
  over.addChild(g);
}

/** Continent name hand-written on the plate, and the ±1 sticker beside the bonus number. */
async function drawContinent(under, over, def, cont) {
  if ( cont.name && def.namePlate ) {
    const p = def.namePlate;
    const label = cont.namedBy ? `${cont.name}` : cont.name;
    const t = handText(label, { size: Math.round(p.height * 1.15), maxWidth: p.width * 0.8 });
    t.anchor.set(0, 0.5);
    t.position.set(p.x + 10, p.y + (p.height / 2));
    over.addChild(t);
    if ( cont.namedBy ) {
      const initials = cont.namedBy.split(/\s+/).filter(Boolean).map(w => w[0].toUpperCase()).join("");
      const i = handText(initials, { size: Math.round(p.height * 0.7), color: 0x58595b });
      i.anchor.set(1, 0.5);
      i.position.set(p.x + p.width - 6, p.y + (p.height / 2) + 2);
      over.addChild(i);
    }
  }
  if ( cont.modifier && def.bonusBadge ) {
    const b = def.bonusBadge;
    const tex = await texture(cont.modifier > 0 ? STICKERS.plus.src : STICKERS.minus.src);
    if ( tex ) {
      const s = sprite(tex, b.r * 0.95);
      s.position.set(b.x + (b.r * 1.45), b.y - (b.r * 0.15));
      s.rotation = -0.06;
      under.addChild(s);
    }
  }
}

/** The winners' signatures on the numbered lines of the victors' section. */
function drawVictors(over, board, sys) {
  const lines = board.furniture?.victors?.lines ?? [];
  const signed = (sys.games ?? []).filter(g => g.signed);
  for ( const [i, game] of signed.entries() ) {
    const line = lines.find(l => l.n === i + 1) ?? lines[i];
    if ( !line ) break;
    const name = game.winner?.player || game.winner?.factionName || "";
    const parts = [name, game.date, game.winner?.motto ? `“${game.winner.motto}”` : ""].filter(Boolean);
    const t = handText(parts.join("   "), { size: 50, maxWidth: line.width - 24 });
    t.anchor.set(0, 1);
    t.position.set(line.x + 16, line.y + 6);
    t.rotation = -0.012;
    over.addChild(t);
  }
}

/** "The World Of ___", named after the 15th game. */
function drawWorldName(over, board, sys) {
  const box = board.furniture?.worldName;
  if ( !sys.worldName || !box ) return;
  const t = handText(sys.worldName, { size: Math.round(box.height * 1.25), maxWidth: box.width - 16, color: MARKER_RED });
  t.anchor.set(0, 0.62);
  t.position.set(box.x + 8, box.y + (box.height / 2));
  over.addChild(t);
}

/* -------------------------------------------- */
/*  Territories added during the campaign       */
/* -------------------------------------------- */

/**
 * The radius of an added territory: the campaign's value, else measured on its (circular) polygon.
 * @param {string} id
 * @param {object} def     campaign-board territory
 * @param {object} [sys]   campaign.system
 */
export function customRadius(id, def, sys) {
  const r = Number(sys?.customTerritories?.[id]?.radius);
  if ( r > 0 ) return Math.max(40, r);
  const [cx, cy] = def.center ?? [0, 0];
  const p = def.polygons?.[0];
  return p?.length ? Math.round(Math.hypot(p[0] - cx, p[1] - cy)) : 150;
}

/**
 * Stickers of the territories added to the board (Alien Island…): their art (or a generic disc) and the name in the
 * printed-label style.
 * @param {PIXI.Container} land
 * @param {object} board   campaign board
 * @param {object} sys     campaign.system
 */
async function drawCustomTerritories(land, board, sys) {
  const labels = [];
  for ( const [id, def] of Object.entries(board.territories ?? {}) ) {
    if ( !def.custom || !def.center ) continue;
    const [x, y] = def.center;
    const radius = customRadius(id, def, sys);
    const art = await territoryArt({ kind: def.kind, radius });
    art.position.set(x, y);
    land.addChild(art);
    if ( def.name ) labels.push(placeLabel(board, def.name, x, y, radius));
  }
  // Labels after every sticker, so a neighbouring sticker never covers a name
  for ( const label of labels ) land.addChild(label);
}

/**
 * Find the art spec of an image path (pickPoint's ghost uses the same scale and mask as the final sticker).
 * @param {string} [img]
 */
function artForImage(img) {
  if ( !img ) return null;
  const path = systemPath(img);
  return Object.values(TERRITORY_ART).find(spec => systemPath(spec.src) === path) ?? null;
}

/**
 * The sticker of an added territory (or the ghost of one being placed), centred on (0, 0).
 *  - known art (TERRITORY_ART, by kind or image path): scaled so the coast matches `radius`, masked to the island,
 *  - any other image: fitted into the circle,
 *  - no image: a generic disc of land with a white coastline, like the printed territories.
 * @param {object} options
 * @param {string} [options.kind]     custom territory kind
 * @param {string} [options.img]      image path (system-relative or full)
 * @param {number} options.radius     scene px
 * @param {boolean} [options.shadow=true]
 * @returns {Promise<PIXI.Container & {art: PIXI.DisplayObject}>}   `art` is the tintable part
 */
export async function territoryArt({ kind, img, radius, shadow = true } = {}) {
  const c = new PIXI.Container();
  const r = Math.max(1, Number(radius) || 0);
  const spec = TERRITORY_ART[kind] ?? artForImage(img);
  const tex = await texture(spec?.src ?? img);

  if ( spec && tex ) {
    const scale = r / spec.coast;
    const n = spec.outline.length;
    const outline = spec.outline.flatMap((d, i) => {
      const a = (i / n) * Math.PI * 2;
      return [Math.cos(a) * d * scale, Math.sin(a) * d * scale];
    });
    if ( shadow ) {
      const g = c.addChild(new PIXI.Graphics());
      g.beginFill(0x000000, 0.24).drawPolygon(outline.map((v, i) => v + (i % 2 ? 7 : 4))).endFill();
    }
    const s = new PIXI.Sprite(tex);
    s.anchor.set(spec.center[0] / spec.size[0], spec.center[1] / spec.size[1]);
    s.scale.set(scale * (spec.size[0] / tex.width));
    const mask = new PIXI.Graphics().beginFill(0xffffff, 1).drawPolygon(outline).endFill();
    c.addChild(s, mask);
    s.mask = mask;
    c.art = s;
    return c;
  }

  if ( tex ) {
    const s = new PIXI.Sprite(tex);
    s.anchor.set(0.5, 0.5);
    s.scale.set((2 * r) / Math.max(tex.width, tex.height));
    c.addChild(s);
    c.art = s;
    return c;
  }

  const g = c.addChild(new PIXI.Graphics());
  if ( shadow ) g.beginFill(0x000000, 0.22).drawCircle(4, 7, r).endFill();
  g.lineStyle(7, COAST, 1).beginFill(LAND, 1).drawCircle(0, 0, r - 4).endFill();
  g.lineStyle(2, INK, 0.55).drawCircle(0, 0, r);
  c.art = g;
  return c;
}

/**
 * A territory name in the style of the printed board labels.
 * @param {string} text
 * @param {number} [size=40]
 * @param {string} [variant="original"]   board id
 * @returns {PIXI.Text}
 */
export function boardLabel(text, size = 40, variant = "original") {
  const spec = LABEL_STYLE[variant] ?? LABEL_STYLE.original;
  const style = new PIXI.TextStyle({
    fontFamily: FONT_LABEL, fontWeight: spec.weight, fontSize: size, fill: INK, letterSpacing: spec.spacing, padding: 6
  });
  const t = new foundry.canvas.containers.PreciseText(spec.upper ? String(text).toUpperCase() : String(text), style);
  t.resolution = 3;
  return t;
}

/**
 * Put an added territory's name just outside its sticker (its art already fills the circle): below it, or above,
 * right or left when that side is land, a pen-drawn sea line or off the board.
 */
function placeLabel(board, name, x, y, radius) {
  const t = boardLabel(name, Math.round(Math.max(30, Math.min(44, radius * 0.27))), board.id);
  const w = t.width;
  const h = t.height;
  const gap = 10;
  const { width = 6000, height = 4000 } = board.scene ?? {};
  const options = [
    { ax: 0.5, ay: 0, px: x, py: y + (radius * 1.05) + gap },
    { ax: 0.5, ay: 1, px: x, py: y - (radius * 1.05) - gap },
    { ax: 0, ay: 0.5, px: x + (radius * 1.05) + gap, py: y },
    { ax: 1, ay: 0.5, px: x - (radius * 1.05) - gap, py: y }
  ];
  // Points along the pen-drawn sea lines (every ~10 px)
  const ink = [];
  for ( const line of board.seaLines ?? [] ) {
    if ( !line.custom || (line.points?.length !== 2) ) continue;
    const [[ax, ay], [bx, by]] = line.points;
    const n = Math.max(2, Math.ceil(Math.hypot(bx - ax, by - ay) / 10));
    for ( let i = 0; i <= n; i++ ) ink.push([ax + (((bx - ax) * i) / n), ay + (((by - ay) * i) / n)]);
  }
  const clear = o => {
    const x0 = o.px - (o.ax * w);
    const y0 = o.py - (o.ay * h);
    if ( (x0 < 0) || (y0 < 0) || (x0 + w > width) || (y0 + h > height) ) return false;
    for ( let i = 0; i <= 4; i++ ) {
      for ( const yy of [y0, y0 + (h / 2), y0 + h] ) {
        if ( board.territoryAt?.(x0 + ((w * i) / 4), yy) ) return false;
      }
    }
    const pad = 8;
    return !ink.some(([x1, y1]) => (x1 > x0 - pad) && (x1 < x0 + w + pad) && (y1 > y0 - pad) && (y1 < y0 + h + pad));
  };
  const o = options.find(clear) ?? options[0];
  t.anchor.set(o.ax, o.ay);
  t.position.set(Math.round(o.px), Math.round(o.py));
  return t;
}

/* -------------------------------------------- */
/*  Sea lines drawn in pen                      */
/* -------------------------------------------- */

/**
 * Every pen-drawn sea line of the campaign board (`board.seaLines` entries with `custom: true`; the printed ones are
 * part of the board image), with a sea-line start sticker at both ends.
 * @param {PIXI.Container} ink
 * @param {object} board
 */
function drawSeaLines(ink, board) {
  const lines = (board.seaLines ?? []).filter(l => l.custom && (l.points?.length === 2));
  if ( !lines.length ) return;
  const pen = ink.addChild(new PIXI.Graphics());
  const nodes = ink.addChild(new PIXI.Graphics());
  for ( const line of lines ) {
    const [[ax, ay], [bx, by]] = line.points;
    const path = penPath(ax, ay, bx, by, `${line.a}|${line.b}`);
    // The stroke, then a thin second pass slightly beside it: a marker never lays down a perfectly even line
    pen.lineStyle({ width: PEN.width, color: INK, alpha: PEN.alpha, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
    pen.moveTo(path[0][0], path[0][1]);
    for ( const [x, y] of path.slice(1) ) pen.lineTo(x, y);
    const k = Math.max(1, Math.floor(path.length * 0.06));
    const inner = path.slice(k, path.length - k);
    if ( inner.length > 1 ) {
      pen.lineStyle({ width: 2.5, color: INK, alpha: 0.5, cap: PIXI.LINE_CAP.ROUND, join: PIXI.LINE_JOIN.ROUND });
      pen.moveTo(inner[0][0] + 1.6, inner[0][1] - 1.4);
      for ( const [x, y] of inner.slice(1) ) pen.lineTo(x + 1.6, y - 1.4);
    }
    for ( const [x, y] of line.points ) drawNode(nodes, x, y);
  }
}

/**
 * A sea-line start sticker: a light disc with a dark ring, like the printed sea-line nodes.
 * @param {PIXI.Graphics} g
 */
function drawNode(g, x, y) {
  const { radius: r, ring, fill } = NODE;
  g.lineStyle(0).beginFill(0x000000, 0.25).drawCircle(x + 2, y + 3, r).endFill();
  // alignment 0: the ring lies inside the disc's edge
  g.lineStyle(ring, INK, 1, 0).beginFill(fill, 1).drawCircle(x, y, r).endFill();
  g.lineStyle(1.5, 0xffffff, 0.55).drawCircle(x, y, r - ring - 1.5);
}

/**
 * Points of a hand-drawn line from A to B: a gentle bow plus a small wobble, both fading out at the ends (where the
 * pen sat on the stickers), seeded by the line so it looks the same on every redraw and every client.
 * @returns {number[][]}
 */
function penPath(ax, ay, bx, by, key) {
  const len = Math.hypot(bx - ax, by - ay);
  if ( len < 1 ) return [[ax, ay], [bx, by]];
  const rand = seeded(key);
  const nx = -(by - ay) / len;
  const ny = (bx - ax) / len;
  const bow = Math.min(16, Math.max(3, len * 0.014)) * (rand() < 0.5 ? -1 : 1);
  const wobble = Math.min(3.2, 1 + (len * 0.003));
  const f1 = 1.6 + (rand() * 1.4);
  const f2 = 4.5 + (rand() * 3);
  const p1 = rand() * Math.PI * 2;
  const p2 = rand() * Math.PI * 2;
  const n = Math.max(8, Math.round(len / 24));
  const out = [];
  for ( let i = 0; i <= n; i++ ) {
    const t = i / n;
    const env = Math.sin(Math.PI * t);
    const d = (bow * env) + (wobble * env * ((0.65 * Math.sin((2 * Math.PI * f1 * t) + p1))
      + (0.35 * Math.sin((2 * Math.PI * f2 * t) + p2))));
    out.push([ax + ((bx - ax) * t) + (nx * d), ay + ((by - ay) * t) + (ny * d)]);
  }
  return out;
}

/** A small deterministic PRNG (mulberry32) seeded from a string. */
function seeded(key) {
  let h = 1779033703;
  for ( const ch of String(key) ) h = Math.imul(h ^ ch.charCodeAt(0), 3432918353) >>> 0;
  return () => {
    h = (h + 0x6D2B79F5) >>> 0;
    let t = h;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
