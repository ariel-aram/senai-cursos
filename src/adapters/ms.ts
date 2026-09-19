import { createFuturoDigitalAdapter } from "./futuro-digital";

// SENAI-MS (ms.senai.br) itself is a Laravel/Livewire site with a real course
// listing (71 cursos técnicos, server-paginated via ?page=N — confirmed live),
// but each course's own detail page links out to a "futuro.digital" checkout
// URL (e.g. "futuro.digital/ms-tecnico-em-informatica-tec185-...") — MS sells
// through the SAME shared VTEX cluster 137 as ma.ts/pi.ts/ro.ts/go.ts, with its
// own real "MS|" productReferenceCode prefix (confirmed: 59 real MS products in
// the cluster, with real "Área Tecnológica" taxonomy — Energia, Logística,
// Eletrônica e Automação, Metalmecânica, etc.).
export const msAdapter = createFuturoDigitalAdapter("ms", "MS|");
