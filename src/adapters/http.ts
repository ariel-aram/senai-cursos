import { config } from "../../config/config";

export function decodeEntities(str: string): string {
	return str
		.replace(/&#x([0-9A-Fa-f]+);/g, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
		.replace(/&#(\d+);/g, (_, dec) => String.fromCharCode(parseInt(dec, 10)))
		.replace(/&amp;/g, "&")
		.replace(/&lt;/g, "<")
		.replace(/&gt;/g, ">")
		.replace(/&quot;/g, '"')
		.replace(/&apos;/g, "'")
		.replace(/<[^>]+>/g, "")
		.trim();
}

// Stable, URL/DB-safe identifier from a display name, e.g. "Tecnologia da
// Informação" → "tecnologia-da-informacao". Used to derive Area.slug values.
export function slugify(name: string): string {
	return name
		.normalize("NFD")
		.replace(/[̀-ͯ]/g, "")
		.toLowerCase()
		.replace(/[^a-z0-9]+/g, "-")
		.replace(/^-+|-+$/g, "");
}

// Run up to `limit` tasks at once; returns results in input order.
export async function withConcurrency<T>(tasks: (() => Promise<T>)[], limit: number): Promise<T[]> {
	const results: T[] = new Array(tasks.length);
	let idx = 0;
	async function worker() {
		while (idx < tasks.length) {
			const i = idx++;
			const task = tasks[i];
			if (task) results[i] = await task();
		}
	}
	await Promise.all(Array.from({ length: Math.min(limit, tasks.length) }, worker));
	return results;
}

// Retry an async task up to `retries` times with exponential backoff.
export async function withRetry<T>(fn: () => Promise<T>, retries = config.maxRetries): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			if (attempt < retries) await Bun.sleep(300 * 2 ** attempt);
		}
	}
	throw lastErr;
}

export async function get(url: string, timeoutMs = config.fetchTimeoutMs): Promise<string> {
	return withRetry(async () => {
		const res = await fetch(url, {
			headers: { "User-Agent": "Mozilla/5.0 (compatible; SENAI-Monitor)" },
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? res.text() : "";
	}).catch(() => "");
}

export async function postForm(
	url: string,
	body: string,
	timeoutMs = config.fetchTimeoutMs,
): Promise<string> {
	return withRetry(async () => {
		const res = await fetch(url, {
			method: "POST",
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; SENAI-Monitor)",
				"Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
				"X-Requested-With": "XMLHttpRequest",
			},
			body,
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? res.text() : "";
	}).catch(() => "");
}

export async function getJson<T>(
	url: string,
	timeoutMs = config.fetchTimeoutMs,
): Promise<T | null> {
	return withRetry(async () => {
		const res = await fetch(url, {
			headers: {
				"User-Agent": "Mozilla/5.0 (compatible; SENAI-Monitor)",
				accept: "application/json",
			},
			signal: AbortSignal.timeout(timeoutMs),
		});
		return res.ok ? ((await res.json()) as T) : null;
	}).catch(() => null);
}
