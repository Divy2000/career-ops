/** POST /api/pipeline/add limits: the route refuses a body past them, and Discover > Network scan stays inside them. */
export const PIPELINE_ADD_MAX = 200;
export const PIPELINE_OFFER_LIMITS = { company: 200, title: 300, location: 200, portal: 100 } as const;

/** A posting as scan-ats-full --json prints it: a missing location is null, a work-model-only board joins every office. */
export interface ScanPostingInput {
  url: string;
  company?: string | null;
  title?: string | null;
  location?: string | null;
  source?: string | null;
}

export interface PipelineOfferInput {
  url: string;
  company: string;
  title: string;
  location?: string;
  portal?: string;
}

function clamp(value: string | null | undefined, max: number): string | undefined {
  const s = (value ?? '').trim();
  if (!s) return undefined;
  return s.length <= max ? s : `${s.slice(0, max - 3).trimEnd()}...`;
}

/** Scan results as request bodies the route accepts: empty fields dropped, long ones shortened, at most PIPELINE_ADD_MAX per body. */
export function pipelineAddBatches(postings: ScanPostingInput[]): Array<{ offers: PipelineOfferInput[] }> {
  const offers = postings.map((p) => {
    const offer: PipelineOfferInput = { url: p.url, company: clamp(p.company, PIPELINE_OFFER_LIMITS.company) ?? '', title: clamp(p.title, PIPELINE_OFFER_LIMITS.title) ?? '' };
    const location = clamp(p.location, PIPELINE_OFFER_LIMITS.location);
    const portal = clamp(p.source, PIPELINE_OFFER_LIMITS.portal);
    if (location !== undefined) offer.location = location;
    if (portal !== undefined) offer.portal = portal;
    return offer;
  });
  const batches: Array<{ offers: PipelineOfferInput[] }> = [];
  for (let i = 0; i < offers.length; i += PIPELINE_ADD_MAX) batches.push({ offers: offers.slice(i, i + PIPELINE_ADD_MAX) });
  return batches;
}
