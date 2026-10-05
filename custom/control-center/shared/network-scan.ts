/**
 * The ATS sources scan-ats-full.mjs walks a public company directory for (its SOURCES keys, in order).
 * The scanner is a writer script that never loads into the server, so the contract test pins this copy to it.
 */
export const NETWORK_SCAN_SOURCES = ['greenhouse', 'lever', 'ashby', 'workday', 'icims', 'bamboohr'] as const;
export type NetworkScanSource = (typeof NETWORK_SCAN_SOURCES)[number];
