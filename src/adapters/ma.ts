import { config } from "../../config/config";
import { DEFAULT_AREA_LABEL, DEFAULT_AREA_SLUG } from "../constants";
import { dbGetCourses, dbGetScrapedAt, dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, Schedule, UnitInfo } from "../types";
import { get, getJson, withConcurrency } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "ma";

// SENAI-MA's real catalog isn't on the institutional domain (futuro.digital/senai-ma)
// at all — that page just iframes a Vercel-hosted micro-app whose data comes from
// a separate JSON endpoint, discovered by reading its bundled HTML for the fetch
// call: senai-ma-scripts.vercel.app/api/cursos?cidade=<slug>, one call per unit.
const CATALOG_HOST = "https://senai-ma-scripts.vercel.app";

// IMPORTANT: this endpoint's "vagas" field is NOT real seat data — every course
// observed during investigation returned either the placeholder 100 or the
// sentinel 99999, never a value that moved between units. So every course here
// is stored with vagas: null (see Course.vagas doc) instead of a fabricated count —
// the UI shows "Ver no site" and links out instead of drawing a fake vagas bar.
//
// There's also no free/gratuito feed: this is purely a paid marketplace catalog
// (same situation as SC's cursostecnicosgratuitos.sc.senai.br — see sc.ts), so
// getUnitData() below always returns an empty list.

interface RawCourse {
	id: string;
	nome: string;
	descricao?: string;
	cargaH?: string;
	turno?: string;
	turma?: string;
	link?: string;
	preco?: { aVista?: number };
}

interface UnitEntry extends UnitInfo {
	slug: string;
}

let unitsCache: UnitEntry[] | null = null;
let unitsPending: Promise<UnitEntry[]> | null = null;

const unitPaidDataCache = new Map<number, { data: CoursesData; updatedAt: number }>();

// This feed has no real category field at all (unlike GO/SC/TO, which all expose
// a genuine per-course área) — so this adapter can only reliably classify ONE
// area (T.I., via keyword matching below) rather than the full área taxonomy.
// Fabricating buckets for other areas from name/description keywords would be
// too unreliable to call "real" data, so getAreas() below only ever offers
// DEFAULT_AREA_SLUG until MA's source exposes real category metadata.
//
// Heuristic match for "Tecnologia da Informação e Informática" — this feed has no
// category field (unlike SP's dedicated /cursos-livres/tecnologia-da-informacao-e-informatica
// page), so courses are classified by keyword against name + description.
// "programação"/"desenvolvimento" alone are too ambiguous in this catalog (CNC
// machine "programação", industrial "desenvolvimento de produto", etc.) — only
// match them together with a software/computing qualifier.
const IT_KEYWORDS =
	/inform[aá]tic|\bti\b|\bexcel\b|power\s*bi|\bdashboard|desenvolv(imento|edor)\s+(de\s+)?(web|software|sistemas|aplicativos|jogos)|programa[çc][aã]o\s+(de\s+)?(web|software|sistemas)|\bsoftware\b|redes?\s+de\s+computadores?|banco\s+de\s+dados|ci[êe]ncia\s+de\s+dados|intelig[êe]ncia\s+artificial|\bpython\b|\bjava\b|javascript|suporte\s+t[ée]cnico|manuten[çc][ãa]o\s+de\s+(computadores|microcomputadores|micros)\b/i;

function isItCourse(c: RawCourse): boolean {
	return IT_KEYWORDS.test(`${c.nome} ${c.descricao ?? ""}`);
}

function slugFromLink(link: string | undefined, fallback: string): string {
	if (!link) return fallback;
	const match = link.match(/\/([^/]+)\/p\/?$/);
	return match?.[1] ?? fallback;
}

function formatPrice(preco: RawCourse["preco"]): string[] {
	if (!preco?.aVista) return [];
	return [`R$ ${preco.aVista.toFixed(2).replace(".", ",")}`];
}

function extractStartDates(turma: string | undefined): string[] {
	if (!turma) return [];
	const match = turma.match(/\d{2}\/\d{2}\/\d{4}/);
	return match ? [match[0]] : [];
}

function extractSchedules(turno: string | undefined): Schedule[] {
	if (!turno) return [];
	return [{ periodo: turno, horario: "" }];
}

async function scrapeUnits(): Promise<UnitEntry[]> {
	const html = await get(`${CATALOG_HOST}/`);
	const units: UnitEntry[] = [];
	const seen = new Set<string>();
	const regex = /data-cidade="([^"]+)"\s+data-nome="([^"]+)"/g;
	let id = 1;
	for (const m of html.matchAll(regex)) {
		const slug = m[1];
		const name = m[2];
		if (!slug || !name || seen.has(slug)) continue;
		seen.add(slug);
		units.push({ id: id++, name, slug });
	}
	return units;
}

async function getUnits(): Promise<UnitEntry[]> {
	if (unitsCache) return unitsCache;
	if (unitsPending) return unitsPending;
	unitsPending = scrapeUnits()
		.then((units) => {
			unitsCache = units;
			unitsPending = null;
			for (const u of units) dbUpsertUnit(UF, u).catch(() => {});
			return units;
		})
		.catch(() => {
			unitsPending = null;
			return [];
		});
	return unitsPending;
}

// Not every city in the site's own menu actually has a qualifying IT course right
// now (this feed is the city's FULL catalog, not a pre-filtered IT category — see
// isItCourse above) — some return zero courses at all (e.g. São Luís itself, the
// state capital, oddly), others have courses but none IT. Surfacing those in the
// unit picker just sends users straight to "nenhum curso encontrado", so
// getCatalogUnitIds() below probes every city up front and only returns the ones
// that actually have something to show — mirrors how SP/SC's catalogs are
// inherently pre-filtered to IT-only by their own source category page/query.
async function probeQualifyingUnitIds(): Promise<number[]> {
	const units = await getUnits();
	const results = await withConcurrency(
		units.map((u) => async () => {
			const courses = await scrapeUnitPaidData(u.slug);
			// Opportunistically warm the per-unit cache so selecting this unit
			// right after doesn't re-fetch.
			unitPaidDataCache.set(u.id, {
				data: { courses, lastUpdated: new Date().toISOString() },
				updatedAt: Date.now(),
			});
			dbUpsertCourses(UF, DEFAULT_AREA_SLUG, u.id, courses, true).catch(() => {});
			return { id: u.id, hasCourses: courses.length > 0 };
		}),
		config.catalogConcurrency,
	);
	return results.filter((r) => r.hasCourses).map((r) => r.id);
}

// isEmpty guard: an empty result is ambiguous between "genuinely zero
// qualifying cities" and "every per-unit probe failed transiently" (each probe
// swallows its own fetch errors — see getJson in http.ts), so it isn't trusted
// as a cacheable answer either way — see KeyedAsyncCache's doc comment.
const qualifyingUnitIdsCache = new KeyedAsyncCache<number[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	if (areaSlug !== DEFAULT_AREA_SLUG) return [];
	return qualifyingUnitIdsCache.get("units", probeQualifyingUnitIds);
}

async function getAreas(): Promise<Area[]> {
	return [{ slug: DEFAULT_AREA_SLUG, label: DEFAULT_AREA_LABEL }];
}

// No live free/gratuito feed for MA (see NOTE above).
async function getUnitData(
	_unitId: number,
	_areaSlug: string,
	_force = false,
): Promise<CoursesData> {
	return { courses: [], lastUpdated: new Date().toISOString() };
}

async function scrapeUnitPaidData(slug: string): Promise<Course[]> {
	const raw = (await getJson<RawCourse[]>(`${CATALOG_HOST}/api/cursos?cidade=${slug}`)) ?? [];
	return raw
		.filter(isItCourse)
		.map((c): Course => {
			const courseSlug = slugFromLink(c.link, `ma-${c.id}`);
			return {
				name: c.nome,
				slug: courseSlug,
				id: parseInt(c.id, 10),
				hours: c.cargaH ? parseInt(c.cargaH, 10) : 0,
				vagas: null,
				turmas: c.turma ? 1 : 0,
				startDates: extractStartDates(c.turma),
				schedules: extractSchedules(c.turno),
				prices: formatPrice(c.preco),
				isBolsa: false,
				url: c.link,
			};
		})
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
}

async function getUnitPaidData(
	unitId: number,
	areaSlug: string,
	force = false,
): Promise<CoursesData> {
	if (areaSlug !== DEFAULT_AREA_SLUG) return { courses: [], lastUpdated: new Date().toISOString() };

	const cached = unitPaidDataCache.get(unitId);
	const isStale = !cached || Date.now() - cached.updatedAt > config.unitTtlMs;
	if (!force && !isStale && cached) return cached.data;

	if (!force) {
		const dbTs = await dbGetScrapedAt(UF, areaSlug, unitId, true);
		if (dbTs !== null && Date.now() - dbTs < config.unitTtlMs) {
			const dbData = await dbGetCourses(UF, areaSlug, unitId, true);
			if (dbData) {
				unitPaidDataCache.set(unitId, { data: dbData, updatedAt: dbTs });
				return dbData;
			}
		}
	}

	try {
		const units = await getUnits();
		const unit = units.find((u) => u.id === unitId);
		if (!unit) return { courses: [], lastUpdated: new Date().toISOString() };

		const courses = await scrapeUnitPaidData(unit.slug);
		dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});

		const data = { courses, lastUpdated: new Date().toISOString() };
		unitPaidDataCache.set(unitId, { data, updatedAt: Date.now() });
		return data;
	} catch (err) {
		const stale = await dbGetCourses(UF, areaSlug, unitId, true);
		if (stale) {
			unitPaidDataCache.set(unitId, {
				data: stale,
				updatedAt: Date.now() - config.unitTtlMs + 60_000,
			});
			return stale;
		}
		throw err;
	}
}

export const maAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "futuro.digital/senai-ma",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
