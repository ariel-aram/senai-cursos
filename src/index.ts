import { serve } from "bun";
import { config } from "../config/config";
import { withConcurrency } from "./adapters/http";
import { getAdapter, STATES } from "./adapters/registry";
import { DEFAULT_AREA_SLUG } from "./constants";
import { connectDb, dbDeleteStaleCourses, dbGetAllUnits } from "./db";
import index from "./index.html";

export type { Area, Course, CoursesData, Schedule, StateCode, StateInfo, UnitInfo } from "./types";

function ufFromRequest(req: Request, fallback = "sp"): string {
	return new URL(req.url).searchParams.get("uf") ?? fallback;
}

function unitIdFromRequest(req: Request): number {
	return parseInt(new URL(req.url).searchParams.get("unit") ?? String(config.defaultUnitId), 10);
}

function areaFromRequest(req: Request): string {
	return new URL(req.url).searchParams.get("area") ?? DEFAULT_AREA_SLUG;
}

// ── L1 response cache ────────────────────────────────────────────────────────
// Short-lived in-memory cache for API GET responses. Coalesces concurrent
// identical requests (e.g., multiple clients polling the same unit) into one
// upstream scrape, eliminating redundant work during traffic spikes.
const L1_TTL_MS = 5_000;
const l1Cache = new Map<string, { body: string; status: number; ts: number }>();

function l1Get(key: string): { body: string; status: number } | null {
	const entry = l1Cache.get(key);
	if (!entry) return null;
	if (Date.now() - entry.ts > L1_TTL_MS) {
		l1Cache.delete(key);
		return null;
	}
	return { body: entry.body, status: entry.status };
}

function l1Set(key: string, body: string, status: number): void {
	l1Cache.set(key, { body, status, ts: Date.now() });
	if (l1Cache.size > 500) {
		const oldest = [...l1Cache.entries()].sort((a, b) => a[1].ts - b[1].ts)[0];
		if (oldest) l1Cache.delete(oldest[0]);
	}
}

function l1Key(req: Request): string | null {
	if (req.method !== "GET") return null;
	const url = new URL(req.url);
	if (!url.pathname.startsWith("/api/")) return null;
	return `${url.pathname}?${url.searchParams.toString()}`;
}

function jsonResponse(data: unknown, cacheControl: string, status = 200): Response {
	return new Response(JSON.stringify(data), {
		status,
		headers: {
			"Content-Type": "application/json",
			"Cache-Control": cacheControl,
		},
	});
}

const server = serve({
	port: config.port,
	hostname: config.host,
	// Bun.serve's default idleTimeout is 10s — too short for a cold-cache request
	// that has to build a whole state's catalog from scratch (TO's ~32-área build
	// alone can take well over a minute; confirmed in practice: the connection was
	// getting dropped with an empty response mid-build, not because the build
	// failed). Only the FIRST request per (uf, área) after a catalogTtl expiry
	// pays this cost — everything after is served from cache almost instantly.
	idleTimeout: 180,
	routes: {
		"/*": index,

		"/api/states": {
			GET() {
				// logo/flag/hue are omitted: outside the frontend's bundler context these
				// asset imports resolve to raw local filesystem paths, not public URLs.
				// The frontend already has that cosmetic data locally (see state-meta.ts)
				// and only reads status/sourceLabel from this endpoint.
				const publicStates = STATES.map(({ uf, name, sourceLabel, status }) => ({
					uf,
					name,
					sourceLabel,
					status,
				}));
				return Response.json(publicStates, {
					headers: { "Cache-Control": "public, max-age=3600" },
				});
			},
		},

		"/api/units": {
			async GET(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					const [units, catalogUnitIds] = await Promise.all([
						adapter.getUnits(),
						adapter.getCatalogUnitIds(areaFromRequest(req)),
					]);
					const catalogSet = new Set(catalogUnitIds);
					const filtered = units.filter((u) => catalogSet.has(u.id));
					return Response.json(filtered, {
						headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar unidades" }, { status: 500 });
				}
			},
		},

		"/api/areas": {
			async GET(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					const areas = await adapter.getAreas();
					return Response.json(areas, {
						headers: { "Cache-Control": "public, max-age=300, stale-while-revalidate=600" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar áreas" }, { status: 500 });
				}
			},
		},

		"/api/config": {
			GET() {
				return Response.json(
					{
						defaultUnitId: config.defaultUnitId,
						refreshIntervalSeconds: config.refreshIntervalSeconds,
					},
					{
						headers: { "Cache-Control": "public, max-age=3600" },
					},
				);
			},
		},

		"/api/courses": {
			async GET(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					const data = await adapter.getUnitData(unitIdFromRequest(req), areaFromRequest(req));
					return Response.json(data, {
						headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar cursos" }, { status: 500 });
				}
			},
		},

		"/api/paid-courses": {
			async GET(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					const data = await adapter.getUnitPaidData(unitIdFromRequest(req), areaFromRequest(req));
					return Response.json(data, {
						headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar cursos pagos" }, { status: 500 });
				}
			},
		},

		"/api/courses/all": {
			async GET(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					const unitId = unitIdFromRequest(req);
					const area = areaFromRequest(req);
					const [free, paid] = await Promise.all([
						adapter.getUnitData(unitId, area),
						adapter.getUnitPaidData(unitId, area),
					]);
					return Response.json(
						{ free, paid },
						{
							headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
						},
					);
				} catch {
					return Response.json({ error: "Falha ao buscar cursos" }, { status: 500 });
				}
			},
		},

		"/api/refresh": {
			async POST(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					return Response.json(
						await adapter.getUnitData(unitIdFromRequest(req), areaFromRequest(req), true),
					);
				} catch {
					return Response.json({ error: "Falha ao atualizar cursos" }, { status: 500 });
				}
			},
		},

		"/api/paid-refresh": {
			async POST(req) {
				const adapter = getAdapter(ufFromRequest(req));
				if (!adapter) return Response.json({ error: "Estado indisponível" }, { status: 404 });
				try {
					return Response.json(
						await adapter.getUnitPaidData(unitIdFromRequest(req), areaFromRequest(req), true),
					);
				} catch {
					return Response.json({ error: "Falha ao atualizar cursos pagos" }, { status: 500 });
				}
			},
		},
	},

	development: process.env.NODE_ENV !== "production" && {
		hmr: true,
		console: true,
	},
});

console.log(`🚀 Servidor operando em ${server.url}`);

// ── Startup: DB + warmup (only for states with a live adapter) ────────────────

connectDb()
	.then(() => console.log("[db] pronto"))
	.catch(console.error);

for (const state of STATES) {
	if (state.status !== "active") continue;
	const adapter = getAdapter(state.uf);
	if (!adapter) continue;

	adapter
		.getUnits()
		.then(async (units) => {
			if (units.length === 0) {
				const dbUnits = await dbGetAllUnits(state.uf);
				console.log(`[${state.uf}] ${dbUnits.length} unidades pré-carregadas do banco`);
			}
		})
		.catch(console.error);

	// Only the default área (T.I.) is pre-warmed at startup — every other real
	// área a state exposes (see getAreas()) is fetched lazily on first request,
	// which keeps startup cost from scaling with a state's full category count.
	adapter
		.getCatalogUnitIds(DEFAULT_AREA_SLUG)
		.then(async (unitIds) => {
			console.log(`[${state.uf}] verificando ${unitIds.length} unidades…`);
			let done = 0;
			await withConcurrency(
				unitIds.map((uid) => async () => {
					await Promise.all([
						adapter.getUnitData(uid, DEFAULT_AREA_SLUG),
						adapter.getUnitPaidData(uid, DEFAULT_AREA_SLUG),
					]);
					done++;
					if (done % 10 === 0 || done === unitIds.length) {
						console.log(`[${state.uf}] ${done}/${unitIds.length} unidades carregadas`);
					}
				}),
				config.warmupConcurrency,
			);
			console.log(`[${state.uf}] todas as unidades carregadas ✓`);
		})
		.catch(console.error);
}

// ── Proactive refresh scheduler ──────────────────────────────────────────────
// Refreshes cached unit data BEFORE TTL expires so users never wait for a scrape.
// Runs every half-TTL; for each active state, re-fetches all catalog units with
// low concurrency (3) to avoid upstream spikes. Falls back gracefully on errors.

const REFRESH_INTERVAL_MS = Math.max(config.unitTtlMs / 2, 60_000);
const REFRESH_CONCURRENCY = 3;

function scheduleProactiveRefresh(): void {
	setInterval(async () => {
		for (const state of STATES) {
			if (state.status !== "active") continue;
			const adapter = getAdapter(state.uf);
			if (!adapter) continue;
			try {
				const unitIds = await adapter.getCatalogUnitIds(DEFAULT_AREA_SLUG);
				let done = 0;
				await withConcurrency(
					unitIds.map((uid) => async () => {
						await Promise.allSettled([
							adapter.getUnitData(uid, DEFAULT_AREA_SLUG, true),
							adapter.getUnitPaidData(uid, DEFAULT_AREA_SLUG, true),
						]);
						done++;
						if (done % 20 === 0 || done === unitIds.length) {
							console.log(`[${state.uf}] refresh proativo ${done}/${unitIds.length}`);
						}
					}),
					REFRESH_CONCURRENCY,
				);
				console.log(`[${state.uf}] refresh proativo concluído ✓`);
			} catch (err) {
				console.error(`[${state.uf}] erro no refresh proativo:`, err);
			}
		}
	}, REFRESH_INTERVAL_MS);
	console.log(`[scheduler] refresh proativo a cada ${Math.round(REFRESH_INTERVAL_MS / 1000)}s`);
}

// Start scheduler after initial warmup has had time to complete
setTimeout(scheduleProactiveRefresh, 60_000);

// ── Stale-data cleanup ───────────────────────────────────────────────────────
// See dbDeleteStaleCourses in db.ts — without this the course table only grows
// as adapters' catalogs rotate over time, across every state. A course not
// re-scraped in 7 days means it's genuinely gone from its source, not just
// unlucky timing (every adapter re-upserts its full catalog at least every
// catalogTtlMs, which defaults to 2h).
const STALE_COURSE_MAX_AGE_MS = 7 * 24 * 60 * 60 * 1000;
const CLEANUP_INTERVAL_MS = 24 * 60 * 60 * 1000;

function scheduleStaleCleanup(): void {
	setInterval(async () => {
		const deleted = await dbDeleteStaleCourses(STALE_COURSE_MAX_AGE_MS);
		if (deleted > 0) console.log(`[db] ${deleted} curso(s) obsoleto(s) removido(s)`);
	}, CLEANUP_INTERVAL_MS);
}

setTimeout(scheduleStaleCleanup, 5 * 60_000);
