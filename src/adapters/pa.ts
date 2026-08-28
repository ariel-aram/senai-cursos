import { createFuturoDigitalAdapter } from "./futuro-digital";

// SENAI-PA sells through the same shared "futuro.digital" VTEX cluster 137
// as ma.ts/pi.ts/ro.ts/ms.ts/go.ts, under the real "PA|" productReferenceCode
// prefix (confirmed: 12 real products, 3 with an actually available turma, in
// Paragominas — thin but real, same tier as ms.ts).
export const paAdapter = createFuturoDigitalAdapter("pa", "PA|");
