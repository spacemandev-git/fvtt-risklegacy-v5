#!/usr/bin/env python3
"""Mark which territories touch an ocean, for the sea-line stickers ("territories that have borders touching an ocean").

Reads data/boards/<id>.json and adds to every territory:
  coastal:     bool   the territory's border touches open water (water connected to a large body, not a lake)
  coastPoints: [[x,y]] polygon vertices that lie on that coast (subsampled, scene px), where pen-drawn sea lines start

Rerun after build_board.py:  python3 tools/board/add_coastal.py original advanced
"""
import json
import sys
from pathlib import Path

import cv2
import numpy as np

ROOT = Path(__file__).resolve().parents[2]
SCALE = 0.25                   # rasterize at 1/4 scene resolution (1500 x 1000)
RING = 4                       # px at that scale (= 16 scene px) around each territory
MIN_WATER_FRACTION = 0.004     # water bodies smaller than this share of the map are lakes, not ocean
MAX_COAST_POINTS = 48


def rasterize(board):
    w, h = int(board["scene"]["width"] * SCALE), int(board["scene"]["height"] * SCALE)
    labels = np.zeros((h, w), np.int32)
    ids = list(board["territories"].keys())
    for i, tid in enumerate(ids, start=1):
        for poly in board["territories"][tid]["polygons"]:
            pts = (np.array(poly, np.float32).reshape(-1, 2) * SCALE).round().astype(np.int32)
            cv2.fillPoly(labels, [pts], i)
    return ids, labels


def ocean_mask(labels):
    water = (labels == 0).astype(np.uint8)
    n, comp, stats, _ = cv2.connectedComponentsWithStats(water, connectivity=4)
    total = labels.size
    ocean = np.zeros_like(water)
    for c in range(1, n):
        if stats[c, cv2.CC_STAT_AREA] >= MIN_WATER_FRACTION * total:
            ocean[comp == c] = 1
    return ocean


def main(board_id):
    path = ROOT / "data" / "boards" / f"{board_id}.json"
    board = json.loads(path.read_text())
    ids, labels = rasterize(board)
    ocean = ocean_mask(labels)
    kernel = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * RING + 1, 2 * RING + 1))
    near_ocean = cv2.dilate(ocean, kernel)
    h, w = labels.shape
    coastal_ids = []
    for i, tid in enumerate(ids, start=1):
        mask = (labels == i).astype(np.uint8)
        ring = cv2.dilate(mask, kernel) & (1 - mask)
        touches = int((ring & ocean).sum())
        t = board["territories"][tid]
        t["coastal"] = touches > 6
        points = []
        if t["coastal"]:
            for poly in t["polygons"]:
                for k in range(0, len(poly), 2):
                    x, y = poly[k], poly[k + 1]
                    sx, sy = min(w - 1, max(0, int(x * SCALE))), min(h - 1, max(0, int(y * SCALE)))
                    if near_ocean[sy, sx]:
                        points.append([int(x), int(y)])
            if len(points) > MAX_COAST_POINTS:
                step = len(points) / MAX_COAST_POINTS
                points = [points[int(j * step)] for j in range(MAX_COAST_POINTS)]
            coastal_ids.append(tid)
        t["coastPoints"] = points
    path.write_text(json.dumps(board, separators=(",", ":")))
    inland = [tid for tid in ids if tid not in coastal_ids]
    print(f"{board_id}: {len(coastal_ids)} coastal, {len(inland)} inland: {', '.join(inland)}")


if __name__ == "__main__":
    for b in (sys.argv[1:] or ["original", "advanced"]):
        main(b)
