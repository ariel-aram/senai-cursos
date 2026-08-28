# Contributing to SENAI Course Intelligence

Welcome! This project aggregates, normalizes, and visualizes public course offerings across multiple Brazilian SENAI state federations. We welcome contributions from software engineers, data engineers, UX/UI designers, researchers, and enthusiasts.

---

## Before You Start

- Review existing [GitHub Issues](https://github.com/ariel-aram/senai-cursos/issues) and [Pull Requests](https://github.com/ariel-aram/senai-cursos/pulls) before starting substantial new work.
- Any change touching data ingestion must respect the upstream source it's fetching from (rate limits, caching, no bypassing access controls).
- Keep communication respectful and constructive.

---

## Development Environment Setup

### Prerequisites

- [Bun](https://bun.sh) (v1.1.0 or higher)
- Git

### Local Setup

```bash
git clone https://github.com/ariel-aram/senai-cursos.git
cd senai-cursos
bun install
cp config/config.example.ts config/config.ts
bun dev
```

The app is served at `http://localhost:3010`.

> **Storage note:** SurrealDB runs embedded via the RocksDB engine (`rocksdb://./data/senai.db` by default — see the comment in `config/config.example.ts` for why not SurrealKV on this stack). If the DB connection fails for any reason, the server keeps working from in-memory cache alone; persistence is a durability layer, not a hard dependency.

---

## Project Structure

```text
senai-cursos/
├── config/
│   └── config.example.ts       # Runtime configuration template — copy to config.ts
├── data/                       # Embedded SurrealDB files (local, gitignored)
├── src/
│   ├── adapters/                # One StateAdapter implementation per active state
│   │   ├── types.ts             # The StateAdapter interface every adapter implements
│   │   ├── registry.ts          # uf -> adapter map — the real "active vs coming-soon" source of truth
│   │   ├── futuro-digital.ts    # Shared VTEX-backend adapter factory (used by several states)
│   │   ├── keyed-cache.ts       # In-memory single-flight TTL cache used by every adapter
│   │   ├── http.ts              # Shared fetch/retry/concurrency helpers
│   │   └── <uf>.ts              # sp.ts, sc.ts, ma.ts, ... one file per state
│   ├── assets/                  # Flags, logos, and the Aero cursor pack (src/assets/cursors/)
│   ├── components/ui/           # Reusable UI primitives (Button, Card)
│   ├── lib/
│   │   ├── cursors.ts            # Custom Aero cursor system (.cur/.ani rendering, hue -> color mapping)
│   │   └── utils.ts              # cn() class-merging helper
│   ├── App.tsx                  # Main React frontend
│   ├── state-meta.ts            # Static per-state cosmetic data (name, logo, flag, hue) — browser-safe
│   ├── constants.ts             # Shared frontend/backend constants (default área slug/label)
│   ├── db.ts                    # SurrealDB connection, upserts, and queries
│   ├── frontend.tsx             # React client entry point
│   ├── index.html               # SPA HTML template
│   ├── index.ts                 # Bun server entry point — HTTP routes, warmup, proactive refresh
│   └── types.ts                 # Shared schema: Course, UnitInfo, Area, StateAdapter's return types
├── styles/globals.css           # Tailwind + the hand-written Frutiger Aero design layer
├── build.ts                     # Production frontend bundler
└── package.json                 # Scripts, dependencies, metadata
```

---

## Areas for Contribution

1. **New State Adapters:** The biggest lever for impact — see [Adding a State](README.md#adding-a-state) in the README. Every new adapter must be verified against the *real* live source (real products, real available turmas) before being wired into the active registry — a state that looks active but returns an empty catalog is worse than leaving it "coming soon".
2. **Bug Fixes:** Parsing errors, UI issues, edge cases in any adapter.
3. **Data Pipeline & Reliability:** Cache invalidation, concurrency tuning, resilience to upstream format changes.
4. **Frontend & UX:** Accessibility, responsive layout, the Frutiger Aero visual language (glass panels, cursor set, brand-hue theming).
5. **Documentation:** This file, the README, and code comments.

---

## Data Collection Guidelines

Every adapter fetches from a real, public upstream source. When touching adapter code:

- **Respect concurrency limits** (`config.catalogConcurrency`, `turmasConcurrency`, `warmupConcurrency`) — don't hammer a state's source.
- **Cache-first:** Always go through `KeyedAsyncCache` (`src/adapters/keyed-cache.ts`) or SurrealDB before a fresh network call.
- **Defensive parsing:** Upstream HTML/JSON shapes change without notice. Parsing must fail gracefully — no uncaught exceptions taking down a route.
- **Public data only.** Never attempt to bypass access controls or scrape non-public data.
- **Verify before activating:** Before adding a state to `ADAPTERS` in `src/adapters/registry.ts`, confirm real products *and* at least one real available turma exist at the source — not just that a page loads. See the comments at the top of any existing `<uf>.ts` adapter for the kind of verification expected.

---

## Development Workflow

### Branch Conventions

- `feature/<description>`
- `fix/<description>`
- `docs/<description>`
- `refactor/<description>`

### Commit Messages

We follow [Conventional Commits](https://www.conventionalcommits.org/):

- `feat: add SENAI-XX adapter`
- `fix: handle empty turma list in futuro-digital adapter`
- `docs: update adapter guide in CONTRIBUTING.md`
- `refactor: extract hue-to-color mapping into cursors.ts`
- `chore: bump ani-cursor version`

---

## Code Quality & Verification

Before opening a PR:

```bash
bun check      # Biome format + lint (autofix)
bun run tsc    # Type-check, no emit
bun run build  # Confirm production bundling still succeeds
```

### Testing Notice

The repository relies on static type-checking and manual runtime verification — there is no automated test suite yet (a welcome contribution area). When changing an adapter or route:

1. Hit the affected endpoints directly (`GET /api/units?uf=sp&area=tecnologia-da-informacao`, etc.) and check the shape/values look real.
2. Exercise the UI change in both desktop and mobile viewports.
3. For a new/changed adapter, confirm against the real upstream source, not just that the request doesn't throw.

---

## Pull Request Checklist

1. **Title:** Clear, imperative, conventional-commit style.
2. **Context:** Why this change, what problem it solves.
3. **Implementation:** Key structural changes, especially for a new adapter (what backend, how verified).
4. **Verification:** What you actually checked (commands run, screenshots for UI changes).
5. **Quality gates:** `bun check` and `bun run tsc` pass clean.

---

## Code of Conduct

Contributors and maintainers are expected to keep interactions inclusive, professional, and respectful.

## License

By contributing, you agree your contributions are licensed under the [Apache License 2.0](LICENSE).
