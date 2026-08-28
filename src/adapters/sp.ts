import { config } from "../../config/config";
import { DEFAULT_AREA_SLUG } from "../constants";
import { dbGetCourses, dbGetScrapedAt, dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { decodeEntities, get, slugify, withConcurrency, withRetry } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "sp";
const SENAI_BASE = "https://www.sp.senai.br";

// SP's "cursos-livres" catalog is split into ~14 category listing pages, one
// URL slug each — found by reading the nav links on the T.I. category page
// (a[href*="/cursos/cursos-livres/"]). "tecnologia-da-informacao-e-informatica"
// bundles Informática with T.I., so its Area.slug is normalized to
// DEFAULT_AREA_SLUG ("tecnologia-da-informacao") below rather than derived
// verbatim from its own (longer) URL slug or <title> label — every adapter must
// resolve DEFAULT_AREA_SLUG, and this is SP's real T.I. category.
const CATEGORY_URL_SLUGS = [
	"tecnologia-da-informacao-e-informatica",
	"administracao-e-gestao",
	"alimentos-e-bebidas",
	"automotiva",
	"construcao-civil-e-design-de-mobiliario",
	"design-de-moda-textil-vestuario-calcados-e-joalheria",
	"design-grafico-papel-celulose-grafica-e-editorial",
	"fabricacao-mecanica-e-mecanica-industrial",
	"logistica-e-transporte",
	"mecatronica-sistemas-de-automacao-energia-e-eletronica",
	"meio-ambiente-saude-e-seguranca-do-trabalho",
	"metalurgia-e-soldagem",
	"quimica-ceramica-e-plasticos",
	"refrigeracao-e-climatizacao",
];

interface AreaDef {
	urlSlug: string;
	slug: string;
	label: string;
}

// Each category page's <title> ends in "… - <Label>" — the only place the real,
// human category name shows up (nav link text is just generic "Cursos Livres").
async function fetchAreaLabel(urlSlug: string): Promise<string | null> {
	const html = await get(`${SENAI_BASE}/cursos/cursos-livres/${urlSlug}`);
	const m = html.match(/<title>([^<]*)<\/title>/);
	if (!m?.[1]) return null;
	const parts = decodeEntities(m[1]).split(" - ");
	return parts[parts.length - 1]?.trim() || null;
}

async function fetchAreaDefs(): Promise<AreaDef[]> {
	const results = await withConcurrency(
		CATEGORY_URL_SLUGS.map((urlSlug) => async (): Promise<AreaDef | null> => {
			const label = await fetchAreaLabel(urlSlug);
			if (!label) return null;
			const slug =
				urlSlug === "tecnologia-da-informacao-e-informatica" ? DEFAULT_AREA_SLUG : slugify(label);
			return { urlSlug, slug, label };
		}),
		config.catalogConcurrency,
	);
	return results.filter((a): a is AreaDef => a !== null);
}

// isEmpty guard: a partially/fully empty result almost always means a transient
// fetch failure (e.g. startup contention from all 5 states warming up
// concurrently), not that SP genuinely has zero categories — see
// KeyedAsyncCache's doc comment.
const areaDefsCache = new KeyedAsyncCache<AreaDef[]>(config.catalogTtlMs, (v) => v.length === 0);
const getAreaDefs = () => areaDefsCache.get("areas", fetchAreaDefs);

// ── Catalog: (course × unit) pairs from listing pages, one catalog per área ──
interface CatalogEntry {
	name: string;
	slug: string;
	courseId: number;
	hours: number;
	unitId: number;
	isBolsa: boolean;
}

const catalogUnitNames = new Map<number, string>();
// Empty is a real, cacheable answer for one área's catalog (e.g. a category with
// zero live listings right now) — no isEmpty guard, unlike the área LIST cache.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(config.catalogTtlMs);

// ── Per-unit caches — keyed by "areaSlug:unitId" ─────────────────────────────
const unitDataCache = new Map<string, { data: CoursesData; updatedAt: number }>();
const unitDataPending = new Map<string, Promise<CoursesData>>();
const unitPaidDataCache = new Map<string, { data: CoursesData; updatedAt: number }>();
const unitPaidDataPending = new Map<string, Promise<CoursesData>>();

// ── Unit registry ────────────────────────────────────────────────────────────
let unitsRegistry: UnitInfo[] | null = null;
let unitsRegistryPending: Promise<UnitInfo[]> | null = null;

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
	unitsRegistryPending = Promise.all([getCatalog(DEFAULT_AREA_SLUG), scrapeUnits()])
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
			for (const u of units) dbUpsertUnit(UF, u).catch(() => {});
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

async function fetchPage(urlSlug: string, page: number): Promise<string> {
	return get(`${SENAI_BASE}/cursos/cursos-livres/${urlSlug}?pag=${page}`);
}

async function detectTotalPages(urlSlug: string): Promise<number> {
	// Binary-search for the last page that has content (openModalTurmas).
	let lo = 1;
	let hi = 25;
	let lastGood = 1;
	const hasContent = async (p: number) => (await fetchPage(urlSlug, p)).includes("openModalTurmas");
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

async function buildCatalog(
	urlSlug: string,
): Promise<{ entries: CatalogEntry[]; updatedAt: number }> {
	const totalPages = await detectTotalPages(urlSlug);
	console.log(`[sp] scraping ${totalPages} página(s) de ${urlSlug}…`);

	const pages = await withConcurrency(
		Array.from({ length: totalPages }, (_, i) => () => fetchPage(urlSlug, i + 1)),
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
		`[sp] ${entries.length} entradas · ${new Set(entries.map((e) => e.courseId)).size} cursos · ${new Set(entries.map((e) => e.unitId)).size} unidades`,
	);
	return { entries, updatedAt: Date.now() };
}

async function getCatalog(areaSlug: string): Promise<CatalogEntry[]> {
	return catalogCache.get(areaSlug, async () => {
		const areas = await getAreaDefs();
		const areaDef = areas.find((a) => a.slug === areaSlug);
		if (!areaDef) return [];
		const { entries } = await buildCatalog(areaDef.urlSlug);
		return entries;
	});
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

// SP marks "A Distância" (EAD, self-paced) turmas with an unlimited-capacity
// sentinel instead of a real seat count — observed as 99988/99996 etc., never
// a value that tracks real enrollment (same sentinel pattern documented in
// ma.ts for that state's feed). Any parsed count at or above this threshold
// is that sentinel, not a real number, so it's excluded from the vagas sum —
// the turma itself is still counted so course/turma totals stay accurate.
const VAGAS_SENTINEL_THRESHOLD = 9999;

function parseTurmasHtml(html: string): TurmasResult {
	let totalVagas = 0;
	let turmaCount = 0;
	const vagasRegex = /Vagas:\s*(?:<\/span>\s*)?(\d+)/g;
	for (const m of html.matchAll(vagasRegex)) {
		const count = m[1];
		if (!count) continue;
		const parsed = parseInt(count, 10);
		if (parsed < VAGAS_SENTINEL_THRESHOLD) totalVagas += parsed;
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

async function scrapeUnitData(unitId: number, areaSlug: string): Promise<CoursesData> {
	const catalog = await getCatalog(areaSlug);
	const unitEntries = catalog.filter((e) => e.unitId === unitId);

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

	courses.sort((a, b) => (b.vagas ?? 0) - (a.vagas ?? 0) || a.name.localeCompare(b.name, "pt-BR"));

	// Persist asynchronously — does not block the response
	dbUpsertCourses(UF, areaSlug, unitId, courses, false).catch(() => {});

	return { courses, lastUpdated: new Date().toISOString() };
}

async function scrapeUnitPaidData(unitId: number, areaSlug: string): Promise<CoursesData> {
	const catalog = await getCatalog(areaSlug);
	// BOLSA courses are always free scholarships — the SENAI API returns turma data for them
	// even under bolsa=0/gratuito=0, but never prices. Skip them to avoid false positives
	// and to save unnecessary HTTP requests.
	const unitEntries = catalog.filter((e) => e.unitId === unitId && !e.isBolsa);

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
	paidOnly.sort((a, b) => (b.vagas ?? 0) - (a.vagas ?? 0) || a.name.localeCompare(b.name, "pt-BR"));

	// Persist asynchronously — does not block the response
	dbUpsertCourses(UF, areaSlug, unitId, paidOnly, true).catch(() => {});

	return { courses: paidOnly, lastUpdated: new Date().toISOString() };
}

// ── Cache + DB layer — keyed by "areaSlug:unitId" ────────────────────────────

async function getUnitData(unitId: number, areaSlug: string, force = false): Promise<CoursesData> {
	const cacheKey = `${areaSlug}:${unitId}`;
	const cached = unitDataCache.get(cacheKey);
	const isStale = !cached || Date.now() - cached.updatedAt > config.unitTtlMs;
	if (!force && !isStale && cached) return cached.data;

	const pending = unitDataPending.get(cacheKey);
	if (pending) return pending;

	// DB fast path: serve from persisted data if still fresh
	if (!force) {
		const dbTs = await dbGetScrapedAt(UF, areaSlug, unitId, false);
		if (dbTs !== null && Date.now() - dbTs < config.unitTtlMs) {
			const dbData = await dbGetCourses(UF, areaSlug, unitId, false);
			if (dbData) {
				unitDataCache.set(cacheKey, { data: dbData, updatedAt: dbTs });
				return dbData;
			}
		}
		// Re-check: another request may have started scraping during the DB await
		const rePending = unitDataPending.get(cacheKey);
		if (rePending) return rePending;
	}

	const promise = scrapeUnitData(unitId, areaSlug)
		.then((data) => {
			unitDataCache.set(cacheKey, { data, updatedAt: Date.now() });
			unitDataPending.delete(cacheKey);
			return data;
		})
		.catch(async (err) => {
			unitDataPending.delete(cacheKey);
			// On scrape failure, fall back to whatever the DB has (even if stale)
			const stale = await dbGetCourses(UF, areaSlug, unitId, false);
			if (stale) {
				// Mark as slightly-stale so it re-scrapes within 1 min
				unitDataCache.set(cacheKey, {
					data: stale,
					updatedAt: Date.now() - config.unitTtlMs + 60_000,
				});
				return stale;
			}
			throw err;
		});
	unitDataPending.set(cacheKey, promise);
	return promise;
}

async function getUnitPaidData(
	unitId: number,
	areaSlug: string,
	force = false,
): Promise<CoursesData> {
	const cacheKey = `${areaSlug}:${unitId}`;
	const cached = unitPaidDataCache.get(cacheKey);
	const isStale = !cached || Date.now() - cached.updatedAt > config.unitTtlMs;
	if (!force && !isStale && cached) return cached.data;

	const pending = unitPaidDataPending.get(cacheKey);
	if (pending) return pending;

	// DB fast path
	if (!force) {
		const dbTs = await dbGetScrapedAt(UF, areaSlug, unitId, true);
		if (dbTs !== null && Date.now() - dbTs < config.unitTtlMs) {
			const dbData = await dbGetCourses(UF, areaSlug, unitId, true);
			if (dbData) {
				unitPaidDataCache.set(cacheKey, { data: dbData, updatedAt: dbTs });
				return dbData;
			}
		}
		const rePending = unitPaidDataPending.get(cacheKey);
		if (rePending) return rePending;
	}

	const promise = scrapeUnitPaidData(unitId, areaSlug)
		.then((data) => {
			unitPaidDataCache.set(cacheKey, { data, updatedAt: Date.now() });
			unitPaidDataPending.delete(cacheKey);
			return data;
		})
		.catch(async (err) => {
			unitPaidDataPending.delete(cacheKey);
			const stale = await dbGetCourses(UF, areaSlug, unitId, true);
			if (stale) {
				unitPaidDataCache.set(cacheKey, {
					data: stale,
					updatedAt: Date.now() - config.unitTtlMs + 60_000,
				});
				return stale;
			}
			throw err;
		});
	unitPaidDataPending.set(cacheKey, promise);
	return promise;
}

async function getAreas(): Promise<Area[]> {
	const areas = await getAreaDefs();
	return areas
		.map(({ slug, label }) => ({ slug, label }))
		.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	const catalog = await getCatalog(areaSlug);
	return [...new Set(catalog.map((e) => e.unitId))];
}

export const spAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "sp.senai.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
