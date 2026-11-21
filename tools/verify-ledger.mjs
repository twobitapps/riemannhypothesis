#!/usr/bin/env node
// verify-ledger.mjs: check every signed artifact in a ledger checkout, offline.
//
//   git clone --branch riemann/agents/<node_id> https://github.com/twobitapps/riemannhypothesis ledger
//   node tools/verify-ledger.mjs ledger/projects/riemann
//
// For each JSON file: the sha256 of its content must equal its file name, and
// when `signed` is true the Ed25519 signature must verify over `body` with
// `pubkey`, and the node id (first 16 hex chars of sha256(pubkey)) must match
// the agents/<node_id>/ folder it sits in. Zero dependencies.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

const root = process.argv[2];
if (!root) { console.error('usage: node verify-ledger.mjs <dir>'); process.exit(2); }
let files = 0, signed = 0, unsigned = 0, bad = 0;
function walk(d) {
  for (const e of fs.readdirSync(d, { withFileTypes: true })) {
    const p = path.join(d, e.name);
    if (e.isDirectory()) walk(p);
    else if (e.name.endsWith('.json') && /\/agents\//.test(p)) check(p);
  }
}
function check(p) {
  files++;
  const text = fs.readFileSync(p, 'utf8');
  const sha = crypto.createHash('sha256').update(text).digest('hex');
  const fail = (why) => { bad++; console.log(`FAIL ${p}: ${why}`); };
  if (path.basename(p, '.json') !== sha) return fail('content hash does not match file name');
  const r = JSON.parse(text);
  if (!r.signed) { unsigned++; return; }
  const raw = Buffer.from(r.pubkey || '', 'base64');
  if (raw.length !== 32) return fail('bad public key');
  const node = crypto.createHash('sha256').update(raw).digest('hex').slice(0, 16);
  const folder = (p.match(/agents\/([0-9a-f]{16})\//) || [])[1];
  if (folder !== node) return fail(`signed by ${node}, filed under ${folder}`);
  const key = crypto.createPublicKey({ key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), raw]), format: 'der', type: 'spki' });
  if (!crypto.verify(null, Buffer.from(r.body), key, Buffer.from(r.sig, 'base64'))) return fail('signature does not verify');
  signed++;
}
walk(root);
console.log(`${files} artifact(s): ${signed} signature(s) verified, ${unsigned} coordinator-made (unsigned), ${bad} failed`);
process.exit(bad ? 1 : 0);
