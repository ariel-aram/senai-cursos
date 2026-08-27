import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson, slugify } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "rs";

// SENAI-RS (cursos.senairs.org.br) is WordPress with a real custom "cursos"
// post type exposed through the standard REST API — no scraping needed.
// Real, live fields (confirmed via /wp-json/wp/v2/cursos): acf.cargahoraria
// (hours), acf.valortotal (price — 0 in every course sampled so far, i.e. this
// state's real catalog is free/gratuidade-funded), acf.turmasabertas ("S"/"N",
// a real open-enrollment flag — only "S" courses are surfaced here, the same
// way MA/DF only surface confirmed-real turmas), and a real "cidade" taxonomy
// (36 real cities) for the unit. acf.segmentoindustrial is a real área field
// but only populated on ~60% of open courses (confirmed: Desenvolvimento de
// Sistemas, Eletrônica e Automação, Metalmecânica, etc.) — courses without it
// are skipped rather than guessed into an área.
const BASE = "https://cursos.senairs.org.br";
const REST_BASE = `${BASE}/wp-json/wp/v2`;
const PAGE_SIZE = 50;
const MAX_PAGES = 30;

interface RawCourseAcf {
	nomecurso?: string;
	segmentoindustrial?: string;
	cargahoraria?: string;
	turmasabertas?: string;
	valortotal?: string;
	modalidade?: string;
	ead?: string;
}

interface RawCourse {
	id: number;
	slug: string;
	title: { rendered: string };
	link: string;
	cidade?: number[];
	acf?: RawCourseAcf;
}

interface RawCidade {
	id: number;
	name: string;
}

async function fetchAllCourses(): Promise<RawCourse[]> {
	const all: RawCourse[] = [];
	for (let page = 1; page <= MAX_PAGES; page++) {
		const batch = await getJson<RawCourse[]>(
			`${REST_BASE}/cursos?per_page=${PAGE_SIZE}&page=${page}&_fields=id,slug,title,link,cidade,acf`,
		);
		if (!batch || batch.length === 0) break;
		all.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	return all;
}

async function fetchCidadeMap(): Promise<Map<number, string>> {
	const cidades = await getJson<RawCidade[]>(`${REST_BASE}/cidade?per_page=100`);
	return new Map((cidades ?? []).map((c) => [c.id, c.name]));
}

interface CatalogEntry {
	unitId: number;
	unitName: string;
	areaSlug: string;
	areaLabel: string;
	isPaid: boolean;
	course: Course;
}

async function buildEntries(): Promise<CatalogEntry[]> {
	const [courses, cidadeMap] = await Promise.all([fetchAllCourses(), fetchCidadeMap()]);
	const entries: CatalogEntry[] = [];
	for (const c of courses) {
		const acf = c.acf;
		if (!acf || acf.turmasabertas !== "S") continue;
		if (!acf.segmentoindustrial) continue;
		const cidadeId = c.cidade?.[0];
		const unitName = cidadeId ? cidadeMap.get(cidadeId) : undefined;
		if (!unitName) continue;

		const price = parseFloat(acf.valortotal ?? "0") || 0;
		entries.push({
			unitId: cidadeId as number,
			unitName,
			areaSlug: slugify(acf.segmentoindustrial),
			areaLabel: acf.segmentoindustrial,
			isPaid: price > 0,
			course: {
				name: acf.nomecurso ?? c.title.rendered,
				slug: c.slug,
				id: c.id,
				hours: acf.cargahoraria ? parseInt(acf.cargahoraria, 10) : 0,
				vagas: null,
				turmas: 1,
				startDates: [],
				schedules: acf.modalidade ? [{ periodo: acf.modalidade, horario: "" }] : [],
				prices: price > 0 ? [`R$ ${price.toFixed(2).replace(".", ",")}`] : [],
				isBolsa: false,
				url: c.link,
			},
		});
	}
	return entries;
}

// isEmpty guard: an empty result almost always means a transient fetch
// failure, not that RS genuinely has zero open turmas — see KeyedAsyncCache's
// doc comment (adapters/keyed-cache.ts).
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
const getCatalog = () => catalogCache.get("all", buildEntries);

async function getUnits(): Promise<UnitInfo[]> {
	const entries = await getCatalog();
	const seen = new Map<number, string>();
	for (const e of entries) if (!seen.has(e.unitId)) seen.set(e.unitId, e.unitName);
	const units = [...seen.entries()]
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	for (const u of units) dbUpsertUnit(UF, u).catch(() => {});
	return units;
}

async function getAreas(): Promise<Area[]> {
	const entries = await getCatalog();
	const seen = new Map<string, string>();
	for (const e of entries) if (!seen.has(e.areaSlug)) seen.set(e.areaSlug, e.areaLabel);
	return [...seen.entries()]
		.map(([slug, label]) => ({ slug, label }))
		.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	const entries = await getCatalog();
	return [...new Set(entries.filter((e) => e.areaSlug === areaSlug).map((e) => e.unitId))];
}

async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId && e.areaSlug === areaSlug && !e.isPaid)
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
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId && e.areaSlug === areaSlug && e.isPaid)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const rsAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "cursos.senairs.org.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
