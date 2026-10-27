#!/usr/bin/env python3
"""Build the Risk Legacy content catalog (data/content/*.json) from assets/unlocks.

Rerunnable. Mechanical parts come from the old asset YAML (assets/unlocks/<pack>/<folder>/cards.yaml):
ids, image paths, quantities, territory faces. Everything that had to be read off the card images
(text, card codes, structured effect/check hints, rulebook addition letters) lives in
tools/content/transcriptions/<pack>.yaml and is merged on top, so a rerun never loses it.

Usage:  python3 tools/content/build.py            # writes data/content/*.json + README.md
        python3 tools/content/build.py --check    # only validates, writes nothing

Merge rules
  * Each transcription entry may carry `yaml: "<folder>:<rawId>"`. Its skeleton (derived from that
    asset YAML document) is used as the base and the transcription fields override it. The same
    YAML document may be claimed by several entries (e.g. one card with two stickers) and by any
    category (e.g. a rules/evolution_1.jpg card that is really a "War Progresses" card).
  * Asset YAML documents no transcription entry claims are appended to their default category
    with "untranscribed": true (territory cards are always generated, never transcribed).
  * Any transcription value that differs from the YAML value for text/players/qty/name is
    reported as a YAML-vs-card mismatch in the README.
"""
import json
import os
import re
import sys
import copy

import yaml

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.normpath(os.path.join(HERE, '..', '..'))
UNLOCKS = os.path.join(ROOT, 'assets', 'unlocks')
OUT = os.path.join(ROOT, 'data', 'content')
TRANS = os.path.join(HERE, 'transcriptions')

PACKS = ['base', 'minorcities', 'eliminated', 'secondwin', 'worldcapital', 'threemissiles', 'thirtytroops']

# category order inside each pack file
CATS = ['warProgresses', 'factions', 'powers', 'territoryCards', 'coinCards', 'scars', 'stickers',
        'events', 'missions', 'draft', 'rules', 'marks', 'secretPowers']
LIST_CATS = [c for c in CATS if c != 'coinCards']

FOLDER_CAT = {
    'factions': 'factions', 'powers': 'powers', 'scars': 'scars', 'stickersheet': 'stickers',
    'territories': 'territoryCards', 'events': 'events', 'missions': 'missions', 'draft': 'draft',
    'rules': 'rules', 'secretmutantpowers': 'secretPowers',
}
IGNORED_FOLDERS = {'macros'}  # old 0.6-era macro scripts and their icons

# icon used for a power by slot (the old importer used these per pack)
SLOT_ICON = {
    'starter': 'assets/unlocks/base/powers/starter.png',
    'knockout': 'assets/unlocks/eliminated/powers/images/knockout.png',
    'mission': 'assets/unlocks/worldcapital/powers/images/mission.png',
    'missile': 'assets/unlocks/threemissiles/powers/images/missile.png',
    'weakness': 'assets/unlocks/thirtytroops/powers/images/weakness.png',
    'scar': 'assets/unlocks/threemissiles/powers/images/nuclear.png',
}
STICKER_GROUP = {'Before First Game': 'beforeFirstGame', 'Held On': 'heldOn', 'Game Won': 'won'}
DRAFT_TYPE = {'coin': 'coin', 'placement': 'placement', 'troops': 'troops', 'turn': 'turnOrder'}
VARIANTS = ['original', 'advanced']

KEY_ORDER = {
    'warProgresses': ['id', 'code', 'order', 'title', 'img', 'text', 'sticker', 'textSource'],
    'factions': ['id', 'name', 'img', 'color', 'pieces'],
    'powers': ['id', 'faction', 'slot', 'name', 'code', 'text', 'img', 'cardImg', 'timing', 'automation',
               'cost', 'effect', 'check', 'limitation', 'scar', 'mission', 'textSource'],
    'secretPowers': ['id', 'faction', 'slot', 'name', 'evolution', 'text', 'img', 'timing', 'automation',
                     'effect', 'textSource'],
    'territoryCards': ['id', 'name', 'code', 'continent', 'value', 'faces', 'back'],
    'scars': ['id', 'name', 'code', 'qty', 'target', 'cardImg', 'stickerImg', 'text', 'play', 'effect',
              'power', 'textSource'],
    'stickers': ['id', 'name', 'code', 'qty', 'img', 'group', 'text', 'effect', 'textSource'],
    'events': ['id', 'name', 'code', 'qty', 'img', 'text', 'afterResolve', 'afterResolveText', 'effect',
               'textSource'],
    'missions': ['id', 'name', 'code', 'qty', 'img', 'private', 'text', 'stickerText', 'reward',
                 'afterComplete', 'check', 'power', 'textSource'],
    'draft': ['id', 'name', 'code', 'img', 'type', 'players', 'value', 'text', 'textSource'],
    'rules': ['id', 'kind', 'addition', 'page', 'inferred', 'inferredFrom', 'code', 'title', 'img', 'text',
              'replaces', 'scar', 'mark', 'textSource'],
    'marks': ['id', 'name', 'code', 'img', 'cardImg', 'text', 'effect', 'rules', 'textSource'],
}

PATH_KEYS = ('img', 'cardImg', 'stickerImg', 'back', 'troop', 'triple', 'hq')


# ----------------------------------------------------------------------------- helpers
def rel(path):
    return os.path.relpath(path, ROOT).replace(os.sep, '/')


_listdir_cache = {}


def exists_cs(relpath):
    """Case-sensitive existence check (macOS file systems are case-insensitive)."""
    cur = ROOT
    for part in relpath.split('/'):
        if cur not in _listdir_cache:
            try:
                _listdir_cache[cur] = set(os.listdir(cur))
            except (FileNotFoundError, NotADirectoryError):
                return False
        if part not in _listdir_cache[cur]:
            return False
        cur = os.path.join(cur, part)
    return True


def snake(s):
    s = re.sub(r'([a-z0-9])([A-Z])', r'\1_\2', s)
    return re.sub(r'[^a-z0-9]+', '_', s.lower()).strip('_')


def title_from_id(i):
    return ' '.join(w.capitalize() for w in i.split('_'))


def load_all(path):
    with open(path) as f:
        return [d for d in yaml.safe_load_all(f) if d]


def ordered(cat, d):
    keys = KEY_ORDER.get(cat, [])
    out = {k: d[k] for k in keys if k in d}
    for k, v in d.items():
        if k not in out:
            out[k] = v
    return out


# ----------------------------------------------------------------------------- skeletons
def skeleton(pack, folder, doc):
    """Return (rawKey, category, fields) for one asset YAML document."""
    ns = doc.get('namespace', '').split('.')
    data = doc.get('data') or {}
    img_dir = f'assets/unlocks/{pack}/{folder}/images'
    if folder == 'secretmutantpowers':
        raw = ns[1]
        evo = ns[0].lower().split('-')  # e.g. DEFENSIVE-BRAINS
        f = {'id': snake(raw), 'slot': 'other', 'name': title_from_id(raw), 'text': data.get('description', '').strip(),
             'evolution': {'approach': evo[0], 'target': evo[1]},
             'img': f'{img_dir}/mutant.png', 'automation': snake(raw), 'textSource': 'yaml'}
        return f'{folder}:{raw}', 'secretPowers', f
    raw = ns[0]
    cat = FOLDER_CAT[folder]
    sid = snake(raw)
    src = {'yaml': f'assets/unlocks/{pack}/{folder}/cards.yaml', 'key': raw}
    if folder == 'factions':
        f = {'id': sid, 'name': data.get('name'), 'img': f'{img_dir}/{doc["imgPath"]}',
             'pieces': {'troop': f'{img_dir}/{data["troop_img"]}', 'triple': f'{img_dir}/{data["three_img"]}',
                        'hq': f'{img_dir}/{data["hq_img"]}'}}
    elif folder == 'powers':
        slot = data.get('type')
        f = {'id': sid, 'slot': slot, 'name': title_from_id(sid), 'text': (data.get('description') or '').strip(),
             'img': SLOT_ICON.get(slot), 'automation': sid, 'textSource': 'yaml'}
        if pack == 'base':
            f['faction'] = sid.split('_')[0]
    elif folder == 'scars':
        f = {'id': sid, 'qty': doc.get('qty', 1), 'cardImg': f'{img_dir}/{doc["imgPath"]}',
             'stickerImg': f'{img_dir}/{data["tokenImg"]}'}
    elif folder == 'stickersheet':
        f = {'id': sid, 'name': title_from_id(sid), 'qty': doc.get('qty', 1), 'img': f'{img_dir}/{doc["imgPath"]}',
             'group': STICKER_GROUP.get(data.get('folder'), 'other')}
    elif folder == 'territories':
        f = {'id': sid, 'value': data.get('value'), 'continent': data.get('continent'),
             '_imgPath': doc.get('imgPath'), '_cardBack': doc.get('cardBack')}
    elif folder in ('events', 'missions'):
        f = {'id': sid, 'qty': doc.get('qty', 1), 'img': f'{img_dir}/{doc["imgPath"]}'}
    elif folder == 'draft':
        f = {'id': sid, 'img': f'{img_dir}/{doc["imgPath"]}', 'type': DRAFT_TYPE.get(data.get('type'), 'other'),
             'players': data.get('players')}
    elif folder == 'rules':
        f = {'id': sid, 'img': f'{img_dir}/{doc["imgPath"]}'}
    else:
        raise ValueError(folder)
    f['source'] = src
    return f'{folder}:{raw}', cat, f


def yaml_refs(pack, folder, doc):
    """Every file path a YAML document points at, resolved the way the old importer resolved it."""
    data = doc.get('data') or {}
    base = f'assets/unlocks/{pack}/{folder}'
    refs = []
    if folder == 'territories':
        v = data.get('value')
        if pack == 'base':
            for var in VARIANTS:
                refs.append(f'{base}/images/{var}/cards.{v}/{doc["imgPath"]}')
        else:  # thirtytroops/init.js: images/cards.<value>/<imgPath>
            refs.append(f'{base}/images/cards.{v}/{doc["imgPath"]}')
        if doc.get('cardBack'):
            refs.append(f'{base}/images/{doc["cardBack"]}')
        return refs
    if doc.get('imgPath'):
        refs.append(f'{base}/images/{doc["imgPath"]}')
    for k in ('tokenImg', 'troop_img', 'three_img', 'hq_img'):
        if data.get(k):
            refs.append(f'{base}/images/{data[k]}')
    return refs


# ----------------------------------------------------------------------------- territories
def build_territories(pack, skel, missing):
    """faces[variant][n-1] = face showing n resources.

    Base cards have per-variant art (images/<variant>/cards.N/). Pack-added cards (Alien Island) have a single
    art set in <pack>/territories/images/cards.N/ used for both variants. Faces below the card's starting
    value cannot occur (cards only gain resources) and are null when no file exists.
    """
    out = []
    for f in skel:
        tid = f['id']
        img = f['_imgPath']
        faces = {}
        for var in VARIANTS:
            row = []
            for n in range(1, 7):
                cands = [f'assets/unlocks/{pack}/territories/images/{var}/cards.{n}/{img}',
                         f'assets/unlocks/{pack}/territories/images/cards.{n}/{img}']
                hit = next((c for c in cands if exists_cs(c)), None)
                if hit is None and n >= (f['value'] or 1):
                    missing.append(cands[0] if pack == 'base' else cands[1])
                row.append(hit)
            faces[var] = row
        back = f'assets/unlocks/{pack}/territories/images/{f["_cardBack"]}'
        cont = f['continent']
        entry = {'id': tid, 'name': title_from_id(tid), 'continent': None if cont in (None, 'None') else cont,
                 'value': f['value'], 'faces': faces, 'back': back, 'source': f['source']}
        out.append(entry)
    return out


# ----------------------------------------------------------------------------- per pack
def build_pack(pack, report):
    tr_path = os.path.join(TRANS, f'{pack}.yaml')
    with open(tr_path) as fh:
        tr = yaml.safe_load(fh) or {}

    # skeletons from asset YAML
    skel = {}          # key -> (cat, fields)
    skel_order = []
    pack_dir = os.path.join(UNLOCKS, pack)
    for folder in sorted(os.listdir(pack_dir)):
        p = os.path.join(pack_dir, folder, 'cards.yaml')
        if folder in IGNORED_FOLDERS or not os.path.isfile(p):
            continue
        for doc in load_all(p):
            key, cat, f = skeleton(pack, folder, doc)
            if key in skel:
                report['problems'].append(f'{pack}: duplicate YAML key {key}')
            skel[key] = (cat, f)
            skel_order.append(key)
            for r in yaml_refs(pack, folder, doc):
                report['yamlRefs'].add(r)
                if not exists_cs(r):
                    report['yamlMissing'].append((f'{pack}/{folder}/cards.yaml', key.split(':', 1)[1], r))

    meta = tr['pack']
    result = {'id': pack, 'label': meta['label'], 'order': meta['order'], 'kind': meta['kind'],
              'trigger': meta['trigger']}
    for c in CATS:
        result[c] = None if c == 'coinCards' else []

    claimed = set()
    for cat in LIST_CATS:
        if cat == 'territoryCards':
            continue  # generated below; transcription entries only patch fields
        for entry in tr.get(cat) or []:
            entry = copy.deepcopy(entry)
            key = entry.pop('yaml', None)
            if key:
                if key not in skel:
                    report['problems'].append(f'{pack}: transcription {cat}/{entry.get("id")} claims unknown YAML key {key}')
                    base = {}
                else:
                    claimed.add(key)
                    base = copy.deepcopy(skel[key][1])
                    # record YAML-vs-card differences
                    for fld in ('text', 'players', 'qty', 'name'):
                        if fld in entry and fld in base and base[fld] not in (None, '') and entry[fld] != base[fld]:
                            if fld == 'name' and skel[key][0] != cat:
                                continue
                            if fld == 'name' and base[fld] == title_from_id(base['id']):
                                continue  # generated name, not YAML data
                            report['overrides'].append((pack, cat, entry.get('id', base.get('id')), fld, base[fld], entry[fld]))
            else:
                base = {}
            base.update(entry)
            if cat == 'powers' and 'automation' not in base:
                base['automation'] = base['id']
            if cat == 'powers' and 'img' not in base:
                base['img'] = SLOT_ICON.get(base.get('slot'))
            if cat in ('powers', 'secretPowers'):
                base.setdefault('faction', None)
            result[cat].append(ordered(cat, base))

    # territory cards: always generated
    terr_skel = [skel[k][1] for k in skel_order if skel[k][0] == 'territoryCards']
    for k in skel_order:
        if skel[k][0] == 'territoryCards':
            claimed.add(k)
    if terr_skel:
        missing = []
        terrs = build_territories(pack, terr_skel, missing)
        overrides = {t['id']: t for t in (tr.get('territoryCards') or [])}
        for t in terrs:
            if t['id'] in overrides:
                t.update({k: v for k, v in overrides[t['id']].items() if k != 'yaml'})
        result['territoryCards'] = [ordered('territoryCards', t) for t in terrs]
        report['territoryMissing'].extend(missing)
        report['territoryChecked'] += sum(2 * (7 - (t['value'] or 1)) for t in terr_skel)

    # unclaimed YAML documents -> default category, flagged
    for k in skel_order:
        if k not in claimed:
            cat, f = skel[k]
            f = copy.deepcopy(f)
            f['untranscribed'] = True
            result[cat].append(ordered(cat, f))
            report['unclaimed'].append(f'{pack}:{k}')

    if tr.get('coinCards'):
        result['coinCards'] = tr['coinCards']
    result['notes'] = tr.get('notes') or []

    # drop empty lists for readability? keep them: the schema allows [] and code can rely on the keys.
    return result


# ----------------------------------------------------------------------------- validation
def walk_paths(obj, found):
    if isinstance(obj, dict):
        for k, v in obj.items():
            if isinstance(v, str) and v.startswith('assets/'):
                found.append(v)
            else:
                walk_paths(v, found)
    elif isinstance(obj, list):
        for v in obj:
            if isinstance(v, str) and v.startswith('assets/'):
                found.append(v)
            else:
                walk_paths(v, found)


def disk_images():
    out = []
    for dp, dn, fn in os.walk(UNLOCKS):
        for f in fn:
            if f.lower().endswith(('.png', '.jpg', '.jpeg', '.webp', '.gif', '.svg')):
                out.append(rel(os.path.join(dp, f)))
    return sorted(out)


def stats_for(pack):
    s = {}
    for c in LIST_CATS:
        s[c] = len(pack.get(c) or [])
    if pack.get('coinCards'):
        s['coinCards'] = pack['coinCards'].get('count', 0)
    return s


def main():
    check_only = '--check' in sys.argv
    report = {'problems': [], 'yamlRefs': set(), 'yamlMissing': [], 'overrides': [], 'unclaimed': [],
              'territoryMissing': [], 'territoryChecked': 0}
    packs = [build_pack(p, report) for p in PACKS]

    # global id uniqueness per category
    for c in LIST_CATS:
        seen = {}
        for p in packs:
            for e in p[c]:
                if e['id'] in seen:
                    report['problems'].append(f'duplicate {c} id {e["id"]} in {seen[e["id"]]} and {p["id"]}')
                seen[e['id']] = p['id']
    # addition letters unique
    letters = {}
    for p in packs:
        for r in p['rules']:
            if r.get('addition'):
                if r['addition'] in letters:
                    report['problems'].append(f'addition {r["addition"]} used twice ({letters[r["addition"]]}, {r["id"]})')
                letters[r['addition']] = r['id']

    # cross references between entries
    ids = {c: {e['id'] for p in packs for e in p[c]} for c in LIST_CATS}
    link_cat = {'power': 'powers', 'scar': 'scars', 'mission': 'missions', 'mark': 'marks'}
    for p in packs:
        for c in LIST_CATS:
            for e in p[c]:
                for fld, tc in link_cat.items():
                    v = e.get(fld)
                    if isinstance(v, str) and v not in ids[tc]:
                        report['problems'].append(f'{p["id"]}.{c}.{e["id"]}.{fld} -> unknown {tc} id {v}')
                st = e.get('sticker') or {}
                if st.get('ref'):
                    tc, tid = st['ref'].split(':', 1)
                    if tid not in ids.get(tc, set()):
                        report['problems'].append(f'{p["id"]}.{c}.{e["id"]}.sticker.ref -> unknown {st["ref"]}')
                for r in e.get('rules') or []:
                    if r not in ids['rules']:
                        report['problems'].append(f'{p["id"]}.{c}.{e["id"]}.rules -> unknown rule {r}')
                eff = e.get('effect') or {}
                if eff.get('type') == 'factionPower' and eff.get('power') not in ids['powers']:
                    report['problems'].append(f'{p["id"]}.{c}.{e["id"]}.effect.power -> unknown {eff.get("power")}')

    # output paths must exist (case-sensitive)
    out_paths = []
    for p in packs:
        walk_paths(p, out_paths)
    out_missing = sorted({x for x in out_paths if not exists_cs(x)})
    used = set(out_paths)
    disk = disk_images()
    not_in_yaml = [d for d in disk if d not in report['yamlRefs'] and '/territories/images/original/' not in d
                   and '/territories/images/advanced/' not in d]
    not_in_output = [d for d in disk if d not in used]

    # stats
    transcribed = sum(1 for p in packs for c in LIST_CATS for e in p[c] if e.get('textSource') == 'card')
    structured = sum(1 for p in packs for c in LIST_CATS for e in p[c] if e.get('effect') or e.get('check'))
    scans = set()
    for p in packs:
        for c in LIST_CATS:
            for e in p[c]:
                if e.get('textSource') == 'card':
                    scans.add(e.get('cardImg') if c in ('scars', 'powers', 'marks') and e.get('cardImg') else e.get('img'))
        if (p.get('coinCards') or {}).get('textSource') == 'card':
            scans.add(p['coinCards']['img'])
    report['scans'] = len({x for x in scans if x and x.endswith('.jpg')})
    by_source = {}
    for p in packs:
        for c in LIST_CATS:
            for e in p[c]:
                ts = e.get('textSource')
                if ts:
                    by_source[ts] = by_source.get(ts, 0) + 1
    illegible = [(p['id'], c, e['id']) for p in packs for c in LIST_CATS for e in p[c]
                 if '[illegible]' in json.dumps(e)]

    index = {'packs': []}
    for p in packs:
        index['packs'].append({'id': p['id'], 'label': p['label'], 'order': p['order'], 'kind': p['kind'],
                               'trigger': p['trigger'], 'file': f'data/content/{p["id"]}.json',
                               'counts': stats_for(p)})

    # --------------------------------------------------------------- write
    if not check_only:
        os.makedirs(OUT, exist_ok=True)
        for p in packs:
            with open(os.path.join(OUT, f'{p["id"]}.json'), 'w') as fh:
                json.dump(p, fh, indent=2, ensure_ascii=False)
                fh.write('\n')
        with open(os.path.join(OUT, 'index.json'), 'w') as fh:
            json.dump(index, fh, indent=2, ensure_ascii=False)
            fh.write('\n')
        write_readme(packs, report, out_missing, not_in_yaml, not_in_output, transcribed, structured, by_source)

    # --------------------------------------------------------------- console summary
    print(f'packs: {", ".join(p["id"] for p in packs)}')
    for p in packs:
        print(f'  {p["id"]:14s}', {k: v for k, v in stats_for(p).items() if v})
    print(f'distinct scans transcribed: {report["scans"]}; entries with card text: {transcribed}; '
          f'with structured effect/check: {structured}')
    print(f'text sources: {by_source}')
    print(f'territory face files checked: {report["territoryChecked"]}, missing: {len(report["territoryMissing"])}')
    for m in report['territoryMissing']:
        print('   missing face', m)
    print(f'YAML refs missing on disk: {len(report["yamlMissing"])}')
    for m in report['yamlMissing']:
        print('  ', m)
    print(f'output paths missing on disk: {len(out_missing)}')
    for m in out_missing:
        print('  ', m)
    print(f'unclaimed YAML docs: {report["unclaimed"]}')
    print(f'YAML-vs-card overrides: {len(report["overrides"])}')
    if illegible:
        print('illegible:', illegible)
    if report['problems']:
        print('PROBLEMS:')
        for pr in report['problems']:
            print('  ', pr)
        sys.exit(1)


# ----------------------------------------------------------------------------- README
_init_cache = {}


def init_js_refs(relpath):
    """True if the pack's old init.js (or its macros) names this file."""
    parts = relpath.split('/')
    pack = parts[2]
    if pack not in _init_cache:
        txt = ''
        for fn in ('init.js',):
            pth = os.path.join(UNLOCKS, pack, fn)
            if os.path.isfile(pth):
                txt += open(pth).read()
        _init_cache[pack] = txt
    name = parts[-1]
    folder = parts[3]
    txt = _init_cache[pack]
    return name in txt and (folder in txt or name in ('coin.png',))

def md_table(rows, head):
    out = ['| ' + ' | '.join(head) + ' |', '| ' + ' | '.join('---' for _ in head) + ' |']
    for r in rows:
        out.append('| ' + ' | '.join(str(x).replace('|', '\\|').replace('\n', ' ') for x in r) + ' |')
    return '\n'.join(out)


def write_readme(packs, report, out_missing, not_in_yaml, not_in_output, transcribed, structured, by_source):
    tpl_path = os.path.join(HERE, 'README.template.md')
    with open(tpl_path) as fh:
        tpl = fh.read()

    cols = ['warProgresses', 'factions', 'powers', 'territoryCards', 'coinCards', 'scars', 'stickers', 'events',
            'missions', 'draft', 'rules', 'marks', 'secretPowers']
    rows = []
    for p in packs:
        s = stats_for(p)
        rows.append([f'`{p["id"]}`', p['label'], p['kind'], p['trigger']['key']] + [s.get(c, 0) or '' for c in cols])
    counts = md_table(rows, ['pack', 'label', 'kind', 'trigger'] + cols)
    phys = []
    for p in packs:
        for c in ('scars', 'stickers', 'events', 'missions'):
            q = sum(e.get('qty', 1) for e in p[c])
            if q:
                phys.append(f'{p["id"]}.{c}={q}')
    counts += '\n\nPhysical card/sticker totals (sum of `qty`): ' + ', '.join(phys) + '.'

    glance = []
    for p in packs:
        parts = []
        for c in LIST_CATS:
            if c == 'territoryCards':
                if p[c]:
                    parts.append(f'{len(p[c])} territory card' + ('s' if len(p[c]) != 1 else ''))
                continue
            if p[c]:
                parts.append(f'**{c}**: ' + ', '.join(f'`{e["id"]}`' + (f'×{e["qty"]}' if e.get('qty', 1) != 1 else '')
                                                     for e in p[c]))
        if p.get('coinCards'):
            parts.append(f'**coinCards**: {p["coinCards"]["count"]}')
        glance.append(f'- **{p["label"]}** (`{p["id"]}`): ' + '; '.join(parts))

    add_rows = []
    for p in packs:
        for r in p['rules']:
            if r.get('kind') == 'addition':
                add_rows.append((r['addition'], r.get('page'), f'`{r["id"]}`', r.get('code', ''), p['id'],
                                 r.get('title', ''), 'inferred' if r.get('inferred') else 'given (file name / rulebook comment)',
                                 r['img']))
    add_rows.sort(key=lambda x: x[0])
    additions = md_table(add_rows, ['box', 'page', 'rule id', 'card', 'pack', 'title', 'basis', 'image'])

    mm = []
    mm.append(f'- Territory faces checked: {report["territoryChecked"]} expected files, '
              f'{len(report["territoryMissing"])} missing.')
    for m in report['territoryMissing']:
        mm.append(f'  - missing: `{m}`')
    mm.append(f'- YAML references that do not resolve to a file (case-sensitive): {len(report["yamlMissing"])}')
    for y, k, r in report['yamlMissing']:
        mm.append(f'  - `{y}` → `{k}` → `{r}`')
    mm.append(f'- Paths written to the JSON that do not exist: {len(out_missing)}')
    for m in out_missing:
        mm.append(f'  - `{m}`')
    mm.append(f'- Images on disk not referenced by any `cards.yaml` ({len(not_in_yaml)}; "init.js" = the old '
              'importer loaded it directly):')
    for m in not_in_yaml:
        why = ''
        if init_js_refs(m):
            why = ' (init.js)'
        elif '/territories/images/cards.' in m:
            why = ' (face for a higher resource value; the YAML only names the starting face)'
        mm.append(f'  - `{m}`' + why)
    mm.append(f'- Images on disk not referenced by the generated JSON ({len(not_in_output)}; territory faces of '
              'every variant are referenced):')
    for m in not_in_output:
        mm.append(f'  - `{m}`')
    mm.append(f'- Values where the card scan differs from `cards.yaml` (the card wins) ({len(report["overrides"])}):')
    for pk, c, i, fld, a, b in report['overrides']:
        mm.append(f'  - `{pk}.{c}.{i}.{fld}`: YAML `{a}` → card `{b}`')
    if report['unclaimed']:
        mm.append('- YAML documents with no transcription (emitted with `"untranscribed": true`): ' +
                  ', '.join(f'`{u}`' for u in report['unclaimed']))
    mismatches = '\n'.join(mm)

    stats = (f'{report["scans"]} distinct card scans were transcribed. '
             f'{transcribed} entries carry text transcribed from a card image (`textSource: "card"`); '
             f'{structured} entries carry a structured `effect` or `check`. Text sources overall: ' +
             ', '.join(f'`{k}` {v}' for k, v in sorted(by_source.items())) + '.')

    txt = (tpl.replace('{{COUNTS}}', counts).replace('{{GLANCE}}', '\n'.join(glance))
           .replace('{{ADDITIONS}}', additions).replace('{{MISMATCHES}}', mismatches).replace('{{STATS}}', stats))
    with open(os.path.join(OUT, 'README.md'), 'w') as fh:
        fh.write(txt)


if __name__ == '__main__':
    main()
