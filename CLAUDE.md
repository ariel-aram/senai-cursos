# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
bun install                  # deps
cp config/config.example.ts config/config.ts   # required before first run
bun dev                      # dev server, HMR, http://localhost:3010
bun start                    # prod (NODE_ENV=production)
bun run build                # bundle client to dist/
bun check                    # biome format+lint, autofix
bun run lint                 # biome check, no autofix
bun run tsc                  # typecheck, no emit
bun run ci                   # prepare-config + lint + tsc + build (what CI runs)
```

No automated test suite. Verify adapter/route changes by hitting endpoints directly (e.g. `GET /api/units?uf=sp&area=tecnologia-da-informacao`) and checking real data, plus exercising UI changes in desktop+mobile viewports. Bun dev server has recurring HMR staleness on CSS/asset changes — if edits don't show, fully stop/restart the server (not just reload the page).

## Architecture

Single Bun process (`src/index.ts`) serves both REST API and prebuilt React 19 SPA via one `Bun.serve()`.

**Adapters (`src/adapters/*.ts`)** — one per active state, all implementing `StateAdapter` (`src/adapters/types.ts`: `getUnits`/`getAreas`/`getCatalogUnitIds`/`getUnitData`/`getUnitPaidData`). Two shapes:
- Bespoke scrapers: SP, SC.
- Shared VTEX backend: `createFuturoDigitalAdapter(uf, "UF|")` in `src/adapters/futuro-digital.ts` — many states share one VTEX storefront account (`tewbhv.vtexcommercestable.com.br`, cluster 137) and are distinguished only by a `"UF|"` prefix on `productReferenceCode`.

`src/adapters/registry.ts`'s `ADAPTERS` map is the real source of truth for active-vs-coming-soon (checked against `state-meta.ts`'s `KNOWN_ACTIVE` hint at dev startup). A state with metadata but no registry entry auto-renders as "coming soon" — no other wiring needed.

**Critical invariant**: a state is only wired into `ADAPTERS` after confirming real products **and** at least one offer with `IsAvailable: true` at the live source — not just that a page/endpoint loads. A state with a cluster entry but zero available turmas is worse than leaving it "coming soon." See any existing `<uf>.ts` adapter's header comment for the verification bar. (Several Brazilian states — AC, AM, AP, BA, PB, RJ, RR, SE — were investigated and rejected on this basis; see plan history if reconsidering one.)

**Cache & persistence** — `KeyedAsyncCache` (`src/adapters/keyed-cache.ts`) does in-memory single-flight TTL caching per (state, área) and deliberately does not cache an empty result as if it were real zero-courses (treats it as likely transient failure). `src/db.ts` persists last-known-good `Course`/`UnitInfo` rows to embedded SurrealDB (RocksDB engine — see comment in `config/config.example.ts` for why not SurrealKV) so cold starts still have data while cache rewarms; if the DB connection fails, the server keeps running from in-memory cache alone. `src/index.ts` also layers a 5s L1 response cache in front of every `/api/*` GET, and runs background warmup + proactive refresh (re-fetches before TTL expiry) for every active state's default área.

**Client (`src/App.tsx`, `src/frontend.tsx`, `styles/globals.css`)** — single-page React 19 app: state/area/unit selectors, free/paid course bars, Frutiger Aero glass theme (translucent glass cards, specular highlights) driven by a single `--brand-hue` CSS custom property per selected state, registered via `@property` so hue changes transition smoothly instead of snapping. Real Windows `.cur`/`.ani` cursor files are decoded and rendered as native-looking browser cursors via `ani-cursor` (`src/lib/cursors.ts`), recolored per state and swapped by context (default/busy/unavailable/working).

**Shared schema**: `src/types.ts` (`Course`, `UnitInfo`, `Area`, `StateAdapter` return shapes) and `src/state-meta.ts` (browser-safe static per-state cosmetics: name, logo, flag, hue, `sourceLabel`, `STATE_ORDER`, `KNOWN_ACTIVE`).

## Adding a state

1. Determine if it's the shared VTEX backend (check for `"UF|"` prefix on `productReferenceCode` at the `tewbhv` account) or bespoke.
2. VTEX case: add `src/adapters/<uf>.ts` calling `createFuturoDigitalAdapter(uf, "UF|")`. Bespoke: full `StateAdapter` impl.
3. Register in `src/adapters/registry.ts`'s `ADAPTERS`.
4. Add cosmetics to `src/state-meta.ts` and the uf to `KNOWN_ACTIVE`.
5. Verify real products + real available turma before step 3, not after.

## Config

`config/config.ts` (gitignored, copy from `config/config.example.ts`) — every field also settable via env var: server port/host, SurrealDB path, catalog/unit cache TTLs, fetch timeout/retries, concurrency limits (`catalogConcurrency`, `turmasConcurrency`, `warmupConcurrency` — respect these, don't hammer upstream sources), default unit, refresh interval.
