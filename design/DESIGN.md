# Risk Legacy: Foundry VTT design system

This is the visual language for the `fvtt-risklegacy-v5` game system. It is reverse-engineered from the 2011 *Risk Legacy*
rulebook (`assets/rules.pdf`: 16 pp., 684 × 864 pt, InDesign CS4, PDF/X-1a, output intent *U.S. Web Coated (SWOP) v2*),
with the board and card art in `assets/` as secondary references.

| File | What it is |
|---|---|
| `tokens.css` | CSS custom properties, self-hosted `@font-face`, and base component styles, all scoped under `.risklegacy` |
| `preview.html` | Showcase: palette, type, decorations, faction sheet (light + dark), cards, dialog, chat |
| `assets/fonts/` | WOFF2 subsets (latin, latin-ext) of the four OFL substitutes, plus their `OFL-*.txt` licences |
| `assets/svg/` | Vector ornaments: two traced from PDF paths, the rest redrawn |
| `assets/textures/` | Small tileable WebP textures derived from the PDF's raster backgrounds |
| `assets/specimens/` | Original-vs-substitute font comparisons, rendered from crops of the PDF |

---

## 1. Mood and visual language

**"A war-room binder that the players have been writing in."** The rulebook mixes three materials, and the UI should too:

1. **Military hardware.** Brushed-steel header and footer *plates* with a bevelled rail that steps down at a 45° chamfer.
   Yellow/gunmetal *hazard tape* is slapped diagonally across page corners. Walls are *dark concrete*, and *barbed wire*
   trails along the bottoms of pages.
2. **Printed briefing material.** Off-white pages with grunge speckle at the margins. Rules sit on *raised stone panels*
   (sage, manila tan, gold, grey-lavender) with a light top/left bevel and a dark bottom/right bevel. *Cream caption
   callouts* sit in heavy 2-pt ink frames, and grey note boxes carry caps labels. Headlines are tall, squared-off
   condensed caps in a single deep red (M100 Y100 K30), and everything else is dense condensed sans.
3. **The players' marker pen.** Felt-tip handwriting labels concept art, names cities ("BenTown", "Awesometonia"), circles
   the designer's name, crosses out the power you didn't pick, and draws arrows. The *legacy brackets* (light-grey
   `[  ]` with 45° arm tips) mark empty spaces that stickers will fill later. The game is unfinished on purpose.

Rules for the UI:
- **Red is the only accent.** Use it for headings, numbered steps, primary actions and marker emphasis. Faction and
  power colours are *data*, not decoration.
- **Square, condensed, dense.** No rounded corners except on physical cards. Corners are square or cut at 45°.
- **Printed objects stay printed.** Panels, callouts, cards and chat cards look identical in light and dark mode. Only
  the surface they lie on changes (white page or concrete wall).
- **Leave room for scribbles.** Player-authored text (names, notes, signatures, modifiers) uses the marker font. Empty
  unlock slots show legacy brackets.

---

## 2. Palette

### How the colours were obtained
- **Vector colours (exact).** I read the raw DeviceCMYK values from the content streams (`mutool trace`) and converted
  them with the PDF's **own embedded SWOP v2 ICC profile** (LittleCMS via Pillow ImageCms, perceptual intent). The
  results match PyMuPDF's span colours and MuPDF/Poppler renders to within 1–2 RGB units. The naive formula
  `255·(1−C)(1−K)` is wrong for this file: it makes K100 ink `#000000` and red `#b20000`. The relative-colorimetric
  intent gives a greyer black (`#373535`) and a pinker red (`#b32e30`). Perceptual is what InDesign and Acrobat show on
  screen.
- **Raster colours (≈).** Panels, plates, hazard tape and concrete are CMYK JPEG2000 images. I extracted them, converted
  them through the same profile, and took the median or k-means cluster of each region at 300 dpi. They are
  approximate (±3–6 RGB) because the textures vary across each surface.
- **Card and sticker colours (≈).** Sampled from the scans and PNGs in `assets/unlocks/**/images`. The scans are
  under-exposed, so paper stocks were white-balanced by eye: scan `#dedfda` → `#f4f4f0`.

### Ink and paper
| Token | Hex | Source | Rulebook use | UI role |
|---|---|---|---|---|
| `--rl-ink` | `#231f20` | K100 (exact) | All body text, 2-pt callout and photo frames | Text, frames |
| `--rl-ink-rich` | `#111213` | ≈ hazard black / C75M68Y67K90 | Hazard-bar rails, token rims | Deepest shadow, attack dice |
| `--rl-paper` | `#ffffff` | page | Page ground | Light-theme surface |
| `--rl-paper-grunge` | `#efeeee` | ≈ | Speckled page margins | Texture tint |
| `--rl-map` | `#dfdfde` | ≈ | Faded world-map watermark (pp. 2–3) | Watermarks |

### Reds
| Token | Hex | Source | Rulebook use | UI role |
|---|---|---|---|---|
| `--rl-red` | `#b11116` | M100 Y100 K30 (exact) | Section titles, italic sub-heads, "WELL, THIS IS NEW.", "Opening New Packages" | Headings, primary buttons, active tab, marker emphasis |
| `--rl-red-bright` | `#c4151c` | M100 Y100 K20 (exact) | Numbered turn-step discs and labels (p. 8) | Step numbers, small red UI |
| `--rl-red-star` | `#c01f25` | ≈ Red Star token | Star fill | Icon fill |
| `--rl-crimson` | `#b10069` | M100 K30 (exact) | 1-pt hairline under "LEGACY KEY TERMS" | Thin section rule (sparingly) |

### Neutral K tints (the rulebook's grey system)
| Token | Hex | Rulebook use | UI role |
|---|---|---|---|
| `--rl-k10` | `#e6e7e8` | – | Subtle fills |
| `--rl-k20` | `#d1d3d4` | Legacy "rules addition" brackets | Empty-slot brackets |
| `--rl-k30` | `#bcbec0` | "A NOTE ON TIMING" box | Note boxes |
| `--rl-k40` | `#a7a9ac` | "Rules addition B will go here…" placeholder | Decorative placeholder text only (2.4:1 on white) |
| `--rl-k50` | `#939598` | Photo captions ("1-troop pieces") | Captions ≥ 11 px (3.0:1) |
| `--rl-k60` / `--rl-k70` / `--rl-k80` / `--rl-k90` | `#808285` / `#6d6f71` / `#58595b` / `#404041` | (derived K tints) | Muted text (K70 = 5.1:1 on white), borders |
| `--rl-concept` | `#b2bdc3` | C30.6 M18.8 Y18 (exact): handwritten concept-art captions | "Sketch caption" hand text |

### Steel, hazard, concrete (from the raster plates)
| Token | Hex | Rulebook use | UI role |
|---|---|---|---|
| `--rl-steel-hi` | `#fbfcfc` | Plate highlight | Bevel top |
| `--rl-steel-1` | `#e0e1e2` | Plate face | Window header, tabs, buttons |
| `--rl-steel-2` | `#cfd0d2` | Plate mid | Gradient stop |
| `--rl-steel-lo` | `#9c9d9f` | Plate shadow line | Bevel rail |
| `--rl-gunmetal` | `#4a4b4d` | Hazard bar, dark stripes | Dark-theme tabs |
| `--rl-gunmetal-2` | `#404142` | C68 M61 Y59 K46 (exact): missile-token frame | Icon frames |
| `--rl-hazard` | `#fcdc07` | Hazard-stripe yellow | Hazard tape, dark-theme focus ring |
| `--rl-concrete` (`-dark`, `-light`) | `#5c5b55` (`#4e4e48`, `#76746e`) | Concrete wall (pp. 4–5) | Dark-theme surface |

### Panels and paper stocks
| Token | Hex | Rulebook use | UI role |
|---|---|---|---|
| `--rl-cream` | `#fffcd5` | Y20 (exact): caption callouts in 2-pt frames (pp. 4, 10, 11) | Callouts, chat results |
| `--rl-sage` | `#d8dbcc` | Stone panels (pp. 4–5) | Default panel |
| `--rl-tan` | `#c4b69d` | "LEGACY KEY TERMS" manila (pp. 2–3) | Glossary / reference panels |
| `--rl-gold` | `#f2dfa6` | "OBJECT OF THE GAME" / "GOAL" (pp. 6, 8) | Objectives, victory |
| `--rl-lavender` | `#bebdca` | Combat/resource panels (p. 11) | Rules asides, scars |
| `--rl-legal` | `#fcefc3` | Legal-pad note "Opening New Packages" (p. 15) | Unlock / package notes |
| `--rl-panel-white` | `#e5e6e7` | "YOUR FACTIONS" plate (p. 3) | Tables, lists |
| `--rl-blueprint` | `#cfe0ea` | Concept-sketch grid paper (pp. 6, 8, 9, 14) | Grid-paper lines (strengthened from ≈`#ecf7f8`) |

### Card stock and stickers (from the card scans)
`--rl-card-paper #f4f4f0` · `--rl-card-strip #fcf6c0` (the pale-yellow "play this card…" strip) ·
`--rl-coin-amber #e3a312` · `--rl-coin-gold #dba945` · `--rl-coin-brown #6d4009` · `--rl-city-navy #112a6e` (major-city
sticker) · `--rl-fort-blue #0a4f9a` / `--rl-fort-cyan #01abe2` (fortification) · `--rl-scar-orange #da8811` (scar-sticker
rim) · `--rl-missile #f37123` (missile token; its DeviceN shading runs `#f47b24 → #f26521`).

### Power-slot colours (faction-card brackets)
Each faction card has six bracket slots: white (scar), then red, yellow, orange, blue and green power slots. The
colour→type mapping comes from the power icons and the YAML (`type:` + comments in `assets/unlocks/**/powers`).

| Token | Hex | Bracket sample | Icon sample | Power type |
|---|---|---|---|---|
| `--rl-power-mission` | `#c23b40` | `#bd4a51` | `mission.png #ff0000` | mission |
| `--rl-power-weakness` | `#e3c34f` | `#d9b262` | `weakness.png #e6da00` | weakness (and "yellow" extras) |
| `--rl-power-missile` | `#d9781e` | `#b18557` (faded in print) | `missile.png #cc6900` | missile |
| `--rl-power-knockout` | `#2f9fd0` | (too small to sample) | `knockout.png #0296cc` | knockout |
| `--rl-power-starter` | `#8db540` | green power sticker (p. 6) | `starter.png #3bb300` | starter |

### Faction accents (sampled from HQ token art)
`--rl-faction-balkania #6f38ad` (purple) · `--rl-faction-enclave #17a838` (green) · `--rl-faction-khan #5f6062`
(black/grey) · `--rl-faction-mechaniker #9a0b0c` (red) · `--rl-faction-saharan #c9b400` (yellow; the token is `#cfcf01`,
deepened slightly so it stays visible on white). Set one with `.rl-faction--<id>`, which assigns `--rl-faction`.

### Contrast (WCAG 2.1)
Red `#b11116` on white = 7.1:1, on cream 6.8:1, on sage 5.0:1, on gold 5.4:1, on tan 3.6:1 (use only for headings ≥ 18 px
there). **Red on concrete is 1.04:1.** In the dark theme, headings switch to `--rl-steel-hi`. Ink on any panel is ≥ 8.7:1.
Hazard yellow on concrete is 6.1:1.

---

## 3. Typography

### Where each font is used in the PDF (from `get_text("dict")` and `mutool trace`)
| Embedded font | Usage (chars, sizes, colour) | Role |
|---|---|---|
| HelveticaNeue-Condensed | ~35.6 k chars, **10 pt** ink; 8 pt cover contents; a few red inline words | Body copy |
| HelveticaNeue-BoldCond | 12 pt "Marks:", "City:" glossary terms; 10 pt inline bold; 8 pt "CONTENTS:" | Run-in terms |
| HelveticaNeue-MediumCond | 10 pt "TERRITORY CARDS:" labels and "Note: …" paragraphs; 12 pt lead lines ("But all that will change.") | Labels, leads |
| HelveticaNeue-BoldCondObl | 12 pt **red** caps sub-heads ("GAMEBOARD", "PLASTIC PIECES"); 10 pt `#c4151c` numbered steps ("Start of Turn") | Sub-heads, steps |
| HelveticaNeue-CondensedObl | 8 pt K40/K50 captions ("1-troop pieces"), K20 bracket placeholders ("Rules addition A will go here.") | Captions, placeholders |
| UnitedSansCond-Heavy | 26 pt red section titles ("A LOOK AT THE COMPONENTS"); 20 pt panel titles ("YOUR FACTIONS"); 32 pt ink "IT'S … WORLD."; 14 pt cover; 10 pt folios "PAGE 7" | Display |
| UnitedSansReg-Black | 5.8–8.7 pt white numerals inside the red step discs | Disc numerals |
| UnitedSansCond-Bold | spaces in the folios only | – |
| BatteryPark | 74 pt red "WeLl, thiS Is nEW." (p. 2), the only hero line | Distressed stencil hero |
| FeltTipRoman | 8 pt `#b2bdc3` concept captions; 10.8 pt ink setup notes; 14.7 pt player-written city names; 16 pt sticker-book note; 32 pt red "Opening New Packages"; 46 pt red "YOUR" | Marker / handwriting |
| StoneSans-Semibold, ZapfDingbatsITC, Helvetica, HN Roman/Medium/Bold | Back-cover legal (6 pt), ☎ glyphs, printer slug line, single glyphs | Not part of the design |

### Substitutes (all SIL OFL 1.1, self-hosted in `assets/fonts/`)
I rendered each candidate at the original's measured cap height or x-height and compared it with a 300–400 dpi crop of
the original. Final comparisons are in `assets/specimens/`.

| Source → role | Web substitute | Why this one | Fallback stack (`tokens.css`) |
|---|---|---|---|
| **United Sans Cond Heavy** → display titles, window titles, tabs, buttons, numbers | **Big Shoulders Display 900** (variable 700–900) | Best of 20 candidates. It has the same squared "stadium" rounds (O, C, G, S), flat terminals, very tall narrow proportions and nearly identical set width (≈2% wider). United Sans has slight 45° cuts on its round corners; Big Shoulders' are softer. Runners-up: Sofia Sans Extra Condensed (too round), Staatliches (too light), Saira Extra Condensed (wedge N). | `"Big Shoulders Display", "Sofia Sans Extra Condensed", "Oswald", "Arial Narrow", "Roboto Condensed", Impact, sans-serif` |
| **BatteryPark** → hero stencil line, stamps | **Big Shoulders Stencil Display 900** + `textures/distress-mask.webp` as a CSS `mask-image` | Same skeleton as the display face, so the hero and titles feel like one family, as in the rulebook. The stencil bridges sit where BatteryPark's do. No free font has BatteryPark's spray-paint erosion, so the mask supplies it. Rejected: Stardos/Allerta/Saira Stencil (too wide or too polite), Black Ops One (too wide), Rubik Dirt (too much texture to read at UI sizes). | `"Big Shoulders Stencil Display", "Big Shoulders Display", "Stardos Stencil", Impact, "Arial Narrow", sans-serif` |
| **Helvetica Neue Condensed / Medium / Bold Cond / Bold Cond Oblique** → body, labels, sub-heads, captions | **Roboto Condensed** 400–700 + italic (variable) | Closest grotesque proportions and x-height. At equal x-height it sets about 4% wider than HN Condensed, which is close enough for the same line breaks in UI copy. Its true italic stands in for the obliques (the red sub-heads). Runners-up: Archivo Narrow (narrower and more "designed"), Pragati Narrow (tighter and less even). | `"Roboto Condensed", "Helvetica Neue", "Arial Narrow", "Liberation Sans Narrow", "Nimbus Sans Narrow", Arial, sans-serif` |
| **Felt Tip Roman** → marker notes, player-written names, flavour | **Gochi Hand 400** | The only one of 23 handwriting candidates with the same felt-marker stroke: monoline, slightly heavy, with loose bouncy single-storey forms. Felt Tip is a little lighter and more upright, with a shorter x-height. Patrick Hand is the second choice (more neutral, better at ≤ 12 px). Covered By Your Grace is closest in spirit but too narrow and scratchy for UI. | `"Gochi Hand", "Patrick Hand", "Comic Neue", "Comic Sans MS", "Chalkboard SE", cursive` |

UnitedSansReg-Black is used only for the step-disc numerals, which `.rl-num` / `.rl-steps` set in Big Shoulders 900.

### Type scale (rulebook pt × 1.4 → px)
| Token | px | Rulebook source | Use |
|---|---|---|---|
| `--rl-fs-hero` | 72 | 74 pt BatteryPark | One stencil line per view (welcome, game-over) |
| `--rl-fs-3xl` | 46 | 32 pt "IT'S YOUR WORLD." | Splash titles |
| `--rl-fs-2xl` | 36 | 26 pt section titles | `.rl-title`, counter values |
| `--rl-fs-xl` | 28 | 20 pt panel titles | `.rl-title--sm`, stamps |
| `--rl-fs-lg` | 22 | – | Window titles, card titles, name plates |
| `--rl-fs-md` | 17 | 12 pt glossary terms / sub-heads | `.rl-subhead`, `.rl-term`, step list |
| `--rl-fs-base` | 14 | 10 pt body | Body, inputs |
| `--rl-fs-sm` | 12 | 9 pt | Labels, stickers, card text |
| `--rl-fs-xs` | 11 | 8 pt captions | Captions, placeholders |
| `--rl-fs-2xs` | 10 | 6 pt card codes | `.rl-code` |

Body line height is 1.3 (the rulebook's is 1.21 at 10/12.1; slightly opened for screens). Display text uses
`line-height: 1` and `letter-spacing: 0.02em`; caps labels use `0.04em`.

### Type roles (classes)
`.rl-hero` stencil + distress · `.rl-title` red display caps · `.rl-subhead` red italic caps · `.rl-label` bold caps
label · `.rl-term` run-in bold term · `.rl-lead` medium lead line · `.rl-caption` K50 italic · `.rl-hand` marker
(`--red`, `--concept`, `--tilt`) · `.rl-code` card code · `.rl-folio` "PAGE 7".

---

## 4. Decoration catalogue

| # | Ornament (rulebook location) | How it's reproduced | Class / asset |
|---|---|---|---|
| 1 | **Steel header/footer plate** with bevelled rail and 45° step (every page, top and bottom) | CSS: `--rl-grad-steel` + an `::after` rail of stacked hard-stop gradients, `clip-path` for the chamfer step | `.application.risklegacy .window-header`, `.rl-plate`, `hr.rl-rail` |
| 2 | **Hazard tape** (yellow/gunmetal 60° stripes with black rails; pp. 2, 5, 13, 15) | SVG tile (repeat-x, 48 × 26) sampled from p. 2: yellow `#fcdc07`, bar `#4a4b4d`, rails `#111213`, top-light / bottom-shade overlay. Thin variant as a pure CSS gradient. | `svg/hazard-stripes.svg`, `.rl-hazard`, `.rl-hazard--thin`, `.rl-hazard-header` |
| 3 | **Raised stone panel** (sage pp. 4–5, tan p. 2, gold p. 8, lavender p. 11) | Measured bevel: 3 px light top edge, 3 px dark bottom/right edge (`#959992` on sage) → inset box-shadows. Stone grain multiplied over the stock colour. | `.rl-panel`, `--tan`, `--gold`, `--lavender`, `--white`; `textures/stone-grain.webp` |
| 4 | **Cream caption callout**, Y20 in a 2-pt K100 frame, docked on a framed photo (pp. 4, 10, 11) | Pure CSS (exact colours and stroke). | `.rl-callout`, `.rl-framed` |
| 5 | **Grey note box** "A NOTE ON TIMING:" (K30, p. 8) | Pure CSS. | `.rl-note` |
| 6 | **Legacy brackets** (K20 `[ ]`, ~4 pt stroke, 45° arm tips) around "Rules addition A will go here." (pp. 7, 12, 13) | Geometry traced from the vector path (8-point polygon). CSS `clip-path` pseudo-elements, so it scales and recolours; an SVG copy is included for `border-image`. Coloured variants are the faction-card power slots. | `.rl-slot`, `.rl-slot--power`; `svg/legacy-brackets.svg` |
| 7 | **Numbered red discs** (p. 8) | CSS circles in `--rl-red-bright` with a CSS counter. | `.rl-steps`, `.rl-num` |
| 8 | **Barbed wire** (pp. 8, 12, 14, 15) | Redrawn as a repeat-x SVG (two twisted strands, 4 barbs per 240 px, slow wander). The original is a raster illustration. | `svg/barbed-wire.svg`, `hr.rl-wire` |
| 9 | **Chamfered name plate** with faction-colour underline (faction cards pp. 4, 6; "YOUR FACTIONS" p. 3) | CSS `clip-path` + `::after` bar using `--rl-faction`. | `.rl-tab-plate` |
| 10 | **Marker arrows** (p. 6, p. 7) | **Traced from the PDF's vector paths** (140 fill paths, ink `#231f20`). Usable as `<img>` or as a tintable CSS mask. | `svg/marker-arrow.svg`, `svg/marker-arrow-squiggle.svg`, `.rl-arrow` |
| 11 | **Marker loop** (circled "Rob Daviau", p. 4; circled power, p. 6) | Procedurally drawn tapered loop SVG, applied as a CSS mask so it's tintable. | `svg/marker-loop.svg`, `.rl-circled` |
| 12 | **Marker cross-out** (p. 6, "Pick one power and destroy the card.") | Red line-through; the checkbox `:checked` state is a hand-drawn red ✕ (inline SVG data URI). | `.rl-strike`, `input[type=checkbox]` |
| 13 | **Red Star token** (p. 5, p. 7) | **Traced from the vector ring and star.** Fills use the sampled shading (grey disc gradient, red star `#c01f25`). | `svg/token-red-star.svg`, `.rl-token` |
| 14 | **Missile token** (p. 5, p. 7) | **Traced from the vector hexagon and missile.** The orange DeviceN shading is approximated as a 2-stop gradient. | `svg/token-missile.svg`, `.rl-token--missile` |
| 15 | **Concept-sketch grid paper** (pp. 6, 8, 9, 14) | SVG tile; lines strengthened from the near-invisible original. | `svg/blueprint-grid.svg`, `.rl-grid-paper` |
| 16 | **Legal-pad note** (p. 15) | Texture from the original, a −1.2° rotation, drop shadow, Gochi title in red. | `textures/legal-pad.webp`, `.rl-legal` |
| 17 | **Page grunge / speckle** (all page margins) | Alpha texture built from pp. 7 page-edge rasters, used at 45–55% on the light page. | `textures/grunge-speckle.webp` |
| 18 | **Dark concrete wall** (pp. 4–5) | Band-pass-filtered crop of the p. 4/5 wall, re-based on `#5c5b55` and made seamless. | `textures/concrete.webp` |
| 19 | **Paper grain** (gold/tan stocks) | Band-pass crop of the p. 8 gold panel, neutral grey, for `multiply`. | `textures/paper-grain.webp` |
| 20 | **Spray-stencil erosion** (BatteryPark) | Procedural alpha mask (blobs, specks, drips, scuffs; ~7% eaten) used as `mask-image`. | `textures/distress-mask.webp`, `.rl-hero`, `.rl-stamp` |
| 21 | **Dice**: black attack, red defence (p. 5) | CSS faces. Modified results are written on in marker via `data-mod`. | `.rl-die`, `.rl-die--defend` |
| 22 | **Power sticker** (green, 3 px white border, peeling corner; p. 6) | CSS; `--rl-power` drives the colour. | `.rl-sticker`, `.rl-sticker--peel` |

Left out on purpose: the RISK and LEGACY logotypes (trademarks), the faded world map (it would compete with the canvas),
and the photographic art. Use the card art in `assets/unlocks` directly where it's needed.

---

## 5. Spacing, borders, shadows

- **Spacing scale** (`--rl-space-1…8`): 2, 4, 6, 8, 12, 16, 24, 32 px. The rulebook is dense, but a screen needs more
  air than print, so the UI is a step looser:
  - Window content and panels pad 16 px. Gutters between cards, panels and grid cells are 16 px (12 px at least).
  - Rows or stickers stacked inside a panel are ≥ 8 px apart. A section heading has ≥ 12 px above and ≥ 6 px below it.
  - Text never touches a frame. Anything bordered or filled (stickers, chips, callouts, plates) pads ≥ 6 px vertically
    and ≥ 10 px horizontally. Table cells pad ≥ 4 × 8 px.
  - Nothing overflows its container or overlaps a neighbour, except deliberate decorations (sticker peel, marker loop,
    stamps, hand notes).
  - Buttons grow with their label (core Foundry fixes `<button>` at 2em; `risklegacy.css` §9 undoes that for `rl-*`
    buttons). Ellipsis is only for single-line labels whose full text is in a tooltip.
- **Borders.** `--rl-border-frame` is 2 px solid ink (the rulebook's 2-pt frame) for callouts, photos and chat cards.
  The hairline is 1 px. The bracket stroke is 4 px with 18 px arms. Corners are square; the 45° chamfer is 10 px
  (`--rl-chamfer`) on buttons and 12–18 px on tabs and plates. `--rl-radius-card` (7 px) is for physical cards only.
- **Shadows.** `--rl-bevel-raised` (panel bevel), `--rl-bevel-steel` (plates), `--rl-shadow-panel` (1–2 px, tight),
  `--rl-shadow-card` (cards on the table), `--rl-shadow-note` (lifted paper), `--rl-shadow-window`, `--rl-inset-field`.
  The rulebook's shadows are short and hard. Avoid big soft glows.

---

## 6. Component guidance for Foundry (ApplicationV2 / Handlebars)

**Wiring.** Ship this as `styles/risklegacy.css` in `system.json` → `"styles": [{ "src": "styles/risklegacy.css" }]`.
It lands in the `system` cascade layer, which already beats core `applications`/`blocks`, so no `!important` is needed.
Copy `assets/fonts|svg|textures` next to it and keep the `url()`s relative to the CSS file. Every app gets
`classes: ["risklegacy", …]` in `DEFAULT_OPTIONS`. Everything is scoped under `.risklegacy`, and no core `--color-*`
variable is redefined.

### Sheets (actor / faction / item)
- Structure: `header` art band (faction card art with `.rl-tab-plate` and power-slot `.rl-slot`s) → side stats
  (`.rl-plate` counters with `.rl-token`, `.rl-field`s) → `nav.sheet-tabs.tabs` → tab bodies of `.rl-panel`s.
- Use `.rl-faction--<id>` on the sheet root so tables, underlines and accents pick up the faction colour.
- Show empty unlockable features as **brackets** (`.rl-slot` / `.rl-slot--power .rl-power--<type>`). When a feature is
  filled, add `.is-filled` and put a `.rl-sticker` inside.
- Player-authored fields (faction/city names, signatures, "game won" log) use `input.rl-input--hand` and `.rl-hand`.
- ✔ One `.rl-title` per tab. ✔ Ink text on panels. ✘ Don't nest panels inside panels more than one level. ✘ Don't put
  red text directly on the concrete (dark) surface; it inverts to steel automatically through `--rl-page-heading`.

### Tabs
Core markup (`templates/generic/tab-navigation.hbs`: `nav.sheet-tabs.tabs > a[data-action=tab][data-tab]`) is styled
as steel plates with a 12 px chamfer on the top-right corner. `.active` = white plate, red label, 4 px red underline,
sitting on a 3 px rule. In the dark theme the tabs are gunmetal and hover turns hazard yellow.
✘ Don't use icons-only tabs; the condensed caps label is the look.

### Inputs
White field, 1 px K60 border, square, inset shadow. Focus ring is 2 px `--rl-focus` (red in light, hazard yellow in
dark). Numbers are set in Big Shoulders 800 and centred. Checkboxes are a 2 px ink box marked with a red marker ✕.
Labels are bold caps. Hints are K70 italic. Scope: only form controls inside `.risklegacy`, never global ones.

### Buttons
`.rl-btn` is a steel plate with a 10 px chamfer and Big Shoulders 800 caps. `.rl-btn--primary` is red with white text.
`.rl-btn--destroy` is near-black with a hazard-stripe edge, for irreversible legacy actions ("destroy this card", "tear
up", "eliminate"). DialogV2 footers (`.form-footer > button`) are styled automatically; `[autofocus]` (the default
button) becomes primary. ✘ Bare `<button>`s are never styled: Foundry header controls, ProseMirror menus and FilePicker
buttons stay core. ✘ Don't use more than one primary per footer.

### Cards
`.rl-card` + a variant: `--scar` (heavy double rule title, yellow instruction strip, sticker art at bottom right),
`--power` (icon disc + coloured sticker; set `.rl-power--<type>`), `--event` (portrait; banner + footer strip),
`--mission` (landscape; red-star token at top right), `--territory` (portrait; amber 3 × 2 resource coins, `.rl-coin.is-filled`).
Cards are 88:63 (or 63:88), with 7 px radius and a table shadow. Set the size with `--rl-card-w`. Use the real card scans
from `assets/unlocks/**` as `<img>` where they exist. These classes are for hover previews, hands, chat and
compendium rows. ✔ Cards look the same in both themes. ✘ Don't stretch scans to another aspect ratio.

### Dialogs (DialogV2)
Same frame as sheets. Add `rl-hazard-header` to the window classes for destructive or legacy-changing confirmations;
it adds hazard tape under the header. Content: a `.rl-callout` stating the consequence, optional card preview, fields.
Footer: secondary on the left, primary/destroy on the right. A marker aside ("(Tough to do, we know.)") is on-brand.
✘ Don't use the stencil hero inside dialogs.

### Chat messages
Render content as `<div class="risklegacy rl-chat-card">` (white with a 2 px ink frame): a steel `__head` with a red
`__title` and an italic `__sub`, a `__body` (rows of `.rl-label` + `.rl-dice`), and a cream `__result` footer. Optional
`.rl-hazard--thin` on top for attacks. To restyle the outer `<li class="chat-message">` too, add `risklegacy` to it in
`Hooks.on("renderChatMessageHTML", (msg, html) => …)` (v13+ passes an HTMLElement). The paper-grain frame then applies.
✔ Chat cards are printed objects and look the same in both chat themes. ✘ Don't exceed about 300 px of content width
(the sidebar is narrow), and don't put more than one marker note per card.

### Do's and don'ts (summary)
✔ red = headings and primary only · ✔ condensed everything · ✔ marker for player voice · ✔ brackets for unfilled slots
· ✔ square or 45° corners · ✘ red on concrete or gunmetal · ✘ stencil paragraphs · ✘ round UI corners · ✘ restyle core UI
· ✘ use trademarked logotypes · ✘ hard-code faction colours outside the `--rl-faction-*` tokens.

---

## 7. Fitting into Foundry v13/v14 light and dark themes

- Foundry puts `theme-light`/`theme-dark` on `<body>` (interface theme), and each ApplicationV2 window gets
  `themed theme-{light|dark}` (document sheets take theirs from the per-sheet setting, `document-sheet.mjs` → `options.classes`).
  `tokens.css` keys only its **semantic** variables (`--rl-page`, `--rl-on-page`, `--rl-page-heading`, `--rl-tab-*`,
  `--rl-focus`, `--rl-slot-color`, `--rl-wire-filter`) off these classes. They are declared only on the outermost
  `.risklegacy` element or on a `.application.risklegacy` window: first the light default, then
  `.theme-dark :is(…)` (inherited from `<body>` or a themed ancestor), then the window's own `.theme-light` /
  `.theme-dark` last. A sheet's per-document theme therefore beats the interface theme, and nested `.risklegacy`
  blocks (chat cards, card previews) inherit from their window. I checked this in Chrome: a light sheet on a dark
  interface resolves light, an unthemed window resolves to the body theme, and nested cards inherit.
- What changes between themes: the window surface (white grunge page ↔ concrete wall), heading colour (red ↔ steel
  white), body text (ink ↔ steel `#e0e1e2`), tab plates (steel ↔ gunmetal), focus ring (red ↔ hazard yellow), bracket
  colour (K20 ↔ K60), and the barbed wire (inverted).
- What does not change: the steel window header (a plate reads fine on both), panels, callouts, notes, cards, stickers,
  dice, tokens and chat cards. They are physical objects, they keep ink text, and so contrast stays ≥ 5:1 in both themes.
- The design never overrides core `--color-*`/`--font-*` variables, and has no global element rules. Foundry chrome
  (sidebar, scene controls, core dialogs) is untouched.
- Core reset already sets `box-sizing: border-box`, and the components rely on it. `preview.html` adds the same rule
  because it doesn't load core CSS.
- Accessibility: there is no reduced-transparency or blur dependence. Decorative textures are `pointer-events: none`
  pseudo-elements. Respect `prefers-reduced-motion` if you add the rotated "note" animations.

---

## 8. Approximations and open questions

- **CMYK → sRGB.** Vector colours are exact *for the SWOP v2 perceptual intent*. A different intent shifts them
  (red `#b11116` → `#b32e30` relative-colorimetric). Raster-derived colours (plates, panels, concrete, hazard) are
  medians of textured areas, within about ±5 RGB. Card colours come from under-exposed scans and were white-balanced by
  eye.
- **Power-slot colours** combine faded print samples with the saturated icon PNGs. The knockout (blue) and missile
  (orange) brackets were too small or faded on pp. 4/6 to sample reliably, so those hues follow the icons.
- **Faction colours** come from the HQ token art, not from an official spec.
- **Fonts.** No free font reproduces BatteryPark's spray erosion; it is simulated with a mask. Big Shoulders' corners are
  rounder than United Sans' chamfered corners. Gochi Hand is bolder and bouncier than Felt Tip Roman. At small sizes
  (< 13 px) consider `--rl-font-hand: "Patrick Hand"` for legibility. Roboto Condensed sets about 4% wider than
  Helvetica Neue Condensed.
- **Barbed wire, marker loop, hazard bar and grid** are redrawn, not traced; the originals are raster art. The two
  marker arrows and the two tokens are vector traces of the PDF paths.
- The rulebook's fonts (Helvetica Neue, United Sans, BatteryPark, Felt Tip Roman, Stone Sans) are commercial. They were
  only rendered for comparison and **not** extracted or redistributed.
