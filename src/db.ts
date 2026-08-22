import { createNodeEngines } from "@surrealdb/node";
import { createRemoteEngines, RecordId, Surreal } from "surrealdb";
import { config } from "../config/config";
import type { Course, CoursesData, Schedule, UnitInfo } from "./types";

export const db = new Surreal({
	engines: { ...createRemoteEngines(), ...createNodeEngines() },
});
let _connected = false;

export async function connectDb(): Promise<void> {
	try {
		await db.connect(config.surrealDbPath);
		await db.use({ namespace: "senai", database: "cursos" });
		_connected = true;
		console.log(`[db] conectado → ${config.surrealDbPath}`);
	} catch (err) {
		console.error("[db] falha ao conectar — continuando sem persistência:", err);
	}
}

// ── Tipos internos do banco ───────────────────────────────────────────────────

interface DbCourse {
	unit_id: number;
	course_id: number;
	name: string;
	slug: string;
	hours: number;
	vagas: number;
	turmas: number;
	start_dates: string[];
	schedules: Schedule[];
	prices: string[];
	is_paid: boolean;
	is_bolsa: boolean;
	scraped_at: string;
}

interface DbUnit {
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
	};
}

// ── Leitura ───────────────────────────────────────────────────────────────────

export async function dbGetCourses(unitId: number, isPaid: boolean): Promise<CoursesData | null> {
	if (!_connected) return null;
	try {
		const [rows] = await db.query<[DbCourse[]]>(
			"SELECT * FROM course WHERE unit_id = $uid AND is_paid = $paid ORDER BY vagas DESC, name ASC",
			{ uid: unitId, paid: isPaid },
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

export async function dbGetScrapedAt(unitId: number, isPaid: boolean): Promise<number | null> {
	if (!_connected) return null;
	try {
		const [rows] = await db.query<[{ scraped_at: string }[]]>(
			"SELECT scraped_at FROM course WHERE unit_id = $uid AND is_paid = $paid LIMIT 1",
			{ uid: unitId, paid: isPaid },
		);
		const row = rows?.[0];
		return row ? new Date(row.scraped_at).getTime() : null;
	} catch {
		return null;
	}
}

export async function dbGetAllUnits(): Promise<UnitInfo[]> {
	if (!_connected) return [];
	try {
		const [rows] = await db.query<[DbUnit[]]>(
			"SELECT unit_id, name, official_id FROM unit ORDER BY name ASC",
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
	unitId: number,
	courses: Course[],
	isPaid: boolean,
): Promise<void> {
	if (!_connected || courses.length === 0) return;
	const scrapedAt = new Date().toISOString();
	try {
		// Sequential writes avoid MVCC write conflicts under concurrent warmup
		for (const c of courses) {
			await db
				.upsert<DbCourse>(new RecordId("course", `${c.id}_${unitId}_${isPaid ? "p" : "f"}`))
				.content({
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
					scraped_at: scrapedAt,
				});
		}
	} catch (err) {
		console.error(`[db] upsert cursos unidade ${unitId}:`, err);
	}
}

export async function dbUpsertUnit(unit: UnitInfo): Promise<void> {
	if (!_connected) return;
	try {
		await db
			.upsert<DbUnit>(new RecordId("unit", unit.id))
			.content({ unit_id: unit.id, name: unit.name, official_id: unit.officialId });
	} catch (err) {
		console.error(`[db] upsert unidade ${unit.id}:`, err);
	}
}
