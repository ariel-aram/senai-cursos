import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, RecordId, Surreal } from "surrealdb";
import { config } from "../config/config";
import type { Course, CoursesData, Schedule, UnitInfo } from "./types";

export const db = new Surreal({
	engines: { ...createRemoteEngines(), ...createNodeEngines() },
});
let _connected = false;

// Under concurrent warmup (many units/areas writing at once — at 27-state scale,
// potentially dozens simultaneously), RocksDB's MVCC layer legitimately rejects
// some writes with "Transaction conflict: Resource busy" — the error message
// itself says the transaction can just be retried. Without this, a write lost to
// a conflict was silently dropped (only logged), so persistence could randomly
// miss units/courses under load with no functional symptom to notice by.
async function withWriteRetry<T>(fn: () => Promise<T>, retries = 4): Promise<T> {
	let lastErr: unknown;
	for (let attempt = 0; attempt <= retries; attempt++) {
		try {
			return await fn();
		} catch (err) {
			lastErr = err;
			const isConflict =
				err instanceof Error && /resource busy|transaction conflict/i.test(err.message);
			if (!isConflict || attempt === retries) throw err;
			await Bun.sleep(20 * 2 ** attempt + Math.random() * 20);
		}
	}
	throw lastErr;
}

export async function connectDb(): Promise<void> {
	try {
		await db.connect(config.surrealDbPath);
		await db.use({ namespace: "senai", database: "cursos" });
		_connected = true;
		console.log(`[db] conectado → ${config.surrealDbPath}`);
		await defineSchema();
	} catch (err) {
		console.error("[db] falha ao conectar — continuando sem persistência:", err);
	}
}

// Every read in this file filters by (uf, area, unit_id, is_paid) or just (uf) —
// without an index SurrealDB has to scan the whole course/unit table per query,
// which stops scaling once every SENAI state (not just 5) is writing into the
// same embedded store. IF NOT EXISTS makes this safe to run on every boot.
async function defineSchema(): Promise<void> {
	try {
		await db.query(`
			DEFINE INDEX IF NOT EXISTS course_lookup ON TABLE course FIELDS uf, area, unit_id, is_paid;
			DEFINE INDEX IF NOT EXISTS course_scraped_at ON TABLE course FIELDS scraped_at;
			DEFINE INDEX IF NOT EXISTS unit_lookup ON TABLE unit FIELDS uf;
		`);
	} catch (err) {
		console.error("[db] falha ao definir índices:", err);
	}
}

// ── Tipos internos do banco ───────────────────────────────────────────────────

interface DbCourse {
	uf: string;
	area: string;
	unit_id: number;
	course_id: number;
	name: string;
	slug: string;
	hours: number;
	vagas: number | null;
	turmas: number;
	start_dates: string[];
	schedules: Schedule[];
	prices: string[];
	is_paid: boolean;
	is_bolsa: boolean;
	url?: string;
	scraped_at: string;
}

interface DbUnit {
	uf: string;
	unit_id: number;
	name: string;
	official_id?: number;
}

function rowToCourse(row: DbCourse): Course {
	return {
		name: row.name,
		slug: row.slug,
		id: row.course_id,
		hours: row.hours,
		vagas: row.vagas,
		turmas: row.turmas,
		startDates: row.start_dates,
		schedules: row.schedules,
		prices: row.prices,
		isBolsa: row.is_bolsa ?? false,
		url: row.url,
	};
}

// ── Leitura ───────────────────────────────────────────────────────────────────

export async function dbGetCourses(
	uf: string,
	area: string,
	unitId: number,
	isPaid: boolean,
): Promise<CoursesData | null> {
	if (!_connected) return null;
	try {
		const [rows] = await db.query<[DbCourse[]]>(
			"SELECT * FROM course WHERE uf = $uf AND area = $area AND unit_id = $uid AND is_paid = $paid ORDER BY vagas DESC, name ASC",
			{ uf, area, uid: unitId, paid: isPaid },
		);
		if (!rows?.length) return null;
		const lastUpdated = rows.reduce(
			(latest, r) => (r.scraped_at > latest ? r.scraped_at : latest),
			rows[0]?.scraped_at ?? new Date(0).toISOString(),
		);
		return { courses: rows.map(rowToCourse), lastUpdated };
	} catch {
		return null;
	}
}

export async function dbGetScrapedAt(
	uf: string,
	area: string,
	unitId: number,
	isPaid: boolean,
): Promise<number | null> {
	if (!_connected) return null;
	try {
		const [rows] = await db.query<[{ scraped_at: string }[]]>(
			"SELECT scraped_at FROM course WHERE uf = $uf AND area = $area AND unit_id = $uid AND is_paid = $paid LIMIT 1",
			{ uf, area, uid: unitId, paid: isPaid },
		);
		const row = rows?.[0];
		return row ? new Date(row.scraped_at).getTime() : null;
	} catch {
		return null;
	}
}

export async function dbGetAllUnits(uf: string): Promise<UnitInfo[]> {
	if (!_connected) return [];
	try {
		const [rows] = await db.query<[DbUnit[]]>(
			"SELECT unit_id, name, official_id FROM unit WHERE uf = $uf ORDER BY name ASC",
			{ uf },
		);
		return (rows ?? []).map((r) => ({
			id: r.unit_id,
			name: r.name,
			officialId: r.official_id,
		}));
	} catch {
		return [];
	}
}

// ── Escrita ───────────────────────────────────────────────────────────────────

export async function dbUpsertCourses(
	uf: string,
	area: string,
	unitId: number,
	courses: Course[],
	isPaid: boolean,
): Promise<void> {
	if (!_connected || courses.length === 0) return;
	const scrapedAt = new Date().toISOString();
	const rows = courses.map((c) => ({
		id: `${uf}_${area}_${c.id}_${unitId}_${isPaid ? "p" : "f"}`,
		uf,
		area,
		unit_id: unitId,
		course_id: c.id,
		name: c.name,
		slug: c.slug,
		hours: c.hours,
		vagas: c.vagas,
		turmas: c.turmas,
		start_dates: c.startDates,
		schedules: c.schedules,
		prices: c.prices,
		is_paid: isPaid,
		is_bolsa: c.isBolsa,
		url: c.url,
		scraped_at: scrapedAt,
	}));
	try {
		// One query for the whole batch (a `FOR` block executes as a single
		// statement) instead of N sequential round-trips — at 27-state scale, a
		// unit with dozens of courses upserting one row at a time was the slow
		// path; this also keeps each unit's write atomic instead of interleavable
		// with concurrent warmup writes to other units.
		await withWriteRetry(() =>
			db.query("FOR $row IN $rows { UPSERT type::record('course', $row.id) CONTENT $row };", {
				rows,
			}),
		);
	} catch (err) {
		console.error(`[db] upsert cursos ${uf}/unidade ${unitId}:`, err);
	}
}

// Courses that vanish from a source (discontinued, renamed, category removed)
// are never deleted by dbUpsertCourses — it only ever upserts what the latest
// scrape found. Without this, the table grows without bound as courses rotate
// over the lifetime of 27 states' worth of adapters. Anything not touched by a
// scrape in `maxAgeMs` is safe to drop: every adapter re-upserts its full active
// catalog at least once per catalogTtlMs, so "not scraped in a long while" means
// "no longer offered", not "just hasn't been checked yet".
export async function dbDeleteStaleCourses(maxAgeMs: number): Promise<number> {
	if (!_connected) return 0;
	try {
		const cutoff = new Date(Date.now() - maxAgeMs).toISOString();
		const [rows] = await db.query<[{ id: unknown }[]]>(
			"DELETE course WHERE scraped_at < $cutoff RETURN BEFORE",
			{ cutoff },
		);
		return rows?.length ?? 0;
	} catch (err) {
		console.error("[db] falha ao limpar cursos obsoletos:", err);
		return 0;
	}
}

export async function dbUpsertUnit(uf: string, unit: UnitInfo): Promise<void> {
	if (!_connected) return;
	try {
		await withWriteRetry(() =>
			db
				.upsert<DbUnit>(new RecordId("unit", `${uf}_${unit.id}`))
				.content({ uf, unit_id: unit.id, name: unit.name, official_id: unit.officialId }),
		);
	} catch (err) {
		console.error(`[db] upsert unidade ${uf}/${unit.id}:`, err);
	}
}
