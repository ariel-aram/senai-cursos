import acFlag from "./assets/ac.png";
import acLogo from "./assets/ac-senai.png";
import alFlag from "./assets/al.png";
import alLogo from "./assets/al-senai.png";
import amFlag from "./assets/am.png";
import amLogo from "./assets/am-senai.png";
import apFlag from "./assets/ap.png";
import apLogo from "./assets/ap-senai.png";
// bh-senai.png / bh.png are used for Bahia (BA) — the asset set had no ba-* files.
import baFlag from "./assets/bh.png";
import baLogo from "./assets/bh-senai.png";
import ceFlag from "./assets/ce.png";
import ceLogo from "./assets/ce-senai.png";
import dfFlag from "./assets/df.png";
import dfLogo from "./assets/df-senai.png";
import esFlag from "./assets/es.png";
import esLogo from "./assets/es-senai.png";
import goFlag from "./assets/go.png";
import goLogo from "./assets/go-senai.png";
import maFlag from "./assets/ma.png";
import maLogo from "./assets/ma-senai.png";
import mgFlag from "./assets/mg.png";
import mgLogo from "./assets/mg-senai.png";
import msFlag from "./assets/ms.png";
import msLogo from "./assets/ms-senai.png";
import mtFlag from "./assets/mt.png";
import mtLogo from "./assets/mt-senai.png";
import paFlag from "./assets/pa.png";
import paLogo from "./assets/pa-senai.png";
import pbFlag from "./assets/pb.png";
import pbLogo from "./assets/pb-senai.png";
import peFlag from "./assets/pe.png";
import peLogo from "./assets/pe-senai.png";
import piFlag from "./assets/pi.png";
import piLogo from "./assets/pi-senai.png";
import prFlag from "./assets/pr.png";
import prLogo from "./assets/pr-senai.png";
import rjFlag from "./assets/rj.png";
import rjLogo from "./assets/rj-senai.png";
import rnFlag from "./assets/rn.png";
import rnLogo from "./assets/rn-senai.png";
import roFlag from "./assets/ro.png";
import roLogo from "./assets/ro-senai.png";
import rrFlag from "./assets/rr.png";
import rrLogo from "./assets/rr-senai.png";
import rsFlag from "./assets/rs.png";
import rsLogo from "./assets/rs-senai.png";
import scFlag from "./assets/sc.png";
import scLogo from "./assets/sc-senai.png";
import seFlag from "./assets/se.png";
import seLogo from "./assets/se-senai.png";
import spFlag from "./assets/sp.png";
import toFlag from "./assets/to.png";
import toLogo from "./assets/to-senai.png";
import logoUrl from "./logo.svg";
import type { StateCode } from "./types";

/** Single source of truth for every state's cosmetic/static info: display name,
 * logo, flag, brand hue, and a fallback sourceLabel domain. Deliberately free of
 * any adapter/db/config import — this module is bundled into the BROWSER (App.tsx
 * imports it directly), so it must never pull in server-only code (process.env,
 * SurrealDB, fetch-based scrapers). Real "active vs coming-soon" status is server
 * truth (see adapters/registry.ts) fetched at runtime via /api/states. */
export const STATE_META: Record<
	StateCode,
	{ name: string; logo: string; flag: string; hue: number; sourceLabel: string }
> = {
	sp: { name: "São Paulo", logo: logoUrl, flag: spFlag, hue: 20, sourceLabel: "sp.senai.br" },
	sc: {
		name: "Santa Catarina",
		logo: scLogo,
		flag: scFlag,
		hue: 145,
		sourceLabel: "cursos.sesisenai.org.br",
	},
	ac: { name: "Acre", logo: acLogo, flag: acFlag, hue: 55, sourceLabel: "senaiac.org.br" },
	al: { name: "Alagoas", logo: alLogo, flag: alFlag, hue: 300, sourceLabel: "al.senai.br" },
	am: {
		name: "Amazonas",
		logo: amLogo,
		flag: amFlag,
		hue: 15,
		sourceLabel: "fieam.org.br/senai",
	},
	ap: { name: "Amapá", logo: apLogo, flag: apFlag, hue: 130, sourceLabel: "ap.senai.br" },
	ba: {
		name: "Bahia",
		logo: baLogo,
		flag: baFlag,
		hue: 30,
		sourceLabel: "curtaduracaosenaiba.com.br",
	},
	ce: { name: "Ceará", logo: ceLogo, flag: ceFlag, hue: 90, sourceLabel: "senai-ce.org.br" },
	df: {
		name: "Distrito Federal",
		logo: dfLogo,
		flag: dfFlag,
		hue: 110,
		sourceLabel: "cursos.senaidf.org.br",
	},
	es: {
		name: "Espírito Santo",
		logo: esLogo,
		flag: esFlag,
		hue: 350,
		sourceLabel: "senaies.com.br",
	},
	go: { name: "Goiás", logo: goLogo, flag: goFlag, hue: 100, sourceLabel: "senaigoias.com.br" },
	ma: {
		name: "Maranhão",
		logo: maLogo,
		flag: maFlag,
		hue: 340,
		sourceLabel: "futuro.digital/senai-ma",
	},
	mg: { name: "Minas Gerais", logo: mgLogo, flag: mgFlag, hue: 20, sourceLabel: "fiemg.com.br" },
	ms: {
		name: "Mato Grosso do Sul",
		logo: msLogo,
		flag: msFlag,
		hue: 215,
		sourceLabel: "ms.senai.br",
	},
	mt: {
		name: "Mato Grosso",
		logo: mtLogo,
		flag: mtFlag,
		hue: 270,
		sourceLabel: "senaimt.ind.br",
	},
	pa: { name: "Pará", logo: paLogo, flag: paFlag, hue: 355, sourceLabel: "senaipa.org.br" },
	pb: {
		name: "Paraíba",
		logo: pbLogo,
		flag: pbFlag,
		hue: 5,
		sourceLabel: "fiepb.com.br/senai",
	},
	pe: { name: "Pernambuco", logo: peLogo, flag: peFlag, hue: 258, sourceLabel: "pe.senai.br" },
	pi: { name: "Piauí", logo: piLogo, flag: piFlag, hue: 175, sourceLabel: "fiepi.com.br" },
	pr: {
		name: "Paraná",
		logo: prLogo,
		flag: prFlag,
		hue: 195,
		sourceLabel: "novo.senaipr.org.br",
	},
	rj: {
		name: "Rio de Janeiro",
		logo: rjLogo,
		flag: rjFlag,
		hue: 248,
		sourceLabel: "firjansenai.com.br",
	},
	rn: {
		name: "Rio Grande do Norte",
		logo: rnLogo,
		flag: rnFlag,
		hue: 265,
		sourceLabel: "rn.senai.br",
	},
	rs: {
		name: "Rio Grande do Sul",
		logo: rsLogo,
		flag: rsFlag,
		hue: 155,
		sourceLabel: "cursos.senairs.org.br",
	},
	ro: {
		name: "Rondônia",
		logo: roLogo,
		flag: roFlag,
		hue: 160,
		sourceLabel: "portal.fiero.org.br/senai",
	},
	rr: { name: "Roraima", logo: rrLogo, flag: rrFlag, hue: 75, sourceLabel: "rr.senai.br" },
	se: { name: "Sergipe", logo: seLogo, flag: seFlag, hue: 45, sourceLabel: "se.senai.br" },
	to: {
		name: "Tocantins",
		logo: toLogo,
		flag: toFlag,
		hue: 185,
		sourceLabel: "senai-to.com.br",
	},
};

/** Selector display order — SP and SC first (longest-running live adapters), then
 * alphabetical. Drives both the backend's /api/states response and the frontend
 * selector directly (see STATE_ORDER usage in App.tsx). */
export const STATE_ORDER = Object.keys(STATE_META) as StateCode[];

/** First-paint hint only, so SP doesn't flash "coming soon" before /api/states
 * resolves (same-origin, near-instant, but not synchronous). The real status
 * always comes from the server — see ADAPTERS in adapters/registry.ts, which is
 * the actual source of truth and must be kept in sync with this list. */
export const KNOWN_ACTIVE: readonly StateCode[] = [
	"sp",
	"sc",
	"al",
	"rs",
	"ma",
	"mg",
	"ms",
	"go",
	"to",
	"pi",
	"ro",
	"ce",
	"mt",
	"df",
	"pr",
	"es",
	"pa",
	"pe",
	"rn",
];
