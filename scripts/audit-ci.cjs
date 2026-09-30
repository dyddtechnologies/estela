#!/usr/bin/env node
/*
 * Gate: fail on high/critical advisories, like `npm audit --audit-level=high`, except for
 * an explicit allowlist of advisories that only reach us bundled inside the npm CLI that
 * semantic-release uses to cut releases (node_modules/npm/node_modules/**). Those are
 * build tooling run in CI, never shipped in the @estela/nest tarball, and npm itself has
 * no fixed release yet (npm 11.20.0 and 12.1.0 still bundle undici 6.28.0 and
 * brace-expansion 5.0.9).
 * Remove each entry once npm ships a patched bundle.
 */
const { execSync } = require('node:child_process');

const BUNDLED_IN_NPM_CLI = 'node_modules/npm/node_modules/';
const ALLOWLIST = {
  'GHSA-3wwx-pv8p-q78v': 'undici DoS via permessage-deflate, bundled in npm CLI (release tooling)',
  'GHSA-r53p-7pc4-xj5r': 'undici response splitting via retry interceptor, bundled in npm CLI',
  'GHSA-rfgv-xxqx-mfg5': 'undici DoS via unrequested WebSocket subprotocol, bundled in npm CLI',
  'GHSA-q2hr-2g5m-vwhr': 'brace-expansion quadratic `{a},b}` rewrite DoS, bundled in npm CLI',
  'GHSA-qhr7-859c-m2p7': 'brace-expansion recursion DoS on nested groups, bundled in npm CLI',
  'GHSA-6j4f-fj2g-mc7p': 'brace-expansion recursion DoS in parseCommaParts, bundled in npm CLI',
};
const BLOCKING = new Set(['high', 'critical']);

let raw;
try {
  raw = execSync('npm audit --json', { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
} catch (error) {
  raw = error.stdout; // npm audit exits non-zero when it finds anything
}
const report = JSON.parse(raw);
const blocking = [];
const allowed = [];

for (const [name, vuln] of Object.entries(report.vulnerabilities ?? {})) {
  if (!BLOCKING.has(vuln.severity)) continue;
  const advisories = vuln.via.filter((via) => typeof via === 'object');
  const onlyBundled = vuln.nodes.every((node) => node.startsWith(BUNDLED_IN_NPM_CLI));
  const allAllowlisted =
    advisories.length > 0 &&
    advisories.every((adv) => ALLOWLIST[String(adv.url).split('/').pop()] !== undefined);
  if (onlyBundled && allAllowlisted) {
    allowed.push(`${name} (${vuln.severity}): ${advisories.map((a) => a.url).join(', ')}`);
  } else {
    blocking.push(`${name} (${vuln.severity}) at ${vuln.nodes.join(', ')}`);
  }
}

for (const line of allowed) console.log(`allowlisted: ${line}`);
if (blocking.length > 0) {
  for (const line of blocking) console.error(`BLOCKING: ${line}`);
  process.exit(1);
}
console.log('audit: no blocking high/critical advisories');
