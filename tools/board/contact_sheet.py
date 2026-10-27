#!/usr/bin/env python3
"""Contact sheet of every territory's label and mark anchor (for eyeballing). Writes out/<board>_anchors.png"""
import json, os, sys
import cv2, numpy as np
HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
board = sys.argv[1]
data = json.load(open(os.path.join(ROOT, 'data', 'boards', f'{board}.json')))
bg = cv2.imread(os.path.join(ROOT, data['scene']['background']))
bg = cv2.resize(bg, (6000, 4000), interpolation=cv2.INTER_AREA if bg.shape[1] > 6000 else cv2.INTER_LINEAR)
tiles = []
for t, td in data['territories'].items():
    row = []
    for key, (w, h) in (('label', (360, 140)), ('mark', (240, 140))):
        p = td[key]
        x0, y0 = int(p[0] - w / 2), int(p[1] - h / 2)
        c = np.zeros((h, w, 3), np.uint8)
        xs0, ys0 = max(0, x0), max(0, y0)
        sub = bg[ys0:y0 + h, xs0:x0 + w]
        c[ys0 - y0:ys0 - y0 + sub.shape[0], xs0 - x0:xs0 - x0 + sub.shape[1]] = sub
        cv2.drawMarker(c, (w // 2, h // 2), (255, 0, 255), cv2.MARKER_CROSS, 30, 2)
        row.append(c)
    lab = np.full((140, 200, 3), 255, np.uint8)
    cv2.putText(lab, t[:18], (4, 70), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (0, 0, 0), 1, cv2.LINE_AA)
    tiles.append(np.hstack([lab] + row))
cols = 3
rows = [np.hstack(tiles[i:i + cols] + [np.zeros_like(tiles[0])] * (cols - len(tiles[i:i + cols]))) for i in range(0, len(tiles), cols)]
sheet = np.vstack(rows)
cv2.imwrite(os.path.join(HERE, 'out', f'{board}_anchors.png'), sheet)
print(sheet.shape)
