# AGENTS.md — ESTELA repo rules for AI agents (Claude · Codex · Cursor · any)

## Commands

- `npm run verify` — typecheck → eslint (type-checked + sonarjs + security) → prettier → build
  (ESM+CJS+d.ts) → jest → dependency-cruiser → madge (circular) + jscpd (clones) → npm audit.
  **MUST pass before you finish any task.**
- The e2e HTTP test (`test/orders.e2e.spec.ts`) binds a loopback socket: run it with network permissions.
- The Postgres saga e2e (`test/saga-postgres.e2e.spec.ts`) is **skipped unless `ESTELA_PG_URL` is
  set** (CI does not set it). Local target: `ESTELA_PG_URL=postgres://postgres:estela@localhost:55433/estela npx jest test/saga-postgres`.
  Run it whenever you touch `src/saga/postgres/` and paste the result in the PR.
- `test/dist-*.spec.ts` check the built package (`dist/`) and are skipped when it is absent: run
  `npm run build` first (`npm run verify` already builds before it tests).

## Non-negotiable runtime invariants (SPEC §17 · PLAN §8)

1. Flows reference channels **by name only** — never import business classes.
2. `replyChannel` precedence per hop — every step passes `reply` **explicitly** to `nextHop`:
   `wireTap/fanout/publish → 'none'` · `to/route → 'inherit'` · `jump → its own ephemeral 'reply.<uuid>'`
   (the parent keeps the inbound reply untouched).
3. Awaited failures (direct send, fanout `wait:true`, jump timeout, `publish`, `to`) report to
   `error.channel` **and** fail the flow. Forget (`wait:false`) never crashes the flow.
   `wireTap` swallows all errors, always.
4. Ephemeral reply channels are unregistered in `finally` — `registry.list()` must return to baseline.
5. `direct` channel = one subscriber (last wins, warn on replace). For N consumers use `queue`/`pubsub`.
6. A direct channel must not be both an activator target and another flow's source —
   forward via the activator (see example: `orders.persist → orders.country`).
7. Dispatchers rebuild the ALS context from `msg.headers` at every dispatch — never trust ambient
   context across `setImmediate`/buffers/EventEmitter listeners.
8. Fanout bindings run the cycle guard: repeated channel in `history` or depth > 50 → `FanoutCycleError`.

## Layer boundaries (enforced by dependency-cruiser)

- `src/message.ts`, `src/channel.ts`, `src/flow/flow-step.ts` (domain): **zero npm imports**.
- Barrel `src/index.ts`: never imports `amqplib` or `@grpc/grpc-js` (transitively).
- `src/testing/`: never imports `src/inbound/` or `src/adapters/`.
- Optional peers (`amqplib`, `@grpc/grpc-js`, `@nestjs/graphql`) live only in `inbound/` and `adapters/`.
- `src/saga/postgres/` (`saga-postgres-no-npm`): **zero npm imports** — the Postgres saga adapters
  take a query function from the app, so the main barrel can export them.
- `src/` (`src-no-pg`): never imports `pg`, `pg-*` or `@types/pg`; `pg` is a devDependency for the
  `ESTELA_PG_URL`-gated e2e only.

## Adding features (OCP)

- New channel kind → new `ChannelFactory` registered in `ChannelFactoryRegistry` (never a switch).
- New inbound transport → `InboundTransportStrategy` + `HeaderMapper`.
- New flow step → `FlowStep` class + builder method + `describe()` (graph) + tests.
- New idempotency backend → `IdempotencyStore` implementation (see README Redis contract).
- New saga lock backend → `LockPort` implementation (reference: `postgresAdvisoryLockPort`).
- New saga CAS / state-transition backend → `TransitionPort` implementation (reference:
  `postgresTransitionPort`).
- New saga idempotency ledger → `IdempotencyLedger` implementation; declare `transactional`
  (`false` = the runner releases claims on rollback and rejects it with a retry policy — test-only).

## Testing rules

- Every invariant gets a test. Use `@estela/nest/testing` helpers:
  `bindFlow` · `waitFor` · `collect` · `createTestMessage` · `MemoryIdempotencyStore` ·
  `MemoryLockPort` · `MemoryTransitionPort` · `testUnitOfWork` (saga concurrency, no database).
- Test files: `*.spec.ts` under `src/` or `test/` (jest roots).
- Handlers subscribed to awaited channels must return their promise (never `void p`) —
  producers of `direct` channels wait for full execution (spec §17.3).

## Pull requests

Every change reaches `main` through a PR. `main` is the only release branch (`.releaserc.json`):
semantic-release reads the commits that land on it, so the branch name, the commit types and the
merge strategy below are release mechanics, not style.

### Branch

- `<type>/<TICKET>-<slug>` — `type ∈ feat | fix | chore | docs | refactor | test`, lowercase, no
  other prefixes (`feature/` is not valid). Example: `feat/SPI-188-saga-concurrency`.
- The ticket key is mandatory: `SPI-xxx` (DyDD Jira) or `TM-xxxx` when the work originates in
  AssureHub. No ticket → no branch; open the ticket first.

### Commits

- Conventional commits: `type(scope): subject`. Type and scope in English; the subject may be in
  Spanish. One topic per commit — split unrelated changes, do not pile them into one.
- Release impact (default `commit-analyzer` rules — `.releaserc.json` sets no preset):
  `feat` → minor · `fix` / `perf` → patch · `BREAKING CHANGE:` footer → major ·
  `chore` / `docs` / `refactor` / `test` / `ci` / `style` / `build` → no release.
  Do not label a behaviour change `chore` or `refactor` to dodge a release, and do not label a
  docs-only change `feat` to force one.
- **Never bump `version` in `package.json` (or `package-lock.json`) by hand.** semantic-release
  owns it and commits it as `chore(release): x.y.z [skip ci]`. A manual bump makes the next release
  compute from a wrong base and breaks the `publish.yml` tag guard.

### Merge strategy: squash, PR title = the conventional header

- **Squash-merge only.** It is what the history already uses (`#1`–`#8`) and what makes the release
  predictable: one PR → one commit on `main` → one, deliberate release decision. A merge commit
  would hand semantic-release every WIP commit in the branch (`feat` + `fix` + `fixup`) and the bump
  would depend on branch hygiene instead of on the PR title; rebase-merge has the same problem.
- The squash commit title is the **PR title** (GitHub uses the sole commit's title when the PR has
  exactly one commit). Write the PR title as the conventional header you want on `main`, e.g.
  `fix(reply): release reply/jump timeouts when the send fails`, and check the final message in the
  merge dialog before confirming.
- The squash body is the concatenated commit messages. Keep it: a `BREAKING CHANGE:` footer written
  in any commit survives into the squash body, which is how a major is detected (see below).

### Breaking changes

- Mark them with a `BREAKING CHANGE: <what changed, why, how to migrate>` footer — in the squash
  body or in at least one commit of the PR. That footer is the **only** marker the current
  configuration honours: the angular preset has no `breakingHeaderPattern`, so a `feat!:` header does
  not even parse as `feat` and releases nothing. `!` is fine for readability, never alone.
- A breaking change is anything that alters a public export of `@estela/nest` or
  `@estela/nest/testing`, a port/interface a consumer implements (`IdempotencyStore`, `LockPort`,
  `TransitionPort`, `ChannelFactory`, `InboundTransportStrategy`, …), a header or reply-channel
  contract, or a runtime invariant from §"Non-negotiable". Consumers (spine, ms-bpm) install from
  the GitHub Release tarball, so the migration note in the footer is their only upgrade guide — say
  which call sites change and how. Prefer an additive path (new option, deprecation warning) over a
  break when one exists.

### PR description

Use `.github/pull_request_template.md`; every heading stays, even as "n/a":
**Scope** · **Design decisions** · **How it was tested** (`npm run verify` output; the Postgres e2e
with `ESTELA_PG_URL`, or state that it was not run; anything else that could not run) ·
**Docs updated** (`AGENTS.md`, `docs/`, `skills/`) · **What remains** (follow-up tickets) ·
**Dependencies added** (any change to `package.json` dependencies, peers, overrides — declare it
even when it is dev-only; "no new dependencies" otherwise). A description that contradicts the diff
is a blocker.

### Required checks and review

- Before marking the PR ready: `npm run verify` green locally, and all CI jobs green — `lint +
  format`, `test + build` (node 20 and 22), `complexity + clones + circular`, `example app`,
  `vulnerabilities + lockfile`, CodeQL, Dependency Review. Never merge on red or with a skipped job.
- `npm run comments:en` must pass on every file the PR touches, even though CI still runs it with
  `continue-on-error` (advisory until the 183 legacy comments are translated). Removing
  `continue-on-error` is a follow-up, not part of a feature PR.
- The Postgres e2e (`test/saga-postgres.e2e.spec.ts`) is skipped without `ESTELA_PG_URL` and CI
  does not set it: run it locally against the documented local target when the PR touches
  `src/saga/postgres/` and paste the result in **How it was tested**.
- `CODEOWNERS` has a single owner, so review cannot rest on it alone: get **at least one review from
  someone other than the author**. If no reviewer exists, the PR stays **ready for review for 24 h**
  and the author posts a documented self-review (what was re-read, what was re-run, what was
  found) before merging. No silent self-merge: merging a ready PR that has neither is a process
  violation, regardless of green CI.

### Language and attribution

- Code, comments, identifiers, test prose (`describe`/`it`) and docs under `docs/` in **English
  only**. Commit subjects and PR descriptions may be in Spanish.
- **No AI/tool attribution** in commits or PR bodies: no `Co-Authored-By:` for agents, no
  "Generated with …", no session links or ids. If one slipped in, amend the commit / `gh pr edit
  --body` before review.

### Keep AGENTS.md true

When you add or change a layer boundary (dependency-cruiser rule), a port or interface a consumer
implements, a `src/testing/` helper, an env-gated or build-dependent test, or a `npm` script, update
the matching AGENTS.md section **in the same PR**. A PR that makes AGENTS.md stale is incomplete.
