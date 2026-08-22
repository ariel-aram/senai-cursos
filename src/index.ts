import { serve } from "bun";
import { config } from "../config/config";
import {
	connectDb,
	dbGetAllUnits,
	dbGetCourses,
	dbGetScrapedAt,
	dbUpsertCourses,
	dbUpsertUnit,
} from "./db";
import index from "./index.html";

export type { Course, CoursesData, Schedule, UnitInfo } from "./types";

import type { Course, CoursesData, UnitInfo } from "./types";

const SENAI_BASE = "https://www.sp.senai.br";

// ── Catalog: (course × unit) pairs from listing pages ───────────────────────
interface CatalogEntry {
	name: string;
	slug: string;
	courseId: number;
	hours: number;
	unitId: number;
	isBolsa: boolean;
}

const catalogUnitNames = new Map<number, string>();
let catalogCache: { entries: CatalogEntry[]; updatedAt: number } | null = null;
let catalogPending: Promise<{ entries: CatalogEntry[]; updatedAt: number }> | null = null;

// ── Per-unit caches ──────────────────────────────────────────────────────────
const unitDataCache = new Map<number, { data: CoursesData; updatedAt: number }>();
const unitDataPending = new Map<number, Promise<CoursesData>>();
const unitPaidDataCache = new Map<number, { data: CoursesData; updatedAt: number }>();
const unitPaidDataPending = new Map<number, Promise<CoursesData>>();

// ── Unit registry ────────────────────────────────────────────────────────────
let unitsRegistry: UnitInfo[] | null = null;
let unitsRegistryPending: Promise<UnitInfo[]> | null = null;

// ── Core helpers ─────────────────────────────────────────────────────────────

function decodeEntities(str: string): string {
	return str
		.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/<[^>]+>/g, "")
		.trim();
}

// Run up to `limit` tasks at once; returns results in input order.
async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let idx = 0;
	async function worker() {
		while (idx < tasks.length) {
			const i = idx++;
			const task = tasks[i];
			if (task) results[i] = await task();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

// Retry an async task up to `retries` times with exponential backoff.
async function withRetry<T>(fn: () => Promise<T>, retries = config.maxRetries): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt < retries) await Bun.sleep(300 * 2 ** attempt);
		}
	}
	throw lastErr;
}

async function get(url: string, timeoutMs = config.fetchTimeoutMs): Promise<string> {
	return withRetry(async () => {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; SENAI-Monitor)" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? res.text() : "";
	}).catch(() => "");
}

// ── Units registry ────────────────────────────────────────────────────────────

// Strips accents, "senai", punctuation → plain lowercase for name matching.
function normalizeForMatch(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/\bsenai\b/g, "")
		.replace(/[-–—·#]/g, " ")
		.replace(/[^a-z0-9 ]/g, "")
		.replace(/\s+/g, " ")
		.trim();
}

async function scrapeUnits(): Promise<UnitInfo[]> {
	const html = await get(`${SENAI_BASE}/unidades`);
	if (!html) return [];
	const units: UnitInfo[] = [];
	const seen = new Set<number>();
	const emailRegex = /secretaria(\d+)@sp\.senai\.br/gi;
	for (const match of html.matchAll(emailRegex)) {
		const id = parseInt(match[1] ?? "", 10);
		if (!id || seen.has(id)) continue;
		seen.add(id);
		const pos = match.index ?? 0;
		const before = html.slice(Math.max(0, pos - 4000), pos);
		const headingPattern = /<h[1-4][^>]*>\s*([^<]{3,100}?)\s*<\/h[1-4]>/gi;
		let closestName = "";
		let lastIdx = -1;
		for (const h of before.matchAll(headingPattern)) {
			if ((h.index ?? 0) > lastIdx) {
				lastIdx = h.index ?? 0;
				closestName = h[1] ?? "";
			}
		}
		if (!closestName) {
			const afterMatch = headingPattern.exec(html.slice(pos, Math.min(html.length, pos + 1000)));
			if (afterMatch) closestName = afterMatch[1] ?? "";
		}
		const name = closestName ? decodeEntities(closestName) : `Unidade ${id}`;
		units.push({ id, name });
	}
	return units.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

async function getUnits(): Promise<UnitInfo[]> {
	if (unitsRegistry) return unitsRegistry;
	if (unitsRegistryPending) return unitsRegistryPending;
	unitsRegistryPending = Promise.all([getCatalog(), scrapeUnits()])
		.then(([, scraped]) => {
			const units: UnitInfo[] = [];
			const seen = new Set<number>();
			for (const [id, name] of catalogUnitNames) {
				units.push({ id, name });
				seen.add(id);
			}
			for (const u of scraped) {
				if (!seen.has(u.id)) {
					units.push(u);
					seen.add(u.id);
				}
			}
			units.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));

			// Map normalized scraped name → official ID (email-based, e.g. secretaria499@)
			const officialByNorm = new Map<string, number>();
			for (const u of scraped) {
				const norm = normalizeForMatch(u.name);
				if (norm) officialByNorm.set(norm, u.id);
			}

			// Assign officialId to catalog-based units by name match.
			// Catalog names are "City - Neighborhood"; scraped names are often just "City".
			// We pick the longest scraped name that is a word-boundary prefix of the catalog name.
			for (const u of units) {
				if (u.officialId) continue;
				const norm = normalizeForMatch(u.name);
				let best: { len: number; id: number } | null = null;
				for (const [sNorm, sid] of officialByNorm) {
					if (norm === sNorm || norm.startsWith(`${sNorm} `)) {
						if (!best || sNorm.length > best.len) best = { len: sNorm.length, id: sid };
					}
				}
				if (best) u.officialId = best.id;
			}

			// Disambiguate units that share the exact same name (multiple campi, same bairro).
			// Use the official ID in the suffix so users can cross-reference sp.senai.br/unidades.
			const nameCount = new Map<string, number>();
			for (const u of units) nameCount.set(u.name, (nameCount.get(u.name) ?? 0) + 1);
			for (const u of units) {
				if ((nameCount.get(u.name) ?? 0) > 1) u.name = `${u.name} · #${u.officialId ?? u.id}`;
			}

			unitsRegistry = units;
			unitsRegistryPending = null;
			// Persist to DB for fast future startups
			for (const u of units) dbUpsertUnit(u).catch(() => {});
			return units;
		})
		.catch(() => {
			unitsRegistryPending = null;
			const fallback: UnitInfo[] = [
				{ id: 403, name: "Alumínio" },
				{ id: 499, name: "Mairinque" },
			];
			unitsRegistry = fallback;
			return fallback;
		});
	return unitsRegistryPending;
}

// ── Catalog: scrape all listing pages ────────────────────────────────────────

async function fetchPage(page: number): Promise<string> {
	return get(
		`${SENAI_BASE}/cursos/cursos-livres/tecnologia-da-informacao-e-informatica?pag=${page}`,
	);
}

async function detectTotalPages(): Promise<number> {
	// Binary-search for the last page that has content (openModalTurmas).
	let lo = 1;
	let hi = 25;
	let lastGood = 1;
	const hasContent = async (p: number) => (await fetchPage(p)).includes("openModalTurmas");
	while (lo <= hi) {
		const mid = (lo + hi) >> 1;
		if (await hasContent(mid)) {
			lastGood = mid;
			lo = mid + 1;
		} else {
			hi = mid - 1;
		}
	}
	return lastGood;
}

async function buildCatalog(): Promise<{ entries: CatalogEntry[]; updatedAt: number }> {
	const totalPages = await detectTotalPages();
	console.log(`[catalog] scraping ${totalPages} página(s)…`);

	const pages = await withConcurrency(
		Array.from({ length: totalPages }, (_, i) => () => fetchPage(i + 1)),
		config.catalogConcurrency,
	);

	const seen = new Set<string>();
	const entries: CatalogEntry[] = [];
	const regex = /openModalTurmas\('([^']+)',\s*'([^']+)',\s*(\d+),\s*(\d+),/g;

	for (const html of pages) {
		for (const match of html.matchAll(regex)) {
			const [, rawName, slug, courseIdStr, unitIdStr] = match;
			if (!rawName || !slug || !courseIdStr || !unitIdStr) continue;
			const courseId = parseInt(courseIdStr, 10);
			const unitId = parseInt(unitIdStr, 10);
			const key = `${courseId}-${unitId}`;
			if (seen.has(key)) continue;
			seen.add(key);

			const name = decodeEntities(rawName);

			const contextStart = Math.max(0, (match.index ?? 0) - 3000);
			const context = html.slice(contextStart, match.index);
			const cardTitleIdx = context.lastIndexOf('class="card-title"');
			const cardContext = cardTitleIdx >= 0 ? context.slice(cardTitleIdx) : context;
			const hoursMatch = cardContext.match(/<strong>(\d+) horas<\/strong>/);
			const hours = hoursMatch?.[1] ? parseInt(hoursMatch[1], 10) : 0;

			if (!catalogUnitNames.has(unitId)) {
				// Use cardContext (current card only) to avoid picking up names from adjacent cards
				const nameMatch = cardContext.match(/<strong>([^\d<][^<]*)<\/strong>\s*-\s*([^<\n\r(]+)/i);
				if (nameMatch) {
					const city = decodeEntities(nameMatch[1]?.trim() ?? "");
					const neighborhood = decodeEntities(nameMatch[2]?.trim() ?? "");
					const unitName = neighborhood ? `${city} - ${neighborhood}` : city;
					if (unitName.length >= 3) catalogUnitNames.set(unitId, unitName);
				}
			}

			const isBolsa = /bolsa/i.test(name);
			entries.push({ name, slug, courseId, hours, unitId, isBolsa });
		}
	}

	console.log(
		`[catalog] ${entries.length} entradas · ${new Set(entries.map((e) => e.courseId)).size} cursos · ${new Set(entries.map((e) => e.unitId)).size} unidades`,
	);
	return { entries, updatedAt: Date.now() };
}

async function getCatalog() {
	const isStale = !catalogCache || Date.now() - catalogCache.updatedAt > config.catalogTtlMs;
	if (!isStale && catalogCache) return catalogCache;
	if (catalogPending) return catalogPending;
	catalogPending = buildCatalog()
		.then((catalog) => {
			catalogCache = catalog;
			catalogPending = null;
			return catalog;
		})
		.catch((err) => {
			catalogPending = null;
			throw err;
		});
	return catalogPending;
}

// ── Turmas fetching ──────────────────────────────────────────────────────────

async function postTurmas(
	slug: string,
	courseId: number,
	unitId: number,
	bolsa: "0" | "1",
	gratuito: "0" | "1",
): Promise<string> {
	return withRetry(async () => {
		const params = new URLSearchParams({
			nomeCurso: slug,
			cursoId: String(courseId),
			escolaId: String(unitId),
			estrategia: "Presencial",
			bolsa,
			gratuito,
			turno: "0",
			pos: "0",
		});
		const res = await fetch(`${SENAI_BASE}/cursosturmas/`, {
			method: "POST",
			headers: {
				"User-Agent": "Mozilla/5.0",
				"X-Requested-With": "XMLHttpRequest",
				"Content-Type": "application/x-www-form-urlencoded",
			},
			body: params.toString(),
			signal: AbortSignal.timeout(config.fetchTimeoutMs),
		});
		return res.ok ? res.text() : "";
	}).catch(() => "");
}

function fetchTurmas(slug: string, courseId: number, unitId: number): Promise<string> {
	return postTurmas(slug, courseId, unitId, "1", "1");
}

function fetchTurmasPaid(slug: string, courseId: number, unitId: number): Promise<string> {
	return postTurmas(slug, courseId, unitId, "0", "0");
}

// ── HTML parsing ─────────────────────────────────────────────────────────────

function parseDateKey(dmy: string): number {
	const [d, m, y] = dmy.split("/");
	return parseInt(`${y}${m}${d}`, 10);
}

interface TurmasResult {
	totalVagas: number;
	turmaCount: number;
	startDates: string[];
	schedules: { periodo: string; horario: string }[];
	prices: string[];
}

function parseTurmasHtml(html: string): TurmasResult {
	let totalVagas = 0;
	let turmaCount = 0;
	const vagasRegex = /Vagas:\s*(?:<\/span>\s*)?(\d+)/g;
	for (const m of html.matchAll(vagasRegex)) {
		const count = m[1];
		if (!count) continue;
		totalVagas += parseInt(count, 10);
		turmaCount++;
	}

	const startDatesRaw = new Set<string>();
	const startDateRegex = /Início\s*<br\s*\/?>\s*<strong>\s*(\d{2}\/\d{2}\/\d{4})\s*<\/strong>/g;
	for (const m of html.matchAll(startDateRegex)) {
		if (m[1]) startDatesRaw.add(m[1]);
	}
	const startDates = [...startDatesRaw].sort((a, b) => parseDateKey(a) - parseDateKey(b));

	const schedulesMap = new Map<string, { periodo: string; horario: string }>();
	const scheduleRegex =
		/Hor[aá]rio<\/strong>(?:<\/div>\s*)+<div[^>]*>\s*<div[^>]*>\s*([\s\S]*?)\s*<\/div>\s*<div[^>]*>\s*([\s\S]*?)\s*<\/div>/gi;
	for (const m of html.matchAll(scheduleRegex)) {
		const periodo = decodeEntities(m[1] ?? "").trim();
		const horario = decodeEntities(m[2] ?? "").trim();
		if (!periodo || !horario) continue;
		const key = `${periodo}|${horario}`;
		if (!schedulesMap.has(key)) schedulesMap.set(key, { periodo, horario });
	}
	const schedules = [...schedulesMap.values()];

	const pricesRaw = new Set<string>();
	const priceRegex = /Investimento[\s\S]{0,150}?<strong>\s*(R\$\s*[\d.,]+)\s*<\/strong>/gi;
	for (const m of html.matchAll(priceRegex)) {
		if (m[1]) pricesRaw.add(m[1].replace(/[\s ]+/g, " ").trim());
	}
	const prices = [...pricesRaw].sort((a, b) => {
		const toNum = (s: string) => parseFloat(s.replace(/[^\d,]/g, "").replace(",", "."));
		return toNum(a) - toNum(b);
	});

	return { totalVagas, turmaCount, startDates, schedules, prices };
}

// ── Unit data scraping ────────────────────────────────────────────────────────

async function scrapeUnitData(unitId: number): Promise<CoursesData> {
	const catalog = await getCatalog();
	const unitEntries = catalog.entries.filter((e) => e.unitId === unitId);

	const courses = await withConcurrency(
		unitEntries.map((entry) => async (): Promise<Course> => {
			const html = await fetchTurmas(entry.slug, entry.courseId, unitId);
			const { totalVagas, turmaCount, startDates, schedules } = parseTurmasHtml(html);
			return {
				name: entry.name,
				slug: entry.slug,
				id: entry.courseId,
				hours: entry.hours,
				vagas: totalVagas,
				turmas: turmaCount,
				startDates,
				schedules,
				prices: [],
				isBolsa: entry.isBolsa,
			};
		}),
		config.turmasConcurrency,
	);

	courses.sort((a, b) => b.vagas - a.vagas || a.name.localeCompare(b.name, "pt-BR"));

	// Persist asynchronously — does not block the response
	dbUpsertCourses(unitId, courses, false).catch(() => {});

	return { courses, lastUpdated: new Date().toISOString() };
}

async function scrapeUnitPaidData(unitId: number): Promise<CoursesData> {
	const catalog = await getCatalog();
	// BOLSA courses are always free scholarships — the SENAI API returns turma data for them
	// even under bolsa=0/gratuito=0, but never prices. Skip them to avoid false positives
	// and to save unnecessary HTTP requests.
	const unitEntries = catalog.entries.filter((e) => e.unitId === unitId && !e.isBolsa);

	const courses = await withConcurrency(
		unitEntries.map((entry) => async (): Promise<Course> => {
			const html = await fetchTurmasPaid(entry.slug, entry.courseId, unitId);
			const { totalVagas, turmaCount, startDates, schedules, prices } = parseTurmasHtml(html);
			return {
				name: entry.name,
				slug: entry.slug,
				id: entry.courseId,
				hours: entry.hours,
				vagas: totalVagas,
				turmas: turmaCount,
				startDates,
				schedules,
				prices,
				isBolsa: false,
			};
		}),
		config.turmasConcurrency,
	);

	// prices.length > 0 is the authoritative signal that a course is truly paid.
	// Free courses queried under bolsa=0/gratuito=0 return turmas but never prices.
	const paidOnly = courses.filter((c) => c.prices.length > 0);
	paidOnly.sort((a, b) => b.vagas - a.vagas || a.name.localeCompare(b.name, "pt-BR"));

	// Persist asynchronously — does not block the response
	dbUpsertCourses(unitId, paidOnly, true).catch(() => {});

	return { courses: paidOnly, lastUpdated: new Date().toISOString() };
}

// ── Cache + DB layer ──────────────────────────────────────────────────────────

async function getUnitData(unitId: number, force = false): Promise<CoursesData> {
	const cached = unitDataCache.get(unitId);
	const isStale = !cached || Date.now() - cached.updatedAt > config.unitTtlMs;
	if (!force && !isStale && cached) return cached.data;

	const pending = unitDataPending.get(unitId);
	if (pending) return pending;

	// DB fast path: serve from persisted data if still fresh
	if (!force) {
		const dbTs = await dbGetScrapedAt(unitId, false);
		if (dbTs !== null && Date.now() - dbTs < config.unitTtlMs) {
			const dbData = await dbGetCourses(unitId, false);
			if (dbData) {
				unitDataCache.set(unitId, { data: dbData, updatedAt: dbTs });
				return dbData;
			}
		}
		// Re-check: another request may have started scraping during the DB await
		const rePending = unitDataPending.get(unitId);
		if (rePending) return rePending;
	}

	const promise = scrapeUnitData(unitId)
		.then((data) => {
			unitDataCache.set(unitId, { data, updatedAt: Date.now() });
			unitDataPending.delete(unitId);
			return data;
		})
		.catch(async (err) => {
			unitDataPending.delete(unitId);
			// On scrape failure, fall back to whatever the DB has (even if stale)
			const stale = await dbGetCourses(unitId, false);
			if (stale) {
				// Mark as slightly-stale so it re-scrapes within 1 min
				unitDataCache.set(unitId, {
					data: stale,
					updatedAt: Date.now() - config.unitTtlMs + 60_000,
				});
				return stale;
			}
			throw err;
		});
	unitDataPending.set(unitId, promise);
	return promise;
}

async function getUnitPaidData(unitId: number, force = false): Promise<CoursesData> {
	const cached = unitPaidDataCache.get(unitId);
	const isStale = !cached || Date.now() - cached.updatedAt > config.unitTtlMs;
	if (!force && !isStale && cached) return cached.data;

	const pending = unitPaidDataPending.get(unitId);
	if (pending) return pending;

	// DB fast path
	if (!force) {
		const dbTs = await dbGetScrapedAt(unitId, true);
		if (dbTs !== null && Date.now() - dbTs < config.unitTtlMs) {
			const dbData = await dbGetCourses(unitId, true);
			if (dbData) {
				unitPaidDataCache.set(unitId, { data: dbData, updatedAt: dbTs });
				return dbData;
			}
		}
		const rePending = unitPaidDataPending.get(unitId);
		if (rePending) return rePending;
	}

	const promise = scrapeUnitPaidData(unitId)
		.then((data) => {
			unitPaidDataCache.set(unitId, { data, updatedAt: Date.now() });
			unitPaidDataPending.delete(unitId);
			return data;
		})
		.catch(async (err) => {
			unitPaidDataPending.delete(unitId);
			const stale = await dbGetCourses(unitId, true);
			if (stale) {
				unitPaidDataCache.set(unitId, {
					data: stale,
					updatedAt: Date.now() - config.unitTtlMs + 60_000,
				});
				return stale;
			}
			throw err;
		});
	unitPaidDataPending.set(unitId, promise);
	return promise;
}

// ── Server ───────────────────────────────────────────────────────────────────

const server = serve({
	port: config.port,
	hostname: config.host,
	routes: {
		"/*": index,

		"/api/units": {
			async GET() {
				try {
					const [units, catalog] = await Promise.all([getUnits(), getCatalog()]);
					const catalogUnitIds = new Set(catalog.entries.map((e) => e.unitId));
					const filtered = units.filter((u) => catalogUnitIds.has(u.id));
					return Response.json(filtered, {
						headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar unidades" }, { status: 500 });
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
			async GET(req: Request) {
				try {
					const unitId = parseInt(
						new URL(req.url).searchParams.get("unit") ?? String(config.defaultUnitId),
						10,
					);
					const cached = unitDataCache.get(unitId);
					let data: CoursesData;
					if (cached) {
						if (Date.now() - cached.updatedAt > config.unitTtlMs) getUnitData(unitId);
						data = cached.data;
					} else {
						data = await getUnitData(unitId);
					}
					return Response.json(data, {
						headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar cursos" }, { status: 500 });
				}
			},
		},

		"/api/paid-courses": {
			async GET(req: Request) {
				try {
					const unitId = parseInt(
						new URL(req.url).searchParams.get("unit") ?? String(config.defaultUnitId),
						10,
					);
					const cached = unitPaidDataCache.get(unitId);
					let data: CoursesData;
					if (cached) {
						if (Date.now() - cached.updatedAt > config.unitTtlMs) getUnitPaidData(unitId);
						data = cached.data;
					} else {
						data = await getUnitPaidData(unitId);
					}
					return Response.json(data, {
						headers: { "Cache-Control": "public, max-age=60, stale-while-revalidate=300" },
					});
				} catch {
					return Response.json({ error: "Falha ao buscar cursos pagos" }, { status: 500 });
				}
			},
		},

		"/api/courses/all": {
			async GET(req: Request) {
				try {
					const unitId = parseInt(
						new URL(req.url).searchParams.get("unit") ?? String(config.defaultUnitId),
						10,
					);
					const [freeCached, paidCached] = [
						unitDataCache.get(unitId),
						unitPaidDataCache.get(unitId),
					];

					let freeData: CoursesData;
					if (freeCached) {
						if (Date.now() - freeCached.updatedAt > config.unitTtlMs) getUnitData(unitId);
						freeData = freeCached.data;
					} else {
						freeData = await getUnitData(unitId);
					}

					let paidData: CoursesData;
					if (paidCached) {
						if (Date.now() - paidCached.updatedAt > config.unitTtlMs) getUnitPaidData(unitId);
						paidData = paidCached.data;
					} else {
						paidData = await getUnitPaidData(unitId);
					}

					return Response.json(
						{ free: freeData, paid: paidData },
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
				try {
					const unitId = parseInt(
						new URL(req.url).searchParams.get("unit") ?? String(config.defaultUnitId),
						10,
					);
					return Response.json(await getUnitData(unitId, true));
				} catch {
					return Response.json({ error: "Falha ao atualizar cursos" }, { status: 500 });
				}
			},
		},

		"/api/paid-refresh": {
			async POST(req) {
				try {
					const unitId = parseInt(
						new URL(req.url).searchParams.get("unit") ?? String(config.defaultUnitId),
						10,
					);
					return Response.json(await getUnitPaidData(unitId, true));
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

// ── Startup: DB + warmup ──────────────────────────────────────────────────────

// Connect to embedded DB first; pre-populate units for instant /api/units response
connectDb()
	.then(async () => {
		const dbUnits = await dbGetAllUnits();
		if (dbUnits.length > 0 && !unitsRegistry) {
			unitsRegistry = dbUnits;
			console.log(`[db] ${dbUnits.length} unidades pré-carregadas do banco`);
		}
	})
	.catch(console.error);

// Build catalog then scrape/refresh ALL units — saves to DB after each unit
getCatalog()
	.then(async (catalog) => {
		const unitIds = [...new Set(catalog.entries.map((e) => e.unitId))];
		console.log(`[warmup] verificando ${unitIds.length} unidades…`);
		let done = 0;
		await withConcurrency(
			unitIds.map((uid) => async () => {
				await Promise.all([getUnitData(uid), getUnitPaidData(uid)]);
				done++;
				if (done % 10 === 0 || done === unitIds.length) {
					console.log(`[warmup] ${done}/${unitIds.length} unidades carregadas`);
				}
			}),
			config.warmupConcurrency,
		);
		console.log("[warmup] todas as unidades carregadas ✓");
	})
	.catch(console.error);

getUnits().catch(console.error);
