import type { Area, CoursesData, UnitInfo } from "../types";

/** One state's scraping/API integration. Each state's SENAI site is an independent
 * deployment (different domain, different CMS/vendor) — there is no shared national
 * scheme, so every adapter owns its own fetch/parse strategy.
 *
 * Every method that returns course data is scoped to one `areaSlug` (from
 * getAreas()) — callers must always pass one; there is no "all areas" mode.
 * DEFAULT_AREA_SLUG (src/constants.ts) is what the UI defaults to and is
 * guaranteed to resolve for every adapter, even ones that can only enumerate a
 * single real area (see ma.ts). */
export interface StateAdapter {
	uf: string;
	/** Domain shown to users as the data source, e.g. "sp.senai.br". */
	sourceLabel: string;
	getUnits(): Promise<UnitInfo[]>;
	/** Real course categories this state's source exposes — drives the area dropdown. */
	getAreas(): Promise<Area[]>;
	/** All unit IDs known from the catalog for one area — used to drive startup warmup. */
	getCatalogUnitIds(areaSlug: string): Promise<number[]>;
	getUnitData(unitId: number, areaSlug: string, force?: boolean): Promise<CoursesData>;
	getUnitPaidData(unitId: number, areaSlug: string, force?: boolean): Promise<CoursesData>;
}
