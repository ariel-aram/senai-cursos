export interface Schedule {
	periodo: string;
	horario: string;
}

export interface Course {
	name: string;
	slug: string;
	id: number;
	hours: number;
	/** null = source has no real seat-count data (e.g. a marketing feed with a fixed placeholder) — never show a fabricated number. */
	vagas: number | null;
	turmas: number;
	startDates: string[];
	schedules: Schedule[];
	prices: string[];
	/** True when the course name contains "BOLSA" — always a free scholarship course. */
	isBolsa: boolean;
	/** Direct link to the course page on the state's own site, when the adapter has one. */
	url?: string;
}

/** One real course category/subject area a state's source exposes (e.g.
 * "Automação", "Gestão", "Construção Civil"). `slug` is a stable, URL/DB-safe
 * identifier; `label` is the display name shown in the area dropdown. */
export interface Area {
	slug: string;
	label: string;
}

export interface CoursesData {
	courses: Course[];
	lastUpdated: string;
}

export interface UnitInfo {
	/** Internal escolaId used for turmas API calls — not the official unit number. */
	id: number;
	name: string;
	/** Official unit number shown on sp.senai.br/unidades (from secretariaXXX@ emails). */
	officialId?: number;
}

/** Two-letter Brazilian state code this app has a UI entry for (active adapter or "coming soon"). */
export type StateCode =
	| "sp"
	| "sc"
	| "ac"
	| "al"
	| "am"
	| "ap"
	| "ba"
	| "ce"
	| "df"
	| "es"
	| "go"
	| "ma"
	| "mg"
	| "ms"
	| "mt"
	| "pa"
	| "pb"
	| "pe"
	| "pi"
	| "pr"
	| "rj"
	| "rn"
	| "ro"
	| "rr"
	| "rs"
	| "se"
	| "to";

export interface StateInfo {
	uf: StateCode;
	name: string;
	/** Domain shown as the data source (e.g. "sp.senai.br"). */
	sourceLabel: string;
	/** "active" = real scraping/API wired up; "coming-soon" = UI only, no live data yet. */
	status: "active" | "coming-soon";
	/** SENAI brand logo for the state (header). São Paulo keeps logo.svg as the main logo. */
	logo: string;
	/** State flag, shown in the state selector dropdown for visual uniformity. */
	flag: string;
	/** OKLCH hue (0-360) picked by eye from the state's logo — drives --brand-hue. */
	hue: number;
}
