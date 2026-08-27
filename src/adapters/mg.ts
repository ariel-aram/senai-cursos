import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson, slugify } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "mg";

// SENAI-MG's real catalog lives behind fiemg.com.br/senai's "Cursos
// Profissionalizantes" page as a JetEngine Custom Content Type, exposed as a
// real public JSON REST route: /senai/wp-json/jet-cct/cursos_tec_senai
// (found by reading the site's own wp-json route list — not scraped HTML).
// The route ignores its own `page` param (page=1 and page=2 return the exact
// same payload — confirmed live), so it's fetched in one shot with a
// generous per_page instead of paginated; the real total is 107 rows, of
// which 102 are cct_status "publish" + matricula_encerrada "aberta" — only
// those are surfaced here, same as MA/DF only surfacing confirmed-real turmas
// (the rest are "draft" internal placeholders, e.g. ofertado_por: "CRIAR
// SEGUNDA TURMA COM OS MESMOS DADOS", never meant to go live).
//
// There is no real subject-área field in this CCT (area_de_atuacao is always
// empty) — but unlike ma.ts/df.ts's keyword-matched single área, this entire
// catalog turned out to have exactly 4 distinct course titles across all 102
// open offerings (Técnico em Segurança do Trabalho, Técnico em Qualidade,
// Técnico em Eletrotécnica, Técnico em Automação Industrial — none of them
// T.I.), so each is mapped 1:1 to a real, unambiguous área label instead of
// a fuzzy keyword match. Per the standing rule established for mt.ts: a real
// non-IT catalog is still real data and is surfaced via the app's multi-área
// browsing rather than skipped for lacking T.I. content.
const BASE = "https://fiemg.com.br/senai";
const CCT_URL = `${BASE}/wp-json/jet-cct/cursos_tec_senai`;
const FETCH_LIMIT = 500;

const COURSE_AREA: Record<string, string> = {
	"técnico em segurança do trabalho": "Segurança do Trabalho",
	"técnico em qualidade": "Gestão da Qualidade",
	"técnico em eletrotécnica": "Eletrotécnica",
	"técnico em automação industrial": "Eletrônica e Automação",
};

interface RawEntry {
	_ID: string;
	cct_status?: string;
	matricula_encerrada?: string;
	curso?: string;
	cidade?: string;
	ofertado_por?: string;
	turno?: string;
	link?: string;
	inicio_das_aulas?: string;
	carga_horaria?: string;
	valor_da_matricula?: string;
	mensalidade?: string;
}

async function fetchAllEntries(): Promise<RawEntry[]> {
	// Not paginated — see the note above on why: `page` is a no-op on this route.
	const batch = await getJson<RawEntry[]>(`${CCT_URL}?per_page=${FETCH_LIMIT}`);
	return batch ?? [];
}

// The source's own "ofertado_por" already says "SENAI <cidade> ..." — the
// app's header already prefixes "SENAI " itself, same fix as ce.ts/df.ts.
function stripSenaiPrefix(name: string): string {
	return name.replace(/^senai\s+/i, "").trim();
}

interface CatalogEntry {
	unitId: number;
	unitName: string;
	areaSlug: string;
	areaLabel: string;
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

function buildEntries(rows: RawEntry[]): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const r of rows) {
		// "draft" rows include internal placeholder entries never meant to go
		// live (e.g. ofertado_por: "CRIAR SEGUNDA TURMA COM OS MESMOS DADOS") —
		// only "publish" is the site's own real, live-visible data.
		if (r.cct_status !== "publish") continue;
		if (r.matricula_encerrada !== "aberta") continue;
		const courseName = r.curso?.trim();
		const unitRaw = r.ofertado_por?.trim();
		if (!courseName || !unitRaw) continue;
		const areaLabel = COURSE_AREA[courseName.toLowerCase()];
		if (!areaLabel) continue;

		const unitName = stripSenaiPrefix(unitRaw);
		const price = parseFloat((r.valor_da_matricula || r.mensalidade || "0").replace(",", ".")) || 0;

		entries.push({
			unitId: getUnitId(unitName),
			unitName,
			areaSlug: slugify(areaLabel),
			areaLabel,
			course: {
				name: `${courseName} — ${r.cidade ?? unitName}`,
				slug: `mg-${r._ID}`,
				id: parseInt(r._ID, 10) || 0,
				hours: r.carga_horaria ? parseInt(r.carga_horaria, 10) || 0 : 0,
				vagas: null,
				turmas: 1,
				startDates: [],
				schedules: r.turno ? [{ periodo: r.turno, horario: "" }] : [],
				prices: price > 0 ? [`R$ ${price.toFixed(2).replace(".", ",")}`] : [],
				isBolsa: false,
				url: r.link ?? `${BASE}/cursos-profissionalizantes/`,
			},
		});
	}
	return entries;
}

// isEmpty guard: an empty result almost always means a transient fetch
// failure, not that MG genuinely has zero open turmas — see KeyedAsyncCache's
// doc comment (adapters/keyed-cache.ts).
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
async function getCatalog(): Promise<CatalogEntry[]> {
	return catalogCache.get("all", async () => buildEntries(await fetchAllEntries()));
}

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

// The source has no real price signal for the vast majority of rows — every
// open entry is surfaced via the free tier; the paid tier is the mirror-image
// empty case (like df.ts) unless a rare row does carry a real mensalidade.
async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId && e.areaSlug === areaSlug && e.course.prices.length === 0)
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
		.filter((e) => e.unitId === unitId && e.areaSlug === areaSlug && e.course.prices.length > 0)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const mgAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "fiemg.com.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
