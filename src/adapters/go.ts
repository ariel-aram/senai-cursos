import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson, slugify } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "go";

// SENAI-GO's real commerce catalog runs on a VTEX account ("tewbhv") shared by
// several "futuro.digital" states — same backend behind ma.ts's Vercel micro-app
// (its images are served from the same tewbhv.vteximg.com.br host). The classic
// VTEX legacy search REST API is public, no auth required:
//   https://tewbhv.vtexcommercestable.com.br/api/catalog_system/pub/products/search
// GO's own products are tagged into four state-specific clusters, discovered by
// inspecting productClusters on any GO product returned by that search:
const CLUSTER_IDS = [550, 551, 553, 554]; // profissionalizantes, técnicos, presenciais, ead
const SEARCH_BASE =
	"https://tewbhv.vtexcommercestable.com.br/api/catalog_system/pub/products/search";
const PAGE_SIZE = 50;
const VTEX_TIMEOUT_MS = 30_000; // these pages can run past the default fetch timeout

// Every GO product carries a real "Área Tecnológica" specification field — used
// here to tag EVERY product into its real category, not just T.I. It isn't
// perfectly clean, though: manual audit during development found "Técnico em
// Vestuário" (a fashion/textile course) mistagged as "Tecnologia da Informação"
// despite its own category path saying "Demais Áreas" — IT_MISTAG_KEYWORDS is a
// small override for exactly that kind of source data error.
const IT_AREA = "Tecnologia da Informação";
const IT_MISTAG_KEYWORDS = /vestu[aá]rio|confec[çc][ãa]o de roupas|t[êe]xtil|\bmoda\b/i;

// commertialOffer.AvailableQuantity is a fixed sentinel here too (0 or 100, never
// a real headcount — see ma.ts for the same pattern) — but unlike MA, IsAvailable
// is a genuine, currently-accurate in-stock/out-of-stock flag (VTEX's own checkout
// eligibility check). So instead of showing every course ever offered with a fake
// vagas number, this adapter only surfaces items that are actually orderable right
// now (IsAvailable === true) and still stores vagas: null — same "Ver no site"
// treatment as MA, just applied to a pre-filtered, currently-real set of turmas.

interface VtexOffer {
	Price: number;
	AvailableQuantity: number;
	IsAvailable: boolean;
}

interface VtexItem {
	itemId: string;
	Cidade?: string[];
	Turno?: string[];
	"Dia da Semana"?: string[];
	sellers?: { commertialOffer: VtexOffer }[];
}

interface VtexProduct {
	productId: string;
	productName: string;
	linkText: string;
	link: string;
	"Área Tecnológica"?: string[];
	"Carga Horária"?: string[];
	items?: VtexItem[];
}

interface CatalogEntry {
	cityId: number;
	cityName: string;
	areaSlug: string;
	areaLabel: string;
	isPaid: boolean;
	course: Course;
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

async function fetchCluster(clusterId: number): Promise<VtexProduct[]> {
	const all: VtexProduct[] = [];
	for (let from = 0; from < 500; from += PAGE_SIZE) {
		const to = from + PAGE_SIZE - 1;
		const page = await getJson<VtexProduct[]>(
			`${SEARCH_BASE}?fq=productClusterIds:${clusterId}&_from=${from}&_to=${to}`,
			VTEX_TIMEOUT_MS,
		);
		if (!page || page.length === 0) break;
		all.push(...page);
		if (page.length < PAGE_SIZE) break;
	}
	return all;
}

function resolveArea(p: VtexProduct): string | null {
	const area = p["Área Tecnológica"]?.[0];
	if (!area) return null;
	if (area === IT_AREA && IT_MISTAG_KEYWORDS.test(p.productName)) return null;
	return area;
}

function formatPrice(price: number): string[] {
	if (!price) return [];
	return [`R$ ${price.toFixed(2).replace(".", ",")}`];
}

function buildEntries(products: VtexProduct[]): CatalogEntry[] {
	const entries: CatalogEntry[] = [];
	for (const p of products) {
		const areaLabel = resolveArea(p);
		if (!areaLabel) continue;
		const areaSlug = slugify(areaLabel);

		const hoursRaw = p["Carga Horária"]?.[0];
		const hours = hoursRaw ? parseInt(hoursRaw, 10) : 0;

		for (const item of p.items ?? []) {
			const offer = item.sellers?.[0]?.commertialOffer;
			if (!offer?.IsAvailable) continue;
			const cityName = item.Cidade?.[0];
			if (!cityName) continue;

			const periodo = item.Turno?.[0] ?? "";
			const prices = formatPrice(offer.Price);

			entries.push({
				cityId: getCityId(cityName),
				cityName,
				areaSlug,
				areaLabel,
				isPaid: prices.length > 0,
				course: {
					name: p.productName,
					slug: p.linkText,
					id: parseInt(item.itemId, 10),
					hours,
					vagas: null,
					turmas: 1,
					startDates: [],
					schedules: periodo ? [{ periodo, horario: item["Dia da Semana"]?.[0] ?? "" }] : [],
					prices,
					isBolsa: false,
					url: p.link,
				},
			});
		}
	}
	return entries;
}

async function buildCatalog(): Promise<CatalogEntry[]> {
	const perCluster = await Promise.all(CLUSTER_IDS.map(fetchCluster));
	const byId = new Map<string, VtexProduct>();
	for (const products of perCluster) {
		for (const p of products) byId.set(p.productId, p);
	}
	const entries = buildEntries([...byId.values()]);
	console.log(
		`[go] ${entries.length} oferta(s) em ${new Set(entries.map((e) => e.areaSlug)).size} área(s) de ${byId.size} produto(s) totais nos clusters`,
	);
	return entries;
}

// isEmpty guard: an empty result almost always means a transient VTEX fetch
// failure across all 4 clusters, not that GO genuinely has zero products — see
// KeyedAsyncCache's doc comment. GO builds its whole (small, ~100-product)
// catalog in one shot rather than per-área, so there's only one cache key here.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
const getCatalog = () => catalogCache.get("all", buildCatalog);

async function getUnits(): Promise<UnitInfo[]> {
	const entries = await getCatalog();
	const seen = new Map<number, string>();
	for (const e of entries) if (!seen.has(e.cityId)) seen.set(e.cityId, e.cityName);
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
	return [...new Set(entries.filter((e) => e.areaSlug === areaSlug).map((e) => e.cityId))];
}

async function getUnitData(unitId: number, areaSlug: string, _force = false): Promise<CoursesData> {
	const entries = await getCatalog();
	const courses = entries
		.filter((e) => e.cityId === unitId && e.areaSlug === areaSlug && !e.isPaid)
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
		.filter((e) => e.cityId === unitId && e.areaSlug === areaSlug && e.isPaid)
		.map((e) => e.course)
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	if (courses.length) dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});
	return { courses, lastUpdated: new Date().toISOString() };
}

export const goAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "tewbhv.vtexcommercestable.com.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
