#!/usr/bin/env python3
"""depgraph.py: a lexical declaration-level dependency graph of the archive.

LEXICAL (APPROXIMATE). For each project declaration, the project names its
source text mentions are resolved through the enclosing namespaces and
`open`s, by exact name only. It misses dependencies that come in through
notation, instances, elaboration, tactics or auto-bound names. It can include
names that are only mentioned in comments that survived stripping, or in
attributes. It is a map for agents to check against the Lean, not a proof.

  python3 -I tools/depgraph.py ARCHIVE.tar.gz OUT/
      Reads OUT/modules.jsonl (from make-units.py scan) and the archive
      (streamed, never extracted), and writes
        OUT/graph-deps.jsonl   one line per module: per declaration (in the
                               modules.jsonl order) the global ids it mentions
        OUT/graph-reach.json   ids of declarations Main's declarations reach,
                               with one parent per reached id (a path to Main)
        OUT/graph-stats.json   counts, and load-bearing share per area
  python3 -I tools/depgraph.py load OUT/ COORDINATOR
      Uploads the graph to the coordinator as blob parts (admin token in
      $RH_ADMIN_TOKEN).
"""
import collections, gzip, importlib.util, json, os, re, sys, tarfile, time

HERE = os.path.dirname(os.path.abspath(__file__))
spec = importlib.util.spec_from_file_location('make_units', os.path.join(HERE, 'make-units.py'))
mu = importlib.util.module_from_spec(spec)
spec.loader.exec_module(mu)

TOKEN = re.compile(r"[A-Za-z_Ͱ-Ͽ℀-⅏][A-Za-z0-9_'!?Ͱ-Ͽ₀-ₜᵢ-ᵪ℀-⅏.]*")
OPEN = re.compile(r'^\s*open\s+(?:scoped\s+)?([^(\n]+?)(?:\s+in\b|\s*\(|$)')


def scan(archive, out):
    mods = [json.loads(l) for l in open(os.path.join(out, 'modules.jsonl'))]
    names = {}
    ids_of = []
    nid = 0
    for i, m in enumerate(mods):
        row = []
        for d in m['decls']:
            names.setdefault(d[1], nid)
            row.append(nid)
            nid += 1
        ids_of.append(row)
    index = {m['name']: i for i, m in enumerate(mods)}
    print(f'{len(mods):,} modules, {nid:,} declarations', file=sys.stderr)
    deps = [None] * len(mods)
    t0 = time.time()
    seen = 0
    with tarfile.open(archive, 'r:gz') as tf:
        for t in tf:
            if not t.isfile() or not t.name.startswith(mu.SRC_PREFIX) or not t.name.endswith('.lean'):
                continue
            mod = t.name[len(mu.SRC_PREFIX):-5].replace('/', '.')
            i = index.get(mod)
            if i is None:
                continue
            text = tf.extractfile(t).read().decode('utf-8', 'replace')
            deps[i] = module_deps(text, mods[i], ids_of[i], names)
            seen += 1
            if seen % 20000 == 0:
                print(f'  {seen:,} modules {time.time() - t0:.0f}s', file=sys.stderr)
    with open(os.path.join(out, 'graph-deps.jsonl'), 'w') as f:
        for i, d in enumerate(deps):
            f.write(json.dumps(d or [[] for _ in ids_of[i]], separators=(',', ':')) + '\n')
    reach(out, mods, ids_of, deps)


def module_deps(text, m, ids, names):
    """Per declaration of the module: sorted global ids its text mentions."""
    clean = mu.strip_comments(text)
    lines = clean.split('\n')
    starts = [d[3] - 1 for d in m['decls']]
    out = []
    # namespace and open state at each line
    stack, opens = [], []
    state = []
    for line in lines:
        s = line.strip()
        mm = mu.NS_RE.match(s)
        if mm:
            kw, name = mm.group(1), mm.group(2)
            if kw == 'namespace' and name:
                stack.append(('ns', name.split('.'), len(opens)))
            elif kw == 'section':
                stack.append(('sec', [], len(opens)))
            elif kw == 'end' and stack:
                k = stack.pop()
                del opens[k[2]:]
        else:
            o = OPEN.match(line)
            if o:
                opens.extend(o.group(1).split())
        state.append(([p for k, ps, _ in stack if k == 'ns' for p in ps], list(opens)))
    for j, start in enumerate(starts):
        end = starts[j + 1] if j + 1 < len(starts) else len(lines)
        ns, op = state[start] if start < len(state) else ([], [])
        prefixes = ['.'.join(ns[:k]) for k in range(len(ns), 0, -1)]
        found = set()
        for tok in TOKEN.findall('\n'.join(lines[start:end])):
            tok = tok.rstrip('.')
            if tok.startswith('_root_.'):
                tok = tok[7:]
            hit = names.get(tok)
            if hit is None:
                for p in prefixes:
                    hit = names.get(f'{p}.{tok}')
                    if hit is not None:
                        break
            if hit is None:
                for o in op:
                    hit = names.get(f'{o}.{tok}')
                    if hit is not None:
                        break
            if hit is not None and hit != ids[j]:
                found.add(hit)
        out.append(sorted(found))
    return out


def reach(out, mods, ids_of, deps):
    main = [k for i, m in enumerate(mods) if m['name'] in ('Main',) for k in ids_of[i]]
    adj = {}
    for i, d in enumerate(deps):
        for k, lst in zip(ids_of[i], d or []):
            adj[k] = lst
    parent = {k: -1 for k in main}
    q = collections.deque(main)
    while q:
        x = q.popleft()
        for y in adj.get(x, ()):
            if y not in parent:
                parent[y] = x
                q.append(y)
    home_of = {}
    for i, row in enumerate(ids_of):
        for k in row:
            home_of[k] = i
    area = collections.Counter()
    area_reach = collections.Counter()
    for i, m in enumerate(mods):
        area[m['area']] += len(ids_of[i])
    for k in parent:
        area_reach[mods[home_of[k]]['area']] += 1
    edges = sum(len(v) for v in adj.values())
    json.dump({'main': main, 'parent': parent}, open(os.path.join(out, 'graph-reach.json'), 'w'), separators=(',', ':'))
    stats = {
        'label': 'lexical (approximate)', 'declarations': len(home_of), 'edges': edges,
        'main_declarations': len(main), 'reach_main': len(parent),
        'areas': sorted(({'area': a, 'declarations': area[a], 'reach_main': area_reach[a]} for a in area), key=lambda x: -x['declarations']),
    }
    json.dump(stats, open(os.path.join(out, 'graph-stats.json'), 'w'), indent=1)
    print(f"edges {edges:,}; Main declarations {len(main)}; reach Main {len(parent):,} of {len(home_of):,}", file=sys.stderr)


BLOB = 1_800_000


def load(out, base):
    """Upload: per-module deps/rdeps rows, the name→id table, and three blobs
    (declofs, reach as little-endian Int32 arrays; graphmeta as JSON)."""
    import array
    token = os.environ.get('RH_ADMIN_TOKEN') or ''
    if len(token) < 16:
        raise SystemExit('set RH_ADMIN_TOKEN')
    base = base.rstrip('/')
    mods = [json.loads(l) for l in open(os.path.join(out, 'modules.jsonl'))]
    deps = [json.loads(l) for l in open(os.path.join(out, 'graph-deps.jsonl'))]
    r = json.load(open(os.path.join(out, 'graph-reach.json')))
    stats = json.load(open(os.path.join(out, 'graph-stats.json')))
    ofs = array.array('i', [0])
    for m in mods:
        ofs.append(ofs[-1] + len(m['decls']))
    n = ofs[-1]
    home_of = array.array('i', [0]) * n
    for i in range(len(mods)):
        for k in range(ofs[i], ofs[i + 1]):
            home_of[k] = i
    rdeps = [[[] for _ in m['decls']] for m in mods]
    for i, d in enumerate(deps):
        for local, lst in enumerate(d):
            src = ofs[i] + local
            for t in lst:
                j = home_of[t]
                rdeps[j][t - ofs[j]].append(src)
    parent = array.array('i', [-2]) * n
    for k, v in r['parent'].items():
        parent[int(k)] = v
    def blob(name, data):
        z = gzip.compress(data, 9, mtime=0)
        parts = [z[i:i + BLOB] for i in range(0, len(z), BLOB)]
        for k, part in enumerate(parts):
            mu.post(base, f'/api/admin/blob?name={name}&part={k}&parts={len(parts)}', None, token, raw=part, ctype='application/octet-stream')
        print(f'blob {name}: {len(z):,} bytes gzip in {len(parts)} part(s)')
    if sys.byteorder != 'little':
        raise SystemExit('little-endian host required')
    blob('declofs', ofs.tobytes())
    blob('reach', parent.tobytes())
    blob('graphmeta', json.dumps({**stats, 'main': r['main']}).encode())
    batch, sent = [], 0
    for i, m in enumerate(mods):
        batch.append({'name': m['name'], 'idx': i, 'deps': deps[i], 'rdeps': [sorted(x)[:2000] for x in rdeps[i]]})
        if len(batch) >= 800 or i == len(mods) - 1:
            mu.post(base, '/api/admin/moddeps', {'modules': batch}, token)
            sent += len(batch); batch = []
            if sent % 16000 == 0:
                print(f'  modules {sent:,}', file=sys.stderr)
    names, sent = [], 0
    for i, m in enumerate(mods):
        for local, d in enumerate(m['decls']):
            names.append([d[1], ofs[i] + local])
            if len(names) >= 20000:
                mu.post(base, '/api/admin/declnames', {'names': names}, token); sent += len(names); names = []
    if names:
        mu.post(base, '/api/admin/declnames', {'names': names}, token); sent += len(names)
    print(f'declaration names: {sent:,}')


if __name__ == '__main__':
    a = sys.argv[1:]
    if len(a) == 3 and a[0] == 'load':
        load(a[1], a[2])
    elif len(a) == 2:
        scan(a[0], a[1])
    else:
        print(__doc__)
        sys.exit(2)
