#!/usr/bin/env python3
"""make-units.py: Track A work units from the Alpöge Lean archive.

Reads the archive by streaming (never extracts it), so it needs only a few
hundred MB of free disk for its output. The archive is data: nothing in it is
executed.

  python3 -I tools/make-units.py scan  ARCHIVE.tar.gz CONE.json OUT/
      Parses every module in Main's import cone: import depth (leaves = 0),
      area, line count, sha256, declarations. Writes
        OUT/modules.jsonl     one row per module
        OUT/packs/NNNN.bin    sources, one gzip member per module, concatenated
        OUT/units.jsonl       card units for every module (leaves first)
        OUT/levels.json       module counts per depth and area (for /api/map)

  python3 -I tools/make-units.py load OUT/ COORDINATOR [--wave N] [--skip K] [--sources]
      Uploads to the coordinator's admin endpoints (bearer token from
      $RH_ADMIN_TOKEN): the module index and source packs (--sources, once),
      the level table, and N card units in depth order after the first K.

Write budget: every stored row counts against the Durable Object's daily
row-write allowance. The module index (--sources) is ~175k rows and is loaded
once. Card units go in waves of at most 2,000 a day (--wave is capped).

  python3 -I tools/make-units.py rpackets OUT/
      Track R packets: sibling leaf modules (depth 0, imports only Mathlib or
      Lean), up to 6 per packet and 30 KB of source -> OUT/r-units.jsonl

  python3 -I tools/make-units.py rload OUT/ COORDINATOR --n N [--skip K]
      Uploads N Track R packets (smallest first) via /api/admin/units.

  python3 -I tools/make-units.py index OUT/ COORDINATOR
      Builds the compact name indexes (modules: name, depth, lines; public
      declarations: name, kind, module number) and uploads them as a few
      blob rows. Searches run on these, never by scanning the module table.

Unit kinds produced here (docs/PROTOCOL.md "Track A"):
  card    one module, or a packet of up to 4 small sibling modules at the same
          depth, or one part of a module whose source exceeds 200 KB.
"""
import gzip, hashlib, io, json, os, re, sys, tarfile, time, urllib.request, collections

SRC_PREFIX = 'lean/src/'
PART_BYTES = 200_000            # split modules above this
PACKET_SMALL = 4_000            # a module this small may share a packet
PACKET_BYTES = 12_000
PACKET_MAX = 4
PACK_TARGET = 900_000           # compressed bytes per source pack
EXPECT_MAX = 24                 # statements a card must cover, at most

IMPORT_RE = re.compile(r'^\s*(?:public\s+|private\s+)?(?:meta\s+)?import\s+(?:all\s+)?(.+)$')
MODS = r'(?:(?:private|protected|noncomputable|partial|unsafe|nonrec|public|scoped|local|meta)\s+)*'
DECL_RE = re.compile(r'^(?:@\[[^\]]*\]\s*)*' + r'(' + MODS + r')' +
                     r'(theorem|lemma|def|abbrev|instance|structure|class(?:\s+inductive)?|inductive|opaque|axiom)\s+([^\s:({\[⦃]+)')
NS_RE = re.compile(r'^(namespace|section|end)\b\s*([^\s]*)')
THEOREMISH = ('theorem', 'lemma')


def strip_comments(text):
    """Source with comments blanked (line structure kept)."""
    out, i, n, depth = [], 0, len(text), 0
    while i < n:
        if depth == 0 and text.startswith('--', i):
            j = text.find('\n', i)
            j = n if j < 0 else j
            out.append(' ' * (j - i)); i = j; continue
        if text.startswith('/-', i):
            depth += 1; out.append('  '); i += 2; continue
        if depth and text.startswith('-/', i):
            depth -= 1; out.append('  '); i += 2; continue
        c = text[i]
        out.append(c if (depth == 0 or c == '\n') else ' ')
        i += 1
    return ''.join(out)


def parse_decls(text):
    """[(kind, full_name, private, line_no)] for named declarations."""
    clean = strip_comments(text)
    stack, out = [], []
    pending_attr = False
    for ln, line in enumerate(clean.split('\n'), 1):
        s = line.strip()
        if not s:
            continue
        m = NS_RE.match(s)
        if m:
            kw, name = m.group(1), m.group(2)
            if kw == 'namespace' and name:
                stack.append(('ns', name.split('.')))
            elif kw == 'section':
                stack.append(('sec', []))
            elif kw == 'end' and stack:
                stack.pop()
            continue
        if line[:1] in (' ', '\t'):
            continue  # declarations start at column 0 in this archive
        m = DECL_RE.match(s)
        if not m:
            continue
        mods, kind, name = m.group(1), m.group(2).split()[0], m.group(3)
        if kind == 'instance' and (name.startswith('(') or name.startswith('[') or name == ':'):
            continue
        name = name.rstrip(',')
        if name.startswith('_root_.'):
            full = name[len('_root_.'):]
        else:
            ns = [p for k, parts in stack if k == 'ns' for p in parts]
            full = '.'.join(ns + [name])
        out.append((kind, full, 'private' in mods, ln))
    return out


def expected(decls):
    pub = [d for d in decls if not d[2]]
    thm = [d[1] for d in pub if d[0] in THEOREMISH]
    if thm:
        return thm[:EXPECT_MAX]
    return [d[1] for d in pub if d[0] != 'instance'][:EXPECT_MAX]


def area_of(mod):
    p = mod.split('.')
    return '.'.join(p[:2]) if len(p) > 2 else p[0]


def depths(cone, imports):
    cs = set(cone)
    proj = {m: [d for d in imports.get(m, []) if d in cs] for m in cone}
    rev = collections.defaultdict(list)
    indeg = {}
    for m, ds in proj.items():
        indeg[m] = len(ds)
        for d in ds:
            rev[d].append(m)
    q = [m for m in cone if indeg[m] == 0]
    depth = {m: 0 for m in q}
    i = 0
    while i < len(q):
        m = q[i]; i += 1
        for r in rev[m]:
            depth[r] = max(depth.get(r, 0), depth[m] + 1)
            indeg[r] -= 1
            if indeg[r] == 0:
                q.append(r)
    if len(q) != len(cs):
        raise SystemExit('import graph has a cycle')
    return depth, proj


def split_parts(text, decls):
    """Cut a large module at declaration starts into chunks <= PART_BYTES."""
    lines = text.split('\n')
    starts = sorted({d[3] - 1 for d in decls} | {0})
    parts, cur_start, cur_bytes = [], 0, 0
    offs = []
    acc = 0
    for l in lines:
        offs.append(acc); acc += len(l.encode()) + 1
    offs.append(acc)
    for s in starts[1:]:
        if offs[s] - offs[cur_start] > PART_BYTES:
            parts.append((cur_start, s)); cur_start = s
    parts.append((cur_start, len(lines)))
    # Any single block still too big is hard-cut by lines.
    fixed = []
    for a, b in parts:
        while offs[b] - offs[a] > PART_BYTES:
            c = a + 1
            while c < b and offs[c + 1] - offs[a] <= PART_BYTES:
                c += 1
            fixed.append((a, c)); a = c
        fixed.append((a, b))
    return fixed  # [(line_from, line_to)) 0-based


def scan(archive, cone_path, out):
    os.makedirs(os.path.join(out, 'packs'), exist_ok=True)
    c = json.load(open(cone_path))
    cone, imports = c['cone'], c['imports']
    depth, proj = depths(cone, imports)
    cs = set(cone)
    rows = {}
    pack_no, pack_buf = 0, io.BytesIO()
    big = {}
    t0 = time.time()

    def flush():
        nonlocal pack_no, pack_buf
        if pack_buf.tell():
            with open(os.path.join(out, 'packs', f'{pack_no:04d}.bin'), 'wb') as f:
                f.write(pack_buf.getvalue())
            pack_no += 1
            pack_buf = io.BytesIO()

    with tarfile.open(archive, 'r:gz') as tf:
        for m in tf:
            if not m.isfile() or not m.name.startswith(SRC_PREFIX) or not m.name.endswith('.lean'):
                continue
            mod = m.name[len(SRC_PREFIX):-len('.lean')].replace('/', '.')
            if mod not in cs:
                continue
            raw = tf.extractfile(m).read()
            text = raw.decode('utf-8', 'replace')
            decls = parse_decls(text)
            gz = gzip.compress(raw, 6, mtime=0)
            off = pack_buf.tell()
            pack_buf.write(gz)
            rows[mod] = {
                'name': mod, 'depth': depth[mod], 'area': area_of(mod),
                'lines': text.count('\n') + 1, 'bytes': len(raw),
                'sha': hashlib.sha256(raw).hexdigest(),
                'pack': pack_no, 'off': off, 'len': len(gz),
                'imports': proj[mod],
                'decls': [[k, n, int(p), ln] for k, n, p, ln in decls],
                'expect': expected(decls),
            }
            if len(raw) > PART_BYTES:
                big[mod] = [(a, b) for a, b in split_parts(text, decls)]
            if pack_buf.tell() >= PACK_TARGET:
                flush()
            if len(rows) % 10000 == 0:
                print(f'  {len(rows):,} modules  {time.time() - t0:.0f}s', file=sys.stderr)
    flush()
    missing = cs - set(rows)
    if missing:
        print(f'warning: {len(missing)} cone modules not in archive', file=sys.stderr)

    with open(os.path.join(out, 'modules.jsonl'), 'w') as f:
        for mod in sorted(rows, key=lambda x: (rows[x]['depth'], x)):
            f.write(json.dumps(rows[mod], separators=(',', ':')) + '\n')

    # Units, leaves first. Small modules with the same parent namespace and
    # depth share a packet; big modules are split into parts.
    units = []
    by_key = collections.defaultdict(list)
    for mod, r in rows.items():
        by_key[(r['depth'], mod.rsplit('.', 1)[0])].append(mod)
    for (d, parent) in sorted(by_key):
        mods = sorted(by_key[(d, parent)])
        packet = []

        def emit_packet():
            if not packet:
                return
            if len(packet) == 1:
                units.append(card_unit([packet[0]], rows))
            else:
                units.append(card_unit(list(packet), rows))
            packet.clear()

        for mod in mods:
            r = rows[mod]
            if mod in big:
                n = len(big[mod])
                for i, (a, b) in enumerate(big[mod]):
                    units.append(card_unit([mod], rows, part=(i + 1, n, a, b)))
                continue
            if r['bytes'] <= PACKET_SMALL:
                if len(packet) >= PACKET_MAX or sum(rows[x]['bytes'] for x in packet) + r['bytes'] > PACKET_BYTES:
                    emit_packet()
                packet.append(mod)
            else:
                units.append(card_unit([mod], rows))
        emit_packet()
    units.sort(key=lambda u: (u['depth'], u['id']))
    with open(os.path.join(out, 'units.jsonl'), 'w') as f:
        for u in units:
            f.write(json.dumps(u, separators=(',', ':')) + '\n')

    levels = collections.defaultdict(lambda: {'modules': 0, 'lines': 0})
    areas = collections.defaultdict(lambda: {'modules': 0, 'lines': 0})
    for r in rows.values():
        levels[r['depth']]['modules'] += 1; levels[r['depth']]['lines'] += r['lines']
        areas[r['area']]['modules'] += 1; areas[r['area']]['lines'] += r['lines']
    meta = {
        'archive_sha256_prefix': '9631b4f0', 'modules': len(rows),
        'lines': sum(r['lines'] for r in rows.values()),
        'max_depth': max(levels), 'units': len(units), 'packs': pack_no,
        'levels': [{'depth': d, **levels[d]} for d in sorted(levels)],
        'areas': [{'area': a, **areas[a]} for a in sorted(areas, key=lambda a: -areas[a]['modules'])],
    }
    json.dump(meta, open(os.path.join(out, 'levels.json'), 'w'))
    ndecl = sum(len(r['decls']) for r in rows.values())
    sizes = [len(u['modules']) for u in units]
    print(f'modules {len(rows):,}  decls {ndecl:,}  units {len(units):,} '
          f'(packets {sum(1 for s in sizes if s > 1):,}, parts {sum(1 for u in units if u.get("part")):,})  '
          f'packs {pack_no}  depth 0..{meta["max_depth"]}  {time.time() - t0:.0f}s')


def card_unit(mods, rows, part=None):
    r0 = rows[mods[0]]
    if part:
        i, n, a, b = part
        uid = f'A:card:{mods[0]}#{i}/{n}'
    elif len(mods) == 1:
        uid = f'A:card:{mods[0]}'
    else:
        uid = f'A:pk:{mods[0]}+{len(mods) - 1}'
    inside = set(mods)
    imports = sorted({d for m in mods for d in rows[m]['imports'] if d not in inside})
    u = {
        'id': uid, 'track': 'A', 'kind': 'card', 'ref': mods[0] if len(mods) == 1 else f'{mods[0]} +{len(mods) - 1}',
        'depth': r0['depth'], 'area': r0['area'],
        'modules': [{'name': m, 'sha': rows[m]['sha'], 'expect': rows[m]['expect']} for m in mods],
        'imports': imports,
        'needs': {'role': 'thinker'},
    }
    if part:
        i, n, a, b = part
        u['part'] = {'i': i, 'n': n, 'from_line': a, 'to_line': b}
        inside_part = [(d[0], d[1], d[2], d[3]) for d in rows[mods[0]]['decls'] if a < d[3] <= b]
        u['modules'][0]['expect'] = expected(inside_part)
    return u


BLOB_PART = 1_800_000


def index(out, base):
    token = os.environ.get('RH_ADMIN_TOKEN') or ''
    if len(token) < 16:
        raise SystemExit('set RH_ADMIN_TOKEN')
    mods, decls = [], []
    for line in open(os.path.join(out, 'modules.jsonl')):
        r = json.loads(line)
        i = len(mods)
        mods.append(f"{r['name']}\t{r['depth']}\t{r['lines']}")
        for d in r['decls']:
            if not d[2]:
                decls.append(f"{d[1]}\t{d[0][:3]}\t{i}")
    for name, lines in (('modules', mods), ('decls', decls)):
        blob = gzip.compress('\n'.join(lines).encode(), 9, mtime=0)
        parts = [blob[i:i + BLOB_PART] for i in range(0, len(blob), BLOB_PART)]
        for k, part in enumerate(parts):
            r = post(base.rstrip('/'), f'/api/admin/blob?name={name}&part={k}&parts={len(parts)}', None, token, raw=part, ctype='application/octet-stream')
            print(f'  {name} part {k + 1}/{len(parts)}: {r}')
        print(f'{name}: {len(lines):,} rows, {len(blob):,} bytes gzip, sha256 {hashlib.sha256(blob).hexdigest()[:16]}')


def rpackets(out):
    rows = [json.loads(l) for l in open(os.path.join(out, 'modules.jsonl'))]
    leaves = [r for r in rows if r['depth'] == 0 and not r['imports']]
    groups = collections.defaultdict(list)
    for r in leaves:
        groups[r['name'].rsplit('.', 1)[0]].append(r)
    units = []
    for parent in sorted(groups):
        cur = []
        for r in sorted(groups[parent], key=lambda r: r['name']):
            if cur and (len(cur) >= 6 or sum(x['bytes'] for x in cur) + r['bytes'] > 30_000):
                units.append(cur); cur = []
            cur.append(r)
        if cur:
            units.append(cur)
    out_units = []
    for mods in units:
        first = mods[0]['name']
        out_units.append({
            'id': f'R:pk:{first}' + (f'+{len(mods) - 1}' if len(mods) > 1 else ''), 'track': 'R', 'kind': 'rebuild',
            'ref': first if len(mods) == 1 else f'{first} +{len(mods) - 1}', 'depth': 0, 'area': mods[0]['area'],
            'bytes': sum(m['bytes'] for m in mods),
            'modules': [{'name': m['name'], 'sha': m['sha']} for m in mods], 'needs': {'role': 'verifier'},
        })
    out_units.sort(key=lambda u: (u['bytes'], u['id']))
    with open(os.path.join(out, 'r-units.jsonl'), 'w') as f:
        for u in out_units:
            f.write(json.dumps(u, separators=(',', ':')) + '\n')
    print(f'Track R packets: {len(out_units):,} from {len(leaves):,} leaf modules')


def rload(out, base, n, skip=0):
    token = os.environ.get('RH_ADMIN_TOKEN') or ''
    if len(token) < 16:
        raise SystemExit('set RH_ADMIN_TOKEN')
    units = [json.loads(l) for l in open(os.path.join(out, 'r-units.jsonl'))][skip:skip + min(n, WAVE_MAX)]
    r = post(base.rstrip('/'), '/api/admin/units', {'units': units}, token)
    print('Track R packets loaded:', r.get('upserted'), 'rejected:', r.get('rejected'))


# ---------------------------------------------------------------- load

def post(base, path, body, token, raw=None, ctype='application/json'):
    data = raw if raw is not None else json.dumps(body, separators=(',', ':')).encode()
    for attempt in range(4):
        req = urllib.request.Request(base + path, data=data, method='POST', headers={
            'authorization': f'Bearer {token}', 'content-type': ctype, 'user-agent': 'rh-make-units/1'})
        try:
            with urllib.request.urlopen(req, timeout=120) as r:
                return json.loads(r.read())
        except urllib.error.HTTPError as e:
            msg = e.read()[:300]
            if e.code < 500:
                raise SystemExit(f'{path}: {e.code} {msg!r}')
            print(f'  {path}: {e.code} {msg!r}, retry', file=sys.stderr)
        except Exception as e:
            print(f'  {path}: {e}, retry', file=sys.stderr)
        time.sleep(3 * (attempt + 1))
    raise SystemExit(f'{path}: failed')


WAVE_MAX = 2000


def load(out, base, wave, sources, skip=0):
    wave = min(wave, WAVE_MAX)
    token = os.environ.get('RH_ADMIN_TOKEN') or ''
    if len(token) < 16:
        raise SystemExit('set RH_ADMIN_TOKEN')
    base = base.rstrip('/')
    meta = json.load(open(os.path.join(out, 'levels.json')))
    if sources:
        packs = sorted(os.listdir(os.path.join(out, 'packs')))
        for p in packs:
            data = open(os.path.join(out, 'packs', p), 'rb').read()
            r = post(base, f'/api/admin/pack?id={int(p[:4])}', None, token, raw=data, ctype='application/octet-stream')
            print(f'  pack {p} {len(data):,} B -> {r}', file=sys.stderr)
        batch = []
        n = 0

        def send():
            nonlocal batch, n
            if batch:
                r = post(base, '/api/admin/modules', {'modules': batch}, token)
                n += r.get('upserted', 0)
                batch = []
        for line in open(os.path.join(out, 'modules.jsonl')):
            r = json.loads(line)
            batch.append(r)
            if len(batch) >= 2000:
                send()
                print(f'  modules {n:,}', file=sys.stderr)
        send()
        print(f'modules loaded: {n:,}')
    r = post(base, '/api/admin/atlas', meta, token)
    print('atlas meta:', r)
    if wave:
        units, n, seen = [], 0, 0
        for line in open(os.path.join(out, 'units.jsonl')):
            seen += 1
            if seen <= skip:
                continue
            units.append(json.loads(line))
            if len(units) >= wave:
                break
        for i in range(0, len(units), 250):
            r = post(base, '/api/admin/units', {'units': units[i:i + 250]}, token)
            n += r.get('upserted', 0)
            if r.get('rejected'):
                print('  rejected:', r['rejected'][:5], file=sys.stderr)
        print(f'units loaded: {n:,} (depth {units[0]["depth"]}..{units[-1]["depth"]})')


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) >= 4 and a[0] == 'scan':
        scan(a[1], a[2], a[3])
    elif len(a) >= 3 and a[0] == 'index':
        index(a[1], a[2])
    elif len(a) >= 2 and a[0] == 'rpackets':
        rpackets(a[1])
    elif len(a) >= 3 and a[0] == 'rload':
        rload(a[1], a[2], int(a[a.index('--n') + 1]) if '--n' in a else 5, int(a[a.index('--skip') + 1]) if '--skip' in a else 0)
    elif len(a) >= 3 and a[0] == 'load':
        wave = int(a[a.index('--wave') + 1]) if '--wave' in a else 0
        skip = int(a[a.index('--skip') + 1]) if '--skip' in a else 0
        load(a[1], a[2], wave, '--sources' in a, skip)
    else:
        print(__doc__)
        sys.exit(2)
