import { config } from "../../config/config";
import { DEFAULT_AREA_LABEL, DEFAULT_AREA_SLUG } from "../constants";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "pr";

// SENAI-PR (novo.senaipr.org.br) runs on Liferay DXP — its real catalog is a
// public Headless Delivery REST API (Liferay Objects), found by reading the
// cursos-tecnicos page's own network calls, not scraped HTML:
//   /o/c/cursos/scopes/8486040     — course catalog (341 total, every type)
//   /o/c/turmases/scopes/8486040   — real turmas: unit, turno, start date, price
// "setor" on the course object looked like a real área field at first, but 259
// of 341 courses (76%) are just "setor": "Outras" — not a usable taxonomy, so
// like ma.ts/df.ts this adapter offers ONE área (T.I.) via keyword match against
// course names, refined against all 341 real names to exclude machine-tool
// "programador e operador de torno/usinagem CNC" courses and industrial
// "instalador de sistemas fotovoltaicos/SCADA/refrigeração" courses that also
// contain the bare word "sistema(s)".
const SCOPE = "8486040";
const BASE = "https://novo.senaipr.org.br";
const CURSOS_URL = `${BASE}/o/c/cursos/scopes/${SCOPE}?fields=id,codcurso,curso,urldapagina&pageSize=5000&filter=cursoInativo%20eq%20false`;
const TURMAS_URL = `${BASE}/o/c/turmases/scopes/${SCOPE}?fields=id,codcurso,unidade,turno,duracao,iniciodasaulas,investimento&pageSize=5000`;

const IT_KEYWORDS =
	/desenvolvimento\s+de\s+sistemas|programador(a)?\s+(de\s+)?(sistemas|web|mobile|aplicativos|full-?stack)|inform[aá]tica|redes?\s+de\s+computadores?|cibersistemas|intelig[êe]ncia\s+artificial|power\s*bi|\bexcel\b|desenvolvedor|programa[çc][aã]o\s+(de\s+)?(web|software|sistemas)/i;

function isItCourse(name: string): boolean {
	return IT_KEYWORDS.test(name);
}

interface RawCurso {
	id: number;
	codcurso: string;
	curso: string;
	urldapagina?: string;
}

interface RawTurma {
	id: number;
	codcurso: string;
	unidade?: string;
	turno?: string;
	duracao?: string;
	iniciodasaulas?: string;
	investimento?: string;
}

interface ListResponse<T> {
	items: T[];
}

function formatPrice(investimento: string | undefined): string[] {
	if (!investimento) return [];
	const m = investimento.match(/R\$\s*[\d.,]+/);
	return m ? [m[0]] : [];
}

function isFree(investimento: string | undefined): boolean {
	return /gratuit/i.test(investimento ?? "");
}

interface CatalogEntry {
	unitId: number;
	unitName: string;
	isPaid: boolean;
	course: Course;
}

const unitIdByName = new Map<string, number>();
let nextUnitId = 1;
function getUnitId(name: string): number {
	let id = unitIdByName.get(name);
	if (id === undefined) {
		id = nextUnitId++;
		unitIdByName.set(name, id);
	}
	return id;
}

async function buildCatalog(): Promise<CatalogEntry[]> {
	const [cursosRes, turmasRes] = await Promise.all([
		getJson<ListResponse<RawCurso>>(CURSOS_URL),
		getJson<ListResponse<RawTurma>>(TURMAS_URL),
	]);
	const cursos = cursosRes?.items ?? [];
	const turmas = turmasRes?.items ?? [];

	const itCourseByCode = new Map(
		cursos.filter((c) => isItCourse(c.curso)).map((c) => [c.codcurso, c] as const),
	);

	const entries: CatalogEntry[] = [];
	for (const t of turmas) {
		const curso = itCourseByCode.get(t.codcurso);
		if (!curso || !t.unidade) continue;
		const hours = t.duracao ? parseInt(t.duracao, 10) || 0 : 0;

		entries.push({
			unitId: getUnitId(t.unidade),
			unitName: t.unidade,
			isPaid: !isFree(t.investimento),
			course: {
				name: curso.curso,
				slug: curso.codcurso.toLowerCase(),
				id: t.id,
				hours,
				vagas: null,
				turmas: 1,
				startDates: t.iniciodasaulas ? [t.iniciodasaulas] : [],
				schedules: t.turno ? [{ periodo: t.turno, horario: "" }] : [],
				prices: formatPrice(t.investimento),
				isBolsa: false,
				url: curso.urldapagina,
			},
		});
	}
	console.log(
		`[pr] ${entries.length} turma(s) de T.I. de ${itCourseByCode.size} curso(s) de T.I. reais`,
	);
	return entries;
}

// isEmpty guard: an empty result almost always means a transient fetch failure,
// not that PR genuinely has zero IT turmas — see KeyedAsyncCache's doc comment.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
const getCatalog = () => catalogCache.get("all", buildCatalog);

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
	return [{ slug: DEFAULT_AREA_SLUG, label: DEFAULT_AREA_LABEL }];
}

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	if (areaSlug !== DEFAULT_AREA_SLUG) return [];
	const entries = await getCatalog();
	return [...new Set(entries.map((e) => e.unitId))];
}

async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	if (areaSlug !== DEFAULT_AREA_SLUG) return { courses: [], lastUpdated: new Date().toISOString() };
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId && !e.isPaid)
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
	if (areaSlug !== DEFAULT_AREA_SLUG) return { courses: [], lastUpdated: new Date().toISOString() };
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId && e.isPaid)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const prAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "novo.senaipr.org.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
