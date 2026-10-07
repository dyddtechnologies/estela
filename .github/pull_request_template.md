<!-- Title = the conventional header that lands on main (squash-merge): type(scope): subject.
     Branch: <type>/<TICKET>-<slug> with SPI-xxx or TM-xxxx. See AGENTS.md → "Pull requests". -->

## Scope

<!-- What changes and why. Link the ticket (SPI-xxx / TM-xxxx). Out of scope, if ambiguous. -->

## Design decisions

<!-- Alternatives considered, invariants touched (AGENTS.md §"Non-negotiable"), trade-offs. -->

## How it was tested

- [ ] `npm run verify` green locally (paste the summary)
- [ ] Postgres e2e (`ESTELA_PG_URL=... npx jest test/saga-postgres`) — ran / not run because: …
- [ ] `npm run comments:en` passes on every touched file
- Could not run: <!-- what and why, or "nothing" -->

## Docs updated

- [ ] `AGENTS.md` (boundary / port / testing helper / env-gated test / script changed → section updated)
- [ ] `docs/`
- [ ] `skills/`
- [ ] n/a — nothing to update

## What remains

<!-- Follow-up tickets, known gaps, TODOs deliberately left out. -->

## Dependencies added

<!-- Every change to package.json dependencies / devDependencies / peers / overrides, with the reason.
     Write "no new dependencies" otherwise. -->

## Breaking changes

<!-- "none", or the exact `BREAKING CHANGE:` footer (what / why / migration for spine, ms-bpm). -->
