#!/usr/bin/env node
/*
 * Gate: fail on high/critical advisories, like `npm audit --audit-level=high`, except for
 * an explicit allowlist of advisories that only reach us bundled inside the npm CLI that
 * semantic-release uses to cut releases (node_modules/npm/node_modules/**). Those are
 * build tooling run in CI, never shipped in the @estela/nest tarball, and npm itself has
 * no fixed release yet (npm 11.20.0 and 12.1.0 still bundle undici 6.28.0 and
 * brace-expansion 5.0.9).
 * Remove each entry once npm ships a patched bundle.
 *
 * A second, separate list covers advisories with no patched release that reach us only through
 * dev tooling (jest, semantic-release). An entry there is honoured only while the package is
 * absent from the production tree (`npm audit --omit=dev`), so it can never hide something
 * that ships to consumers. Remove each entry once a patched release exists.
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
  'GHSA-ch52-4w7c-c8xp': 'http-cache-semantics ReDoS on cache headers, bundled in npm CLI',
};
const DEV_TOOLING_ALLOWLIST = {
  'GHSA-vfj7-8cjw-p6xm':
    'braces DoS on crafted patterns, no patched release; via micromatch in jest and semantic-release',
};
const BLOCKING = new Set(['high', 'critical']);

function audit(args) {
  try {
    return JSON.parse(
      execSync(`npm audit --json ${args}`, {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
      }),
    );
  } catch (error) {
    return JSON.parse(error.stdout); // npm audit exits non-zero when it finds anything
  }
}

const vulnerabilities = audit('').vulnerabilities ?? {};
const production = new Set(Object.keys(audit('--omit=dev').vulnerabilities ?? {}));
const advisoryId = (advisory) => String(advisory.url).split('/').pop();

/** Advisories behind a package, following `via` package names to the packages that own them. */
function rootAdvisories(name, seen = new Set()) {
  if (seen.has(name)) return [];
  seen.add(name);
  const vuln = vulnerabilities[name];
  if (vuln === undefined)
    return [{ owner: name, id: 'unknown', url: `unknown advisory of ${name}` }];
  return vuln.via.flatMap((via) =>
    typeof via === 'object'
      ? [{ owner: name, id: advisoryId(via), url: via.url }]
      : rootAdvisories(via, seen),
  );
}

function isAllowed({ owner, id }) {
  const nodes = vulnerabilities[owner]?.nodes ?? [];
  const onlyBundled =
    nodes.length > 0 && nodes.every((node) => node.startsWith(BUNDLED_IN_NPM_CLI));
  if (onlyBundled && ALLOWLIST[id] !== undefined) return true;
  return DEV_TOOLING_ALLOWLIST[id] !== undefined && !production.has(owner);
}

const blocking = [];
const allowed = [];

for (const [name, vuln] of Object.entries(vulnerabilities)) {
  if (!BLOCKING.has(vuln.severity)) continue;
  const advisories = rootAdvisories(name);
  const urls = [...new Set(advisories.map((advisory) => advisory.url))].join(', ');
  if (advisories.length > 0 && !production.has(name) && advisories.every(isAllowed)) {
    allowed.push(`${name} (${vuln.severity}): ${urls}`);
  } else {
    blocking.push(`${name} (${vuln.severity}) at ${vuln.nodes.join(', ')}: ${urls}`);
  }
}

for (const line of allowed) console.log(`allowlisted: ${line}`);
if (blocking.length > 0) {
  for (const line of blocking) console.error(`BLOCKING: ${line}`);
  process.exit(1);
}
console.log('audit: no blocking high/critical advisories');
