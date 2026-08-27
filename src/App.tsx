import {
	AlertCircle,
	BookOpen,
	CalendarDays,
	CheckCircle,
	Clock,
	DollarSign,
	Globe,
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
import {
	AERO_ARROW_CURSOR,
	busyCursorClass,
	initStaticCursors,
	unavailableCursorClass,
	wagtailCursorClass,
	workingCursorClass,
} from "@/lib/cursors";
import { cn } from "@/lib/utils";
import { DEFAULT_AREA_LABEL, DEFAULT_AREA_SLUG } from "./constants";
import { KNOWN_ACTIVE, STATE_META, STATE_ORDER } from "./state-meta";
import type { Area, Course, CoursesData, StateInfo, UnitInfo } from "./types";
import "./index.css";

type ApiResponse = CoursesData;

const REFRESH_INTERVAL_DEFAULT = 5 * 60;
const DEFAULT_UNIT_ID_FALLBACK = 403;

// ── State list ───────────────────────────────────────────────────────────────
// STATE_META (name/logo/flag/hue) is static, bundled data — safe for the browser.
// "status" (active vs coming-soon) is server truth, computed from the real adapter
// registry (see adapters/registry.ts) and fetched at runtime via /api/states, so
// this file never imports adapter/db/config code into the client bundle.

function buildStates(statusByUf: Record<string, "active" | "coming-soon">): StateInfo[] {
	return STATE_ORDER.map((uf) => {
		const meta = STATE_META[uf];
		return {
			uf,
			name: meta.name,
			logo: meta.logo,
			flag: meta.flag,
			hue: meta.hue,
			sourceLabel: meta.sourceLabel,
			status: statusByUf[uf] ?? "coming-soon",
		};
	});
}

// First-paint hint so SP doesn't flash "coming soon" before /api/states resolves.
const INITIAL_STATUS: Record<string, "active" | "coming-soon"> = Object.fromEntries(
	STATE_ORDER.map((uf) => [uf, KNOWN_ACTIVE.includes(uf) ? "active" : "coming-soon"]),
);

function useStates(): StateInfo[] {
	const [states, setStates] = useState<StateInfo[]>(() => buildStates(INITIAL_STATUS));
	useEffect(() => {
		fetch("/api/states")
			.then((r) => r.json())
			.then((serverStates: Pick<StateInfo, "uf" | "status" | "sourceLabel">[]) => {
				const byUf = new Map(serverStates.map((s) => [s.uf, s]));
				setStates((prev) =>
					prev.map((s) => {
						const server = byUf.get(s.uf);
						return server ? { ...s, status: server.status, sourceLabel: server.sourceLabel } : s;
					}),
				);
			})
			.catch(() => {});
	}, []);
	return states;
}

// Real course categories for the selected state, fetched fresh on every state
// change — unlike states, areas aren't known ahead of time client-side (each
// adapter's real taxonomy differs, see StateAdapter.getAreas()).
function useAreas(uf: string, isComingSoon: boolean): { areas: Area[]; loading: boolean } {
	const [areas, setAreas] = useState<Area[]>([
		{ slug: DEFAULT_AREA_SLUG, label: DEFAULT_AREA_LABEL },
	]);
	const [loading, setLoading] = useState(true);
	useEffect(() => {
		if (isComingSoon) {
			setLoading(false);
			return;
		}
		setLoading(true);
		fetch(`/api/areas?uf=${uf}`)
			.then((r) => r.json())
			.then((list: Area[]) => {
				setAreas(list.length > 0 ? list : [{ slug: DEFAULT_AREA_SLUG, label: DEFAULT_AREA_LABEL }]);
				setLoading(false);
			})
			.catch(() => setLoading(false));
	}, [uf, isComingSoon]);
	return { areas, loading };
}

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
				0 0 0 1px oklch(0.65 0.08 var(--brand-hue) / 0.12) inset,
				0 1px 0 oklch(0.8 0.04 var(--brand-hue) / 0.15) inset,
				${-x * 8}px ${-y * 8}px 40px oklch(0.12 0.06 var(--brand-hue) / 0.7),
				0 0 50px oklch(0.4 0.18 var(--brand-hue) / 0.12)
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

// Mounts a popover panel only while open or animating closed — a glass panel
// carries a continuous backdrop-filter blur + shimmer animation, which is real
// ongoing GPU/paint cost even at opacity:0, so it must not stay in the DOM
// permanently (unlike a plain `{open && ...}` mount, this still plays a close
// animation before actually unmounting).
function usePopoverPhase(open: boolean, closeMs = 160): "open" | "closing" | null {
	const [phase, setPhase] = useState<"open" | "closing" | null>(null);
	useEffect(() => {
		if (open) {
			setPhase("open");
			return;
		}
		setPhase((p) => (p ? "closing" : null));
		const timer = setTimeout(() => setPhase(null), closeMs);
		return () => clearTimeout(timer);
	}, [open, closeMs]);
	return phase;
}

// ── Unit search dropdown ─────────────────────────────────────────────────────

function UnitSearch({
	units,
	selectedId,
	onSelect,
	uf,
	area,
}: {
	units: UnitInfo[];
	selectedId: number;
	onSelect: (id: number) => void;
	uf: string;
	area: string;
}) {
	const [query, setQuery] = useState("");
	const [open, setOpen] = useState(false);
	const phase = usePopoverPhase(open);
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
				data-state={open ? "open" : "closed"}
				className={cn(
					"popover-trigger glass-card rounded-xl flex items-center gap-2 px-3 py-2 cursor-text",
					"border border-ink/12 transition-colors duration-200",
					open && "border-brand/45 shadow-[0_0_16px_oklch(0.6_0.2_var(--brand-hue)/0.18)]",
				)}
				onClick={() => {
					setOpen(true);
					inputRef.current?.focus();
				}}
			>
				<Search className="aero-icon-glint h-3.5 w-3.5 text-brand/75 shrink-0" />
				{open ? (
					<input
						ref={inputRef}
						className="flex-1 bg-transparent text-sm text-ink placeholder:text-ink/40 outline-none min-w-0"
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
					<span className="flex-1 text-sm text-ink/80 truncate">
						{selected ? selected.name : "Selecionar unidade…"}
					</span>
				)}
				<MapPin className="aero-icon-glint h-3 w-3 text-brand/70 shrink-0" />
			</button>

			{/* Dropdown — mounted only while open/closing, see usePopoverPhase */}
			{phase && (
				<div
					data-state={phase}
					className="popover-3d absolute left-0 right-0 top-full mt-1.5 z-50 glass-card rounded-xl border border-ink/12 overflow-hidden shadow-2xl shadow-black/60"
				>
					{filtered.length === 0 ? (
						<p className="px-4 py-3 text-sm text-ink/45 text-center">Nenhuma unidade encontrada</p>
					) : (
						<ul className="max-h-64 overflow-y-auto divide-y divide-ink/8">
							{filtered.map((u, i) => (
								<li
									key={u.id}
									className="popover-item"
									style={{ animationDelay: `${Math.min(i, 10) * 16}ms` }}
								>
									<button
										type="button"
										className={cn(
											"w-full text-left px-4 py-2.5 flex items-center justify-between gap-3",
											"text-sm transition-colors duration-100",
											"hover:bg-brand/10 hover:text-ink",
											u.id === selectedId ? "text-brand bg-brand/8" : "text-ink/72",
										)}
										onClick={() => pick(u.id)}
										onMouseEnter={() => prefetchUnitData(uf, area, u.id)}
									>
										<span className="truncate font-medium">{u.name}</span>
										<span className="text-xs text-ink/40 shrink-0">#{u.officialId ?? u.id}</span>
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

// ── State selector ───────────────────────────────────────────────────────────

function StateSelector({
	states,
	selectedUf,
	onSelect,
}: {
	states: StateInfo[];
	selectedUf: string;
	onSelect: (uf: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const phase = usePopoverPhase(open);
	const containerRef = useRef<HTMLDivElement>(null);
	const selected = states.find((s) => s.uf === selectedUf) ?? (states[0] as StateInfo);

	useEffect(() => {
		function handler(e: MouseEvent) {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	return (
		<div ref={containerRef} className="relative w-full sm:w-56">
			<button
				type="button"
				data-state={open ? "open" : "closed"}
				className={cn(
					"popover-trigger glass-card rounded-xl flex items-center gap-2 px-3 py-2 w-full",
					"border border-ink/12 transition-colors duration-200",
					busyCursorClass(selected.hue),
					open && "border-ink/20",
				)}
				onClick={() => setOpen((o) => !o)}
			>
				<img
					src={selected.flag}
					alt=""
					className="h-3.5 w-5 object-cover rounded-[3px] ring-1 ring-glass/70 shrink-0"
				/>
				<span className="flex-1 text-sm text-ink/80 truncate text-left">{selected.name}</span>
				<Globe className="aero-icon-glint popover-trigger-icon h-3.5 w-3.5 text-ink/45 shrink-0" />
			</button>

			{phase && (
				<div
					data-state={phase}
					className="popover-3d absolute left-0 right-0 top-full mt-1.5 z-50 glass-card rounded-xl border border-ink/12 overflow-hidden shadow-2xl shadow-black/60"
				>
					<ul className="max-h-72 overflow-y-auto divide-y divide-ink/8">
						{states.map((s, i) => (
							<li
								key={s.uf}
								className="popover-item"
								style={{ animationDelay: `${Math.min(i, 10) * 16}ms` }}
							>
								<button
									type="button"
									className={cn(
										"w-full text-left px-4 py-2.5 flex items-center gap-3",
										"text-sm transition-colors duration-100 hover:bg-ink/8 hover:text-ink",
										s.status === "coming-soon"
											? unavailableCursorClass(s.hue)
											: busyCursorClass(s.hue),
										s.uf === selectedUf ? "text-ink bg-ink/8" : "text-ink/72",
									)}
									onClick={() => {
										onSelect(s.uf);
										setOpen(false);
									}}
									onMouseEnter={() => {
										if (s.status === "active") {
											fetch(`/api/units?uf=${s.uf}`).catch(() => {});
										}
									}}
								>
									<img
										src={s.flag}
										alt=""
										className="h-3.5 w-5 object-cover rounded-[3px] ring-1 ring-glass/70 shrink-0"
									/>
									<span className="truncate font-medium flex-1">{s.name}</span>
									{s.status === "coming-soon" && (
										<span className="text-[10px] font-bold tracking-wide text-ink/40 uppercase shrink-0">
											Em breve
										</span>
									)}
								</button>
							</li>
						))}
					</ul>
				</div>
			)}
		</div>
	);
}

// ── Area selector ────────────────────────────────────────────────────────────

function AreaSelector({
	areas,
	selectedSlug,
	onSelect,
}: {
	areas: Area[];
	selectedSlug: string;
	onSelect: (slug: string) => void;
}) {
	const [open, setOpen] = useState(false);
	const phase = usePopoverPhase(open);
	const containerRef = useRef<HTMLDivElement>(null);
	const selected = areas.find((a) => a.slug === selectedSlug) ?? areas[0];

	useEffect(() => {
		function handler(e: MouseEvent) {
			if (containerRef.current && !containerRef.current.contains(e.target as Node)) {
				setOpen(false);
			}
		}
		document.addEventListener("mousedown", handler);
		return () => document.removeEventListener("mousedown", handler);
	}, []);

	return (
		<div ref={containerRef} className="relative w-full sm:w-64">
			<button
				type="button"
				data-state={open ? "open" : "closed"}
				className={cn(
					"popover-trigger glass-card rounded-xl flex items-center gap-2 px-3 py-2 cursor-pointer w-full",
					"border border-ink/12 transition-colors duration-200",
					open && "border-ink/20",
				)}
				onClick={() => setOpen((o) => !o)}
			>
				<BookOpen className="aero-icon-glint h-3.5 w-3.5 text-brand/75 shrink-0" />
				<span className="flex-1 text-sm text-ink/80 truncate text-left">
					{selected?.label ?? "Selecionar área…"}
				</span>
				<Globe className="aero-icon-glint popover-trigger-icon h-3.5 w-3.5 text-ink/45 shrink-0" />
			</button>

			{phase && (
				<div
					data-state={phase}
					className="popover-3d absolute left-0 right-0 top-full mt-1.5 z-50 glass-card rounded-xl border border-ink/12 overflow-hidden shadow-2xl shadow-black/60"
				>
					<ul className="max-h-72 overflow-y-auto divide-y divide-ink/8">
						{areas.map((a, i) => (
							<li
								key={a.slug}
								className="popover-item"
								style={{ animationDelay: `${Math.min(i, 10) * 16}ms` }}
							>
								<button
									type="button"
									className={cn(
										"w-full text-left px-4 py-2.5 flex items-center gap-3",
										"text-sm transition-colors duration-100 hover:bg-ink/8 hover:text-ink",
										a.slug === selectedSlug ? "text-ink bg-ink/8" : "text-ink/72",
									)}
									onClick={() => {
										onSelect(a.slug);
										setOpen(false);
									}}
								>
									<span className="truncate font-medium flex-1">{a.label}</span>
								</button>
							</li>
						))}
					</ul>
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
							isPaid ? "border-accent2/22" : "border-brand/25",
						)}
						style={{ animationDuration: "2s" }}
					/>
					<div
						className={cn(
							"absolute h-14 w-14 rounded-full border animate-ping",
							isPaid ? "border-accent2/32" : "border-brand/35",
						)}
						style={{ animationDuration: "1.5s", animationDelay: "0.3s" }}
					/>
					<div
						className={cn(
							"h-10 w-10 rounded-full ring-1 flex items-center justify-center",
							isPaid ? "bg-accent2/10 ring-accent2/32" : "bg-brand/10 ring-brand/32",
						)}
					>
						<Loader2
							className={cn("h-5 w-5 animate-spin", isPaid ? "text-accent2" : "text-brand")}
						/>
					</div>
				</div>

				<div className="text-center space-y-1.5">
					<p className="text-sm font-semibold text-ink/72">Buscando dados do SENAI…</p>
					<p className={cn("text-xs", isPaid ? "text-accent2/58" : "text-brand/58")}>
						Consultando turmas disponíveis em{" "}
						<span className={isPaid ? "text-accent2/78" : "text-brand/72"}>{unitName}</span>
					</p>
					<p className="text-xs text-ink/38 mt-2">
						Esta unidade não estava pré-carregada — pode levar alguns instantes.
					</p>
				</div>

				<div className="w-48 h-0.5 rounded-full bg-ink/8 overflow-hidden">
					<div
						className={cn(
							"h-full w-1/3 rounded-full bg-gradient-to-r animate-[shimmer-sweep_1.8s_ease-in-out_infinite]",
							isPaid ? "from-accent2-dark to-accent2-light" : "from-brand-dark to-brand-light",
						)}
					/>
				</div>
			</CardContent>
		</Card>
	);
}

// ── No qualifying courses card ────────────────────────────────────────────────

function NoCoursesCard({
	unitName,
	stateName,
	areaLabel,
}: {
	unitName: string;
	stateName: string;
	areaLabel: string;
}) {
	return (
		<Card className="glass-card border-0 shadow-none bg-transparent section-3d section-3d-4 border border-brand-dark/30">
			<CardContent className="px-6 py-14 flex flex-col items-center gap-4">
				<div className="h-10 w-10 rounded-full bg-brand/10 ring-1 ring-brand/28 flex items-center justify-center">
					<XCircle className="h-5 w-5 text-brand/75" />
				</div>
				<div className="text-center space-y-1.5">
					<p className="text-sm font-semibold text-brand/72">Nenhum curso qualificado encontrado</p>
					<p className="text-xs text-ink/42 leading-relaxed max-w-sm">
						A unidade <span className="text-ink/55">{unitName}</span> não possui cursos presenciais
						de {areaLabel} cadastrados no SENAI {stateName} no momento.
					</p>
				</div>
			</CardContent>
		</Card>
	);
}

// ── Coming-soon state placeholder ─────────────────────────────────────────────

function ComingSoonCard({ stateName }: { stateName: string }) {
	return (
		<Card className="glass-card border-0 shadow-none bg-transparent section-3d section-3d-4">
			<CardContent className="px-6 py-16 flex flex-col items-center gap-4">
				<div className="h-10 w-10 rounded-full bg-ink/10 ring-1 ring-glass/70 flex items-center justify-center">
					<Clock className="h-5 w-5 text-ink/62" />
				</div>
				<div className="text-center space-y-1.5">
					<p className="text-sm font-semibold text-ink/80">Em breve</p>
					<p className="text-xs text-ink/45 leading-relaxed max-w-sm">
						Ainda estamos verificando como o SENAI de{" "}
						<span className="text-ink/62">{stateName}</span> publica vagas de cursos — assim que
						houver uma fonte de dados confiável, este estado passa a mostrar cursos reais.
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
				highlight && "card-highlight ring-1 ring-brand/50",
			)}
			style={{
				animationDelay: `${delay}ms`,
				transition: "transform 0.18s ease, box-shadow 0.18s ease",
			}}
		>
			<div className="stat-icon-wrap aero-icon-orb h-11 w-11 rounded-full shrink-0 flex items-center justify-center">
				<Icon className="h-5 w-5 text-white drop-shadow-[0_1px_1.5px_rgba(0,0,0,0.4)]" />
			</div>
			<div className="min-w-0">
				<p className="text-xs text-brand/65 uppercase tracking-wider font-medium truncate">
					{title}
				</p>
				<p className="text-2xl font-bold text-ink leading-tight">{value}</p>
				{sub && <p className="text-xs text-brand-light/62 mt-0.5 truncate">{sub}</p>}
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
	uf,
}: {
	course: Course;
	maxVagas: number;
	index: number;
	variant?: "free" | "paid";
	uf: string;
}) {
	const isUnknownVagas = course.vagas === null;
	const pct = !isUnknownVagas && maxVagas > 0 ? ((course.vagas as number) / maxVagas) * 100 : 0;
	const hasVagas = !isUnknownVagas && (course.vagas as number) > 0;
	const isFull = !hasVagas && !isUnknownVagas && course.turmas > 0;
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

	const courseUrl =
		course.url ??
		(uf === "sc"
			? `https://cursos.sesisenai.org.br/cursos-profissionalizantes/${course.slug}/${course.id}`
			: `https://www.sp.senai.br/curso/${course.slug}/${course.id}`);

	return (
		<a
			href={courseUrl}
			target="_blank"
			rel="noopener noreferrer"
			className={cn(
				"flex items-start gap-3 py-1.5 animate-slide-in rounded-lg px-2 -mx-2",
				"transition-colors duration-150 hover:bg-ink/6 cursor-pointer group",
				!hasVagas && !isUnknownVagas && "opacity-50 hover:opacity-70",
			)}
			style={{ animationDelay: delay, contain: "layout paint", willChange: "transform, opacity" }}
		>
			<div className="shrink-0 text-right pt-1.5" style={{ width: "clamp(130px, 26%, 200px)" }}>
				<p
					className="text-sm font-semibold text-ink/95 leading-tight truncate group-hover:text-ink transition-colors"
					title={course.name}
				>
					{course.name}
				</p>
				<div className="flex items-center justify-end gap-1.5 mt-0.5">
					{course.hours > 0 && <p className="text-xs text-brand/58">{course.hours}h</p>}
					{course.isBolsa && (
						<span className="text-[10px] font-bold tracking-wide text-emerald-600/80 uppercase">
							Bolsa
						</span>
					)}
					{isFull && (
						<span className="text-[10px] font-bold tracking-wide text-amber-600/85 uppercase">
							Esgotado
						</span>
					)}
					{!hasVagas && !isFull && !isUnknownVagas && (
						<span className="text-[10px] font-bold tracking-wide text-ink/40 uppercase">
							Sem turmas
						</span>
					)}
					{isUnknownVagas && (
						<span className="text-[10px] font-bold tracking-wide text-sky-600/70 uppercase">
							Ver no site
						</span>
					)}
				</div>
			</div>

			<div className="flex-1 flex flex-col gap-1.5">
				<div className="relative h-10 rounded-lg overflow-hidden bg-ink/6 border border-ink/10">
					<div
						className={cn(
							"bar-fill absolute inset-y-0 left-0 rounded-lg",
							hasVagas
								? isPaid
									? "bg-gradient-to-r from-accent2-dark via-accent2 to-accent2-light"
									: "bg-gradient-to-r from-brand-dark via-brand to-brand-light"
								: isFull
									? "bg-amber-500/22"
									: isUnknownVagas
										? "bg-sky-500/12"
										: "bg-ink/6",
						)}
						style={{
							width: hasVagas ? `${Math.max(pct, 6)}%` : isFull || isUnknownVagas ? "100%" : "0%",
							animationDelay: delay,
						}}
					>
						{hasVagas && (
							<>
								<div className="absolute inset-0 bg-gradient-to-b from-white/45 to-transparent rounded-lg" />
								<div className="absolute inset-0 bg-gradient-to-r from-transparent via-white/25 to-transparent rounded-lg" />
							</>
						)}
					</div>
					<div className="absolute inset-0 flex items-center px-3 gap-2">
						{hasVagas ? (
							<>
								<span className="text-sm font-bold text-ink drop-shadow-sm">{course.vagas}</span>
								<span className="text-xs text-ink/72">{course.vagas === 1 ? "vaga" : "vagas"}</span>
								{course.turmas > 0 && (
									<span className="ml-auto text-xs text-ink/55 shrink-0">
										{course.turmas} {course.turmas === 1 ? "turma" : "turmas"}
									</span>
								)}
							</>
						) : isFull ? (
							<>
								<span className="text-sm font-bold text-amber-600/85">0</span>
								<span className="text-xs text-amber-600/60">vagas</span>
								{course.turmas > 0 && (
									<span className="ml-auto text-xs text-amber-600/50 shrink-0">
										{course.turmas} {course.turmas === 1 ? "turma" : "turmas"} esgotada
										{course.turmas !== 1 ? "s" : ""}
									</span>
								)}
							</>
						) : isUnknownVagas ? (
							<span className="text-xs font-medium text-sky-600/80">
								Vagas não informadas — ver no site
							</span>
						) : (
							<span className="text-xs font-medium text-ink/40 italic">Sem turmas abertas</span>
						)}
					</div>
				</div>

				{visibleDates.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1" title={dates.join(" · ")}>
						<CalendarDays className="aero-icon-glint h-3 w-3 text-emerald-600/80 shrink-0" />
						{visibleDates.map((d) => (
							<span key={d} className="text-xs text-emerald-600/85 font-medium">
								{d}
							</span>
						))}
						{hiddenCount > 0 && (
							<span className="text-xs text-ink/40">
								+{hiddenCount} data{hiddenCount !== 1 ? "s" : ""}
							</span>
						)}
					</div>
				)}

				{schedules.length > 0 && (
					<div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
						<Clock className="aero-icon-glint h-3 w-3 text-ink/42 shrink-0" />
						{schedules.map((s) => (
							<span key={`${s.periodo}|${s.horario}`} className="text-xs text-ink/48">
								{s.periodo} · {s.horario}
							</span>
						))}
					</div>
				)}

				{isPaid && priceLabel && (
					<div className="flex items-center gap-x-2.5">
						<DollarSign className="h-3 w-3 text-amber-600/75 shrink-0" />
						<span className="text-xs text-amber-600/80 font-medium">{priceLabel}</span>
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
				className="shrink-0 h-9 rounded-lg bg-ink/8 animate-pulse"
				style={{ width: "clamp(130px, 26%, 200px)" }}
			/>
			<div className="flex-1 h-10 rounded-lg bg-ink/8 animate-pulse" />
		</div>
	);
}

// ── Global Client Cache ────────────────────────────────────────────────────────
// Keyed by "uf:area:unitId" — unit IDs are only unique within a single state's
// adapter, and course lists differ per área even for the same unit.
const unitCache = new Map<string, { data: ApiResponse; paidData: ApiResponse; ts: number }>();
const CACHE_TTL = 30000; // 30 seconds local memory cache for instant transitions

// ── Prefetch (idle-time background fetch to warm cache on hover) ──────────────
// Populates unitCache without touching React state — so when the user actually
// clicks, fetchData() finds a fresh cache hit and renders instantly.
const prefetching = new Set<string>();

async function prefetchUnitData(uf: string, area: string, unitId: number): Promise<void> {
	const cacheKey = `${uf}:${area}:${unitId}`;
	if (prefetching.has(cacheKey)) return;
	const cached = unitCache.get(cacheKey);
	if (cached && Date.now() - cached.ts < CACHE_TTL) return;
	prefetching.add(cacheKey);
	try {
		const res = await fetch(`/api/courses/all?uf=${uf}&unit=${unitId}&area=${area}`, {
			method: "GET",
		});
		if (!res.ok) return;
		const json: { free: ApiResponse; paid: ApiResponse } = await res.json();
		unitCache.set(cacheKey, { data: json.free, paidData: json.paid, ts: Date.now() });
	} catch {
		// silent — prefetch is best-effort
	} finally {
		prefetching.delete(cacheKey);
	}
}

// ── Aero atmosphere (background sky dressing) ───────────────────────────────
// Fixed, deterministic bubble presets — hand-picked, not Math.random() — so
// there is no hydration/re-render jitter and no per-mount recomputation cost.
// Each only ever animates transform/opacity via CSS (see .aero-bubble in
// styles/globals.css), so this whole layer is compositor-only.
const BUBBLE_PRESETS: {
	left: string;
	size: string;
	duration: string;
	delay: string;
	drift: string;
}[] = [
	{ left: "6%", size: "16px", duration: "22s", delay: "0s", drift: "24px" },
	{ left: "16%", size: "10px", duration: "17s", delay: "3s", drift: "-18px" },
	{ left: "28%", size: "26px", duration: "27s", delay: "1s", drift: "34px" },
	{ left: "41%", size: "13px", duration: "20s", delay: "6s", drift: "-22px" },
	{ left: "55%", size: "20px", duration: "24s", delay: "2s", drift: "16px" },
	{ left: "68%", size: "9px", duration: "16s", delay: "8s", drift: "-14px" },
	{ left: "80%", size: "24px", duration: "29s", delay: "4s", drift: "28px" },
	{ left: "91%", size: "14px", duration: "19s", delay: "5.5s", drift: "-20px" },
];

function AeroAtmosphere() {
	return (
		<>
			<div className="aero-bg-glow" />
			<div className="aero-orb aero-orb-1" />
			<div className="aero-orb aero-orb-2" />
			<div className="aero-orb aero-orb-3" />
			<div className="aero-rays" />
			<div className="aero-bubbles">
				{BUBBLE_PRESETS.map((b, i) => (
					<span
						// biome-ignore lint/suspicious/noArrayIndexKey: fixed-length static preset list, never reordered
						key={i}
						className="aero-bubble"
						style={
							{
								"--bubble-left": b.left,
								"--bubble-size": b.size,
								"--bubble-duration": b.duration,
								"--bubble-delay": b.delay,
								"--bubble-drift": b.drift,
							} as React.CSSProperties
						}
					/>
				))}
			</div>
		</>
	);
}

// ── App ──────────────────────────────────────────────────────────────────────

export function App() {
	const states = useStates();
	const [selectedUf, setSelectedUf] = useState<string>("sp");
	const currentState = states.find((s) => s.uf === selectedUf) ?? (states[0] as StateInfo);
	const isComingSoon = currentState.status === "coming-soon";

	const { areas, loading: areasLoading } = useAreas(selectedUf, isComingSoon);
	const [selectedArea, setSelectedArea] = useState<string>(DEFAULT_AREA_SLUG);
	const currentArea = areas.find((a) => a.slug === selectedArea) ?? areas[0];

	// Areas are state-specific — reset to the default área whenever the state
	// changes, since the previous selection may not exist for the new state.
	// biome-ignore lint/correctness/useExhaustiveDependencies: selectedUf is the reset trigger, not read in the body
	useEffect(() => {
		setSelectedArea(DEFAULT_AREA_SLUG);
	}, [selectedUf]);

	// Not every state has a "Tecnologia da Informação" área at all (e.g. mt.ts's
	// real catalog has none right now) — once the real área list loads, fall back
	// to the state's first área instead of silently fetching units/courses for a
	// default that returns empty for every unit (header text and actual fetched
	// data would otherwise disagree, since currentArea's own ?? areas[0] fallback
	// only covers display, not the área actually requested from the API).
	useEffect(() => {
		if (areasLoading || areas.length === 0) return;
		if (!areas.some((a) => a.slug === selectedArea)) {
			setSelectedArea(areas[0]?.slug ?? DEFAULT_AREA_SLUG);
		}
	}, [areas, areasLoading, selectedArea]);

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

	// Recolor the glassmorphism gradient/glow to match the selected state's logo.
	useEffect(() => {
		document.documentElement.style.setProperty("--brand-hue", String(currentState.hue));
	}, [currentState.hue]);

	// One-time: sets the CSS custom properties every static Aero cursor role
	// (pointer/text/help/…) reads — see the `body …` rules in globals.css.
	useEffect(() => {
		initStaticCursors();
	}, []);

	// "Coming soon" states have no backend adapter — clear course data instead of loading.
	useEffect(() => {
		if (!isComingSoon) return;
		setData(null);
		setPaidData(null);
		setError(null);
		setLoading(false);
	}, [isComingSoon]);

	// Fetch server-side config (defaultUnitId, refreshIntervalSeconds) — SP only, other
	// states pick their first unit once the unit list loads (see effect below).
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

	// Load unit list for the selected state + área — waits for catalog on server, so
	// may take a while on first run. "Coming soon" states have no backend adapter, and
	// the área list itself must resolve first (its default is a placeholder until then).
	useEffect(() => {
		if (isComingSoon || areasLoading) {
			setUnits([]);
			setUnitsLoading(!isComingSoon);
			return;
		}
		setUnitsLoading(true);
		fetch(`/api/units?uf=${selectedUf}&area=${selectedArea}`)
			.then((r) => r.json())
			.then((list: UnitInfo[]) => {
				setUnits(list);
				setUnitsLoading(false);
				setSelectedUnit((prev) => (list.some((u) => u.id === prev) ? prev : (list[0]?.id ?? prev)));
			})
			.catch(() => {
				setUnits([]);
				setUnitsLoading(false);
			});
	}, [selectedUf, selectedArea, isComingSoon, areasLoading]);

	const fetchData = useCallback(
		async (unitId: number, uf: string, area: string, force = false) => {
			const cacheKey = `${uf}:${area}:${unitId}`;
			if (!force) {
				const cached = unitCache.get(cacheKey);
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
				const res = await fetch(`/api/courses/all?uf=${uf}&unit=${unitId}&area=${area}`, {
					method: "GET",
				});
				if (!res.ok) throw new Error(`Erro ${res.status} do servidor`);
				const json: { free: ApiResponse; paid: ApiResponse } = await res.json();

				setData(json.free);
				setPaidData(json.paid);
				unitCache.set(cacheKey, { data: json.free, paidData: json.paid, ts: Date.now() });

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

	// Fetch when unit, state, or área changes
	useEffect(() => {
		if (isComingSoon || !selectedUnit) return;
		fetchData(selectedUnit, selectedUf, selectedArea);
	}, [selectedUnit, selectedUf, selectedArea, isComingSoon, fetchData]);

	// Auto-refresh countdown
	useEffect(() => {
		if (isComingSoon) return;
		const timer = setInterval(() => {
			countdownRef.current -= 1;
			setCountdown(countdownRef.current);
			if (countdownRef.current <= 0) {
				countdownRef.current = refreshInterval;
				setCountdown(refreshInterval);
				fetchData(selectedUnit, selectedUf, selectedArea);
			}
		}, 1000);
		return () => clearInterval(timer);
	}, [selectedUnit, selectedUf, selectedArea, isComingSoon, fetchData, refreshInterval]);

	const selectedUnitEntry = units.find((u) => u.id === selectedUnit);
	const selectedUnitName = selectedUnitEntry?.name ?? `Unidade ${selectedUnit}`;
	const selectedUnitDisplayId = selectedUnitEntry?.officialId ?? selectedUnit;

	// Free courses derived values — "tracked" excludes states whose source has no
	// real seat-count data (course.vagas === null), so totals aren't fabricated.
	const courses = data?.courses ?? [];
	const trackedCourses = courses.filter((c) => c.vagas !== null);
	const vagasTracked = trackedCourses.length > 0;
	const totalVagas = trackedCourses.reduce((sum, c) => sum + (c.vagas as number), 0);
	const openCount = trackedCourses.filter((c) => (c.vagas as number) > 0).length;
	const maxVagas = Math.max(...trackedCourses.map((c) => c.vagas as number), 1);
	const noCourses = !loading && !error && data !== null && courses.length === 0;

	// Paid courses derived values
	const paidCourses = paidData?.courses ?? [];
	const trackedPaidCourses = paidCourses.filter((c) => c.vagas !== null);
	const maxPaidVagas = Math.max(...trackedPaidCourses.map((c) => c.vagas as number), 1);
	const paidNoCourses = !loading && !error && paidData !== null && paidCourses.length === 0;

	function renderFreeChart() {
		if (slowLoad && loading) return <LoadingCard unitName={selectedUnitName} />;

		return (
			<Card className="glass-card glass-card-scan border-0 shadow-none bg-transparent section-3d section-3d-4">
				<CardHeader className="pb-3 pt-5 px-6">
					<CardTitle className="text-sm font-semibold text-ink/80 flex items-center gap-2.5">
						<span className="inline-block h-1 w-5 rounded-full bg-gradient-to-r from-brand to-brand-light shadow-[0_0_8px_oklch(0.6_0.2_var(--brand-hue)/0.55)]" />
						Cursos Gratuitos — {selectedUnitName}
					</CardTitle>
				</CardHeader>
				<CardContent className="px-6 pb-6 space-y-0.5">
					{loading
						? ["a", "b", "c", "d", "e", "f"].map((k, i) => <SkeletonBar key={k} delay={i * 55} />)
						: courses.map((course, i) => (
								<CourseBar
									key={course.id}
									course={course}
									maxVagas={maxVagas}
									index={i}
									uf={selectedUf}
								/>
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
					<CardTitle className="text-sm font-semibold text-ink/80 flex items-center gap-2.5">
						<span className="inline-block h-1 w-5 rounded-full bg-gradient-to-r from-accent2 to-accent2-light shadow-[0_0_8px_oklch(0.6_0.14_200/0.5)]" />
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
									uf={selectedUf}
								/>
							))}
				</CardContent>
			</Card>
		);
	}

	const isFetchingCursor = !isComingSoon && (loading || refreshing);

	return (
		<div
			className={cn(
				"aero-root min-h-screen w-full p-4 md:p-8",
				isFetchingCursor && workingCursorClass(currentState.hue),
			)}
			// Inline `style` always wins over a class selector, so the working
			// cursor (applied via className, see ani-cursor's :hover-driven
			// @keyframes in cursors.ts) must not be fought by an inline value here.
			style={isFetchingCursor ? undefined : { cursor: AERO_ARROW_CURSOR }}
		>
			<AeroAtmosphere />

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
							src={currentState.logo}
							alt={`SENAI ${currentState.name}`}
							className={cn("h-10 w-auto logo-float", wagtailCursorClass())}
							style={{
								filter:
									"drop-shadow(0 0 4px oklch(0.58 0.22 var(--brand-hue) / 0.55)) drop-shadow(0 0 10px oklch(0.5 0.2 var(--brand-hue) / 0.3))",
							}}
						/>
						<div>
							<h1 className="text-lg font-bold text-ink tracking-tight leading-tight">
								SENAI {isComingSoon ? currentState.name : selectedUnitName}
							</h1>
							<p className="text-sm text-brand-light/78">
								Cursos de{" "}
								{isComingSoon ? DEFAULT_AREA_LABEL : (currentArea?.label ?? DEFAULT_AREA_LABEL)}
							</p>
						</div>
					</div>

					<div className="flex items-center gap-3 ml-auto flex-wrap">
						{data && !loading && (
							<span className="flex items-center gap-1.5 text-xs text-brand-light/68">
								<Clock className="aero-icon-glint h-3 w-3 shrink-0" />
								Atualizado às {formatTime(data.lastUpdated)}
							</span>
						)}
						{loading && (
							<span className="flex items-center gap-1.5 text-xs text-brand/65">
								<Loader2 className="h-3 w-3 animate-spin shrink-0" />
								{slowLoad ? "Consultando SENAI…" : "Buscando cursos…"}
							</span>
						)}
						{!isComingSoon && (
							<Button
								size="sm"
								onClick={() => {
									fetchData(selectedUnit, selectedUf, selectedArea, true);
								}}
								disabled={refreshing || loading}
							>
								<RefreshCw
									className={cn("h-3.5 w-3.5 mr-1.5", (refreshing || loading) && "animate-spin")}
								/>
								{refreshing ? "Atualizando…" : "Atualizar"}
							</Button>
						)}
					</div>
				</header>

				{/* ── State + area + unit search ── */}
				<div className="flex items-center gap-3 flex-wrap section-3d section-3d-2">
					<StateSelector states={states} selectedUf={selectedUf} onSelect={setSelectedUf} />
					{!isComingSoon &&
						(areasLoading ? (
							<div className="glass-card rounded-xl flex items-center gap-2 px-3 py-2 w-full sm:w-64 border border-ink/12">
								<Loader2 className="h-3.5 w-3.5 text-brand/68 animate-spin shrink-0" />
								<span className="text-sm text-ink/40 animate-pulse">Carregando áreas…</span>
							</div>
						) : (
							<AreaSelector areas={areas} selectedSlug={selectedArea} onSelect={setSelectedArea} />
						))}
					{!isComingSoon &&
						(unitsLoading ? (
							<div className="glass-card rounded-xl flex items-center gap-2 px-3 py-2 w-full sm:w-72 border border-ink/12">
								<Loader2 className="h-3.5 w-3.5 text-brand/68 animate-spin shrink-0" />
								<span className="text-sm text-ink/40 animate-pulse">Carregando unidades…</span>
							</div>
						) : (
							<UnitSearch
								units={units}
								selectedId={selectedUnit}
								onSelect={setSelectedUnit}
								uf={selectedUf}
								area={selectedArea}
							/>
						))}
					{!isComingSoon && !unitsLoading && units.length > 0 && (
						<p className="text-xs text-ink/38">
							{units.length} unidade{units.length !== 1 ? "s" : ""} com cursos de{" "}
							{currentArea?.label ?? DEFAULT_AREA_LABEL}
						</p>
					)}
				</div>

				{/* ── Network / server error ── */}
				{error && (
					<div className="glass-card rounded-xl px-4 py-3 flex items-center gap-3 border border-destructive/35 section-3d">
						<AlertCircle className="h-4 w-4 text-destructive shrink-0" />
						<p className="text-sm text-destructive">{error}</p>
					</div>
				)}

				{isComingSoon ? (
					<ComingSoonCard stateName={currentState.name} />
				) : (
					<>
						{/* ── Stats ── */}
						<div className="grid grid-cols-2 md:grid-cols-4 gap-3">
							<StatCard
								icon={BookOpen}
								title="Cursos"
								value={loading ? "…" : courses.length}
								sub="presenciais"
								delay={80}
							/>
							<StatCard
								icon={Users}
								title="Vagas Abertas"
								value={loading ? "…" : vagasTracked ? totalVagas : "—"}
								sub={vagasTracked ? "total disponível" : "não informado pela fonte"}
								highlight={vagasTracked && totalVagas > 0}
								delay={140}
							/>
							<StatCard
								icon={CheckCircle}
								title="Com Vagas"
								value={loading ? "…" : vagasTracked ? openCount : "—"}
								sub={loading ? "" : vagasTracked ? `de ${courses.length} cursos` : "ver cada curso"}
								highlight={vagasTracked && openCount > 0}
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
						{noCourses && paidNoCourses && (
							<NoCoursesCard
								unitName={selectedUnitName}
								stateName={currentState.name}
								areaLabel={currentArea?.label ?? DEFAULT_AREA_LABEL}
							/>
						)}
						{!noCourses && renderFreeChart()}
						{!paidNoCourses && renderPaidChart()}
					</>
				)}

				{/* ── Footer ── */}
				<p className="text-center text-xs text-ink/35 pb-2 section-3d section-3d-5">
					Fonte: <span className="text-ink/42">{currentState.sourceLabel}</span>
					{!isComingSoon && (
						<>
							{" "}
							· Unidade {selectedUnitName} (ID {selectedUnitDisplayId}) · Refresh automático a cada
							5 min
						</>
					)}{" "}
					·{" "}
					<a
						href="/privacidade"
						className="underline hover:text-ink/60 transition-colors cursor-alias"
					>
						Política de Privacidade
					</a>
				</p>
			</div>
		</div>
	);
}

function PrivacyPolicy() {
	useEffect(() => {
		initStaticCursors();
	}, []);

	return (
		<div className="aero-root min-h-screen p-6 md:p-12" style={{ cursor: AERO_ARROW_CURSOR }}>
			<AeroAtmosphere />
			<div className="relative z-10 max-w-3xl mx-auto">
				<div className="glass-card rounded-2xl p-8 md:p-12">
					<a
						href="/"
						className="inline-flex items-center gap-2 text-sm text-ink/45 hover:text-ink/85 transition-colors mb-8 cursor-alias"
					>
						← Voltar para o início
					</a>

					<h1 className="text-3xl font-bold text-ink mb-2">Política de Privacidade</h1>
					<p className="text-ink/45 text-sm mb-8">Última atualização: 25 de abril de 2026</p>

					<div className="space-y-8 text-ink/72 text-sm leading-relaxed">
						<section>
							<h2 className="text-lg font-semibold text-ink/90 mb-3">1. Sobre este site</h2>
							<p>
								Este site (<strong>spsenai.arielaram.com</strong>) é um agregador independente e não
								oficial de vagas em cursos gratuitos de Tecnologia da Informação oferecidos pelo{" "}
								<strong>SENAI-SP</strong>. Os dados exibidos são obtidos publicamente em{" "}
								<span className="text-ink/55">sp.senai.br</span> e atualizados automaticamente a
								cada 5 minutos. O site é operado por <strong>Ariel Aram</strong> (
								<a
									href="mailto:arielaram@protonmail.com"
									className="underline hover:text-ink/95 transition-colors"
								>
									arielaram@protonmail.com
								</a>
								).
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-ink/90 mb-3">2. Dados coletados</h2>
							<p>
								Este site <strong>não coleta dados pessoais diretamente</strong>. Não há cadastro,
								login, formulário ou armazenamento de informações identificáveis dos visitantes em
								nossos servidores. Os dados exibidos (cursos, vagas, horários) são públicos e
								provenientes exclusivamente do SENAI-SP.
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-ink/90 mb-3">3. Armazenamento local</h2>
							<p>
								O site pode utilizar armazenamento local no navegador (como{" "}
								<code>localStorage</code>) apenas para salvar preferências de exibição de forma
								anônima e local no seu próprio dispositivo.
							</p>
						</section>

						<section>
							<h2 className="text-lg font-semibold text-ink/90 mb-3">4. Seus direitos</h2>
							<p className="mb-2">
								Nos termos da <strong>LGPD</strong> (Lei Geral de Proteção de Dados — Lei nº
								13.709/2018) e do <strong>GDPR</strong> (Regulamento Geral de Proteção de Dados da
								UE), você tem direito a:
							</p>
							<ul className="ml-4 list-disc space-y-1 text-ink/58">
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
							<h2 className="text-lg font-semibold text-ink/90 mb-3">
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
							<h2 className="text-lg font-semibold text-ink/90 mb-3">6. Contato</h2>
							<p>
								Para dúvidas sobre esta política de privacidade, entre em contato pelo e-mail:{" "}
								<a
									href="mailto:arielaram@protonmail.com"
									className="underline hover:text-ink/95 transition-colors"
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
