#!/usr/bin/env python3
"""Validate data/boards/<id>.json and render overlay PNGs to tools/board/out/.

Usage: python3 tools/board/validate_board.py original|advanced [--no-render]
Exit code 1 if any hard check fails.
"""
import argparse
import json
import math
import os
import sys
from collections import defaultdict, deque

import cv2
import numpy as np
from matplotlib.path import Path

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT = os.path.join(HERE, 'out')
sys.path.insert(0, HERE)
from build_board import CLASSIC, ring_self_intersects  # noqa: E402

IDS = sorted(CLASSIC.keys())


def ring_area(pts):
    x, y = pts[:, 0].astype(float), pts[:, 1].astype(float)
    return 0.5 * abs(float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum()))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--no-render', action='store_true')
    args = ap.parse_args()
    data = json.load(open(os.path.join(ROOT, 'data', 'boards', f'{args.board}.json')))
    cfg = json.load(open(os.path.join(HERE, f'{args.board}.config.json')))
    W, H = data['scene']['width'], data['scene']['height']
    errors, warns = [], []
    T = data['territories']

    # ---- ids
    if sorted(T.keys()) != IDS:
        errors.append(f'territory ids mismatch: missing {set(IDS) - set(T)}, extra {set(T) - set(IDS)}')

    # ---- polygons
    paths = {}
    npts = 0
    for t, td in T.items():
        ps = []
        for poly in td['polygons']:
            a = np.asarray(poly, np.int64).reshape(-1, 2)
            npts += len(a)
            if len(a) < 3:
                errors.append(f'{t}: polygon with {len(a)} points')
                continue
            if ring_area(a) <= 0:
                errors.append(f'{t}: zero-area polygon')
            if ring_self_intersects([tuple(p) for p in a.tolist()]):
                errors.append(f'{t}: self-intersecting polygon ({len(a)} pts)')
            if len(a) > 260:
                warns.append(f'{t}: polygon has {len(a)} points')
            if (a[:, 0] < 0).any() or (a[:, 0] > W).any() or (a[:, 1] < 0).any() or (a[:, 1] > H).any():
                errors.append(f'{t}: polygon outside scene')
            ps.append(Path(a.astype(float)))
        paths[t] = ps

    def inside(t, p):
        return any(pp.contains_point((p[0] + 0.01, p[1] + 0.013)) for pp in paths[t])

    # ---- anchors inside
    piece = data['pieceSize']
    for t, td in T.items():
        for key in ('center', 'label', 'mark'):
            p = td.get(key)
            if p is None:
                errors.append(f'{t}: missing {key}')
            elif not inside(t, p):
                errors.append(f'{t}: {key} {p} outside polygons')
        sp = td['spots']
        if len(sp) < 4:
            errors.append(f'{t}: only {len(sp)} spots')
        elif len(sp) < 10:
            warns.append(f'{t}: {len(sp)} spots')
        for p in sp:
            if not inside(t, p):
                errors.append(f'{t}: spot {p} outside polygons')
        if len(sp) > 1:
            a = np.asarray(sp, float)
            d = np.hypot(a[:, None, 0] - a[None, :, 0], a[:, None, 1] - a[None, :, 1])
            d[np.arange(len(a)), np.arange(len(a))] = 1e9
            md = d.min()
            if md < piece * 0.8 - 0.5:
                warns.append(f'{t}: spots only {md:.0f}px apart (< 0.8*pieceSize)')
        for p in sp:
            for key in ('label', 'mark'):
                q = td[key]
                if q and math.hypot(p[0] - q[0], p[1] - q[1]) < piece * 0.6:
                    warns.append(f'{t}: spot {p} close to {key}')

    # ---- overlaps (pixel-centre rasterisation)
    count = np.zeros((H, W), np.uint8)
    owner = np.zeros((H, W), np.uint8)
    idx = {t: i + 1 for i, t in enumerate(IDS)}
    pair_ov = defaultdict(int)
    for t in IDS:
        for poly in T[t]['polygons']:
            a = np.asarray(poly, float).reshape(-1, 2)
            x0, y0 = int(max(0, a[:, 0].min())), int(max(0, a[:, 1].min()))
            x1, y1 = int(min(W, a[:, 0].max() + 1)), int(min(H, a[:, 1].max() + 1))
            xs, ys = np.meshgrid(np.arange(x0, x1) + 0.5137, np.arange(y0, y1) + 0.5071)
            m = Path(a).contains_points(np.c_[xs.ravel(), ys.ravel()]).reshape(xs.shape)
            sub_o = owner[y0:y1, x0:x1]
            ov = m & (sub_o > 0) & (sub_o != idx[t])
            if ov.any():
                for o, c in zip(*np.unique(sub_o[ov], return_counts=True)):
                    pair_ov[(IDS[o - 1], t)] += int(c)
            count[y0:y1, x0:x1] += m.astype(np.uint8)
            sub_o[m] = idx[t]
    total_ov = int((count > 1).sum())
    for (a, b), c in sorted(pair_ov.items(), key=lambda z: -z[1]):
        if c > 4:
            errors.append(f'overlap {a}/{b}: {c} px')
    land_px = int((count > 0).sum())

    # ---- adjacency
    for t, td in T.items():
        for u in td['neighbors']:
            if u not in T:
                errors.append(f'{t}: unknown neighbour {u}')
            elif t not in T[u]['neighbors']:
                errors.append(f'asymmetric adjacency {t} -> {u}')
    seen = {IDS[0]}
    q = deque([IDS[0]])
    while q:
        t = q.popleft()
        for u in T[t]['neighbors']:
            if u not in seen:
                seen.add(u)
                q.append(u)
    if len(seen) != len(IDS):
        errors.append(f'adjacency graph not connected: unreachable {set(IDS) - seen}')
    if 'kamchatka' not in T['alaska']['neighbors']:
        errors.append('alaska-kamchatka not connected')
    extra, missing = [], []
    for t in IDS:
        for u in T[t]['neighbors']:
            if u not in CLASSIC[t] and t < u:
                extra.append((t, u))
        for u in CLASSIC[t]:
            if u not in T[t]['neighbors'] and t < u:
                missing.append((t, u))

    # ---- continents
    tot = 0
    for cid, cd in data['continents'].items():
        n = len(cd['territories'])
        tot += n
        exp = cfg['continents'][cid].get('plateCount')
        if exp is not None and exp != n:
            errors.append(f'continent {cid}: {n} territories but plate says {exp}')
        for t in cd['territories']:
            if T[t]['continent'] != cid:
                errors.append(f'{t} continent mismatch')
        for k in ('plate', 'namePlate', 'bonusBadge'):
            if not cd.get(k):
                errors.append(f'continent {cid}: missing {k}')
    if tot != 42:
        errors.append(f'continents cover {tot} territories')
    # sea-line endpoints near their territories
    for s in data['seaLines']:
        for end, t in ((0, s['a']), (1, s['b'])):
            if s.get('wrap') and end == 1:
                continue
            p = s['points'][end]
            dmin = min(min(np.hypot(np.asarray(poly[0::2]) - p[0], np.asarray(poly[1::2]) - p[1]).min() for poly in T[t]['polygons']), 1e9)
            if not inside(t, p) and dmin > 60:
                warns.append(f'sea-line {s["a"]}-{s["b"]} end {end} is {dmin:.0f}px from {t}')

    summary = {
        'board': data['id'],
        'territories': len(T),
        'polygons': sum(len(td['polygons']) for td in T.values()),
        'points': npts,
        'landPixels': land_px,
        'overlapPixels': total_ov,
        'seaLines': len(data['seaLines']),
        'extraVsClassic': extra,
        'missingVsClassic': missing,
        'spots': {t: len(td['spots']) for t, td in T.items()},
    }
    print(json.dumps({k: v for k, v in summary.items() if k != 'spots'}, indent=None))
    print('spots per territory: min', min(summary['spots'].values()), 'max', max(summary['spots'].values()))
    for w in warns:
        print('WARN ', w)
    for e in errors:
        print('ERROR', e)
    print('OK' if not errors else f'{len(errors)} ERRORS')

    if not args.no_render:
        render(data, args.board, cfg)
    sys.exit(1 if errors else 0)


# --------------------------------------------------------------------------- rendering
def palette(n):
    cols = []
    for i in range(n):
        h = (i * 0.61803398875) % 1.0
        hsv = np.uint8([[[int(h * 179), 200, 255]]])
        cols.append(tuple(int(c) for c in cv2.cvtColor(hsv, cv2.COLOR_HSV2BGR)[0, 0]))
    return cols


def draw_overlay(bg, data, scale, show_text=True):
    T = data['territories']
    img = bg.copy()
    fillc = img.copy()
    cols = palette(len(IDS))
    piece = data['pieceSize']
    for i, t in enumerate(IDS):
        for poly in T[t]['polygons']:
            a = (np.asarray(poly, float).reshape(-1, 2) * scale).round().astype(np.int32)
            cv2.fillPoly(fillc, [a], cols[i])
    img = cv2.addWeighted(fillc, 0.38, img, 0.62, 0)
    lw = max(1, int(round(2 * scale * 2)))
    for i, t in enumerate(IDS):
        for poly in T[t]['polygons']:
            a = (np.asarray(poly, float).reshape(-1, 2) * scale).round().astype(np.int32)
            cv2.polylines(img, [a], True, (20, 20, 20), lw + 1, cv2.LINE_AA)
            cv2.polylines(img, [a], True, cols[i], max(1, lw - 1), cv2.LINE_AA)
    S = lambda p: (int(round(p[0] * scale)), int(round(p[1] * scale)))
    # adjacency edges
    sea_pairs = {tuple(sorted((s['a'], s['b']))) for s in data['seaLines']}
    done = set()
    for t in IDS:
        for u in T[t]['neighbors']:
            k = tuple(sorted((t, u)))
            if k in done:
                continue
            done.add(k)
            if k == ('alaska', 'kamchatka'):
                continue
            col = (255, 255, 0) if k in sea_pairs else (255, 255, 255)
            cv2.line(img, S(T[t]['center']), S(T[u]['center']), (0, 0, 0), lw + 2, cv2.LINE_AA)
            cv2.line(img, S(T[t]['center']), S(T[u]['center']), col, lw, cv2.LINE_AA)
    for s in data['seaLines']:
        col = (0, 140, 255) if s.get('wrap') else (0, 255, 255)
        cv2.line(img, S(s['points'][0]), S(s['points'][1]), col, lw + 1, cv2.LINE_AA)
        for p in s['points']:
            cv2.circle(img, S(p), max(2, int(14 * scale)), col, lw, cv2.LINE_AA)
    for i, t in enumerate(IDS):
        td = T[t]
        for p in td['spots']:
            cv2.circle(img, S(p), max(2, int(piece / 2 * scale)), (0, 0, 0), lw + 1, cv2.LINE_AA)
            cv2.circle(img, S(p), max(2, int(piece / 2 * scale)), (0, 230, 255), lw, cv2.LINE_AA)
        cv2.circle(img, S(td['center']), max(3, int(12 * scale)), (255, 255, 255), -1, cv2.LINE_AA)
        cv2.circle(img, S(td['center']), max(3, int(12 * scale)), (0, 0, 0), lw, cv2.LINE_AA)
        cv2.circle(img, S(td['label']), max(3, int(10 * scale)), (255, 255, 0), -1, cv2.LINE_AA)
        if td['mark']:
            cv2.drawMarker(img, S(td['mark']), (255, 0, 255), cv2.MARKER_TILTED_CROSS, max(6, int(50 * scale)), lw + 1)
        if show_text:
            org = S((td['center'][0] - 80, td['center'][1] - 18))
            fs = max(0.35, 1.1 * scale)
            cv2.putText(img, t, org, cv2.FONT_HERSHEY_SIMPLEX, fs, (0, 0, 0), max(2, int(5 * scale)), cv2.LINE_AA)
            cv2.putText(img, t, org, cv2.FONT_HERSHEY_SIMPLEX, fs, (255, 255, 255), max(1, int(2 * scale)), cv2.LINE_AA)
    # furniture
    F = data['furniture']

    def rect(b, col):
        cv2.rectangle(img, S((b['x'], b['y'])), S((b['x'] + b['width'], b['y'] + b['height'])), col, lw + 1)
    for r in F['referenceStickers']:
        rect(r, (0, 255, 0) if r['printed'] else (0, 160, 0))
    for k in ('troopChart', 'tradeChart', 'starTrade', 'worldName'):
        rect(F[k], (255, 128, 0))
    rect(F['victors'], (255, 0, 128))
    for ln in F['victors']['lines']:
        cv2.line(img, S((ln['x'], ln['y'])), S((ln['x'] + ln['width'], ln['y'])), (0, 0, 255), lw + 1)
    for cid, cd in data['continents'].items():
        rect(cd['plate'], (0, 0, 255))
        if cd.get('namePlate'):
            rect(cd['namePlate'], (255, 0, 255))
        b = cd.get('bonusBadge')
        if b:
            cv2.circle(img, S((b['x'], b['y'])), max(2, int(b['r'] * scale)), (255, 0, 255), lw + 1, cv2.LINE_AA)
    return img


def render(data, board, cfg):
    bgp = os.path.join(ROOT, data['scene']['background'])
    bg = cv2.imread(bgp)
    bg = cv2.resize(bg, (data['scene']['width'], data['scene']['height']), interpolation=cv2.INTER_AREA if bg.shape[1] > 6000 else cv2.INTER_LINEAR)
    os.makedirs(OUT, exist_ok=True)
    small = cv2.resize(bg, (3000, 2000), interpolation=cv2.INTER_AREA)
    full = draw_overlay(small, data, 0.5)
    cv2.imwrite(os.path.join(OUT, f'{board}_overlay.png'), full)
    cv2.imwrite(os.path.join(OUT, f'{board}_overlay_small.jpg'), cv2.resize(full, (2000, 1333), interpolation=cv2.INTER_AREA), [cv2.IMWRITE_JPEG_QUALITY, 90])
    for name, b in cfg.get('zooms', {}).items():
        x0, y0, x1, y1 = [int(v * cfg.get('coordScale', 1)) for v in b]
        crop = bg[y0:y1, x0:x1]
        sc = min(1.0, 1800.0 / max(x1 - x0, y1 - y0))
        crop = cv2.resize(crop, None, fx=sc, fy=sc, interpolation=cv2.INTER_AREA)
        sub = json.loads(json.dumps(data))
        for t in sub['territories'].values():
            t['polygons'] = [[(v - (x0 if i % 2 == 0 else y0)) for i, v in enumerate(p)] for p in t['polygons']]
            for k in ('center', 'label', 'mark'):
                if t[k]:
                    t[k] = [t[k][0] - x0, t[k][1] - y0]
            t['spots'] = [[p[0] - x0, p[1] - y0] for p in t['spots']]
        for s in sub['seaLines']:
            s['points'] = [[p[0] - x0, p[1] - y0] for p in s['points']]
        F = sub['furniture']

        def shift(o):
            o['x'] -= x0
            o['y'] -= y0
        for r in F['referenceStickers']:
            shift(r)
        for k in ('troopChart', 'tradeChart', 'starTrade', 'worldName', 'victors'):
            shift(F[k])
        for ln in F['victors']['lines']:
            shift(ln)
        for cd in sub['continents'].values():
            shift(cd['plate'])
            if cd.get('namePlate'):
                shift(cd['namePlate'])
            if cd.get('bonusBadge'):
                shift(cd['bonusBadge'])
        img = draw_overlay(crop, sub, sc)
        cv2.imwrite(os.path.join(OUT, f'{board}_zoom_{name}.png'), img)


if __name__ == '__main__':
    main()
