import { KNOWN_ACTIVE, STATE_META, STATE_ORDER } from "../state-meta";
import type { StateCode, StateInfo } from "../types";
import { alAdapter } from "./al";
import { ceAdapter } from "./ce";
import { dfAdapter } from "./df";
import { esAdapter } from "./es";
import { goAdapter } from "./go";
import { maAdapter } from "./ma";
import { mgAdapter } from "./mg";
import { msAdapter } from "./ms";
import { mtAdapter } from "./mt";
import { paAdapter } from "./pa";
import { peAdapter } from "./pe";
import { piAdapter } from "./pi";
import { prAdapter } from "./pr";
import { rnAdapter } from "./rn";
import { roAdapter } from "./ro";
import { rsAdapter } from "./rs";
import { scAdapter } from "./sc";
import { spAdapter } from "./sp";
import { toAdapter } from "./to";
import type { StateAdapter } from "./types";

/** uf → adapter, for states with a real, live-verified scraping/API integration.
 * Every other Brazilian SENAI runs on its own domain/CMS (different federação —
 * FIERGS, Sistema FIEP, FIEMG, Firjan…), so there is no shared national scheme to
 * generalize from SP; each additional state needs its own adapter, built the same
 * way SP's, SC's and MA's were: by inspecting that state's real site traffic
 * (see scripts/platform-manifest.json for the platform family each one runs on).
 *
 * This is the actual source of truth for "active vs coming-soon" — keep
 * KNOWN_ACTIVE in ../state-meta.ts (the frontend's first-paint hint) in sync
 * with these keys when adding a state. */
const ADAPTERS: Partial<Record<StateCode, StateAdapter>> = {
	sp: spAdapter,
	sc: scAdapter,
	al: alAdapter,
	rs: rsAdapter,
	ma: maAdapter,
	mg: mgAdapter,
	ms: msAdapter,
	go: goAdapter,
	to: toAdapter,
	pi: piAdapter,
	ro: roAdapter,
	ce: ceAdapter,
	mt: mtAdapter,
	df: dfAdapter,
	pr: prAdapter,
	es: esAdapter,
	pa: paAdapter,
	pe: peAdapter,
	rn: rnAdapter,
};

if (process.env.NODE_ENV !== "production") {
	const known = new Set(KNOWN_ACTIVE);
	const real = new Set(Object.keys(ADAPTERS));
	if (known.size !== real.size || [...known].some((uf) => !real.has(uf))) {
		console.warn(
			`[registry] state-meta.ts KNOWN_ACTIVE (${[...known]}) is out of sync with ADAPTERS (${[...real]})`,
		);
	}
}

export const STATES: StateInfo[] = STATE_ORDER.map((uf) => {
	const meta = STATE_META[uf];
	const adapter = ADAPTERS[uf];
	return {
		uf,
		name: meta.name,
		logo: meta.logo,
		flag: meta.flag,
		hue: meta.hue,
		sourceLabel: adapter?.sourceLabel ?? meta.sourceLabel,
		status: adapter ? "active" : "coming-soon",
	};
});

export function getAdapter(uf: string): StateAdapter | undefined {
	return ADAPTERS[uf as StateCode];
}

export function isKnownState(uf: string): uf is StateCode {
	return uf in STATE_META;
}
