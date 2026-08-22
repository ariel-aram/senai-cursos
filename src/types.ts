export interface Schedule {
	periodo: string;
	horario: string;
}

export interface Course {
	name: string;
	slug: string;
	id: number;
	hours: number;
	vagas: number;
	turmas: number;
	startDates: string[];
	schedules: Schedule[];
	prices: string[];
	/** True when the course name contains "BOLSA" — always a free scholarship course. */
	isBolsa: boolean;
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
