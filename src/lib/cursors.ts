import { convertAniBinaryToCSS } from "ani-cursor";
import arrowCur from "@/assets/cursors/Arrow.cur";
import busyBlue from "@/assets/cursors/busy/Blue.ani";
import busyGreen from "@/assets/cursors/busy/Green.ani";
import busyPink from "@/assets/cursors/busy/Pink.ani";
import busyPurple from "@/assets/cursors/busy/Purple.ani";
import busyRed from "@/assets/cursors/busy/Red.ani";
import busySilver from "@/assets/cursors/busy/Silver.ani";
import busyYellow from "@/assets/cursors/busy/Yellow.ani";
import crossCur from "@/assets/cursors/Cross.cur";
import handCur from "@/assets/cursors/Hand.cur";
import helpCur from "@/assets/cursors/Help.cur";
import moveCur from "@/assets/cursors/Move.cur";
import resize1Cur from "@/assets/cursors/Resize1.cur";
import resize2Cur from "@/assets/cursors/Resize2.cur";
import resize3Cur from "@/assets/cursors/Resize3.cur";
import resize4Cur from "@/assets/cursors/Resize4.cur";
import textCur from "@/assets/cursors/Text.cur";
import upCur from "@/assets/cursors/Up.cur";
import unavailableBlue from "@/assets/cursors/unavailable/Blue.ani";
import unavailableGreen from "@/assets/cursors/unavailable/Green.ani";
import unavailablePink from "@/assets/cursors/unavailable/Pink.ani";
import unavailablePurple from "@/assets/cursors/unavailable/Purple.ani";
import unavailableRed from "@/assets/cursors/unavailable/Red.ani";
import unavailableSilver from "@/assets/cursors/unavailable/Silver.ani";
import unavailableYellow from "@/assets/cursors/unavailable/Yellow.ani";
import wagtailAni from "@/assets/cursors/Wagtail.ani";
import workingBlue from "@/assets/cursors/working/Blue.ani";
import workingGreen from "@/assets/cursors/working/Green.ani";
import workingPink from "@/assets/cursors/working/Pink.ani";
import workingPurple from "@/assets/cursors/working/Purple.ani";
import workingRed from "@/assets/cursors/working/Red.ani";
import workingSilver from "@/assets/cursors/working/Silver.ani";
import workingYellow from "@/assets/cursors/working/Yellow.ani";

// Windows-XP-era "Aero Cursors" pack (C:\Portable\WindowsCursor-Aero) ships:
//   - Arrow.cur                          the default pointer
//   - Text/Hand/Help/Move/Cross/Up.cur   the other static system-cursor roles
//   - Resize1-4.cur                      the four resize-handle roles
//   - busy/working/unavailable/*.ani     THREE colored *animated* cursors per
//                                        theme (Blue/Green/Pink/Purple/Red/
//                                        Silver/Yellow)
//   - Wagtail.ani                        a bonus animated cursor, no fixed
//                                        system role
// Every `.cur` here is used unconverted: browsers support `.cur` natively as
// a static `cursor: url(...)`, embedded hotspot and all — no re-encoding, no
// manual x/y. `.ani` has no native CSS support at all, so those are rendered
// via `ani-cursor` (github.com/captbaritone/webamp — used in production for
// Winamp skins), which decodes the real frames and drives `cursor` through a
// discrete `@keyframes` animation, feeding the browser each frame's *raw*
// embedded `.cur` bytes as a data: URL — again, no GIF/PNG re-encoding.
type CursorColor = "red" | "yellow" | "green" | "blue" | "purple" | "pink" | "silver";
type CursorCategory = "busy" | "working" | "unavailable";

const ANI_FILES: Record<CursorCategory, Record<CursorColor, string>> = {
	busy: {
		red: busyRed,
		yellow: busyYellow,
		green: busyGreen,
		blue: busyBlue,
		purple: busyPurple,
		pink: busyPink,
		silver: busySilver,
	},
	working: {
		red: workingRed,
		yellow: workingYellow,
		green: workingGreen,
		blue: workingBlue,
		purple: workingPurple,
		pink: workingPink,
		silver: workingSilver,
	},
	unavailable: {
		red: unavailableRed,
		yellow: unavailableYellow,
		green: unavailableGreen,
		blue: unavailableBlue,
		purple: unavailablePurple,
		pink: unavailablePink,
		silver: unavailableSilver,
	},
};

// Hue bands (0-360, matching STATE_META's `hue` — see state-meta.ts) mapped
// to the closest Aero pack color, so a state's cursor color tracks its own
// brand hue (the same --brand-hue driving its glow/orb colors elsewhere).
// Full 360° coverage, six ~60°-wide bands centered on each color's natural
// position on the wheel — "silver" is an unreachable fallback, never a band
// of its own, since every hue maps into exactly one of the six.
// Red is centered near hue 20 so SP (20) and MG (20) land there, per the
// explicit example this mapping was corrected against — it previously fell
// just outside the red band's `< 20` cutoff and landed in yellow instead.
const BAND_WIDTH = [
	{ min: 350, max: 360, color: "red" as const },
	{ min: 0, max: 50, color: "red" as const },
	{ min: 50, max: 110, color: "yellow" as const },
	{ min: 110, max: 170, color: "green" as const },
	{ min: 170, max: 230, color: "blue" as const },
	{ min: 230, max: 290, color: "purple" as const },
	{ min: 290, max: 350, color: "pink" as const },
];

export function hueToCursorColor(hue: number): CursorColor {
	const h = ((hue % 360) + 360) % 360;
	return BAND_WIDTH.find((b) => h >= b.min && h < b.max)?.color ?? "silver";
}

/** `cursor` CSS value for the plain Aero pointer — .cur is natively supported
 * as a static cursor image (embedded hotspot and all), so the raw file is
 * used directly, unconverted. */
export const AERO_ARROW_CURSOR = `url(${arrowCur}), auto`;

// One <style> injected per animated cursor the app actually needs, the first
// time it's needed — fetched lazily so a session that never hovers, say, the
// unavailable-pink combo never pays for it.
const injected = new Set<string>();

function ensureAniClass(className: string, url: string): string {
	if (!injected.has(className)) {
		injected.add(className);
		fetch(url)
			.then((res) => res.arrayBuffer())
			.then((buf) => {
				const css = convertAniBinaryToCSS(`.${className}`, new Uint8Array(buf));
				const styleEl = document.createElement("style");
				styleEl.dataset.aniCursor = className;
				styleEl.textContent = css;
				document.head.appendChild(styleEl);
			});
	}
	return className;
}

/** CSS class for the given state's hue-matched "busy" ring (small spinning
 * ring beside the pointer) — used while hovering a state that's selectable
 * right now. Only animates on `:hover` (ani-cursor's own convention). */
export function busyCursorClass(hue: number): string {
	const color = hueToCursorColor(hue);
	return ensureAniClass(`cursor-busy-${color}`, ANI_FILES.busy[color]);
}

/** CSS class for the given state's hue-matched "not allowed" cursor — used
 * while hovering a coming-soon state (no live adapter yet). */
export function unavailableCursorClass(hue: number): string {
	const color = hueToCursorColor(hue);
	return ensureAniClass(`cursor-unavailable-${color}`, ANI_FILES.unavailable[color]);
}

/** CSS class for the given state's hue-matched "working" cursor (pointer +
 * trailing ring) — used while data is actively being fetched. */
export function workingCursorClass(hue: number): string {
	const color = hueToCursorColor(hue);
	return ensureAniClass(`cursor-working-${color}`, ANI_FILES.working[color]);
}

/** CSS class for the pack's bonus "Wagtail" animated cursor — no fixed
 * system role, used as a decorative flourish (see the header logo). */
export function wagtailCursorClass(): string {
	return ensureAniClass("cursor-wagtail", wagtailAni);
}

/** Sets the CSS custom properties (see styles/globals.css) that back every
 * *static* Aero cursor role — must run once, client-side, before those rules
 * have real cursors instead of their plain-keyword fallback. Each value pairs
 * the raw `.cur` file with the matching CSS cursor keyword as a fallback, so
 * a browser that can't decode the image still gets a sane native cursor. */
export function initStaticCursors(): void {
	const root = document.documentElement.style;
	root.setProperty("--cursor-arrow", `url(${arrowCur}), auto`);
	root.setProperty("--cursor-pointer", `url(${handCur}), pointer`);
	root.setProperty("--cursor-text", `url(${textCur}), text`);
	root.setProperty("--cursor-help", `url(${helpCur}), help`);
	root.setProperty("--cursor-move", `url(${moveCur}), move`);
	root.setProperty("--cursor-crosshair", `url(${crossCur}), crosshair`);
	root.setProperty("--cursor-alias", `url(${upCur}), alias`);
	// Windows cursor-scheme slot order (see the pack's .inf files): vert/horz
	// are the straight resize handles, dgn1/dgn2 the two diagonals.
	root.setProperty("--cursor-ns-resize", `url(${resize3Cur}), ns-resize`);
	root.setProperty("--cursor-ew-resize", `url(${resize1Cur}), ew-resize`);
	root.setProperty("--cursor-nwse-resize", `url(${resize4Cur}), nwse-resize`);
	root.setProperty("--cursor-nesw-resize", `url(${resize2Cur}), nesw-resize`);
}
