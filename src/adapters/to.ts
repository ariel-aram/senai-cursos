import { config } from "../../config/config";
import { DEFAULT_AREA_SLUG } from "../constants";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { decodeEntities, get, postForm, slugify, withConcurrency } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "to";

// SENAI-TO's real catalog is a separate ASP.NET MVC app on its own subdomain
// (cursos.senai-to.com.br) — the institutional senai-to.com.br domain only links
// out to it. The listing itself is an AJAX partial-view POST endpoint (found by
// reading the page's inline `buscarCatalogoCursos()` handler for its exact field
// names — the naive guess "Area_Id"/"Modalidade" from the <select id="Area_Id">
// element silently returns the unfiltered list; the real field is "Area"):
//   POST /Inicio/GetCatalogoCursos  body: Area=<id>&Modalidade=Outros&Filtro=&page=<n>
// The full área list (all 32 real categories, e.g. "Automação", "Gestão",
// "Tecnologia da Informação"...) is scraped from the <select id="Area_Id">
// options on the catalog page itself — no separate "list areas" endpoint exists.
const BASE = "http://cursos.senai-to.com.br";
const PAGE_SIZE = 10;

// There is no seat/inventory system here at all (unlike GO's VTEX commertialOffer)
// — a course page is a lead-gen form ("Registrar Interesse") that submits contact
// info, not a purchase. So vagas is always null, same "Ver no site" treatment as
// MA/GO. A course can also have zero active turmas ("Nenhuma turma encontrada") —
// those are skipped entirely rather than shown with no schedule to speak of.
//
// Each course can have multiple turmas (see the "Selecione a Turma" <select> on
// its detail page); this adapter only surfaces the DEFAULT one the detail page
// renders without a turmaId query param, to keep per-refresh request volume sane
// across all ~32 areas statewide — the course's own link (course.url) is the
// real source of truth for browsing every turma.

interface AreaInfo {
	id: string;
	slug: string;
	label: string;
}

async function fetchAreaOptions(): Promise<AreaInfo[]> {
	const html = await get(`${BASE}/Inicio/CatalogoCursos?modalidade=Outros`);
	const selectMatch = html.match(/<select[^>]*id="Area_Id"[^>]*>([\s\S]*?)<\/select>/);
	if (!selectMatch?.[1]) return [];
	const areas: AreaInfo[] = [];
	for (const m of selectMatch[1].matchAll(/<option value="(\d+)">([^<]+)<\/option>/g)) {
		const id = m[1];
		const label = m[2] ? decodeEntities(m[2]).trim() : "";
		if (id && label) areas.push({ id, slug: slugify(label), label });
	}
	return areas;
}

// isEmpty guard: an empty result almost always means the fetch/parse failed
// silently (get() swallows errors into "" — see http.ts) rather than the site
// genuinely having zero areas — see KeyedAsyncCache's doc comment.
const areasCache = new KeyedAsyncCache<AreaInfo[]>(config.catalogTtlMs, (v) => v.length === 0);
const getAreaInfos = () => areasCache.get("areas", fetchAreaOptions);

async function fetchCatalogPage(areaId: string, page: number): Promise<string[]> {
	const html = await postForm(
		`${BASE}/Inicio/GetCatalogoCursos`,
		`Area=${areaId}&Modalidade=Outros&Filtro=&page=${page}`,
	);
	const ids = new Set<string>();
	for (const m of html.matchAll(/cursoId=(\d+)/g)) {
		const id = m[1];
		if (id) ids.add(id);
	}
	return [...ids];
}

async function collectCourseIdsForArea(areaId: string): Promise<string[]> {
	const all = new Set<string>();
	for (let page = 1; page <= 30; page++) {
		const ids = await fetchCatalogPage(areaId, page);
		if (ids.length === 0) break;
		for (const id of ids) all.add(id);
		if (ids.length < PAGE_SIZE) break;
	}
	return [...all];
}

function extractField(html: string, id: string): string | null {
	const m = html.match(new RegExp(`id="${id}"[^>]*>([^<]*)<`));
	return m?.[1] ? decodeEntities(m[1]) : null;
}

function extractTitle(html: string): string | null {
	const m = html.match(/<h1[^>]*>([\s\S]{0,200}?)<\/h1>/);
	return m?.[1] ? decodeEntities(m[1]) : null;
}

function extractStartDate(periodo: string | null): string[] {
	const m = periodo?.match(/\d{2}\/\d{2}\/\d{4}/);
	return m ? [m[0]] : [];
}

const cityIdByName = new Map<string, number>();
let nextCityId = 1;

function getCityId(name: string): number {
	let id = cityIdByName.get(name);
	if (id === undefined) {
		id = nextCityId++;
		cityIdByName.set(name, id);
	}
	return id;
}

interface CatalogEntry {
	cityId: number;
	cityName: string;
	areaSlug: string;
	isPaid: boolean;
	course: Course;
}

async function scrapeCourse(id: string, area: AreaInfo): Promise<CatalogEntry | null> {
	const url = `${BASE}/Inicio/Curso?cursoId=${id}&modalidade=Outros`;
	const html = await get(url);
	if (!html || html.includes("Nenhuma turma encontrada")) return null;

	const unidade = extractField(html, "_unidade");
	if (!unidade) return null;
	const cityName = unidade.split(" - ")[0]?.trim();
	if (!cityName) return null;

	const name = extractTitle(html) ?? `Curso ${id}`;
	const periodoTurma = extractField(html, "_periodoTurma");
	const cargaHoraria = extractField(html, "_cargaHoraria");
	const turno = extractField(html, "_turno");
	const investimento = extractField(html, "_investimento") ?? "";

	const isFree = /gratuidade|gratuito/i.test(investimento);
	const prices = !isFree && investimento.includes("R$") ? [investimento] : [];
	const hours = cargaHoraria ? parseInt(cargaHoraria, 10) || 0 : 0;

	return {
		cityId: getCityId(cityName),
		cityName,
		areaSlug: area.slug,
		isPaid: !isFree,
		course: {
			name,
			slug: `to-${id}`,
			id: parseInt(id, 10),
			hours,
			vagas: null,
			turmas: 1,
			startDates: extractStartDate(periodoTurma),
			schedules: turno ? [{ periodo: turno, horario: "" }] : [],
			prices,
			isBolsa: false,
			url,
		},
	};
}

// One catalog PER área, built lazily on first request — not one combined build
// across all ~32 areas. Building everything up front (even concurrently) meant
// a single cold request could involve 500+ per-course detail-page fetches to a
// slow ASP.NET site, taking minutes; getUnits() in particular doesn't need that
// since units are the same physical cities across every área, so it only needs
// ONE área's catalog (the default), same approach as sp.ts. An empty result here
// (an área with zero active turmas right now) is a real, cacheable answer —
// unlike the área LIST above, there's no reliable way to tell "genuinely empty"
// from "transient failure" for one área's course list, so no isEmpty guard.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(config.catalogTtlMs);

async function buildCatalogForArea(area: AreaInfo): Promise<CatalogEntry[]> {
	const ids = await collectCourseIdsForArea(area.id);
	const results = await withConcurrency(
		ids.map((id) => () => scrapeCourse(id, area)),
		config.catalogConcurrency,
	);
	const entries = results.filter((e): e is CatalogEntry => e !== null);
	console.log(
		`[to] ${entries.length} turma(s) ativa(s) em "${area.label}" de ${ids.length} curso(s)`,
	);
	return entries;
}

async function getCatalog(areaSlug: string): Promise<CatalogEntry[]> {
	return catalogCache.get(areaSlug, async () => {
		const areas = await getAreaInfos();
		const area = areas.find((a) => a.slug === areaSlug);
		return area ? buildCatalogForArea(area) : [];
	});
}

async function getUnits(): Promise<UnitInfo[]> {
	const entries = await getCatalog(DEFAULT_AREA_SLUG);
	const seen = new Map<number, string>();
	for (const e of entries) if (!seen.has(e.cityId)) seen.set(e.cityId, e.cityName);
	const units = [...seen.entries()]
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	for (const u of units) dbUpsertUnit(UF, u).catch(() => {});
	return units;
}

async function getAreas(): Promise<Area[]> {
	const areas = await getAreaInfos();
	return areas
		.map(({ slug, label }) => ({ slug, label }))
		.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	const entries = await getCatalog(areaSlug);
	return [...new Set(entries.map((e) => e.cityId))];
}

async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	const entries = await getCatalog(areaSlug);
	const courses = entries
		.filter((e) => e.cityId === unitId && !e.isPaid)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, false).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

async function getUnitPaidData(
	unitId: number,
	areaSlug: string,
	_force = false,
): Promise<CoursesData> {
	const entries = await getCatalog(areaSlug);
	const courses = entries
		.filter((e) => e.cityId === unitId && e.isPaid)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const toAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "cursos.senai-to.com.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
