import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { decodeEntities, get, slugify, withConcurrency } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "mt";

// SENAI-MT runs a bespoke server-rendered PHP catalog (senaimt.ind.br) — NOT
// ASP.NET (a prior platform-manifest guess of "aspnet" was wrong: the real page
// is plain HTML forms, no __VIEWSTATE/aspx — confirmed by reading the page
// itself), not VTEX, not shared with any other state. The statewide course
// listing (/para-voce/cursos, paginated, ~16 courses total) doesn't carry real
// per-unit turma data itself — only each course's own detail page
// (/cursos/detalhes/<code>/<modalidade-slug>/<course-slug>/) has the real
// per-unit turma list (dates, times, unit), so this adapter fetches the small
// listing once for URLs, then every detail page (cheap at this scale: ~16
// requests) for the actual turma-level data.
//
// Every course's "Investimento" is always the literal placeholder text
// "* Consulte Valores" — genuinely no real price anywhere on the site, for any
// course, and no free-vs-paid signal at all (unlike TO's "GRATUIDADE
// REGIMENTAL" text or GO's VTEX Price field). Rather than guess a split, every
// course here is surfaced through the paid tier only, with an empty prices
// array (same "Ver no site" treatment already used for unknown vagas).
const BASE = "https://senaimt.ind.br";
const LISTING_PATH = "/para-voce/cursos";
const MAX_LISTING_PAGES = 10;

async function collectDetailUrls(): Promise<string[]> {
	const urls = new Set<string>();
	for (let page = 1; page <= MAX_LISTING_PAGES; page++) {
		const html = await get(
			page === 1 ? `${BASE}${LISTING_PATH}` : `${BASE}${LISTING_PATH}?page=${page}`,
		);
		if (!html) break;
		// Links in the raw HTML are relative ("cursos/detalhes/...") — the browser
		// resolves them to absolute automatically when read via the DOM, which is
		// how this was first (mis)investigated; curl/fetch sees the raw relative form.
		const pageUrls = [...html.matchAll(/href="\/?(cursos\/detalhes\/[^"]+)"/g)]
			.map((m) => (m[1] ? `${BASE}/${m[1]}` : null))
			.filter((u): u is string => !!u);
		if (pageUrls.length === 0) break;
		const before = urls.size;
		for (const u of pageUrls) urls.add(u);
		if (urls.size === before) break; // no new courses found -> past the last real page
	}
	return [...urls];
}

function extractCourseName(html: string): string | null {
	const m = html.match(/<h3>\s*<b>\s*([^<]+?)\s*<\/b>\s*<\/h3>/);
	return m?.[1] ? decodeEntities(m[1]) : null;
}

function extractArea(html: string): string | null {
	const m = html.match(/ÁREA:\s*<\/strong>\s*([^<]+?)\s*<\/div>/);
	return m?.[1] ? decodeEntities(m[1].trim()) : null;
}

function extractHours(html: string): number {
	const m = html.match(/CARGA HOR[ÁA]RIA:\s*<\/strong>\s*(\d+)\s*horas/i);
	return m?.[1] ? parseInt(m[1], 10) : 0;
}

interface TurmaEntry {
	turmaId: string;
	unitName: string;
	dataInicio: string;
	horarioInicio: string;
	horarioFim: string;
}

function extractTurmas(html: string): TurmaEntry[] {
	const turmas: TurmaEntry[] = [];
	for (const m of html.matchAll(
		/<li data-value="([^"]+)"[^>]*class="[^"]*turma-card[^"]*"[\s\S]*?<\/li>/g,
	)) {
		const block = m[0];
		const turmaId = m[1];
		if (!turmaId) continue;
		const unitMatch = block.match(/<p class="unidade m-0">\s*([^<]+?)\s*<\/p>/);
		const dataMatch = block.match(/Data de realiza[çc][ãa]o:\s*<\/b>\s*(\d{2}\/\d{2}\/\d{4})/);
		const horarioMatch = block.match(/Hor[áa]rio:\s*<\/b>\s*das\s*([\d:]+)\s*[àa]s\s*([\d:]+)/);
		if (!unitMatch) continue;

		turmas.push({
			turmaId,
			unitName: decodeEntities(unitMatch[1] ?? ""),
			dataInicio: dataMatch?.[1] ?? "",
			horarioInicio: horarioMatch?.[1] ?? "",
			horarioFim: horarioMatch?.[2] ?? "",
		});
	}
	return turmas;
}

// The site's own unit names are ALL CAPS with a "SENAI " prefix (e.g. "SENAI
// DISTRITO INDUSTRIAL") — the app's header already prefixes "SENAI " itself, so
// left as-is this would double up (see the same fix in ce.ts).
function stripSenaiPrefix(name: string): string {
	return name.replace(/^SENAI\s+/i, "").trim();
}

const TITLE_CASE_LOWER = new Set(["de", "da", "do", "das", "dos", "e"]);
function titleCase(raw: string): string {
	return raw
		.toLowerCase()
		.split(" ")
		.map((w, i) => (i > 0 && TITLE_CASE_LOWER.has(w) ? w : w.charAt(0).toUpperCase() + w.slice(1)))
		.join(" ");
}

function derivePeriodo(horarioInicio: string): string {
	const hour = parseInt(horarioInicio.split(":")[0] ?? "", 10);
	if (Number.isNaN(hour)) return "";
	if (hour < 12) return "Manhã";
	if (hour < 18) return "Tarde";
	return "Noite";
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

const courseNumericIdByTurmaId = new Map<string, number>();
let nextCourseNumericId = 1;
function getCourseNumericId(turmaId: string): number {
	let id = courseNumericIdByTurmaId.get(turmaId);
	if (id === undefined) {
		id = nextCourseNumericId++;
		courseNumericIdByTurmaId.set(turmaId, id);
	}
	return id;
}

async function scrapeCourse(url: string): Promise<CatalogEntry[]> {
	const html = await get(url);
	if (!html) return [];
	const name = extractCourseName(html);
	const areaLabelRaw = extractArea(html);
	if (!name || !areaLabelRaw) return [];
	const areaSlug = slugify(areaLabelRaw);
	const areaLabel = titleCase(areaLabelRaw);
	const hours = extractHours(html);
	const slug = slugify(name);

	const entries: CatalogEntry[] = [];
	for (const t of extractTurmas(html)) {
		if (!t.unitName) continue;
		const unitName = titleCase(stripSenaiPrefix(t.unitName));
		const periodo = t.horarioInicio ? derivePeriodo(t.horarioInicio) : "";
		const horario = t.horarioInicio && t.horarioFim ? `${t.horarioInicio} às ${t.horarioFim}` : "";

		entries.push({
			unitId: getUnitId(unitName),
			unitName,
			areaSlug,
			areaLabel,
			course: {
				name: titleCase(name),
				slug,
				id: getCourseNumericId(t.turmaId),
				hours,
				vagas: null,
				turmas: 1,
				startDates: t.dataInicio ? [t.dataInicio] : [],
				schedules: periodo ? [{ periodo, horario }] : [],
				prices: [],
				isBolsa: false,
				url,
			},
		});
	}
	return entries;
}

async function buildCatalog(): Promise<CatalogEntry[]> {
	const detailUrls = await collectDetailUrls();
	const results = await withConcurrency(
		detailUrls.map((url) => () => scrapeCourse(url)),
		config.catalogConcurrency,
	);
	const entries = results.flat();
	console.log(
		`[mt] ${entries.length} turma(s) em ${new Set(entries.map((e) => e.areaSlug)).size} área(s) de ${detailUrls.length} curso(s) totais`,
	);
	return entries;
}

// isEmpty guard: an empty result almost always means a transient fetch failure,
// not that MT genuinely has zero courses — see KeyedAsyncCache's doc comment.
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

// No free/gratuito feed exists on this site at all (see NOTE above).
async function getUnitData(
	_unitId: number,
	_areaSlug: string,
	_force = false,
): Promise<CoursesData> {
	return { courses: [], lastUpdated: new Date().toISOString() };
}

async function getUnitPaidData(
	unitId: number,
	areaSlug: string,
	_force = false,
): Promise<CoursesData> {
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.unitId === unitId && e.areaSlug === areaSlug)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const mtAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "senaimt.ind.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
