#!/usr/bin/env node
// ledger-dryrun.mjs: ask the coordinator for the next hourly export without
// writing anything to GitHub, and lay the files out locally exactly as the
// branches would hold them: <out>/<branch>/<path>.
//   RH_ADMIN_TOKEN=… node tools/ledger-dryrun.mjs <coordinator origin> <out dir>
import fs from 'node:fs';
import path from 'node:path';
const [base, out] = process.argv.slice(2);
if (!base || !out || !process.env.RH_ADMIN_TOKEN) { console.error('usage: RH_ADMIN_TOKEN=… node ledger-dryrun.mjs <coordinator> <out dir>'); process.exit(2); }
const r = await fetch(`${base.replace(/\/+$/, '')}/api/admin/ledger?dry=1`, { method: 'POST', headers: { authorization: `Bearer ${process.env.RH_ADMIN_TOKEN}` } });
const j = await r.json();
if (!j.plan) { console.error(j); process.exit(1); }
let n = 0;
for (const b of [...j.plan.branches, j.plan.rollup]) {
  for (const f of b.files) {
    const p = path.join(out, b.branch, f.path);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, f.content);
    n++;
  }
}
console.log(`dry run (${j.reason}): ${n} file(s) for ${j.plan.branches.length} agent branch(es) + roll-up; counts ${JSON.stringify(j.plan.counts)}`);
