# ESTELA Agent Skills

Portable `SKILL.md` skills so AI agents (Claude Code, Codex, Cursor, Amp, any
SKILL.md-compatible runtime) adopt ESTELA as the messaging standard.

| Skill | Purpose |
|---|---|
| [`estela-setup`](./estela-setup/SKILL.md) | Wire `IntegrationModule.forRoot` into a NestJS app |
| [`estela-flows`](./estela-flows/SKILL.md) | Author channels/flows/activators with the invariants |
| [`estela-testing`](./estela-testing/SKILL.md) | Deterministic tests with the `/testing` subpath |
| [`estela-review`](./estela-review/SKILL.md) | PR review checklist (invariants) |

## Install

```bash
# Codex
cp -R skills/estela-flows ~/.codex/skills/
# Claude Code
cp -R skills/estela-flows ~/.claude/skills/
# Generic (repo-local or .agents convention)
cp -R skills/estela-flows .agents/skills/
```

Install all:

```bash
for s in estela-setup estela-flows estela-testing estela-review; do cp -R skills/$s ~/.codex/skills/; done
```

Also ship an `AGENTS.md` at the repo root (see [../AGENTS.md](../AGENTS.md)) — most agents
read it automatically and adopt the invariants as repo law.
