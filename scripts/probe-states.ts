/**
 * Platform-family detector for all 27 Brazilian SENAI state portals.
 *
 * Fetches each state's homepage + likely "cursos" listing page, greps for
 * platform signatures (WordPress, VTEX, Nuxt, Next, Drupal, MatriculaWebSENAI,
 * SP-custom PHP), and writes scripts/platform-manifest.json.
 *
 * Run:  bun scripts/probe-states.ts
 *
 * Each request uses an identifiable User-Agent and a 1-second inter-request
 * delay to be gentle on the upstream servers.
 */

interface ProbeTarget {
	uf: string;
	name: string;
	urls: string[];
}

const UA =
	"SENAI-Course-Intelligence/1.0 (platform-research; +https://github.com/ariel-aram/senai-cursos)";

const TARGETS: ProbeTarget[] = [
	{
		uf: "sp",
		name: "São Paulo",
		urls: ["https://www.sp.senai.br/cursos/cursos-livres/tecnologia-da-informacao-e-informatica"],
	},
	{
		uf: "sc",
		name: "Santa Catarina",
		urls: ["https://cursos.sesisenai.org.br/cursos-profissionalizantes"],
	},
	{
		uf: "ac",
		name: "Acre",
		urls: ["https://senaiac.org.br/", "https://senaiac.org.br/category/cursos/"],
	},
	{ uf: "al", name: "Alagoas", urls: ["https://al.senai.br/cursos/", "https://al.senai.br/"] },
	{
		uf: "ap",
		name: "Amapá",
		urls: ["https://www.ap.senai.br/", "https://ap.senai.br/educacao-profissional.html"],
	},
	{
		uf: "am",
		name: "Amazonas",
		urls: ["https://fieam.org.br/senai/", "https://fieam.org.br/senai/cursos-do-senai/"],
	},
	{
		uf: "ba",
		name: "Bahia",
		urls: ["https://curtaduracaosenaiba.com.br/", "https://www.senaibahia.com.br/"],
	},
	{
		uf: "ce",
		name: "Ceará",
		urls: ["https://www.senai-ce.org.br/cursos", "https://www.senai-ce.org.br/"],
	},
	{
		uf: "df",
		name: "Distrito Federal",
		urls: [
			"https://cursos.senaidf.org.br/",
			"https://www.sistemafibra.org.br/senai/educacao/educacao-profissional",
		],
	},
	{
		uf: "es",
		name: "Espírito Santo",
		urls: ["https://senaies.com.br/", "https://conteudo.senaies.com.br/cursos-qualificacao"],
	},
	{
		uf: "go",
		name: "Goiás",
		urls: [
			"https://senaigoias.com.br/cursos/",
			"https://conteudo.senaigoias.com.br/cursos-profissionalizantes",
		],
	},
	{
		uf: "ma",
		name: "Maranhão",
		urls: ["https://www.fiema.org.br/senai", "https://www.futuro.digital/senai-ma"],
	},
	{
		uf: "mt",
		name: "Mato Grosso",
		urls: ["https://senaimt.ind.br/para-voce/cursos", "https://senaimt.ind.br/"],
	},
	{
		uf: "ms",
		name: "Mato Grosso do Sul",
		urls: ["https://www.ms.senai.br/para-voce", "https://www.ms.senai.br/"],
	},
	{
		uf: "mg",
		name: "Minas Gerais",
		urls: [
			"https://www.fiemg.com.br/cursos-tecnicos-senai/",
			"https://secure.futuro.digital/cursos-profissionalizantes/SENAI%20Nacional",
		],
	},
	{
		uf: "pa",
		name: "Pará",
		urls: ["https://www.senaipa.org.br/sistema-cursos", "https://www.senaipa.org.br/"],
	},
	{
		uf: "pb",
		name: "Paraíba",
		urls: ["https://fiepb.com.br/senai/cursos", "https://fiepb.com.br/senai"],
	},
	{
		uf: "pe",
		name: "Pernambuco",
		urls: ["https://cursos.pe.senai.br/futuro-digital", "https://mkt.pe.senai.br/tecnicos"],
	},
	{
		uf: "pi",
		name: "Piauí",
		urls: ["https://www.fiepi.com.br/", "https://www.fiepi.com.br/servicos/senai_ead_pf/"],
	},
	{
		uf: "pr",
		name: "Paraná",
		urls: [
			"https://novo.senaipr.org.br/pt/cursos-tecnicos",
			"https://www.senaipr.org.br/cursos-tecnicos/",
		],
	},
	{
		uf: "rj",
		name: "Rio de Janeiro",
		urls: ["https://firjansenai.com.br/cursos", "https://www.firjan.com.br/senai/"],
	},
	{
		uf: "rn",
		name: "Rio Grande do Norte",
		urls: ["https://www.rn.senai.br/cursos", "https://www.rn.senai.br/"],
	},
	{
		uf: "rs",
		name: "Rio Grande do Sul",
		urls: ["https://cursos.senairs.org.br/", "https://www.senairs.org.br/cursos"],
	},
	{
		uf: "ro",
		name: "Rondônia",
		urls: ["https://portal.fiero.org.br/senai", "https://portal.fiero.org.br/"],
	},
	{ uf: "rr", name: "Roraima", urls: ["https://rr.senai.br/", "https://rr.senai.br/home"] },
	{
		uf: "se",
		name: "Sergipe",
		urls: ["https://www.se.senai.br/cursos", "https://www.se.senai.br/"],
	},
	{
		uf: "to",
		name: "Tocantins",
		urls: ["http://cursos.senai-to.com.br/", "http://senai-to.com.br/"],
	},
];

interface PlatformSignatures {
	platform: string;
	evidence: string[];
}

function classifyPlatform(html: string, url: string): PlatformSignatures {
	const lower = html.toLowerCase();
	const evidence: string[] = [];

	if (lower.includes("wp-json") || lower.includes("wp-content") || lower.includes("wp-includes")) {
		evidence.push("wp-json/wp-content detected");
	}
	if (lower.includes("elementor")) {
		evidence.push("Elementor page builder");
	}
	if (lower.includes("futuro.digital") || url.includes("futuro.digital")) {
		evidence.push("futuro.digital e-commerce");
	}
	if (lower.includes("vtex") || lower.includes("/api/catalog_system/")) {
		evidence.push("VTEX catalog API");
	}
	if (lower.includes("__nuxt__") || lower.includes("window.__nuxt__")) {
		evidence.push("__NUXT__ hydration data");
	}
	if (lower.includes("__next_data__") || lower.includes("__NEXT_DATA__")) {
		evidence.push("__NEXT_DATA__ hydration");
	}
	if (
		lower.includes("sites/default/files") ||
		lower.includes("drupal.js") ||
		lower.includes("jsonapi")
	) {
		evidence.push("Drupal (sites/default/files or jsonapi)");
	}
	if (lower.includes("matriculaweb") || url.includes("MatriculaWebSENAI")) {
		evidence.push("MatriculaWebSENAI (Sistema FIES ASP.NET)");
	}
	if (lower.includes("openmodalturmas") || lower.includes("cursosturmas")) {
		evidence.push("SP-custom PHP (openModalTurmas / cursosturmas endpoint)");
	}
	if (lower.includes("api-ecommerce.sesisenai") || lower.includes("sesisenai.org.br/api")) {
		evidence.push("SENAI-SC Nuxt JSON API");
	}
	if (url.includes("senai-ce.org.br")) {
		evidence.push("CE-custom (senai-ce.org.br per-course pages)");
	}
	if (lower.includes("aspx") || lower.includes("__viewstate") || lower.includes("/default.aspx")) {
		evidence.push("ASP.NET (aspx/viewstate)");
	}
	if (
		lower.includes("controller/cursos.php") ||
		(url.includes("se.senai.br") && lower.includes("foreach"))
	) {
		evidence.push("Custom PHP (controller/cursos.php)");
	}
	if (lower.includes("joomla") || lower.includes("/components/com_")) {
		evidence.push("Joomla");
	}
	if (
		lower.includes("data-reactroot") ||
		lower.includes("react-dom") ||
		lower.includes("_next/static")
	) {
		evidence.push("React/Next.js SPA");
	}
	if (lower.includes("vue.") || lower.includes("data-v-")) {
		evidence.push("Vue.js SPA");
	}

	let platform = "unknown";
	if (evidence.some((e) => e.includes("SP-custom"))) platform = "sp-php";
	else if (evidence.some((e) => e.includes("futuro.digital") || e.includes("VTEX")))
		platform = "vtex";
	else if (evidence.some((e) => e.includes("__NUXT__"))) platform = "nuxt";
	else if (evidence.some((e) => e.includes("__NEXT_DATA__") || e.includes("React/Next")))
		platform = "next";
	else if (evidence.some((e) => e.includes("SENAI-SC Nuxt"))) platform = "sc-nuxt";
	else if (evidence.some((e) => e.includes("Elementor") || e.includes("wp-json")))
		platform = "wordpress";
	else if (evidence.some((e) => e.includes("Drupal"))) platform = "drupal";
	else if (evidence.some((e) => e.includes("MatriculaWebSENAI"))) platform = "matriculaweb";
	else if (evidence.some((e) => e.includes("CE-custom"))) platform = "ce-custom";
	else if (evidence.some((e) => e.includes("ASP.NET"))) platform = "aspnet";
	else if (evidence.some((e) => e.includes("Custom PHP"))) platform = "custom-php";
	else if (evidence.some((e) => e.includes("Joomla"))) platform = "joomla";

	return { platform, evidence };
}

interface ManifestEntry {
	uf: string;
	name: string;
	reachedUrl: string;
	statusCode: number;
	platform: string;
	evidence: string[];
	redirectedTo: string | null;
	notes: string;
}

async function fetchWithRedirect(
	url: string,
	timeoutMs = 15000,
): Promise<{ body: string; status: number; finalUrl: string }> {
	const res = await fetch(url, {
		headers: { "User-Agent": UA, accept: "text/html" },
		signal: AbortSignal.timeout(timeoutMs),
		redirect: "follow",
	});
	return { body: await res.text(), status: res.status, finalUrl: res.url };
}

const manifest: ManifestEntry[] = [];

for (const target of TARGETS) {
	let result: ManifestEntry | null = null;

	for (const url of target.urls) {
		try {
			await Bun.sleep(1000);
			console.log(`[${target.uf}] probing ${url}…`);
			const { body, status, finalUrl } = await fetchWithRedirect(url);

			if (status >= 400 || body.length < 500) {
				console.log(`  → status ${status}, ${body.length} bytes — trying next candidate`);
				continue;
			}

			const { platform, evidence } = classifyPlatform(body, finalUrl);
			result = {
				uf: target.uf,
				name: target.name,
				reachedUrl: finalUrl,
				statusCode: status,
				platform,
				evidence,
				redirectedTo: finalUrl !== url ? finalUrl : null,
				notes:
					evidence.length === 0 ? "No platform signature detected — needs DevTools inspection" : "",
			};
			console.log(`  → ${platform} (${status}, ${body.length} bytes)`);
			break;
		} catch (err) {
			console.log(
				`  → error: ${err instanceof Error ? err.message : "unknown"} — trying next candidate`,
			);
		}
	}

	if (!result) {
		result = {
			uf: target.uf,
			name: target.name,
			reachedUrl: "",
			statusCode: 0,
			platform: "unreachable",
			evidence: [],
			redirectedTo: null,
			notes: "All candidate URLs failed — domain may be different or site offline",
		};
		console.log(`  → UNREACHABLE`);
	}

	manifest.push(result);
}

const manifestPath = new URL("./platform-manifest.json", import.meta.url);
await Bun.write(manifestPath, JSON.stringify(manifest, null, "\t"));
console.log(`\nManifest written to ${manifestPath.pathname}`);

const byPlatform = new Map<string, string[]>();
for (const m of manifest) {
	const list = byPlatform.get(m.platform) ?? [];
	list.push(m.uf);
	byPlatform.set(m.platform, list);
}
console.log("\n── Platform families ──");
for (const [platform, ufs] of [...byPlatform.entries()].sort()) {
	console.log(`  ${platform}: ${ufs.join(", ")} (${ufs.length})`);
}
