import { createFuturoDigitalAdapter } from "./futuro-digital";

// SENAI-ES sells through the same shared "futuro.digital" VTEX cluster 137
// as ma.ts/pi.ts/ro.ts/ms.ts/go.ts, under the real "ES|" productReferenceCode
// prefix (confirmed: 16 real products, 6 with an actually available turma,
// across 3 real cities — Linhares, Cachoeiro de Itapemirim, Vila Velha — with
// real "Área Tecnológica" taxonomy including Tecnologia da Informação).
export const esAdapter = createFuturoDigitalAdapter("es", "ES|");
