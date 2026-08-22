import {
	AlertCircle,
	BookOpen,
	CalendarDays,
	CheckCircle,
	Clock,
	DollarSign,
	Loader2,
	MapPin,
	RefreshCw,
	Search,
	TrendingUp,
	Users,
	XCircle,
} from "lucide-react";
import { memo, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { cn } from "@/lib/utils";
import logoUrl from "./logo.svg";
import "./index.css";

interface Schedule {
	periodo: string;
	horario: string;
}

interface Course {
	name: string;
	slug: string;
	id: number;
	hours: number;
	vagas: number;
	turmas: number;
	startDates: string[];
	schedules: Schedule[];
	prices: string[];
	isBolsa: boolean;
}

interface ApiResponse {
	courses: Course[];
	lastUpdated: string;
}

interface UnitInfo {
	id: number;
	name: string;
	officialId?: number;
}

const REFRESH_INTERVAL_DEFAULT = 5 * 60;
const DEFAULT_UNIT_ID_FALLBACK = 403;

function formatTime(date: string): string {
	return new Date(date).toLocaleTimeString("pt-BR", { hour: "2-digit", minute: "2-digit" });
}

function formatCountdown(seconds: number): string {
	const m = Math.floor(seconds / 60);
	const s = seconds % 60;
	return `${m}:${s.toString().padStart(2, "0")}`;
}

function useTilt(strength = 10) {
	const ref = useRef<HTMLDivElement>(null);

	const onMouseMove = useCallback(
		(e: React.MouseEvent<HTMLDivElement>) => {
			const el = ref.current;
			if (!el) return;
			const rect = el.getBoundingClientRect();
			const x = (e.clientX - rect.left) / rect.width - 0.5;
			const y = (e.clientY - rect.top) / rect.height - 0.5;
			el.style.transform = `perspective(900px) rotateY(${x * strength}deg) rotateX(${-y * strength}deg) translateZ(6px)`;
			el.style.boxShadow = `
				0 0 0 1px oklch(0.65 0.08 20 / 0.12) inset,
				0 1px 0 oklch(0.8 0.04 20 / 0.15) inset,
				${-x * 8}px ${-y * 8}px 40px oklch(0.12 0.06 15 / 0.7),
				0 0 50px oklch(0.4 0.18 20 / 0.12)
			`;
		},
		[strength],
	);

	const onMouseLeave = useCallback(() => {
		const el = ref.current;
		if (!el) return;
		el.style.transform = "";
		el.style.boxShadow = "";
	}, []);

	return { ref, onMouseMove, onMouseLeave };
}

// ── Unit search dropdown ─────────────────────────────────────────────────────

function UnitSearch({
	units,
	selectedId,
	onSelect,
}: {
	units: UnitInfo[];
	selectedId: number;
	onSelect: (id: number) => void;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const inputRef = useRef<HTMLInputElement>(null);
	const containerRef = useRef<HTMLDivElement>(null);

	const selected = units.find((u) => u.id === selectedId);

	const filtered = useMemo(() => {
		const q = query.trim().toLowerCase();
		if (!q) return units;
		return units.filter(
			(u) =>
				u.name.toLowerCase().includes(q) ||
				String(u.officialId ?? u.id).includes(q) ||
				String(u.id).includes(q),
		);
	}, [query, units]);

	// Close on outside click
	useEffect(() => {
		function handler(e: MouseEvent) {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
				setQuery("");
			}
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	// Focus input when dropdown opens
	useEffect(() => {
		if (open) inputRef.current?.focus();
	}, [open]);

	function pick(id: number) {
		onSelect(id);
		setOpen(false);
		setQuery("");
	}

	return (
		<div ref={containerRef} className="relative w-full sm:w-72">
			{/* Trigger / search input */}
			<button
				type="button"
				className={cn(
					"glass-card rounded-xl flex items-center gap-2 px-3 py-2 cursor-text",
					"border border-white/10 transition-all duration-200",
					open && "border-red-500/40 shadow-[0_0_16px_rgba(220,38,38,0.15)]",
				)}
				onClick={() => {
					setOpen(true);
					inputRef.current?.focus();
				}}
			>
				<Search className="h-3.5 w-3.5 text-red-400/70 shrink-0" />
				{open ? (
					<input
						ref={inputRef}
						className="flex-1 bg-transparent text-sm text-white placeholder:text-white/30 outline-none min-w-0"
						placeholder="Cidade ou ID da unidade…"
						value={query}
						onChange={(e) => setQuery(e.target.value)}
						onKeyDown={(e) => {
							if (e.key === "Escape") {
								setOpen(false);
								setQuery("");
							}
							if (e.key === "Enter" && filtered[0]) pick(filtered[0].id);
						}}
					/>
				) : (
					<span className="flex-1 text-sm text-white/80 truncate">
						{selected ? selected.name : "Selecionar unidade…"}
					</span>
				)}
				<MapPin className="h-3 w-3 text-red-500/60 shrink-0" />
			</button>

			{/* Dropdown */}
			{open && (
				<div className="absolute left-0 right-0 top-full mt-1.5 z-50 glass-card rounded-xl border border-white/10 overflow-hidden shadow-2xl shadow-black/50">
					{filtered.length === 0 ? (
						<p className="px-4 py-3 text-sm text-white/40 text-center">
							Nenhuma unidade encontrada
						</p>
					) : (
						<ul className="max-h-64 overflow-y-auto divide-y divide-white/5">
							{filtered.map((u) => (
								<li key={u.id}>
									<button
										type="button"
										className={cn(
											"w-full text-left px-4 py-2.5 flex items-center justify-between gap-3",
											"text-sm transition-colors duration-100",
											"hover:bg-red-500/10 hover:text-white",
											u.id === selectedId ? "text-red-400 bg-red-500/8" : "text-white/70",
										)}
										onClick={() => pick(u.id)}
									>
										<span className="truncate font-medium">{u.name}</span>
										<span className="text-xs text-white/30 shrink-0">#{u.officialId ?? u.id}</span>
									</button>
								</li>
							))}
						</ul>
					)}
				</div>
			)}
		</div>
	);
}

// ── Stat card ────────────────────────────────────────────────────────────────

// ── Loading card (replaces chart while fetching non-prewarmed unit) ──────────

function LoadingCard({
	unitName,
	variant = "free",
}: {
	unitName: string;
	variant?: "free" | "paid";
}) {
	const isPaid = variant === "paid";
	return (
		<Card className="glass-card glass-card-scan border-0 shadow-none bg-transparent section-3d section-3d-4">
			<CardContent className="px-6 py-16 flex flex-col items-center gap-5">
				<div className="relative flex items-center justify-center">
					<div
						className={cn(
							"absolute h-20 w-20 rounded-full border animate-ping",
							isPaid ? "border-blue-500/20" : "border-red-500/20",
						)}
						style={{ animationDuration: "2s" }}
					/>
					<div
						className={cn(
							"absolute h-14 w-14 rounded-full border animate-ping",
							isPaid ? "border-blue-500/30" : "border-red-500/30",
						)}
						style={{ animationDuration: "1.5s", animationDelay: "0.3s" }}
					/>
					<div
						className={cn(
							"h-10 w-10 rounded-full ring-1 flex items-center justify-center",
							isPaid ? "bg-blue-500/10 ring-blue-500/30" : "bg-red-500/10 ring-red-500/30",
						)}
					>
						<Loader2
							className={cn("h-5 w-5 animate-spin", isPaid ? "text-blue-400" : "text-red-400")}
						/>
					</div>
				</div>

				<div className="text-center space-y-1.5">
					<p className="text-sm font-semibold text-white/70">Buscando dados do SENAI…</p>
					<p className={cn("text-xs", isPaid ? "text-blue-300/50" : "text-red-300/50")}>
						Consultando turmas disponíveis em{" "}
						<span className={isPaid ? "text-blue-300/70" : "text-red-300/70"}>{unitName}</span>
					</p>
					<p className="text-xs text-white/25 mt-2">
						Esta unidade não estava pré-carregada — pode levar alguns instantes.
					</p>
				</div>

				<div className="w-48 h-0.5 rounded-full bg-white/8 overflow-hidden">
					<div
						className={cn(
							"h-full w-1/3 rounded-full bg-gradient-to-r animate-[shimmer-sweep_1.8s_ease-in-out_infinite]",
							isPaid ? "from-blue-700 to-sky-400" : "from-red-700 to-rose-400",
						)}
					/>
				</div>
			</CardContent>
		</Card>
	);
}

// ── No qualifying courses card ────────────────────────────────────────────────

function NoCoursesCard({ unitName }: { unitName: string }) {
	return (
		<Card className="glass-card border-0 shadow-none bg-transparent section-3d section-3d-4 border border-red-900/30">
			<CardContent className="px-6 py-14 flex flex-col items-center gap-4">
				<div className="h-10 w-10 rounded-full bg-red-500/10 ring-1 ring-red-500/25 flex items-center justify-center">
					<XCircle className="h-5 w-5 text-red-500/70" />
				</div>
				<div className="text-center space-y-1.5">
					<p className="text-sm font-semibold text-red-300/70">
						Nenhum curso qualificado encontrado
					</p>
					<p className="text-xs text-white/35 leading-relaxed max-w-sm">
						A unidade <span className="text-white/50">{unitName}</span> não possui cursos
						presenciais de T.I. cadastrados no SENAI SP no momento.
					</p>
				</div>
			</CardContent>
		</Card>
	);
}

// ── Stat card ────────────────────────────────────────────────────────────────

const StatCard = memo(function StatCard({
	icon: Icon,
	title,
	value,
	sub,
	highlight,
	delay = 0,
}: {
	icon: React.ComponentType<{ className?: string }>;
	title: string;
	value: string | number;
	sub?: string;
	highlight?: boolean;
	delay?: number;
}) {
	const tilt = useTilt(8);
	return (
		// biome-ignore lint/a11y/noStaticElementInteractions: tilt is a purely visual CSS effect
		<section
			ref={tilt.ref}
			onMouseMove={tilt.onMouseMove}
			onMouseLeave={tilt.onMouseLeave}
			className={cn(
				"glass-card rounded-2xl p-5 flex items-center gap-4 section-3d cursor-default",
				highlight && "card-highlight ring-1 ring-red-500/50",
			)}
			style={{
				animationDelay: `${delay}ms`,
				transition: "transform 0.18s ease, box-shadow 0.18s ease",
			}}
		>
			<div className="stat-icon-wrap p-2.5 rounded-xl bg-red-500/20 shrink-0 ring-1 ring-red-500/15">
				<Icon className="h-5 w-5 text-red-400" />
			</div>
			<div className="min-w-0">
				<p className="text-xs text-red-300/60 uppercase tracking-wider font-medium truncate">
					{title}
				</p>
				<p className="text-2xl font-bold text-white leading-tight">{value}</p>
				{sub && <p className="text-xs text-red-200/40 mt-0.5 truncate">{sub}</p>}
			</div>
		</section>
	);
});

// ── Course bar ───────────────────────────────────────────────────────────────

const DATE_DISPLAY_LIMIT = 3;

const CourseBar = memo(function CourseBar({
	course,
	maxVagas,
	index,
	variant = "free",
}: {
	course: Course;
	maxVagas: number;
	index: number;
	variant?: "free" | "paid";
}) {
	const pct = maxVagas > 0 ? (course.vagas / maxVagas) * 100 : 0;
	const hasVagas = course.vagas > 0;
	const isFull = !hasVagas && course.turmas > 0;
	const delay = `${index * 55}ms`;
	const isPaid = variant === "paid";

	const dates = course.startDates ?? [];
	const visibleDates = dates.slice(0, DATE_DISPLAY_LIMIT);
	const hiddenCount = dates.length - visibleDates.length;

	const schedules = course.schedules ?? [];
	const prices = course.prices ?? [];
	const priceLabel =
		prices.length === 0
			? null
			: prices.length === 1
				? prices[0]
				: `${prices[0]} – ${prices[prices.length - 1]}`;

	const courseUrl = `https://www.sp.senai.br/curso/${course.slug}/${course.id}`;

	return (
		<a
			href={courseUrl}
			target="_blank"
			rel="noopener noreferrer"
			className={cn(
				"flex items-start gap-3 py-1.5 animate-slide-in rounded-lg px-2 -mx-2",
				"transition-colors duration-150 hover:bg-white/5 cursor-pointer group",
				!hasVagas && "opacity-50 hover:opacity-70",
			)}
			style={{ animationDelay: delay, contain: "layout paint", willChange: "transform, opacity" }}
		>
			<div className="shrink-0 text-right pt-1.5" style={{ width: "clamp(130px, 26%, 200px)" }}>
				<p
					className="text-sm font-semibold text-white/95 leading-tight truncate group-hover:text-white transition-colors"
					title={course.name}
				>
					{course.name}
				</p>
				<div className="flex items-center justify-end gap-1.5 mt-0.5">
					{course.hours > 0 && <p className="text-xs text-red-300/50">{course.hours}h</p>}
					{course.isBolsa && (
						<span className="text-[10px] font-bold tracking-wide text-emerald-400/60 uppercase">
							Bolsa
						</span>
					)}
					{isFull && (
						<span className="text-[10px] font-bold tracking-wide text-amber-400/70 uppercase">
							Esgotado
						</span>
					)}
					{!hasVagas && !isFull && (
						<span className="text-[10px] font-bold tracking-wide text-white/30 uppercase">
							Sem turmas
						</span>
					)}
				</div>
			</div>

			<div className="flex-1 flex flex-col gap-1.5">
				<div className="relative h-10 rounded-lg overflow-hidden bg-white/5 border border-white/8">
					<div
						className={cn(
							"bar-fill absolute inset-y-0 left-0 rounded-lg",
							hasVagas
								? isPaid
									? "bg-gradient-to-r from-blue-800 via-blue-600 to-sky-400"
									: "bg-gradient-to-r from-red-800 via-red-600 to-rose-400"
								: isFull
									? "bg-amber-500/20"
									: "bg-white/5",
						)}
						style={{
							width: hasVagas ? `${Math.max(pct, 6)}%` : isFull ? "100%" : "0%",
							animationDelay: delay,
						}}
					>
						{hasVagas && (
							<>
								<div className="absolute inset-0 bg-gradient-to-b from-white/20 to-transparent rounded-lg" />
								<div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/10 to-transparent rounded-lg" />
							</>
						)}
					</div>
					<div className="absolute inset-0 flex items-center px-3 gap-2">
						{hasVagas ? (
							<>
								<span className="text-sm font-bold text-white drop-shadow-sm">{course.vagas}</span>
								<span className="text-xs text-white/70">
									{course.vagas === 1 ? "vaga" : "vagas"}
								</span>
								{course.turmas > 0 && (
									<span className="ml-auto text-xs text-white/50 shrink-0">
										{course.turmas} {course.turmas === 1 ? "turma" : "turmas"}
									</span>
								)}
							</>
						) : isFull ? (
							<>
								<span className="text-sm font-bold text-amber-400/70">0</span>
								<span className="text-xs text-amber-300/50">vagas</span>
								{course.turmas > 0 && (
									<span className="ml-auto text-xs text-amber-300/40 shrink-0">
										{course.turmas} {course.turmas === 1 ? "turma" : "turmas"} esgotada
										{course.turmas !== 1 ? "s" : ""}
									</span>
								)}
							</>
						) : (
							<span className="text-xs font-medium text-white/30 italic">Sem turmas abertas</span>
						)}
					</div>
				</div>

				{visibleDates.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" title={dates.join(" · ")}>
						<CalendarDays className="h-3 w-3 text-emerald-400/60 shrink-0" />
						{visibleDates.map((d) => (
							<span key={d} className="text-xs text-emerald-300/70 font-medium">
								{d}
							</span>
						))}
						{hiddenCount > 0 && (
							<span className="text-xs text-white/30">
								+{hiddenCount} data{hiddenCount !== 1 ? "s" : ""}
							</span>
						)}
					</div>
				)}

				{schedules.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<Clock className="h-3 w-3 text-white/35 shrink-0" />
						{schedules.map((s) => (
							<span key={`${s.periodo}|${s.horario}`} className="text-xs text-white/45">
								{s.periodo} · {s.horario}
							</span>
						))}
					</div>
				)}

				{isPaid && priceLabel && (
					<div className="flex items-center gap-x-2.5">
						<DollarSign className="h-3 w-3 text-amber-400/60 shrink-0" />
						<span className="text-xs text-amber-300/70 font-medium">{priceLabel}</span>
					</div>
				)}
			</div>
		</a>
	);
});

function SkeletonBar({ delay }: { delay: number }) {
	return (
		<div
			className="flex items-center gap-3 py-1.5 opacity-0 animate-slide-in"
			style={{ animationDelay: `${delay}ms` }}
		>
			<div
				className="shrink-0 h-9 rounded-lg bg-white/8 animate-pulse"
				style={{ width: "clamp(130px, 26%, 200px)" }}
			/>
			<div className="flex-1 h-10 rounded-lg bg-white/8 animate-pulse" />
		</div>
	);
}

// ── Global Client Cache ────────────────────────────────────────────────────────
const unitCache = new Map<number, { data: ApiResponse; paidData: ApiResponse; ts: number }>();
const CACHE_TTL = 30000; // 30 seconds local memory cache for instant transitions

// ── App ──────────────────────────────────────────────────────────────────────

export function App() {
	const [units, setUnits] = useState<UnitInfo[]>([]);
	const [unitsLoading, setUnitsLoading] = useState(true);
	const [selectedUnit, setSelectedUnit] = useState<number>(DEFAULT_UNIT_ID_FALLBACK);
	const [refreshInterval, setRefreshInterval] = useState(REFRESH_INTERVAL_DEFAULT);

	const [data, setData] = useState<ApiResponse | null>(null);
	const [paidData, setPaidData] = useState<ApiResponse | null>(null);

	const [loading, setLoading] = useState(true);
	const [slowLoad, setSlowLoad] = useState(false);
	const [refreshing, setRefreshing] = useState(false);
	const [error, setError] = useState<string | null>(null);

	const [countdown, setCountdown] = useState(REFRESH_INTERVAL_DEFAULT);
	const countdownRef = useRef(REFRESH_INTERVAL_DEFAULT);
	const slowLoadTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

	const headerTilt = useTilt(5);

	// Fetch server-side config (defaultUnitId, refreshIntervalSeconds)
	useEffect(() => {
		fetch("/api/config")
			.then((r) => r.json())
			.then((cfg: { defaultUnitId: number; refreshIntervalSeconds: number }) => {
				setSelectedUnit(cfg.defaultUnitId);
				setRefreshInterval(cfg.refreshIntervalSeconds);
				setCountdown(cfg.refreshIntervalSeconds);
				countdownRef.current = cfg.refreshIntervalSeconds;
			})
			.catch(() => {});
	}, []);

	// Load unit list — waits for catalog on server, so may take a while on first run
	useEffect(() => {
		setUnitsLoading(true);
		fetch("/api/units")
			.then((r) => r.json())
			.then((list: UnitInfo[]) => {
				setUnits(list);
				setUnitsLoading(false);
			})
			.catch(() => {
				setUnits([{ id: 403, name: "Alumínio" }]);
				setUnitsLoading(false);
			});
	}, []);

	const fetchData = useCallback(
		async (unitId: number, force = false) => {
			if (!force) {
				const cached = unitCache.get(unitId);
				if (cached && Date.now() - cached.ts < CACHE_TTL) {
					setData(cached.data);
					setPaidData(cached.paidData);
					setLoading(false);
					setError(null);
					return;
				}
				setLoading(true);
				setSlowLoad(false);
				// After 800ms still loading → show fluid LoadingCard (pre-warmed units resolve faster)
				slowLoadTimerRef.current = setTimeout(() => setSlowLoad(true), 800);
			} else {
				setRefreshing(true);
			}

			setError(null);
			try {
				const res = await fetch(`/api/courses/all?unit=${unitId}`, {
					method: "GET",
				});
				if (!res.ok) throw new Error(`Erro ${res.status} do servidor`);
				const json: { free: ApiResponse; paid: ApiResponse } = await res.json();

				setData(json.free);
				setPaidData(json.paid);
				unitCache.set(unitId, { data: json.free, paidData: json.paid, ts: Date.now() });

				countdownRef.current = refreshInterval;
				setCountdown(refreshInterval);
			} catch (e) {
				setError(e instanceof Error ? e.message : "Erro desconhecido");
			} finally {
				if (slowLoadTimerRef.current) {
					clearTimeout(slowLoadTimerRef.current);
					slowLoadTimerRef.current = null;
				}
				setLoading(false);
				setSlowLoad(false);
				setRefreshing(false);
			}
		},
		[refreshInterval],
	);

	// Fetch when unit changes
	useEffect(() => {
		fetchData(selectedUnit);
	}, [selectedUnit, fetchData]);

	// Auto-refresh countdown
	useEffect(() => {
		const timer = setInterval(() => {
			countdownRef.current -= 1;
			setCountdown(countdownRef.current);
			if (countdownRef.current <= 0) {
				countdownRef.current = refreshInterval;
				setCountdown(refreshInterval);
				fetchData(selectedUnit);
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [selectedUnit, fetchData, refreshInterval]);

	const selectedUnitEntry = units.find((u) => u.id === selectedUnit);
	const selectedUnitName = selectedUnitEntry?.name ?? `Unidade ${selectedUnit}`;
	const selectedUnitDisplayId = selectedUnitEntry?.officialId ?? selectedUnit;

	// Free courses derived values
	const courses = data?.courses ?? [];
	const totalVagas = courses.reduce((sum, c) => sum + c.vagas, 0);
	const openCount = courses.filter((c) => c.vagas > 0).length;
	const maxVagas = Math.max(...courses.map((c) => c.vagas), 1);
	const noCourses = !loading && !error && data !== null && courses.length === 0;

	// Paid courses derived values
	const paidCourses = paidData?.courses ?? [];
	const maxPaidVagas = Math.max(...paidCourses.map((c) => c.vagas), 1);
	const paidNoCourses = !loading && !error && paidData !== null && paidCourses.length === 0;

	function renderFreeChart() {
		if (slowLoad && loading) return <LoadingCard unitName={selectedUnitName} />;

		return (
			<Card className="glass-card glass-card-scan border-0 shadow-none bg-transparent section-3d section-3d-4">
				<CardHeader className="pb-3 pt-5 px-6">
					<CardTitle className="text-sm font-semibold text-white/80 flex items-center gap-2.5">
						<span className="inline-block h-1 w-5 rounded-full bg-gradient-to-r from-red-600 to-rose-400 shadow-[0_0_8px_rgba(220,38,38,0.6)]" />
						Cursos Gratuitos — {selectedUnitName}
					</CardTitle>
				</CardHeader>
				<CardContent className="px-6 pb-6 space-y-0.5">
					{loading
						? ["a", "b", "c", "d", "e", "f"].map((k, i) => <SkeletonBar key={k} delay={i * 55} />)
						: courses.map((course, i) => (
								<CourseBar key={course.id} course={course} maxVagas={maxVagas} index={i} />
							))}
				</CardContent>
			</Card>
		);
	}

	function renderPaidChart() {
		if (slowLoad && loading) return <LoadingCard unitName={selectedUnitName} variant="paid" />;

		return (
			<Card className="glass-card border-0 shadow-none bg-transparent section-3d section-3d-5 mt-8">
				<CardHeader className="pb-3 pt-5 px-6">
					<CardTitle className="text-sm font-semibold text-white/80 flex items-center gap-2.5">
						<span className="inline-block h-1 w-5 rounded-full bg-gradient-to-r from-blue-500 to-indigo-400 shadow-[0_0_8px_rgba(59,130,246,0.5)]" />
						Cursos Pagos — {selectedUnitName}
					</CardTitle>
				</CardHeader>
				<CardContent className="px-6 pb-6 space-y-0.5">
					{loading
						? ["a", "b", "c", "d", "e", "f"].map((k, i) => <SkeletonBar key={k} delay={i * 55} />)
						: paidCourses.map((course, i) => (
								<CourseBar
									key={course.id}
									course={course}
									maxVagas={maxPaidVagas}
									index={i}
									variant="paid"
								/>
							))}
				</CardContent>
			</Card>
		);
	}

	return (
		<div className="aero-root min-h-screen w-full p-4 md:p-8">
			<div className="aero-bg-glow" />
			<div className="aero-orb aero-orb-1" />
			<div className="aero-orb aero-orb-2" />
			<div className="aero-orb aero-orb-3" />

			<div className="relative z-10 max-w-4xl mx-auto space-y-5">
				{/* ── Header ── */}
				{/* biome-ignore lint/a11y/noStaticElementInteractions: tilt is a purely visual CSS effect */}
				<header
					ref={headerTilt.ref}
					onMouseMove={headerTilt.onMouseMove}
					onMouseLeave={headerTilt.onMouseLeave}
					className="glass-card rounded-2xl px-6 py-5 flex flex-col sm:flex-row items-start sm:items-center justify-between gap-4 section-3d section-3d-1 cursor-default"
					style={{ transition: "transform 0.18s ease, box-shadow 0.18s ease" }}
				>
					<div className="flex items-center gap-4">
						<img
							src={logoUrl}
							alt="SENAI"
							className="h-10 w-auto logo-float"
							style={{
								filter:
									"drop-shadow(0 0 4px rgba(220,38,38,0.55)) drop-shadow(0 0 10px rgba(185,28,28,0.3))",
							}}
						/>
						<div>
							<h1 className="text-lg font-bold text-white tracking-tight leading-tight">
								SENAI {selectedUnitName}
							</h1>
							<p className="text-sm text-red-200/60">Cursos de Tecnologia da Informação</p>
						</div>
					</div>

					<div className="flex items-center gap-3 ml-auto flex-wrap">
						{data && !loading && (
							<span className="flex items-center gap-1.5 text-xs text-red-200/50">
								<Clock className="h-3 w-3 shrink-0" />
								Atualizado às {formatTime(data.lastUpdated)}
							</span>
						)}
						{loading && (
							<span className="flex items-center gap-1.5 text-xs text-red-300/60">
								<Loader2 className="h-3 w-3 animate-spin shrink-0" />
								{slowLoad ? "Consultando SENAI…" : "Buscando cursos…"}
							</span>
						)}
						<Button
							size="sm"
							onClick={() => {
								fetchData(selectedUnit, true);
							}}
							disabled={refreshing || loading}
							className="bg-red-600 hover:bg-red-500 text-white border-0 shadow-lg shadow-red-900/40 transition-all duration-200 hover:scale-105 hover:shadow-red-700/50 active:scale-95"
						>
							<RefreshCw
								className={cn("h-3.5 w-3.5 mr-1.5", (refreshing || loading) && "animate-spin")}
							/>
							{refreshing ? "Atualizando…" : "Atualizar"}
						</Button>
					</div>
				</header>

				{/* ── Unit search ── */}
				<div className="flex items-center gap-3 section-3d section-3d-2">
					{unitsLoading ? (
						<div className="glass-card rounded-xl flex items-center gap-2 px-3 py-2 w-full sm:w-72 border border-white/10">
							<Loader2 className="h-3.5 w-3.5 text-red-400/60 animate-spin shrink-0" />
							<span className="text-sm text-white/30 animate-pulse">Carregando unidades…</span>
						</div>
					) : (
						<UnitSearch units={units} selectedId={selectedUnit} onSelect={setSelectedUnit} />
					)}
					{!unitsLoading && units.length > 0 && (
						<p className="text-xs text-white/25">
							{units.length} unidade{units.length !== 1 ? "s" : ""} com cursos de T.I.
						</p>
					)}
				</div>

				{/* ── Network / server error ── */}
				{error && (
					<div className="glass-card rounded-xl px-4 py-3 flex items-center gap-3 border border-red-500/30 section-3d">
						<AlertCircle className="h-4 w-4 text-red-400 shrink-0" />
						<p className="text-sm text-red-300">{error}</p>
					</div>
				)}

				{/* ── Stats ── */}
				<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
					<StatCard
						icon={BookOpen}
						title="Cursos"
						value={loading ? "…" : courses.length}
						sub="presenciais TI"
						delay={80}
					/>
					<StatCard
						icon={Users}
						title="Vagas Abertas"
						value={loading ? "…" : totalVagas}
						sub="total disponível"
						highlight={totalVagas > 0}
						delay={140}
					/>
					<StatCard
						icon={CheckCircle}
						title="Com Vagas"
						value={loading ? "…" : openCount}
						sub={loading ? "" : `de ${courses.length} cursos`}
						highlight={openCount > 0}
						delay={200}
					/>
					<StatCard
						icon={TrendingUp}
						title="Próx. Refresh"
						value={formatCountdown(countdown)}
						sub="automático"
						delay={260}
					/>
				</div>

				{/* ── Chart area ── */}
				{noCourses && paidNoCourses && <NoCoursesCard unitName={selectedUnitName} />}
				{!noCourses && renderFreeChart()}
				{!paidNoCourses && renderPaidChart()}

				{/* ── Footer ── */}
				<p className="text-center text-xs text-white/20 pb-2 section-3d section-3d-5">
					Fonte: <span className="text-white/35">sp.senai.br</span> · Unidade {selectedUnitName} (ID{" "}
					{selectedUnitDisplayId}) · Refresh automático a cada 5 min ·{" "}
					<a href="/privacidade" className="underline hover:text-white/40 transition-colors">
						Política de Privacidade
					</a>
				</p>
			</div>
		</div>
	);
}

function PrivacyPolicy() {
	return (
		<div className="aero-root min-h-screen p-6 md:p-12">
			<div className="max-w-3xl mx-auto">
				<div className="glass-card rounded-2xl p-8 md:p-12">
					<a
						href="/"
						className="inline-flex items-center gap-2 text-sm text-white/40 hover:text-white/70 transition-colors mb-8"
					>
						← Voltar para o início
					</a>

					<h1 className="text-3xl font-bold text-white mb-2">Política de Privacidade</h1>
					<p className="text-white/40 text-sm mb-8">Última atualização: 25 de abril de 2026</p>

					<div className="space-y-8 text-white/70 text-sm leading-relaxed">
						<section>
							<h2 className="text-lg font-semibold text-white/90 mb-3">1. Sobre este site</h2>
							<p>
								Este site (<strong>spsenai.arielaram.com</strong>) é um agregador independente e não
								oficial de vagas em cursos gratuitos de Tecnologia da Informação oferecidos pelo{" "}
								<strong>SENAI-SP</strong>. Os dados exibidos são obtidos publicamente em{" "}
								<span className="text-white/50">sp.senai.br</span> e atualizados automaticamente a
								cada 5 minutos. O site é operado por <strong>Ariel Aram</strong> (
								<a
									href="mailto:arielaram@protonmail.com"
									className="underline hover:text-white/90 transition-colors"
								>
									arielaram@protonmail.com
								</a>
								).
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-white/90 mb-3">2. Dados coletados</h2>
							<p>
								Este site <strong>não coleta dados pessoais diretamente</strong>. Não há cadastro,
								login, formulário ou armazenamento de informações identificáveis dos visitantes em
								nossos servidores. Os dados exibidos (cursos, vagas, horários) são públicos e
								provenientes exclusivamente do SENAI-SP.
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-white/90 mb-3">3. Armazenamento local</h2>
							<p>
								O site pode utilizar armazenamento local no navegador (como{" "}
								<code>localStorage</code>) apenas para salvar preferências de exibição de forma
								anônima e local no seu próprio dispositivo.
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-white/90 mb-3">4. Seus direitos</h2>
							<p className="mb-2">
								Nos termos da <strong>LGPD</strong> (Lei Geral de Proteção de Dados — Lei nº
								13.709/2018) e do <strong>GDPR</strong> (Regulamento Geral de Proteção de Dados da
								UE), você tem direito a:
							</p>
							<ul className="ml-4 list-disc space-y-1 text-white/55">
								<li>Confirmar a existência de tratamento de dados pessoais</li>
								<li>Acessar seus dados pessoais</li>
								<li>Corrigir dados incompletos, inexatos ou desatualizados</li>
								<li>Solicitar a anonimização, bloqueio ou eliminação de dados</li>
								<li>Revogar o consentimento a qualquer momento</li>
								<li>Opor-se ao tratamento realizado com base em legítimo interesse</li>
							</ul>
							<p className="mt-3">
								Como este site não armazena dados pessoais em seus servidores, não mantemos perfis
								de usuários ou rastreamento individualizado.
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-white/90 mb-3">
								5. Links externos e isenção de responsabilidade
							</h2>
							<p>
								Este site pode conter links para o site oficial do SENAI-SP. Não nos
								responsabilizamos pela disponibilidade, exatidão ou políticas de privacidade de
								sites externos. As informações sobre cursos são fornecidas "como estão" e podem não
								refletir alterações em tempo real no sistema do SENAI-SP.
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-white/90 mb-3">6. Contato</h2>
							<p>
								Para dúvidas sobre esta política de privacidade, entre em contato pelo e-mail:{" "}
								<a
									href="mailto:arielaram@protonmail.com"
									className="underline hover:text-white/90 transition-colors"
								>
									arielaram@protonmail.com
								</a>
								.
							</p>
						</section>
					</div>
				</div>
			</div>
		</div>
	);
}

export default function Root() {
	if (typeof window !== "undefined" && window.location.pathname === "/privacidade") {
		return <PrivacyPolicy />;
	}
	return <App />;
}
