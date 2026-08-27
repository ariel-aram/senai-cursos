/** Area slug every adapter must support and every state defaults to on first
 * paint — kept as the fallback so the app's original "T.I. only" behavior never
 * regresses for states that can't (yet) enumerate real categories (see ma.ts).
 * Browser-safe: no adapter/db/config imports allowed here (see state-meta.ts). */
export const DEFAULT_AREA_SLUG = "tecnologia-da-informacao";
export const DEFAULT_AREA_LABEL = "Tecnologia da Informação";
