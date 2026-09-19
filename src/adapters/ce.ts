import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson, slugify } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "ce";

// SENAI-CE runs its own bespoke Laravel/Botble-style commerce app (senai-ce.org.br)
// — not VTEX, not shared with any other state. Found by reading the site's real
// filter-panel network calls: clicking "Segmento" → "Tecnologia da Informação"
// fires GET /category-products/2?segmento=<id>&page=<n>, a real paginated JSON
// API (no HTML scraping needed). "2" is the root "Cursos" category id; "segmento"
// option ids come from /categories/filterable-attributes/2, which is the site's
// real, live área taxonomy (21 segments) — not a guessed/hardcoded list here.
const BASE = "https://www.senai-ce.org.br";
const ROOT_CATEGORY_ID = 2;
const PAGE_SIZE = 12;

// No seat/vagas field exists anywhere in this API's product shape — same
// "Ver no site" treatment as MA/GO/TO/PI/RO. Unlike those, though, CE's product
// already carries a real, stable numeric unit id (attributes.unidade_id) and
// unit name (attributes.unidade_senai), so no city-name→id mapping is needed.

interface AttributeOption {
	id: number;
	label: string;
}

interface FilterAttribute {
	code: string;
	options: AttributeOption[];
}

interface FilterableAttributesResponse {
	filter_attributes: FilterAttribute[];
}

interface RawProductAttributes {
	segmento: string;
	carga_horaria: string;
	data_inicio: string;
	data_fim: string;
	horario_inicio: string;
	horario_fim: string;
	unidade_id: string;
	unidade_senai: string;
}

interface RawProduct {
	product_id: number;
	sku: string;
	slug: string;
	name: string;
	prices: { final_price: { price: number } };
	attributes: RawProductAttributes;
}

interface CategoryProductsResponse {
	products: RawProduct[];
}

async function fetchAreaOptions(): Promise<AttributeOption[]> {
	const json = await getJson<FilterableAttributesResponse>(
		`${BASE}/categories/filterable-attributes/${ROOT_CATEGORY_ID}`,
	);
	const segmento = json?.filter_attributes.find((a) => a.code === "segmento");
	return segmento?.options ?? [];
}

// isEmpty guard: an empty result almost always means a transient fetch failure,
// not that CE genuinely has zero áreas — see KeyedAsyncCache's doc comment.
const areasCache = new KeyedAsyncCache<AttributeOption[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
const getAreaOptions = () => areasCache.get("areas", fetchAreaOptions);

// The site's own unit names already say "SENAI <cidade>" (e.g. "SENAI Barra do
// Ceará") — the app's header already prefixes "SENAI " itself, so left as-is
// this doubled up to "SENAI SENAI Barra do Ceará".
function stripSenaiPrefix(name: string): string {
	return name.replace(/^SENAI\s+/i, "");
}

function formatDate(iso: string | undefined): string[] {
	if (!iso) return [];
	const [y, m, d] = iso.split("-");
	if (!y || !m || !d) return [];
	return [`${d}/${m}/${y}`];
}

// No explicit "Manhã/Tarde/Noite" field in the API — derived from the real
// start-time hour, same kind of derivation SP's own adapter does from raw HTML.
function derivePeriodo(horarioInicio: string | undefined): string {
	const hour = horarioInicio ? parseInt(horarioInicio.split(":")[0] ?? "", 10) : Number.NaN;
	if (Number.isNaN(hour)) return "";
	if (hour < 12) return "Manhã";
	if (hour < 18) return "Tarde";
	return "Noite";
}

interface CatalogEntry {
	unitId: number;
	unitName: string;
	areaSlug: string;
	isPaid: boolean;
	course: Course;
}

async function fetchAreaProducts(areaId: number): Promise<RawProduct[]> {
	const all: RawProduct[] = [];
	for (let page = 1; page <= 30; page++) {
		const json = await getJson<CategoryProductsResponse>(
			`${BASE}/category-products/${ROOT_CATEGORY_ID}?segmento=${areaId}&page=${page}`,
		);
		const products = json?.products ?? [];
		if (products.length === 0) break;
		all.push(...products);
		if (products.length < PAGE_SIZE) break;
	}
	return all;
}

function buildEntries(products: RawProduct[], areaSlug: string): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const p of products) {
		const unitId = parseInt(p.attributes.unidade_id, 10);
		if (!unitId) continue;
		const price = p.prices.final_price.price;
		const periodo = derivePeriodo(p.attributes.horario_inicio);
		const horario =
			p.attributes.horario_inicio && p.attributes.horario_fim
				? `${p.attributes.horario_inicio} às ${p.attributes.horario_fim}`
				: "";

		entries.push({
			unitId,
			unitName: stripSenaiPrefix(p.attributes.unidade_senai),
			areaSlug,
			isPaid: price > 0,
			course: {
				name: p.name,
				slug: p.slug,
				id: p.product_id,
				hours: p.attributes.carga_horaria ? parseInt(p.attributes.carga_horaria, 10) : 0,
				vagas: null,
				turmas: 1,
				startDates: formatDate(p.attributes.data_inicio),
				schedules: periodo ? [{ periodo, horario }] : [],
				prices: price > 0 ? [`R$ ${price.toFixed(2).replace(".", ",")}`] : [],
				isBolsa: false,
				url: `${BASE}/${p.slug}`,
			},
		});
	}
	return entries;
}

const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(config.catalogTtlMs);

async function getCatalog(areaSlug: string): Promise<CatalogEntry[]> {
	return catalogCache.get(areaSlug, async () => {
		const areas = await getAreaOptions();
		const area = areas.find((a) => slugify(a.label) === areaSlug);
		if (!area) return [];
		const products = await fetchAreaProducts(area.id);
		return buildEntries(products, areaSlug);
	});
}

async function getUnits(): Promise<UnitInfo[]> {
	// Units are area-independent, but there's no single "all areas" catalog call
	// here — reuse the área that's cheapest to have already built (T.I., the
	// UI's default) the same way sp.ts/to.ts/sc.ts do.
	const areas = await getAreaOptions();
	const itArea = areas.find((a) => a.label === "Tecnologia da Informação");
	const entries = itArea ? await getCatalog(slugify(itArea.label)) : [];
	const seen = new Map<number, string>();
	for (const e of entries) if (!seen.has(e.unitId)) seen.set(e.unitId, e.unitName);
	const units = [...seen.entries()]
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	for (const u of units) dbUpsertUnit(UF, u).catch(() => {});
	return units;
}

async function getAreas(): Promise<Area[]> {
	const areas = await getAreaOptions();
	return areas
		.map((a) => ({ slug: slugify(a.label), label: a.label }))
		.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	const entries = await getCatalog(areaSlug);
	return [...new Set(entries.map((e) => e.unitId))];
}

async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	const entries = await getCatalog(areaSlug);
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
	const entries = await getCatalog(areaSlug);
	const courses = entries
		.filter((e) => e.unitId === unitId && e.isPaid)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const ceAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "senai-ce.org.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
