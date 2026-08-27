import { config } from "../../config/config";
import { DEFAULT_AREA_LABEL, DEFAULT_AREA_SLUG } from "../constants";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { decodeEntities, get } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "df";

// SENAI-DF's real catalog is a legacy PHP page — not the Joomla institutional
// site itself (sistemafibra.org.br/senai/...), which only links out to it:
//   sistemafibra.org.br/senai/cursos_gratuidade/indexCursos.php?categoria=PSGR – Cursos Gratuitos&exibeFiltro=no
// The whole statewide catalog (74 courses across 4 modalidades — Iniciação,
// Aperfeiçoamento, Qualificação, Técnicos) is server-rendered onto ONE page as
// Bootstrap accordion cards, each with a small "Escola/Turno/Carga Horária"
// table of real turmas — no pagination, no AJAX, one fetch gets everything.
// "PSGR" = "Programa SENAI de Gratuidade Regimental": every course behind this
// URL is confirmed free (the page's own title says "Cursos Gratuitos"), so
// getUnitPaidData() below always returns empty — the mirror image of ma.ts.
const CATALOG_URL =
	"https://sistemafibra.org.br/senai/cursos_gratuidade/indexCursos.php?categoria=PSGR%20%E2%80%93%20Cursos%20Gratuitos&exibeFiltro=no";

// This feed has no real subject-área field (only a course-LEVEL modalidade:
// Iniciação/Aperfeiçoamento/Qualificação/Técnicos, not a subject like "Tecnologia
// da Informação" vs "Automotiva") — so like ma.ts, this adapter can only reliably
// offer ONE área (T.I.), via keyword match against course names. Unlike ma.ts's
// catalog, DF's course names are unambiguous ("Desenvolvedor Full Stack",
// "Técnico em Redes de Computadores", etc.) with no CNC-machine-style false
// positives found during a manual read of all 74 course names, so a plain
// keyword match is safe here without the narrower qualifiers ma.ts needed.
const IT_KEYWORDS =
	/desenvolved|programador|inform[aá]tic|rede[s]?\s+de\s+computador|reparador\s+de\s+computador|front-?end|back-?end|full-?stack|low-?code|banco\s+de\s+dados|ci[êe]ncia\s+de\s+dados|python|java\b|javascript/i;

interface TurmaEntry {
	school: string;
	turno: string;
	hours: number;
}

interface RawCourse {
	courseId: string;
	name: string;
	turmas: TurmaEntry[];
}

function parseCatalog(html: string): RawCourse[] {
	const courses: RawCourse[] = [];
	const cards = html.split('<div class="card">').slice(1); // [0] is everything before the first card

	for (const card of cards) {
		const headerMatch = card.match(
			/data-target="#Curso(\d+)"[\s\S]{0,200}?▼<\/span>\s*([^<]+?)\s*<\/button>/,
		);
		if (!headerMatch) continue;
		const courseId = headerMatch[1];
		const name = headerMatch[2] ? decodeEntities(headerMatch[2]).trim() : "";
		if (!courseId || !name) continue;

		const turmas: TurmaEntry[] = [];
		for (const m of card.matchAll(
			/<tr class="Desktop">\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>\s*<td>([^<]*)<\/td>/g,
		)) {
			const school = m[1] ? decodeEntities(m[1]).trim() : "";
			const turno = m[2] ? decodeEntities(m[2]).trim() : "";
			const hours = m[3] ? parseInt(m[3].trim(), 10) || 0 : 0;
			if (!school) continue;
			turmas.push({ school, turno, hours });
		}
		if (turmas.length === 0) continue;

		courses.push({ courseId, name, turmas });
	}
	return courses;
}

function isItCourse(name: string): boolean {
	return IT_KEYWORDS.test(name);
}

// The site's own "Escola" values already say "Senai <cidade>" (e.g. "Senai
// Brasília") — the app's header already prefixes "SENAI " itself, so left as-is
// this doubled up to "SENAI Senai Brasília" (same fix as ce.ts/mt.ts).
function stripSenaiPrefix(name: string): string {
	return name.replace(/^senai\s+/i, "").trim();
}

interface CatalogEntry {
	unitId: number;
	unitName: string;
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

let nextCourseNumericId = 1;
function buildEntries(rawCourses: RawCourse[]): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const c of rawCourses) {
		if (!isItCourse(c.name)) continue;
		for (const t of c.turmas) {
			const school = stripSenaiPrefix(t.school);
			entries.push({
				unitId: getUnitId(school),
				unitName: school,
				course: {
					name: c.name,
					slug: `df-${c.courseId}`,
					id: nextCourseNumericId++,
					hours: t.hours,
					vagas: null,
					turmas: 1,
					startDates: [],
					schedules: t.turno ? [{ periodo: t.turno, horario: "" }] : [],
					prices: [],
					isBolsa: false,
					url: CATALOG_URL,
				},
			});
		}
	}
	return entries;
}

async function fetchCatalog(): Promise<CatalogEntry[]> {
	const html = await get(CATALOG_URL);
	if (!html) return [];
	const rawCourses = parseCatalog(html);
	const entries = buildEntries(rawCourses);
	console.log(`[df] ${entries.length} turma(s) de T.I. de ${rawCourses.length} curso(s) totais`);
	return entries;
}

// isEmpty guard: an empty result almost always means a transient fetch failure,
// not that DF genuinely has zero courses — see KeyedAsyncCache's doc comment.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
const getCatalog = () => catalogCache.get("all", fetchCatalog);

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

// Every course here is confirmed free (see NOTE above) — surfaced through the
// free tier; the paid tier always returns empty, the mirror of ma.ts.
async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	if (areaSlug !== DEFAULT_AREA_SLUG) return { courses: [], lastUpdated: new Date().toISOString() };
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, false).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

async function getUnitPaidData(
	_unitId: number,
	_areaSlug: string,
	_force = false,
): Promise<CoursesData> {
	return { courses: [], lastUpdated: new Date().toISOString() };
}

export const dfAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "sistemafibra.org.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
