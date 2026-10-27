#!/usr/bin/env python3
"""Build a Risk Legacy board-geometry JSON (data/boards/<id>.json) from a board image.

Usage:  python3 tools/board/build_board.py original|advanced [--debug]

Hand-entered data lives in tools/board/<id>.config.json (label positions, plate/furniture
boxes, island overrides, thresholds).  Everything else (territory polygons, sea-lines,
marks, spots, adjacency, furniture refinement) is detected from the image.  See README.md.
"""
import argparse
import json
import math
import os
import sys
import time
from collections import defaultdict

import cv2
import numpy as np
from scipy import ndimage as ndi

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
OUT_DIR = os.path.join(HERE, 'out')
SW, SH = 6000, 4000
SEA = 255

CLASSIC = {
    'alaska': ['northwest_territory', 'alberta', 'kamchatka'],
    'northwest_territory': ['alaska', 'alberta', 'ontario', 'greenland'],
    'greenland': ['northwest_territory', 'ontario', 'eastern_canada', 'iceland'],
    'alberta': ['alaska', 'northwest_territory', 'ontario', 'western_united_states'],
    'ontario': ['northwest_territory', 'alberta', 'western_united_states', 'eastern_united_states', 'eastern_canada', 'greenland'],
    'eastern_canada': ['ontario', 'greenland', 'eastern_united_states'],
    'western_united_states': ['alberta', 'ontario', 'eastern_united_states', 'central_america'],
    'eastern_united_states': ['western_united_states', 'ontario', 'eastern_canada', 'central_america'],
    'central_america': ['western_united_states', 'eastern_united_states', 'venezuela'],
    'venezuela': ['central_america', 'peru', 'brazil'],
    'peru': ['venezuela', 'brazil', 'argentina'],
    'brazil': ['venezuela', 'peru', 'argentina', 'north_africa'],
    'argentina': ['peru', 'brazil'],
    'iceland': ['greenland', 'great_britain', 'scandinavia'],
    'scandinavia': ['iceland', 'great_britain', 'northern_europe', 'russia'],
    'great_britain': ['iceland', 'scandinavia', 'northern_europe', 'western_europe'],
    'northern_europe': ['great_britain', 'scandinavia', 'russia', 'southern_europe', 'western_europe'],
    'western_europe': ['great_britain', 'northern_europe', 'southern_europe', 'north_africa'],
    'southern_europe': ['western_europe', 'northern_europe', 'russia', 'middle_east', 'egypt', 'north_africa'],
    'russia': ['scandinavia', 'northern_europe', 'southern_europe', 'middle_east', 'afghanistan', 'ural'],
    'north_africa': ['brazil', 'western_europe', 'southern_europe', 'egypt', 'east_africa', 'central_africa'],
    'egypt': ['north_africa', 'southern_europe', 'middle_east', 'east_africa'],
    'east_africa': ['egypt', 'north_africa', 'central_africa', 'south_africa', 'madagascar', 'middle_east'],
    'central_africa': ['north_africa', 'east_africa', 'south_africa'],
    'south_africa': ['central_africa', 'east_africa', 'madagascar'],
    'madagascar': ['south_africa', 'east_africa'],
    'middle_east': ['southern_europe', 'russia', 'afghanistan', 'india', 'egypt', 'east_africa'],
    'afghanistan': ['russia', 'ural', 'china', 'india', 'middle_east'],
    'ural': ['russia', 'siberia', 'china', 'afghanistan'],
    'siberia': ['ural', 'yakutsk', 'irkutsk', 'mongolia', 'china'],
    'yakutsk': ['siberia', 'irkutsk', 'kamchatka'],
    'kamchatka': ['yakutsk', 'irkutsk', 'mongolia', 'japan', 'alaska'],
    'irkutsk': ['siberia', 'yakutsk', 'kamchatka', 'mongolia'],
    'mongolia': ['irkutsk', 'kamchatka', 'japan', 'china', 'siberia'],
    'japan': ['kamchatka', 'mongolia'],
    'china': ['mongolia', 'siberia', 'ural', 'afghanistan', 'india', 'southeast_asia'],
    'india': ['middle_east', 'afghanistan', 'china', 'southeast_asia'],
    'southeast_asia': ['india', 'china', 'indonesia'],
    'indonesia': ['southeast_asia', 'new_guinea', 'western_australia'],
    'new_guinea': ['indonesia', 'western_australia', 'eastern_australia'],
    'western_australia': ['indonesia', 'new_guinea', 'eastern_australia'],
    'eastern_australia': ['western_australia', 'new_guinea'],
}


def log(*a):
    print(*a, flush=True)


# --------------------------------------------------------------------------- config helpers
class Cfg:
    def __init__(self, board):
        self.path = os.path.join(HERE, f'{board}.config.json')
        self.c = json.load(open(self.path))
        self.s = float(self.c.get('coordScale', 1))
        self.P = self.c['params']

    def pt(self, p):
        return (p[0] * self.s, p[1] * self.s)

    def box(self, b):
        return [int(round(v * self.s)) for v in b]


def clip_box(b):
    x0, y0, x1, y1 = b
    return [max(0, x0), max(0, y0), min(SW, x1), min(SH, y1)]


# --------------------------------------------------------------------------- image features
def load_scene(cfg):
    src = cv2.imread(os.path.join(ROOT, cfg.c['image']), cv2.IMREAD_COLOR)
    if src is None:
        raise SystemExit('cannot read ' + cfg.c['image'])
    h, w = src.shape[:2]
    interp = cv2.INTER_AREA if w >= SW else cv2.INTER_LINEAR
    img = cv2.resize(src, (SW, SH), interpolation=interp)
    return src, img


def features(img, P):
    lab = cv2.cvtColor(cv2.GaussianBlur(img, (3, 3), 0), cv2.COLOR_BGR2LAB)
    med = cv2.medianBlur(lab, int(P.get('medianK', 21)))
    labf = lab.astype(np.float32)
    d = np.sqrt(((labf - med.astype(np.float32)) ** 2).sum(2))
    L = labf[..., 0]
    a = labf[..., 1] - 128
    b = labf[..., 2] - 128
    ch = np.sqrt(a * a + b * b)
    del labf
    return lab, med, L, ch, d


def seaish_mask(L, ch, d, P):
    m = (ch < P['seaChroma']) & (L > P['seaLmin']) & (L < P['seaLmax']) & (d < P['fillDist'])
    m = cv2.morphologyEx(m.astype(np.uint8), cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (5, 5)))
    return m


# --------------------------------------------------------------------------- furniture boxes
def refine_box(nonsea, b, pad=0, open_px=7):
    """Bounding box of the main non-sea component inside rough box b (thin leader lines removed)."""
    x0, y0, x1, y1 = clip_box(b)
    sub = nonsea[y0:y1, x0:x1].astype(np.uint8)
    sub = cv2.morphologyEx(sub, cv2.MORPH_CLOSE, np.ones((5, 5), np.uint8))
    if open_px:
        sub = cv2.morphologyEx(sub, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (open_px, open_px)))
    n, lab, st, _ = cv2.connectedComponentsWithStats(sub, connectivity=8)
    if n <= 1:
        return [x0, y0, x1, y1]
    H, W = sub.shape
    best, ba = None, -1
    for i in range(1, n):
        x, y, w, h, a = st[i]
        touches = x == 0 or y == 0 or x + w >= W or y + h >= H
        score = a * (0.2 if touches else 1.0)
        if score > ba:
            best, ba = i, score
    x, y, w, h, a = st[best]
    return [x0 + x - pad, y0 + y - pad, x0 + x + w + pad, y0 + y + h + pad]


def box_obj(b):
    return {'x': int(b[0]), 'y': int(b[1]), 'width': int(b[2] - b[0]), 'height': int(b[3] - b[1])}


# --------------------------------------------------------------------------- sea-lines
def detect_nodes(gray, excl, P):
    dark = (gray < P['nodeDark']).astype(np.uint8)
    cnts, hier = cv2.findContours(dark, cv2.RETR_CCOMP, cv2.CHAIN_APPROX_NONE)
    amin, amax = P['nodeArea']
    nodes = []
    for i, c in enumerate(cnts):
        if hier[0][i][3] < 0:
            continue
        a = cv2.contourArea(c)
        if a < amin or a > amax:
            continue
        per = cv2.arcLength(c, True)
        if per <= 0 or 4 * math.pi * a / (per * per) < 0.75:
            continue
        (x, y), r = cv2.minEnclosingCircle(c)
        if excl[int(y), int(x)]:
            continue
        # ring check: the annulus just outside the hole must be dark
        ang = np.linspace(0, 2 * math.pi, 48, endpoint=False)
        rr = r + 4
        xs = np.clip((x + rr * np.cos(ang)).round().astype(int), 0, SW - 1)
        ys = np.clip((y + rr * np.sin(ang)).round().astype(int), 0, SH - 1)
        if (gray[ys, xs] < P['nodeDark'] + 30).mean() < 0.8:
            continue
        nodes.append([float(x), float(y), float(r)])
    return nodes


def seg_dark_fraction(gray, p, q, r0, thr, tol=2):
    p = np.asarray(p, float)
    q = np.asarray(q, float)
    v = q - p
    Ln = float(np.hypot(*v))
    if Ln < 2 * r0 + 6:
        return 0.0
    u = v / Ln
    n = np.array([-u[1], u[0]])
    ts = np.arange(r0, Ln - r0, 2.0)
    pts = p[None, :] + ts[:, None] * u[None, :]
    best = np.full(len(ts), 255.0)
    for k in range(-tol, tol + 1):
        pp = pts + k * n[None, :]
        xs = np.clip(pp[:, 0].round().astype(int), 0, SW - 1)
        ys = np.clip(pp[:, 1].round().astype(int), 0, SH - 1)
        best = np.minimum(best, gray[ys, xs])
    return float((best < thr).mean())


def detect_sealines(gray, nodes, P):
    lines = []
    N = len(nodes)
    outer = P['nodeOuterR']
    thr = P.get('lineDark', 55)
    for i in range(N):
        for j in range(i + 1, N):
            p = np.array(nodes[i][:2])
            q = np.array(nodes[j][:2])
            Ln = np.hypot(*(q - p))
            if Ln > 1500:
                continue
            if Ln <= 2 * outer + 10:
                # nodes almost touching: the short connector sits between the rings
                m = (p + q) / 2
                if gray[int(m[1]) - 2:int(m[1]) + 3, int(m[0]) - 2:int(m[0]) + 3].min() < thr:
                    lines.append((i, j, 1.0))
                continue
            # skip if another node sits on the segment (collinear chains)
            blocked = False
            for k in range(N):
                if k in (i, j):
                    continue
                c = np.array(nodes[k][:2])
                t = np.dot(c - p, q - p) / (Ln * Ln)
                if 0 < t < 1 and np.hypot(*(p + t * (q - p) - c)) < outer + 4:
                    blocked = True
                    break
            if blocked:
                continue
            f = seg_dark_fraction(gray, p, q, outer + 3, thr)
            if f >= 0.93:
                lines.append((i, j, f))
    stubs = []
    for i, (x, y, r) in enumerate(nodes):
        for side, ex in (('left', 0), ('right', SW - 1)):
            if abs(x - ex) > 700:
                continue
            step = -1 if side == 'left' else 1
            run, gap = 0, 0
            xx = x + step * (outer + 3)
            while 0 <= xx < SW:
                v = gray[int(y) - 4:int(y) + 5, int(xx)].min()
                if v < thr:
                    run += 1
                    gap = 0
                else:
                    gap += 1
                    if gap > 6:
                        break
                xx += step
            if run >= 35:
                stubs.append((i, side, run))
    return lines, stubs


# --------------------------------------------------------------------------- segmentation
def comp_in_window(comp, st, p, win, minarea):
    x, y = int(p[0]), int(p[1])
    w = comp[max(0, y - win):y + win, max(0, x - win):x + win]
    ids, cnt = np.unique(w[w > 0], return_counts=True)
    best, bc = None, 0
    for i, c in zip(ids, cnt):
        if st[i, 4] >= minarea and c > bc:
            best, bc = int(i), c
    return best


def split_by_erosion(mask, pts, win):
    """mask: uint8 sub-image; pts: seed points in sub coords. Erode until seeds separate."""
    for r in range(1, 40):
        k = cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1))
        er = cv2.erode(mask, k)
        n, lab = cv2.connectedComponents(er, connectivity=4)
        st = np.zeros((n, 5), np.int64)
        st[:, 4] = np.bincount(lab.ravel(), minlength=n)
        assign = [comp_in_window(lab, st, p, win + r, 1) for p in pts]
        if all(a is not None for a in assign) and len(set(assign)) == len(assign):
            return lab, assign, r
    return None, None, None


def grow_nearest(M):
    """Assign every 0 pixel of M to the label of the nearest non-zero pixel."""
    unknown = (M == 0).astype(np.uint8)
    if not unknown.any():
        return M
    _, idx = cv2.distanceTransformWithLabels(unknown, cv2.DIST_L2, 5, labelType=cv2.DIST_LABEL_PIXEL)
    lut = np.concatenate([[0], M[unknown == 0]]).astype(M.dtype)
    out = lut[idx]
    return out


def mean_lab(med, mask):
    return med[mask].reshape(-1, 3).astype(np.float32).mean(0)


def color_dist(c1, c2):
    return float(math.sqrt(((c1[0] - c2[0]) * 0.5) ** 2 + (c1[1] - c2[1]) ** 2 + (c1[2] - c2[2]) ** 2))


def segment(cfg, img, feats, excl, paint_sea, dbg):
    P = cfg.P
    lab, med, L, ch, d = feats
    tids = list(cfg.c['territories'].keys())
    tnum = {t: i + 1 for i, t in enumerate(tids)}

    fill = (ch > P['fillChroma']) & (d < P['fillDist'])
    if P.get('fillGrad'):
        k3 = np.ones((3, 3), np.uint8)
        grad = np.max(cv2.dilate(lab, k3) - cv2.erode(lab, k3), axis=2)
        fill &= grad < P['fillGrad']
        del grad
    fill = fill.astype(np.uint8)
    for cut in cfg.c.get('cuts', []):
        a = cfg.pt(cut[:2])
        b = cfg.pt(cut[2:4])
        w = int(cut[4]) if len(cut) > 4 else 3
        cv2.line(fill, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 0, w)
    if P.get('fillOpen', 0):
        r = int(P['fillOpen'])
        fill = cv2.morphologyEx(fill, cv2.MORPH_OPEN, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (2 * r + 1, 2 * r + 1)))
    n, comp, st, cen = cv2.connectedComponentsWithStats(fill, connectivity=4)
    log(f'  fill components: {n}')

    # ---- seeds
    win = int(P.get('seedWin', 60))
    seed_pts = {}
    for t, td in cfg.c['territories'].items():
        seed_pts[t] = cfg.pt(td.get('seed', td['label']))
    comp_of = {}
    for t, p in seed_pts.items():
        c = comp_in_window(comp, st, p, win, int(P.get('seedMinArea', 2000)))
        if c is None:
            raise SystemExit(f'no fill component near seed of {t} at {p}')
        comp_of[t] = c
    by_comp = defaultdict(list)
    for t, c in comp_of.items():
        by_comp[c].append(t)

    M = np.zeros((SH, SW), np.uint8)
    for c, ts in by_comp.items():
        x, y, w, h, a = st[c]
        if len(ts) == 1:
            M[y:y + h, x:x + w][comp[y:y + h, x:x + w] == c] = tnum[ts[0]]
            continue
        sub = (comp[y:y + h, x:x + w] == c).astype(np.uint8)
        pts = [(seed_pts[t][0] - x, seed_pts[t][1] - y) for t in ts]
        elab, assign, r = split_by_erosion(sub, pts, win)
        if elab is None:
            raise SystemExit(f'could not split component shared by {ts}')
        log(f'  split leaked component {ts} by erosion r={r}')
        dbg.setdefault('splits', []).append({'territories': ts, 'radius': r})
        for t, ai in zip(ts, assign):
            M[y:y + h, x:x + w][elab == ai] = tnum[t]

    # ---- territory colours (for island assignment)
    tcol = {}
    for t in tids:
        tcol[t] = mean_lab(med, M == tnum[t])

    # ---- islands / fragments
    seeded = set(by_comp.keys())
    overrides = [(cfg.pt(o['at']), o['territory']) for o in cfg.c.get('islands', [])]
    drops = [cfg.pt(p) for p in cfg.c.get('drop', [])]
    forced = {}
    for p, t in overrides:
        c = comp_in_window(comp, st, p, 30, 1)
        if c is None:
            log(f'  WARNING island override {t} at {p}: no component')
            continue
        forced[c] = t
    dropped = set()
    for p in drops:
        c = comp_in_window(comp, st, p, 30, 1)
        if c is not None:
            dropped.add(c)
    maxd = P['islandMaxDist']
    island_log = []
    order = np.argsort(-st[:, 4])
    for c in order:
        c = int(c)
        if c == 0 or c in seeded or c in dropped:
            continue
        x, y, w, h, a = st[c]
        if a < P['islandMinArea'] and c not in forced:
            continue
        cx, cy = cen[c]
        if excl[int(cy), int(cx)] and c not in forced:
            continue
        cm = comp[y:y + h, x:x + w] == c
        if c not in forced:
            pad_cm = np.pad(cm, 1).astype(np.uint8)
            if cv2.distanceTransform(pad_cm, cv2.DIST_L2, 3).max() < P.get('islandMinRadius', 7):
                island_log.append({'at': [int(cx), int(cy)], 'area': int(a), 'result': 'too thin'})
                continue
        if c in forced:
            t = forced[c]
        else:
            col = med[y:y + h, x:x + w][cm].reshape(-1, 3).astype(np.float32).mean(0)
            cands = [t for t in tids if color_dist(col, tcol[t]) < P['islandColorTol']]
            if not cands:
                island_log.append({'at': [int(cx), int(cy)], 'area': int(a), 'result': 'no colour match'})
                continue
            X0, Y0 = max(0, x - maxd), max(0, y - maxd)
            X1, Y1 = min(SW, x + w + maxd), min(SH, y + h + maxd)
            Msub = M[Y0:Y1, X0:X1]
            cmask = np.zeros(Msub.shape, bool)
            cmask[y - Y0:y - Y0 + h, x - X0:x - X0 + w] = cm
            best, bd = None, 1e9
            for t in cands:
                tm = Msub == tnum[t]
                if not tm.any():
                    continue
                dt = cv2.distanceTransform((~tm).astype(np.uint8), cv2.DIST_L2, 5)
                dd = float(dt[cmask].min())
                if dd < bd:
                    best, bd = t, dd
            if best is None or bd > maxd:
                island_log.append({'at': [int(cx), int(cy)], 'area': int(a), 'result': 'too far'})
                continue
            t = best
        M[y:y + h, x:x + w][cm] = tnum[t]
        island_log.append({'at': [int(cx), int(cy)], 'area': int(a), 'result': t})
    dbg['islands'] = island_log

    # ---- sea markers
    sea = seaish_mask(L, ch, d, P)
    ns, sl, sst, _ = cv2.connectedComponentsWithStats(sea, connectivity=4)
    big = sst[:, 4] >= P['seaMinArea']
    big[0] = False
    seam = big[sl]
    M[(M == 0) & seam] = SEA
    M[(M == 0) & (paint_sea > 0)] = SEA
    M[(M == 0) & excl] = SEA

    # ---- grow
    T = grow_nearest(M)

    # ---- lakes: enclosed sea pockets smaller than lakeMaxArea go to the surrounding land
    seamask = (T == SEA).astype(np.uint8)
    nl, ll, lst, lcen = cv2.connectedComponentsWithStats(seamask, connectivity=4)
    border_ids = set(np.unique(np.concatenate([ll[0], ll[-1], ll[:, 0], ll[:, -1]])).tolist())
    lake_pts = [cfg.pt(p) for p in cfg.c.get('lakes', [])]
    listed = set()
    for p in lake_pts:
        v = int(ll[int(p[1]), int(p[0])])
        if v == 0 or v in border_ids:
            log(f'  WARNING lake point {p} is not an enclosed sea pocket')
        else:
            listed.add(v)
    lakes = [i for i in range(1, nl) if i not in border_ids and (lst[i, 4] < P['lakeMaxArea'] or i in listed)]
    kept = [(i, int(lst[i, 4]), [int(c) for c in lcen[i]]) for i in range(1, nl) if i not in border_ids and i not in lakes]
    dbg['inlandSeasKept'] = kept
    if lakes:
        lk = np.zeros(nl, bool)
        lk[lakes] = True
        T2 = T.copy()
        T2[lk[ll]] = 0
        T = grow_nearest(T2)
    log(f'  filled {len(lakes)} lakes; kept {len(kept)} inland seas: {[(k[1], k[2]) for k in kept]}')

    # ---- specks: remove tiny pieces of territories, then fill holes inside a single territory
    for _round in range(2):
        changed = False
        T2 = T.copy()
        for t in tids:
            k = tnum[t]
            m = (T == k).astype(np.uint8)
            nn, cl, cst, _ = cv2.connectedComponentsWithStats(m, connectivity=4)
            for i in range(1, nn):
                if cst[i, 4] < P['speckArea']:
                    x, y, w, h, a = cst[i]
                    T2[y:y + h, x:x + w][cl[y:y + h, x:x + w] == i] = 0
                    changed = True
        if changed:
            T = grow_nearest(T2)
    for t in tids:
        k = tnum[t]
        m = T == k
        ys, xs = np.nonzero(m)
        y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
        sub = m[y0:y1, x0:x1]
        filled = ndi.binary_fill_holes(sub)
        holes = filled & ~sub
        if holes.any():
            vals = T[y0:y1, x0:x1][holes]
            if np.all(vals == SEA):
                T[y0:y1, x0:x1][holes] = k
            else:
                # fill only sea pockets
                hl, nh = ndi.label(holes)
                for i in range(1, nh + 1):
                    hm = hl == i
                    if np.all(T[y0:y1, x0:x1][hm] == SEA):
                        T[y0:y1, x0:x1][hm] = k
                    else:
                        log(f'  WARNING {t} encloses other territory pixels')
    T[T == SEA] = 0
    return T, tnum, tcol


# --------------------------------------------------------------------------- polygons (shared-arc simplification)
def junction_map(T):
    H, W = T.shape
    P = np.full((H + 2, W + 2), -1, np.int16)
    P[1:-1, 1:-1] = T
    a = P[:-1, :-1]
    b = P[:-1, 1:]
    c = P[1:, :-1]
    e = P[1:, 1:]
    n = 1 + (b != a).astype(np.uint8) + ((c != a) & (c != b)) + ((e != a) & (e != b) & (e != c))
    J = (n >= 3) | ((n == 2) & (a == e) & (b == c) & (a != b))
    return P, J


def trace_territory(P, k):
    """Return rings of label k as lists of (vertex list, neighbour list). Interior on the right (y down)."""
    m = P == k
    ys, xs = np.nonzero(m)
    y0, y1, x0, x1 = ys.min() - 1, ys.max() + 2, xs.min() - 1, xs.max() + 2
    Q = P[y0:y1, x0:x1]
    inner = Q[1:-1, 1:-1] == k
    oy, ox = y0, x0  # padded coords of Q[1,1] are (y0+1, x0+1) -> pixel (x0, y0)
    S, Ex, Ey, Nb, Dr = [], [], [], [], []
    up, rt, dn, lf = Q[:-2, 1:-1], Q[1:-1, 2:], Q[2:, 1:-1], Q[1:-1, :-2]
    jj, ii = np.nonzero(inner & (up != k))
    S.append((ox + ii, oy + jj)); Ex.append(ox + ii + 1); Ey.append(oy + jj); Nb.append(up[jj, ii]); Dr.append(np.zeros(len(ii), np.int8))
    jj, ii = np.nonzero(inner & (rt != k))
    S.append((ox + ii + 1, oy + jj)); Ex.append(ox + ii + 1); Ey.append(oy + jj + 1); Nb.append(rt[jj, ii]); Dr.append(np.ones(len(ii), np.int8))
    jj, ii = np.nonzero(inner & (dn != k))
    S.append((ox + ii + 1, oy + jj + 1)); Ex.append(ox + ii); Ey.append(oy + jj + 1); Nb.append(dn[jj, ii]); Dr.append(np.full(len(ii), 2, np.int8))
    jj, ii = np.nonzero(inner & (lf != k))
    S.append((ox + ii, oy + jj + 1)); Ex.append(ox + ii); Ey.append(oy + jj); Nb.append(lf[jj, ii]); Dr.append(np.full(len(ii), 3, np.int8))
    sx = np.concatenate([s[0] for s in S]).astype(np.int64)
    sy = np.concatenate([s[1] for s in S]).astype(np.int64)
    ex = np.concatenate(Ex).astype(np.int64)
    ey = np.concatenate(Ey).astype(np.int64)
    nb = np.concatenate(Nb).astype(np.int64)
    dr = np.concatenate(Dr).astype(np.int64)
    W1 = 100000
    skey = sy * W1 + sx
    ekey = ey * W1 + ex
    out = defaultdict(list)
    for i, kk in enumerate(skey.tolist()):
        out[kk].append(i)
    nE = len(sx)
    used = np.zeros(nE, bool)
    rings = []
    sxl, syl, nbl, drl, ekl = sx.tolist(), sy.tolist(), nb.tolist(), dr.tolist(), ekey.tolist()
    for i0 in range(nE):
        if used[i0]:
            continue
        vs, ns = [], []
        i = i0
        while True:
            used[i] = True
            vs.append((sxl[i], syl[i]))
            ns.append(nbl[i])
            cands = out[ekl[i]]
            if len(cands) == 1:
                j = cands[0]
            else:
                j = None
                for w in ((drl[i] + 1) % 4, drl[i], (drl[i] + 3) % 4):
                    for c in cands:
                        if drl[c] == w and (not used[c] or c == i0):
                            j = c
                            break
                    if j is not None:
                        break
            if j is None or j == i0 or used[j]:
                break
            i = j
        rings.append((vs, ns))
    return rings


def ring_area(vs):
    a = np.asarray(vs, np.float64)
    x, y = a[:, 0], a[:, 1]
    return 0.5 * float((x * np.roll(y, -1) - np.roll(x, -1) * y).sum())


def dp(pts, eps, closed):
    arr = np.asarray(pts, np.int32).reshape(-1, 1, 2)
    if len(arr) <= 2:
        return [tuple(p) for p in arr.reshape(-1, 2).tolist()]
    out = cv2.approxPolyDP(arr, eps, closed)
    return [tuple(p) for p in out.reshape(-1, 2).tolist()]


def segments_intersect(p1, p2, p3, p4):
    def orient(a, b, c):
        v = (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0])
        return (v > 0) - (v < 0)
    o1, o2, o3, o4 = orient(p1, p2, p3), orient(p1, p2, p4), orient(p3, p4, p1), orient(p3, p4, p2)
    return o1 * o2 < 0 and o3 * o4 < 0


def ring_self_intersects(pts):
    n = len(pts)
    segs = [(pts[i], pts[(i + 1) % n]) for i in range(n)]
    for i in range(n):
        for j in range(i + 2, n):
            if i == 0 and j == n - 1:
                continue
            if segments_intersect(segs[i][0], segs[i][1], segs[j][0], segs[j][1]):
                return True
    return False


def build_polygons(T, tids, tnum, P):
    t0 = time.time()
    Ppad, J = junction_map(T)
    chains = []          # each: dict(pts, closed, labels)
    chain_index = {}
    rings = []           # each: dict(t, chain refs [(cid, rev)], area)
    for t in tids:
        k = tnum[t]
        for vs, ns in trace_territory(Ppad, k):
            area = ring_area(vs)
            if area <= 0:
                continue  # hole ring (should not exist after hole filling)
            n = len(vs)
            jidx = [i for i in range(n) if J[vs[i][1], vs[i][0]]]
            refs = []
            if not jidx:
                key = ('closed', k, vs[0])
                cid = len(chains)
                chains.append({'pts': vs, 'closed': True, 'labels': (k, ns[0]), 'rings': []})
                refs.append((cid, False))
            else:
                s = jidx[0]
                vs2 = vs[s:] + vs[:s]
                ns2 = ns[s:] + ns[:s]
                jset = [i - s if i >= s else i - s + n for i in jidx]
                jset.append(n)
                for a_, b_ in zip(jset[:-1], jset[1:]):
                    seg = vs2[a_:b_] + [vs2[b_ % n]]
                    nbv = ns2[a_]
                    rev = tuple(seg[::-1])
                    fwd = tuple(seg)
                    key = (min(k, nbv), max(k, nbv), min(fwd, rev))
                    isrev = key[2] != fwd
                    cid = chain_index.get(key)
                    if cid is None:
                        cid = len(chains)
                        chain_index[key] = cid
                        chains.append({'pts': list(key[2]), 'closed': False, 'labels': (k, nbv), 'rings': []})
                    refs.append((cid, isrev))
            rid = len(rings)
            for cid, _ in refs:
                chains[cid]['rings'].append(rid)
            rings.append({'t': t, 'refs': refs, 'area': area})
    log(f'  traced {len(rings)} rings, {len(chains)} chains in {time.time() - t0:.1f}s')

    eps0 = float(P['eps'])
    maxpts = int(P['maxRingPoints'])
    ring_eps = [eps0] * len(rings)
    cache = {}

    def simp(cid, eps):
        key = (cid, round(eps, 3))
        if key not in cache:
            ch = chains[cid]
            cache[key] = dp(ch['pts'], eps, ch['closed'])
        return cache[key]

    for it in range(40):
        chain_eps = [max(ring_eps[r] for r in ch['rings']) for ch in chains]
        changed = False
        out_rings = []
        for rid, r in enumerate(rings):
            pts = []
            for cid, rev in r['refs']:
                s = simp(cid, chain_eps[cid])
                if chains[cid]['closed']:
                    pts.extend(s)
                else:
                    s = s[::-1] if rev else s
                    pts.extend(s[:-1])
            out_rings.append(pts)
            if len(pts) > maxpts:
                ring_eps[rid] *= 1.2
                changed = True
        if not changed:
            break
    polys = defaultdict(list)
    bad = []
    for rid, r in enumerate(rings):
        pts = out_rings[rid]
        if len(pts) < 3:
            continue
        if ring_self_intersects(pts):
            bad.append(r['t'])
        polys[r['t']].append((r['area'], pts, ring_eps[rid]))
    for t in polys:
        polys[t].sort(key=lambda z: -z[0])
    log(f'  simplified in {time.time() - t0:.1f}s; self-intersecting rings: {bad}')
    # land adjacency with shared border length (crack edges)
    shared = defaultdict(int)
    for ch in chains:
        a, b = ch['labels']
        if a > 0 and b > 0 and a != SEA and b != SEA and a != b:
            shared[(min(a, b), max(a, b))] += len(ch['pts']) - 1
    # chains are stored once per pair key but closed/duplicate shouldn't occur; lengths above count each chain once
    return polys, shared, bad


# --------------------------------------------------------------------------- anchors
def pole(mask):
    """Pole of inaccessibility of a boolean mask -> (x, y, radius)."""
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    sub = np.zeros((y1 - y0 + 2, x1 - x0 + 2), np.uint8)
    sub[1:-1, 1:-1] = mask[y0:y1, x0:x1]
    dt = cv2.distanceTransform(sub, cv2.DIST_L2, 5)
    j, i = np.unravel_index(np.argmax(dt), dt.shape)
    return int(x0 + i - 1), int(y0 + j - 1), float(dt[j, i])


def refine_label(L, ch, p, P, ignore=None):
    x, y = int(p[0]), int(p[1])
    wx, wy = int(P.get('labelWinX', 210)), int(P.get('labelWinY', 90))
    X0, Y0 = max(0, x - wx), max(0, y - wy)
    sub = ((L[Y0:y + wy, X0:x + wx] < P.get('textL', 70)) & (ch[Y0:y + wy, X0:x + wx] < P.get('textChroma', 30))).astype(np.uint8)
    if ignore is not None:
        sub[ignore[Y0:y + wy, X0:x + wx] > 0] = 0
    sub = cv2.morphologyEx(sub, cv2.MORPH_OPEN, np.ones((2, 2), np.uint8))
    merged = cv2.dilate(sub, cv2.getStructuringElement(cv2.MORPH_RECT, (int(P.get('labelGapX', 27)), int(P.get('labelGapY', 25)))))
    n, lab, st, _ = cv2.connectedComponentsWithStats(merged, connectivity=8)
    if n <= 1:
        return [x, y], [x - 60, y - 15, x + 60, y + 15]
    best, bd = None, 1e9
    for i in range(1, n):
        bx, by, bw, bh, a = st[i]
        if bh > 200 or bw > 2 * wx:
            continue
        cx = min(max(x - X0, bx), bx + bw)
        cy = min(max(y - Y0, by), by + bh)
        dd = math.hypot(cx - (x - X0), cy - (y - Y0))
        if dd < bd:
            best, bd = i, dd
    if best is None or bd > 45:
        return [x, y], [x - 60, y - 15, x + 60, y + 15]
    sel = (lab == best) & (sub > 0)
    ys, xs = np.nonzero(sel)
    b = [X0 + int(xs.min()), Y0 + int(ys.min()), X0 + int(xs.max()) + 1, Y0 + int(ys.max()) + 1]
    return [int(round((b[0] + b[2]) / 2)), int(round((b[1] + b[3]) / 2))], b


def whiteness(L, ch):
    return np.clip(L - 1.6 * ch, 0, 255).astype(np.float32)


def find_marks(Wimg, T, tids, tnum, cfg):
    P = cfg.P
    mx, my = cfg.pt(cfg.c['markTemplate'])
    mx, my = int(mx), int(my)
    win = Wimg[my - 50:my + 50, mx - 90:mx + 90]
    wm = (win > P.get('markWhite', 190)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(wm, connectivity=8)
    i = 1 + int(np.argmax(st[1:, 4]))
    bx, by, bw, bh, _ = st[i]
    cx, cy = mx - 90 + bx + bw / 2.0, my - 50 + by + bh / 2.0
    pad = 8
    tx0, ty0 = int(round(cx - bw / 2 - pad)), int(round(cy - bh / 2 - pad))
    tpl = Wimg[ty0:ty0 + bh + 2 * pad, tx0:tx0 + bw + 2 * pad].copy()
    th, tw = tpl.shape
    res = cv2.matchTemplate(Wimg, tpl, cv2.TM_CCOEFF_NORMED)
    mxf = cv2.dilate(res, np.ones((61, 61), np.uint8))
    pk = np.argwhere((res >= mxf) & (res > P['markThreshold']))
    cands = defaultdict(list)
    stray = []
    for (yy, xx) in pk:
        sc = float(res[yy, xx])
        px, py = int(xx + tw / 2), int(yy + th / 2)
        k = int(T[py, px])
        if k == 0:
            stray.append([px, py, round(sc, 3)])
            continue
        cands[k].append((sc, px, py))
    marks = {}
    extra = {}
    for t in tids:
        lst = sorted(cands.get(tnum[t], []), reverse=True)
        if lst:
            marks[t] = [lst[0][1], lst[0][2], lst[0][0]]
            if len(lst) > 1:
                extra[t] = [[a[1], a[2], round(a[0], 3)] for a in lst[1:]]
    return marks, {'templateSize': [int(tw), int(th)], 'markSize': [int(bw), int(bh)], 'extra': extra, 'stray': stray}


def hex_spots(mask, avoid, piece, n_max=16, n_min=10, min_spacing_ok=True):
    """Hex-packed spots inside mask (bool), away from `avoid` (bool), ordered from the centre outwards.
    Spacing stays >= 0.8*piece unless fewer than 4 spots would fit."""
    ys, xs = np.nonzero(mask)
    y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
    sub = np.zeros((y1 - y0 + 2, x1 - x0 + 2), np.uint8)
    sub[1:-1, 1:-1] = mask[y0:y1, x0:x1]
    av = np.zeros_like(sub)
    av[1:-1, 1:-1] = avoid[y0:y1, x0:x1]
    dt = cv2.distanceTransform(sub, cv2.DIST_L2, 5)
    H, W = sub.shape
    schedule = [(0.6, 1.2), (0.55, 1.1), (0.5, 1.0), (0.45, 0.95), (0.4, 0.9), (0.35, 0.85), (0.3, 0.8),
                (0.2, 0.8), (0.1, 0.8), (0.0, 0.8), (0.0, 0.7), (0.0, 0.6)]
    phases = [(0, 0), (0.5, 0), (0, 0.5), (0.5, 0.5), (0.25, 0.25), (0.75, 0.25), (0.25, 0.75), (0.75, 0.75)]
    best, best_sp = [], None
    for margin_f, spacing_f in schedule:
        if spacing_f < 0.8 and len(best) >= 4:
            break
        allowed = (dt >= max(piece * margin_f, 8)) & (av == 0) & (sub > 0)
        if not allowed.any():
            continue
        dta = cv2.distanceTransform(allowed.astype(np.uint8), cv2.DIST_L2, 5)
        cj, ci = np.unravel_index(np.argmax(dta), dta.shape)
        s = piece * spacing_f
        h = s * math.sqrt(3) / 2
        cand_best = []
        for px, py in phases:
            ax, ay = ci + px * s, cj + py * h * 2
            pts = []
            rmax = int(H / h) + 3
            for r in range(-rmax, rmax + 1):
                yy = ay + r * h
                if yy < 0 or yy >= H:
                    continue
                off = (s / 2) if (r % 2) else 0.0
                cmax = int(W / s) + 3
                for c in range(-cmax, cmax + 1):
                    xx = ax + off + c * s
                    if 0 <= xx < W and allowed[int(yy), int(xx)]:
                        pts.append((math.hypot(xx - ci, yy - cj), xx, yy))
            pts.sort()
            pts = pts[:n_max]
            if len(pts) > len(cand_best):
                cand_best = pts
        if len(cand_best) > len(best):
            best, best_sp = cand_best, spacing_f
        if len(cand_best) >= n_min:
            break
    return [[int(round(x0 + p[1] - 1)), int(round(y0 + p[2] - 1))] for p in best]


# --------------------------------------------------------------------------- plates & furniture
def refine_plate(img, L, ch, nonsea, rough, P):
    pb = refine_box(nonsea, rough, open_px=int(P.get('plateOpen', 7)))
    x0, y0, x1, y1 = pb
    Ls, cs = L[y0:y1, x0:x1], ch[y0:y1, x0:x1]
    H, W = Ls.shape
    white = ((Ls > P.get('plateWhiteL', 215)) & (cs < 25)).astype(np.uint8)
    n, lab, st, _ = cv2.connectedComponentsWithStats(white, connectivity=4)
    name = None
    best = 0
    for i in range(1, n):
        x, y, w, h, a = st[i]
        if x == 0 or y == 0 or x + w >= W or y + h >= H:
            continue
        if w < 3 * h or x + w / 2 > 0.75 * W:
            continue
        if a > best:
            best, name = a, [x0 + x, y0 + y, x0 + x + w, y0 + y + h]
    # bonus digit: largest dark blob in right 40%
    dark = ((Ls < 60) & (cs < 25)).astype(np.uint8)
    dark[:, :int(W * 0.55)] = 0
    n, lab, st, _ = cv2.connectedComponentsWithStats(dark, connectivity=8)
    badge = None
    if n > 1:
        i = 1 + int(np.argmax(st[1:, 4]))
        x, y, w, h, a = st[i]
        cx, cy = x + w / 2.0, y + h / 2.0
        # radius: walk outward until the white ring
        rs = []
        for dx, dy in ((0, -1), (0, 1), (-1, 0), (1, 0), (0.707, 0.707), (-0.707, 0.707), (0.707, -0.707), (-0.707, -0.707)):
            r0 = max(w, h) / 2.0 + 2
            for r in np.arange(r0, H, 1.0):
                px, py = int(cx + dx * r), int(cy + dy * r)
                if px < 0 or py < 0 or px >= W or py >= H:
                    break
                if Ls[py, px] > P.get('plateWhiteL', 215) and cs[py, px] < 30:
                    rs.append(r)
                    break
        r = float(np.median(rs)) if rs else h * 0.8
        badge = {'x': int(round(x0 + cx)), 'y': int(round(y0 + cy)), 'r': int(round(r))}
    return pb, name, badge


def victor_lines(L, ch, b, count):
    x0, y0, x1, y1 = b
    Ls = L[y0:y1, x0:x1].astype(np.float32)
    th = Ls - cv2.morphologyEx(Ls, cv2.MORPH_OPEN, np.ones((17, 1), np.uint8))
    light = ((th > 18) & (ch[y0:y1, x0:x1] < 25)).astype(np.uint8)
    H, W = light.shape
    # horizontal runs: close small gaps
    lightc = cv2.morphologyEx(light, cv2.MORPH_CLOSE, np.ones((1, 9), np.uint8))
    rows = []
    for yy in range(H):
        r = lightc[yy]
        # longest run
        d = np.diff(np.concatenate([[0], r, [0]]).astype(np.int8))
        s = np.nonzero(d == 1)[0]
        e = np.nonzero(d == -1)[0]
        if len(s) == 0:
            continue
        k = int(np.argmax(e - s))
        if e[k] - s[k] > 0.6 * W:
            rows.append((yy, int(s[k]), int(e[k])))
    groups = []
    for r in rows:
        if groups and r[0] - groups[-1][-1][0] <= 2:
            groups[-1].append(r)
        else:
            groups.append([r])
    lines = []
    for g in groups:
        ys = [r[0] for r in g]
        xs0 = int(np.median([r[1] for r in g]))
        xs1 = int(np.median([r[2] for r in g]))
        lines.append({'y': y0 + int(round(np.mean(ys))), 'x': x0 + xs0, 'width': xs1 - xs0})
    return lines


# --------------------------------------------------------------------------- main
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('board')
    ap.add_argument('--debug', action='store_true')
    args = ap.parse_args()
    cfg = Cfg(args.board)
    P = cfg.P
    os.makedirs(OUT_DIR, exist_ok=True)
    t0 = time.time()
    src, img = load_scene(cfg)
    log(f'[{args.board}] source {src.shape[1]}x{src.shape[0]} -> scene {SW}x{SH}')
    if cfg.c.get('writeBackground'):
        bg = os.path.join(ROOT, cfg.c['background'])
        big = cv2.resize(src, (SW, SH), interpolation=cv2.INTER_LANCZOS4)
        cv2.imwrite(bg, big, [cv2.IMWRITE_WEBP_QUALITY, 85])
        log(f'  wrote {cfg.c["background"]} ({os.path.getsize(bg) / 1e6:.1f} MB)')
        del big
    feats = features(img, P)
    lab, med, L, ch, d = feats
    gray = cv2.cvtColor(img, cv2.COLOR_BGR2GRAY)
    seaish = seaish_mask(L, ch, d, P)
    nonsea = (seaish == 0)

    dbg = {}
    # ---- furniture boxes (refined)
    F = cfg.c['furniture']
    excl = np.zeros((SH, SW), bool)
    fur = {}
    refs = []
    for r in F['referenceStickers']:
        b = refine_box(nonsea, cfg.box(r['box'])) if r.get('refine', True) else cfg.box(r['box'])
        refs.append(dict(box_obj(b), printed=r['printed']))
        excl[b[1]:b[3], b[0]:b[2]] = True
    fur['referenceStickers'] = refs
    for key in ('troopChart', 'tradeChart', 'starTrade'):
        rb = cfg.box(F[key]['box'])
        b = refine_box(nonsea, rb) if F[key].get('refine', True) else rb
        fur[key] = box_obj(b)
        excl[b[1]:b[3], b[0]:b[2]] = True
    vb = cfg.box(F['victors']['box'])
    excl[vb[1]:vb[3], vb[0]:vb[2]] = True
    wb = cfg.box(F['worldName']['box'])
    excl[wb[1]:wb[3], wb[0]:wb[2]] = True
    for b in F.get('exclude', []):
        b = cfg.box(b)
        excl[b[1]:b[3], b[0]:b[2]] = True
    plates = {}
    if P.get('plateMask') == 'colour':
        # plates have drop shadows on this board: use coloured + white pixels only
        plate_src = (ch > P['fillChroma']) | ((L > P.get('plateWhiteL', 215) - 10) & (ch < 25))
    else:
        plate_src = nonsea
    for cid, cd in cfg.c['continents'].items():
        pb, name, badge = refine_plate(img, L, ch, plate_src, cfg.box(cd['plateBox']), P)
        plates[cid] = (pb, name, badge)
        excl[pb[1]:pb[3], pb[0]:pb[2]] = True

    # ---- sea-lines
    nodes = detect_nodes(gray, excl, P)
    gray_line = np.where(ch < P.get('lineChroma', 20), gray, 255).astype(np.uint8)
    lines, stubs = detect_sealines(gray_line, nodes, P)
    log(f'  sea-line nodes: {len(nodes)}, lines: {len(lines)}, wrap stubs: {len(stubs)}')
    paint = np.zeros((SH, SW), np.uint8)
    for i, j, f in lines:
        a, b = nodes[i], nodes[j]
        cv2.line(paint, (int(a[0]), int(a[1])), (int(b[0]), int(b[1])), 1, 9)
    for i, side, f in stubs:
        a = nodes[i]
        cv2.line(paint, (int(a[0]), int(a[1])), (0 if side == 'left' else SW - 1, int(a[1])), 1, 9)
    node_disc = np.zeros((SH, SW), np.uint8)
    for x, y, r in nodes:
        cv2.circle(node_disc, (int(round(x)), int(round(y))), int(P['nodeOuterR']) + 3, 1, -1)
    paint |= node_disc

    # ---- segmentation
    T, tnum, tcol = segment(cfg, img, feats, excl, paint, dbg)
    tids = list(cfg.c['territories'].keys())
    inv = {v: k for k, v in tnum.items()}
    if args.debug:
        os.makedirs(os.path.join(HERE, 'tmp'), exist_ok=True)
        np.save(os.path.join(HERE, 'tmp', f'{args.board}_labels.npy'), T)

    # ---- polygons
    polys, shared, bad = build_polygons(T, tids, tnum, P)

    # ---- adjacency
    land = defaultdict(dict)
    for (a, b), n in shared.items():
        ta, tb = inv[a], inv[b]
        land[ta][tb] = n
        land[tb][ta] = n

    def node_territory(x, y, rad=90):
        x, y = int(round(x)), int(round(y))
        sub = T[max(0, y - rad):y + rad, max(0, x - rad):x + rad]
        if T[y, x] > 0:
            return inv[int(T[y, x])], 0.0
        ys, xs = np.nonzero(sub)
        if len(ys) == 0:
            return None, None
        dd = np.hypot(xs + max(0, x - rad) - x, ys + max(0, y - rad) - y)
        k = int(np.argmin(dd))
        return inv[int(sub[ys[k], xs[k]])], float(dd[k])

    sealines = []
    sea_pairs = set()
    for i, j, f in lines:
        ta, da = node_territory(*nodes[i][:2])
        tb, db = node_territory(*nodes[j][:2])
        a, b = nodes[i], nodes[j]
        if ta is None or tb is None or ta == tb:
            log(f'  WARNING sea-line between nodes {a[:2]} {b[:2]} -> {ta} {tb}')
            continue
        sealines.append({'a': ta, 'b': tb, 'points': [[int(round(a[0])), int(round(a[1]))], [int(round(b[0])), int(round(b[1]))]]})
        sea_pairs.add(tuple(sorted((ta, tb))))
    wrap_ends = {}
    for i, side, f in sorted(stubs, key=lambda z: z[2]):
        t, _ = node_territory(*nodes[i][:2])
        wrap_ends[side] = (t, nodes[i])  # longest run per side wins
    if 'left' in wrap_ends and 'right' in wrap_ends:
        (tl, nl), (tr, nr) = wrap_ends['left'], wrap_ends['right']
        sealines.append({'a': tl, 'b': tr, 'wrap': True, 'points': [[int(round(nl[0])), int(round(nl[1]))], [0, int(round(nl[1]))]]})
        sealines.append({'a': tr, 'b': tl, 'wrap': True, 'points': [[int(round(nr[0])), int(round(nr[1]))], [SW, int(round(nr[1]))]]})
        sea_pairs.add(tuple(sorted((tl, tr))))
    else:
        log(f'  WARNING wrap stubs incomplete: {wrap_ends}')

    neighbors = {t: set() for t in tids}
    minshare = int(P.get('minSharedBorder', 6))
    weak = []
    for ta in land:
        for tb, n in land[ta].items():
            if n >= minshare:
                neighbors[ta].add(tb)
            if n < 40 and ta < tb:
                weak.append((ta, tb, n))
    for a, b in sea_pairs:
        neighbors[a].add(b)
        neighbors[b].add(a)
    for o in cfg.c.get('adjacencyOverrides', []):
        a, b, on = o['a'], o['b'], o['connected']
        if on:
            neighbors[a].add(b); neighbors[b].add(a)
        else:
            neighbors[a].discard(b); neighbors[b].discard(a)

    # ---- anchors
    Wimg = whiteness(L, ch)
    paint_dil = cv2.dilate(paint, np.ones((7, 7), np.uint8))
    sea_px = cv2.dilate(seaish, cv2.getStructuringElement(cv2.MORPH_ELLIPSE, (9, 9))) > 0
    marks, markdbg = find_marks(Wimg, T, tids, tnum, cfg)
    dbg['marks'] = markdbg
    piece = int(P['pieceSize'])
    mw, mh = markdbg['markSize']
    terr_out = {}
    for t in tids:
        k = tnum[t]
        mask = T == k
        nn, cl, cst, _ = cv2.connectedComponentsWithStats(mask.astype(np.uint8), connectivity=4)
        main = 1 + int(np.argmax(cst[1:, 4]))
        mainmask = cl == main
        # printed land only (sea pockets that were merged into the territory are not used for anchors)
        landmask = mainmask & ~sea_px
        if landmask.sum() < 0.5 * mainmask.sum():
            landmask = mainmask
        cx, cy, cr = pole(landmask)
        lab_c, lab_b = refine_label(L, ch, cfg.pt(cfg.c['territories'][t]['label']), P, paint_dil)
        def avoid_mask(padf):
            av = np.zeros((SH, SW), np.uint8)
            pad = int(piece * padf)
            cv2.rectangle(av, (lab_b[0] - pad, lab_b[1] - pad), (lab_b[2] + pad, lab_b[3] + pad), 1, -1)
            mk_ = marks.get(t)
            if mk_:
                cv2.rectangle(av, (int(mk_[0] - mw / 2 - pad), int(mk_[1] - mh / 2 - pad)), (int(mk_[0] + mw / 2 + pad), int(mk_[1] + mh / 2 + pad)), 1, -1)
            for x, y, r in nodes:
                cv2.circle(av, (int(x), int(y)), int(P['nodeOuterR'] + piece * padf), 1, -1)
            return av > 0
        mk = marks.get(t)
        spots = []
        for padf in (0.55, 0.35, 0.2):
            av = avoid_mask(padf)
            sp = hex_spots(landmask, av, piece, min_spacing_ok=True)
            if nn > 2 and len(sp) < 10:
                for i in np.argsort(-cst[1:, 4]) + 1:
                    if i == main or cst[i, 4] < (piece * 1.2) ** 2:
                        continue
                    sp.extend(hex_spots((cl == i) & ~sea_px, av, piece, n_max=16 - len(sp), n_min=1))
                    if len(sp) >= 10:
                        break
            if len(sp) > len(spots):
                spots = sp
            if len(spots) >= 8:
                break
        terr_out[t] = {
            'mask_area': int(mask.sum()),
            'center': [cx, cy],
            'label': lab_c,
            'labelBox': lab_b,
            'mark': [int(mk[0]), int(mk[1])] if mk else None,
            'markScore': round(mk[2], 3) if mk else None,
            'spots': spots,
            'n_landmasses': int(nn - 1),
        }

    # ---- continents
    continents = {}
    for cid, cd in cfg.c['continents'].items():
        pb, name, badge = plates[cid]
        cm = np.zeros((SH, SW), bool)
        for t in cd['territories']:
            cm |= T == tnum[t]
        rgb = np.median(img[cm].reshape(-1, 3), axis=0)[::-1]
        col = '#%02x%02x%02x' % tuple(int(round(v)) for v in rgb)
        continents[cid] = {
            'label': cd['label'],
            'bonus': cd['bonus'],
            'color': col,
            'territories': cd['territories'],
            'plate': box_obj(pb),
            'namePlate': box_obj(name) if name else None,
            'bonusBadge': badge,
        }
    cont_of = {t: cid for cid, cd in cfg.c['continents'].items() for t in cd['territories']}

    # ---- furniture: victors & world name
    vlines = victor_lines(L, ch, vb, F['victors']['count'])
    cnt = F['victors']['count']
    if len(vlines) != cnt:
        log(f'  WARNING detected {len(vlines)} victor lines, expected {cnt}: {[l["y"] for l in vlines]}')
    if vlines:
        vx0 = int(np.median([l['x'] for l in vlines]))
        vx1 = int(np.median([l['x'] + l['width'] for l in vlines]))
    vl_out = [{'n': i + 1, 'x': vx0, 'y': l['y'], 'width': vx1 - vx0} for i, l in enumerate(vlines[:cnt])]
    fur['victors'] = dict(box_obj(vb), lines=vl_out)
    # world name: the write-in area after the printed "THE WORLD OF" (box from config)
    fur['worldName'] = box_obj(wb)

    # ---- assemble JSON
    territories = {}
    for t in tids:
        to = terr_out[t]
        territories[t] = {
            'name': cfg.c['territories'][t]['name'],
            'continent': cont_of[t],
            'polygons': [[c for p in pts for c in p] for (_a, pts, _e) in polys[t]],
            'center': to['center'],
            'label': to['label'],
            'mark': to['mark'],
            'spots': to['spots'],
            'neighbors': sorted(neighbors[t]),
        }
    out = {
        'id': cfg.c['id'],
        'label': cfg.c['label'],
        'credits': cfg.c['credits'],
        'scene': {'width': SW, 'height': SH, 'background': cfg.c['background']},
        'source': {'path': cfg.c['image'], 'width': int(src.shape[1]), 'height': int(src.shape[0])},
        'pieceSize': piece,
        'continents': continents,
        'territories': territories,
        'seaLines': sealines,
        'furniture': fur,
    }
    os.makedirs(os.path.join(ROOT, 'data', 'boards'), exist_ok=True)
    path = os.path.join(ROOT, 'data', 'boards', f'{cfg.c["id"]}.json')
    with open(path, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    log(f'  wrote {os.path.relpath(path, ROOT)} ({os.path.getsize(path) / 1e3:.0f} kB)')

    # ---- report
    diffs_add, diffs_miss = [], []
    for t in tids:
        for u in neighbors[t]:
            if u not in CLASSIC[t] and t < u:
                diffs_add.append((t, u))
        for u in CLASSIC[t]:
            if u not in neighbors[t] and t < u:
                diffs_miss.append((t, u))
    report = {
        'board': cfg.c['id'],
        'nodes': [[round(x), round(y), round(r, 1)] for x, y, r in nodes],
        'sealines': [(s['a'], s['b'], s.get('wrap', False)) for s in sealines],
        'adjacency_extra_vs_classic': diffs_add,
        'adjacency_missing_vs_classic': diffs_miss,
        'weak_land_contacts': weak,
        'land_shared': {f'{a}|{b}': n for a in land for b, n in land[a].items() if a < b},
        'self_intersecting': bad,
        'territory_debug': {t: {k: v for k, v in terr_out[t].items() if k in ('mask_area', 'markScore', 'n_landmasses', 'labelBox')} for t in tids},
        'dbg': dbg,
        'ring_points': {t: [len(p) for (_a, p, _e) in polys[t]] for t in tids},
        'ring_eps': {t: [round(e, 2) for (_a, _p, e) in polys[t]] for t in tids},
    }
    with open(os.path.join(OUT_DIR, f'{cfg.c["id"]}.report.json'), 'w') as f:
        json.dump(report, f, indent=1, default=str)
    log(f'  extra vs classic: {diffs_add}')
    log(f'  missing vs classic: {diffs_miss}')
    log(f'  weak land contacts (<40px): {weak}')
    log(f'  marks missing: {[t for t in tids if not terr_out[t]["mark"]]}; extra candidates: {list(markdbg["extra"].keys())}')
    log(f'  spots<10: {[(t, len(terr_out[t]["spots"])) for t in tids if len(terr_out[t]["spots"]) < 10]}')
    log(f'  done in {time.time() - t0:.1f}s')


if __name__ == '__main__':
    main()
