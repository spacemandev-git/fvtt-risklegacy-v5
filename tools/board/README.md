# Board geometry generator

Builds `data/boards/<id>.json` (territory polygons, anchors, spots, adjacency, sea-lines,
continent plates and other board furniture) from the board images, in 6000x4000 scene px.

```sh
python3 tools/board/build_board.py original     # also writes assets/board/original.webp (6000x4000, Lanczos, q85)
python3 tools/board/build_board.py advanced
python3 tools/board/validate_board.py original   # checks + overlay PNGs in tools/board/out/
python3 tools/board/validate_board.py advanced
python3 tools/board/contact_sheet.py original    # optional: label/mark crops for eyeballing
```

Requires python3 with opencv (cv2), numpy, scipy and matplotlib. A full build takes about 15 s per board.

## Files

- `original.config.json`, `advanced.config.json`: the hand-entered data. All coordinates are in
  2000-px-wide preview space; `coordScale` (3) converts them to scene px. The files contain:
  - `continents`: id, default label, bonus, `plateCount` (the printed "N TERRITORIES"), territory list
    and a rough `plateBox`. The plate, name strip and bonus disc are refined from the image.
  - `territories`: display name and the approximate centre of the printed name. This point is the
    segmentation seed and is refined to the text's bounding-box centre.
  - `furniture`: rough boxes for the reference stickers (with `printed` type), troop/trade charts,
    the star trade box, victors panel and "THE WORLD OF" write-in. Boxes with `"refine": false` are
    used as given. `exclude` boxes (logo, credits) are kept out of the segmentation.
  - `islands` (`{"at": [x, y], "territory": id}`), `drop` (`[x, y]`), `cuts` (`[x0, y0, x1, y1, width]`),
    `lakes` (`[x, y]` of an enclosed sea pocket to fill), `adjacencyOverrides`: manual fixes. They are
    empty or unused at the moment because neither board needs them.
  - `params`: thresholds. The scanned original and the flat digital advanced board need different values.
  - `zooms`: crops that `validate_board.py` renders for visual checks.
- `build_board.py`: the pipeline.
- `validate_board.py`: hard checks (exit code 1 on failure) and overlay rendering.
- `out/`: overlays (`<id>_overlay.png`, `<id>_overlay_small.jpg`, `<id>_zoom_*.png`, `<id>_anchors.png`)
  and `<id>.report.json` (nodes, sea-lines, island assignments, shared border lengths, debug).

## How it works

1. The board is resized to 6000x4000 and converted to Lab. A pixel counts as "fill" when its chroma
   is above the land threshold and it is close to its local median colour (21 px window). On the
   advanced board it also needs a low colour gradient. Thin white borders, coast strokes, text and
   marks therefore all fall outside the fill.
2. Each 4-connected fill component holding a label seed becomes that territory's marker. A component
   holding several seeds (a leak through a broken border) is eroded until the seeds separate.
   Unseeded components (islands, pieces cut off by text) go to the nearest territory of similar
   colour. Thin ones, such as plate leader lines, are ignored.
3. Grey sea pixels become a sea marker, together with sea-line and node discs and the furniture boxes.
   All other pixels go to the nearest marker, so borders split down the middle and coast strokes
   split half and half. Sea pockets under 2500 px² go to the land. A sea pocket enclosed by a single
   territory is filled into it. Specks under 1200 px² are dropped.
4. Polygons are traced on the pixel-crack lattice and split into arcs at junctions. Each shared arc is
   simplified once with Douglas-Peucker (eps 1.5 px for original, 3.5 px for advanced; more where a
   ring would exceed 250 points) and reused by both neighbours. Neighbouring polygons therefore share
   edges exactly and never overlap.
5. Sea-line nodes are found as dark rings whose hole is circular. A line exists between two nodes when
   the segment between them is dark and low-chroma for at least 93% of its length. Each node goes to
   the nearest territory. Wrap stubs run horizontally from a node to the board edge.
6. Adjacency is the land borders (shared arc length of at least 6 px) plus the sea-lines.
   `validate_board.py` compares it with classic Risk.
7. Anchors:
   - `center` is the distance-transform maximum of the main landmass's printed land.
   - `label` is the refined text centre.
   - `mark` is the best template match of the bow-tie mark inside the territory. The template is cut
     from the image at `markTemplate`.
   - `spots` are hex-packed points around the pole of the land area, ordered from the centre outwards.
     They keep away from the label and mark (padding shrinks for small territories) and from sea-line
     nodes. Spacing is at least 0.8 x `pieceSize`.

## Notes

- Polygons follow the printed coasts. Where coast strokes merge, a strait closes and islands join
  their territory's main polygon, along with any sea pocket they enclose: Indonesia, Japan, Great
  Britain + Ireland, and the Adriatic inside Southern Europe on the advanced board. Spots and centres
  avoid those pockets. Larger enclosed seas stay sea: the Black Sea, the Caspian, both Mediterranean
  basins, Lake Superior on the original, and the Baltic on the advanced board.
- The advanced board's "1 TERRITORY" plate covers part of India, so India has a second small polygon
  for the visible tip below the plate.

## Coastal territories (sea-line stickers)
After `build_board.py`, run `python3 tools/board/add_coastal.py original advanced`. It adds `coastal` (the territory
touches open water; lakes such as the Caspian don't count) and `coastPoints` (polygon vertices on that coast, where
pen-drawn sea lines start) to every territory. Inland on both boards: Afghanistan, Irkutsk.
