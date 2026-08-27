import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { decodeEntities, get, postForm, slugify } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "al";

// SENAI-AL (al.senai.br) is WordPress + WooCommerce, but the real per-course
// unit/área/turno/price data isn't in the WooCommerce Store API (categories
// are all "Sem categoria" there) — it's rendered server-side into the /cursos/
// listing page as data-attributes on each <article>, loaded via a real AJAX
// action (admin-ajax.php?action=senai_filter_courses, found in the theme's own
// course-filters.js), which is what this adapter calls directly. The nonce is
// public (embedded in the page's window.senaiCourseFiltersConfig, no login
// needed) and is re-fetched from the page on every cold build since WP nonces
// rotate periodically. data-commercial_area is a real, multi-value área
// taxonomy (confirmed 8 real areas incl. "Tecnologia da Informação").
const BASE = "https://al.senai.br";
const AJAX_URL = `${BASE}/wp-admin/admin-ajax.php`;
const PAGE_SIZE = 10;
const MAX_OFFSET = 300;

const ARTICLE_RE =
	/<article\s+data-title="([^"]*)"\s+data-commercial_area="([^"]*)"\s+data-unit="([^"]*)"\s+data-shift="([^"]*)"\s+data-price="([^"]*)"\s+data-ticket_form="([^"]*)"\s+data-modality="([^"]*)"\s+id="([^"]*)"/;
const URL_RE = /itemprop="url" content="([^"]*)"/;

interface RawCourse {
	title: string;
	area: string;
	unit: string;
	shift: string;
	price: string;
	modality: string;
	id: string;
	url: string;
}

async function fetchNonce(): Promise<string | null> {
	const html = await get(`${BASE}/cursos/`);
	const m = html.match(/senaiCourseFiltersConfig\s*=\s*(\{[^;]*\});/);
	if (!m?.[1]) return null;
	try {
		return (JSON.parse(m[1]) as { nonce?: string }).nonce ?? null;
	} catch {
		return null;
	}
}

async function fetchAllCourses(): Promise<RawCourse[]> {
	const nonce = await fetchNonce();
	if (!nonce) return [];

	const all: RawCourse[] = [];
	const seen = new Set<string>();
	for (let offset = 0; offset < MAX_OFFSET; offset += PAGE_SIZE) {
		const body = new URLSearchParams({
			action: "senai_filter_courses",
			nonce,
			offset: String(offset),
			intent: "load-more",
		}).toString();
		const raw = await postForm(AJAX_URL, body);
		let html: string;
		try {
			html = (JSON.parse(raw) as { data?: { html?: string } }).data?.html ?? "";
		} catch {
			break;
		}
		if (!html) break;

		const blocks = html.split("</article>").slice(0, -1);
		let newCount = 0;
		for (const block of blocks) {
			const m = block.match(ARTICLE_RE);
			if (!m) continue;
			const id = m[8] ?? "";
			if (seen.has(id)) continue;
			seen.add(id);
			newCount++;
			const urlMatch = block.match(URL_RE);
			all.push({
				title: decodeEntities(m[1] ?? ""),
				area: decodeEntities(m[2] ?? ""),
				unit: decodeEntities(m[3] ?? ""),
				shift: decodeEntities(m[4] ?? ""),
				price: m[5] ?? "0",
				modality: decodeEntities(m[6] ?? ""),
				id,
				url: urlMatch?.[1] ?? `${BASE}/cursos/`,
			});
		}
		if (newCount === 0) break;
	}
	return all;
}

interface CatalogEntry {
	unitId: number;
	unitName: string;
	areaSlug: string;
	areaLabel: string;
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

function buildEntries(courses: RawCourse[]): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const c of courses) {
		if (!c.area || !c.unit) continue;
		const price = parseFloat(c.price) || 0;
		entries.push({
			unitId: getUnitId(c.unit),
			unitName: c.unit,
			areaSlug: slugify(c.area),
			areaLabel: c.area,
			isPaid: price > 0,
			course: {
				name: c.title,
				slug: `al-${c.id}`,
				id: parseInt(c.id.replace(/\D/g, ""), 10) || 0,
				hours: 0,
				vagas: null,
				turmas: 1,
				startDates: [],
				schedules: c.shift ? [{ periodo: c.shift, horario: "" }] : [],
				prices: price > 0 ? [`R$ ${price.toFixed(2).replace(".", ",")}`] : [],
				isBolsa: false,
				url: c.url,
			},
		});
	}
	return entries;
}

// isEmpty guard: an empty result almost always means a transient fetch/nonce
// failure, not that AL genuinely has zero courses — see KeyedAsyncCache's doc.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
async function getCatalog(): Promise<CatalogEntry[]> {
	return catalogCache.get("all", async () => buildEntries(await fetchAllCourses()));
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

export const alAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "al.senai.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
