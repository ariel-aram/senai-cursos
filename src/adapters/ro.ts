import { createFuturoDigitalAdapter } from "./futuro-digital";

// SENAI-RO shares the tewbhv "futuro.digital" VTEX backend (see futuro-digital.ts)
// — found by reading portal.fiero.org.br's real course-catalog link, which points
// to futuro.digital/senai-ro. productReferenceCode for RO's own products starts
// with "RO|" (confirmed by inspecting real product data in the shared cluster).
export const roAdapter = createFuturoDigitalAdapter("ro", "RO|");
