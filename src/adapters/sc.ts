import { config } from "../../config/config";
import { DEFAULT_AREA_SLUG } from "../constants";
import { dbGetCourses, dbGetScrapedAt, dbUpsertCourses, dbUpsertUnit } from "../db";
import type { Area, Course, CoursesData, UnitInfo } from "../types";
import { getJson, slugify, withConcurrency } from "./http";
import { KeyedAsyncCache } from "./keyed-cache";
import type { StateAdapter } from "./types";

const UF = "sc";

// SENAI-SC runs on a completely different platform than SP: a modern Nuxt.js
// storefront (cursos.sesisenai.org.br) backed by a real JSON API — no HTML
// regex-scraping needed. Discovered by inspecting network calls in the browser
// (the same "element inspection" method used to find SP's hidden endpoint).
const SEARCH_BASE = "https://api-ecommerce.sesisenai.org.br/api/produto-busca";
const DETAIL_BASE = "https://cursos.sesisenai.org.br/api/produto/detalhes";
const AREAS_URL = "https://api-ecommerce.sesisenai.org.br/api/grupo-area-atuacao";

// id_modalidade=3 → "Cursos Profissionalizantes" (paid); id_tipo_curso=2 → presencial.
// id_grupo_area_atuacao is real per-category data from AREAS_URL — no keyword
// guessing needed, unlike ma.ts. Only "ativo: true" entries are real, browsable
// categories; inactive ones (found auditing AREAS_URL's response) return no results.
const BASE_SEARCH_QS = "id_modalidade[]=3&id_tipo_curso[]=2";

// NOTE: SC's free/gratuito courses live on a separate system
// (cursostecnicosgratuitos.sc.senai.br) that only exposes a lead-capture form,
// not a live searchable catalog with vacancy data — so getUnitData() below
// always returns an empty list until that's investigated separately.

interface AreaGroup {
	id_grupo_area_atuacao: number;
	descricao: string;
	ativo: boolean;
}

interface SearchItem {
	id_produto: number;
	preco_original: number | null;
}

interface SearchResponse {
	itens: SearchItem[];
}

interface OfertaItem {
	id_unidade_execucao: number;
	nome: string;
	vagas: number;
	carga_horaria: number | null;
}

interface ProdutoDetalhes {
	id_produto: number;
	titulo: string;
	titulo_slug: string;
	carga_presencial: number | null;
	oferta: OfertaItem[] | null;
}

interface CatalogEntry {
	productId: number;
	title: string;
	slug: string;
	hours: number;
	unitId: number;
	unitName: string;
	areaSlug: string;
	vagas: number;
	price: number | null;
}

async function fetchAreaGroups(): Promise<AreaGroup[]> {
	const json = await getJson<AreaGroup[]>(AREAS_URL);
	return (json ?? []).filter((a) => a.ativo);
}

// isEmpty guard: an empty result almost always means a transient fetch failure
// (e.g. startup contention from all 5 states warming up concurrently), not that
// SC genuinely has zero active categories — see KeyedAsyncCache's doc comment.
const areasCache = new KeyedAsyncCache<AreaGroup[]>(config.catalogTtlMs, (v) => v.length === 0);
const getAreaGroups = () => areasCache.get("areas", fetchAreaGroups);

async function searchProductIds(areaGroupId: number): Promise<number[]> {
	const ids = new Set<number>();
	for (let pagina = 1; pagina <= 10; pagina++) {
		const json = await getJson<SearchResponse>(
			`${SEARCH_BASE}?${BASE_SEARCH_QS}&id_grupo_area_atuacao=${areaGroupId}&pagina=${pagina}`,
		);
		const itens = json?.itens ?? [];
		if (itens.length === 0) break;
		for (const it of itens) ids.add(it.id_produto);
	}
	return [...ids];
}

async function searchPrices(areaGroupId: number): Promise<Map<number, number | null>> {
	const priceByProduct = new Map<number, number | null>();
	for (let pagina = 1; pagina <= 10; pagina++) {
		const json = await getJson<SearchResponse>(
			`${SEARCH_BASE}?${BASE_SEARCH_QS}&id_grupo_area_atuacao=${areaGroupId}&pagina=${pagina}`,
		);
		const itens = json?.itens ?? [];
		if (itens.length === 0) break;
		for (const it of itens) priceByProduct.set(it.id_produto, it.preco_original);
	}
	return priceByProduct;
}

// One catalog PER área, built lazily on first request — not one combined build
// across all ~15 areas. getUnits() in particular doesn't need every área's
// catalog since units are the same physical cities regardless of category, so
// it only needs the default área's catalog, same approach as sp.ts/to.ts.
async function buildCatalogForArea(area: AreaGroup): Promise<CatalogEntry[]> {
	const areaSlug = slugify(area.descricao);
	const productIds = await searchProductIds(area.id_grupo_area_atuacao);
	if (productIds.length === 0) return [];

	const [details, priceByProduct] = await Promise.all([
		withConcurrency(
			productIds.map((id) => () => getJson<ProdutoDetalhes>(`${DETAIL_BASE}/${id}`)),
			config.catalogConcurrency,
		),
		searchPrices(area.id_grupo_area_atuacao),
	]);

	const entries: CatalogEntry[] = [];
	for (const detail of details) {
		if (!detail?.oferta) continue;
		for (const oferta of detail.oferta) {
			entries.push({
				productId: detail.id_produto,
				title: detail.titulo,
				slug: detail.titulo_slug,
				hours: oferta.carga_horaria ?? detail.carga_presencial ?? 0,
				unitId: oferta.id_unidade_execucao,
				unitName: oferta.nome,
				areaSlug,
				vagas: oferta.vagas ?? 0,
				price: priceByProduct.get(detail.id_produto) ?? null,
			});
		}
	}
	console.log(
		`[sc] ${entries.length} oferta(s) em "${area.descricao}" de ${productIds.length} produto(s)`,
	);
	return entries;
}

// Empty is a real, cacheable answer for one área's catalog — no isEmpty guard,
// unlike the área LIST cache above.
const catalogCache = new KeyedAsyncCache<CatalogEntry[]>(config.catalogTtlMs);

async function getCatalog(areaSlug: string): Promise<CatalogEntry[]> {
	return catalogCache.get(areaSlug, async () => {
		const areaGroups = await getAreaGroups();
		const area = areaGroups.find((a) => slugify(a.descricao) === areaSlug);
		return area ? buildCatalogForArea(area) : [];
	});
}

let unitsCache: UnitInfo[] | null = null;

async function getUnits(): Promise<UnitInfo[]> {
	if (unitsCache) return unitsCache;
	const entries = await getCatalog(DEFAULT_AREA_SLUG);
	const seen = new Map<number, string>();
	for (const e of entries) if (!seen.has(e.unitId)) seen.set(e.unitId, e.unitName);
	const units = [...seen.entries()]
		.map(([id, name]) => ({ id, name }))
		.sort((a, b) => a.name.localeCompare(b.name, "pt-BR"));
	unitsCache = units;
	for (const u of units) dbUpsertUnit(UF, u).catch(() => {});
	return units;
}

async function getAreas(): Promise<Area[]> {
	const areaGroups = await getAreaGroups();
	return areaGroups
		.map((a) => ({ slug: slugify(a.descricao), label: a.descricao }))
		.sort((a, b) => a.label.localeCompare(b.label, "pt-BR"));
}

async function getCatalogUnitIds(areaSlug: string): Promise<number[]> {
	const entries = await getCatalog(areaSlug);
	return [...new Set(entries.map((e) => e.unitId))];
}

function formatPrice(price: number | null): string[] {
	if (price === null) return [];
	return [`R$ ${price.toFixed(2).replace(".", ",")}`];
}

// SC's free/gratuito catalog isn't available through a live API yet (see note above).
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
	force = false,
): Promise<CoursesData> {
	const cacheKey = `${areaSlug}:${unitId}`;
	const cached = unitPaidDataCache.get(cacheKey);
	const isStale = !cached || Date.now() - cached.updatedAt > config.unitTtlMs;
	if (!force && !isStale && cached) return cached.data;

	if (!force) {
		const dbTs = await dbGetScrapedAt(UF, areaSlug, unitId, true);
		if (dbTs !== null && Date.now() - dbTs < config.unitTtlMs) {
			const dbData = await dbGetCourses(UF, areaSlug, unitId, true);
			if (dbData) {
				unitPaidDataCache.set(cacheKey, { data: dbData, updatedAt: dbTs });
				return dbData;
			}
		}
	}

	try {
		const entries = await getCatalog(areaSlug);
		const courses: Course[] = entries
			.filter((e) => e.unitId === unitId)
			.map((e) => ({
				name: e.title,
				slug: e.slug,
				id: e.productId,
				hours: e.hours,
				vagas: e.vagas,
				turmas: e.vagas > 0 ? 1 : 0,
				startDates: [],
				schedules: [],
				prices: formatPrice(e.price),
				isBolsa: false,
			}));
		courses.sort(
			(a, b) => (b.vagas ?? 0) - (a.vagas ?? 0) || a.name.localeCompare(b.name, "pt-BR"),
		);

		dbUpsertCourses(UF, areaSlug, unitId, courses, true).catch(() => {});

		const data = { courses, lastUpdated: new Date().toISOString() };
		unitPaidDataCache.set(cacheKey, { data, updatedAt: Date.now() });
		return data;
	} catch (err) {
		const stale = await dbGetCourses(UF, areaSlug, unitId, true);
		if (stale) {
			unitPaidDataCache.set(cacheKey, {
				data: stale,
				updatedAt: Date.now() - config.unitTtlMs + 60_000,
			});
			return stale;
		}
		throw err;
	}
}

const unitPaidDataCache = new Map<string, { data: CoursesData; updatedAt: number }>();

export const scAdapter: StateAdapter = {
	uf: UF,
	sourceLabel: "cursos.sesisenai.org.br",
	getUnits,
	getAreas,
	getCatalogUnitIds,
	getUnitData,
	getUnitPaidData,
};
