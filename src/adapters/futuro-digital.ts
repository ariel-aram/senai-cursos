import { config } from "../../config/config";
import { dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson, slugify } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

// Several states run their commerce catalog on the SAME shared "futuro.digital"
// VTEX storefront (account "tewbhv") — the same backend behind ma.ts and go.ts.
// Unlike GO (which has its own dedicated, fully-populated clusters), these states
// share one master cluster with every other participating state's products mixed
// together, distinguished only by a "UF|..." prefix on productReferenceCode
// (confirmed by inspecting real product data — e.g. "PI|2257|..." vs "RO|...").
// Cluster 137 ("catalogo-de-cursos") is that master cluster.
//
// This file fetches cluster 137 ONCE (shared, cached) and lets each state's
// adapter filter it by its own reference-code prefix — adding one more state on
// this backend is then just one createFuturoDigitalAdapter() call, no new HTTP
// traffic pattern to design.
const SEARCH_BASE =
	"https://tewbhv.vtexcommercestable.com.br/api/catalog_system/pub/products/search";
const MASTER_CLUSTER_ID = 137;
const PAGE_SIZE = 50;
const VTEX_TIMEOUT_MS = 30_000;
// Real observed size of cluster 137 is ~1200 products across every participating
// state combined; capped well above that so growth doesn't silently truncate it.
const MAX_PAGES = 60;

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

export interface VtexProduct {
	productId: string;
	productName: string;
	productReferenceCode?: string;
	linkText: string;
	link: string;
	"Área Tecnológica"?: string[];
	"Carga Horária"?: string[];
	items?: VtexItem[];
}

async function fetchMasterCluster(): Promise<VtexProduct[]> {
	const all: VtexProduct[] = [];
	for (let page = 0; page < MAX_PAGES; page++) {
		const from = page * PAGE_SIZE;
		const to = from + PAGE_SIZE - 1;
		const batch = await getJson<VtexProduct[]>(
			`${SEARCH_BASE}?fq=productClusterIds:${MASTER_CLUSTER_ID}&_from=${from}&_to=${to}`,
			VTEX_TIMEOUT_MS,
		);
		if (!batch || batch.length === 0) break;
		all.push(...batch);
		if (batch.length < PAGE_SIZE) break;
	}
	return all;
}

// isEmpty guard: an empty result almost always means a transient VTEX fetch
// failure, not that the shared catalog genuinely has zero products — see
// KeyedAsyncCache's doc comment (adapters/keyed-cache.ts).
const masterClusterCache = new KeyedAsyncCache<VtexProduct[]>(
	config.catalogTtlMs,
	(v) => v.length === 0,
);
async function getMasterCluster(): Promise<VtexProduct[]> {
	return masterClusterCache.get("cluster137", fetchMasterCluster);
}

function formatPrice(price: number): string[] {
	if (!price) return [];
	return [`R$ ${price.toFixed(2).replace(".", ",")}`];
}

interface CatalogEntry {
	cityId: number;
	cityName: string;
	areaSlug: string;
	areaLabel: string;
	isPaid: boolean;
	course: Course;
}

/**
 * Builds a StateAdapter for a state whose real catalog lives in tewbhv's shared
 * "futuro.digital" cluster 137, distinguished by `refPrefix` (the state's
 * "UF|" prefix on productReferenceCode — confirmed per-state before wiring in,
 * not guessed from the two-letter uf code, since the prefix is source data).
 */
export function createFuturoDigitalAdapter(uf: string, refPrefix: string): StateAdapter {
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

	function buildEntries(products: VtexProduct[]): CatalogEntry[] {
		const entries: CatalogEntry[] = [];
		for (const p of products) {
			if (!p.productReferenceCode?.startsWith(refPrefix)) continue;
			const areaLabel = p["Área Tecnológica"]?.[0];
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

	const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(config.catalogTtlMs);
	async function getCatalog(): Promise<CatalogEntry[]> {
		return catalogCache.get("all", async () => {
			const products = await getMasterCluster();
			return buildEntries(products);
		});
	}

	async function getUnits(): Promise<UnitInfo[]> {
		const entries = await getCatalog();
		const seen = new Map<number, string>();
		for (const e of entries) if (!seen.has(e.cityId)) seen.set(e.cityId, e.cityName);
		const units = [...seen.entries()]
			.map(([id, name]) => ({ id, name }))
			.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
		for (const u of units) dbUpsertUnit(uf, u).catch(() => {});
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

	async function getUnitData(
		unitId: number,
		areaSlug: string,
		_force = false,
	): Promise<CoursesData> {
		const entries = await getCatalog();
		const courses = entries
			.filter((e) => e.cityId === unitId && e.areaSlug === areaSlug && !e.isPaid)
			.map((e) => e.course)
			.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
		if (courses.length) dbUpsertCourses(uf, areaSlug, unitId, courses, false).catch(() => {});
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
		if (courses.length) dbUpsertCourses(uf, areaSlug, unitId, courses, true).catch(() => {});
		return { courses, lastUpdated: new Date().toISOString() };
	}

	return {
		uf,
		sourceLabel: "tewbhv.vtexcommercestable.com.br",
		getUnits,
		getAreas,
		getCatalogUnitIds,
		getUnitData,
		getUnitPaidData,
	};
}
