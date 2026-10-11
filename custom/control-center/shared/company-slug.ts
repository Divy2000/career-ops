// The paid sponsorship check writes data/immigration/companies/<slug>.md, named by companySlug() in
// custom/immigration/lib.mjs (the control center cannot import it). Every guard of that check keys a company by this
// slug, so two spellings of one company file ("Acme, Inc.", "Acme Inc") are one company: one guard per file.
const LEGAL_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|co|plc|gmbh)\b\.?/g;

/** The company-file slug of `name`, or the trimmed, lowercased name when nothing is left after slugging. */
export function sponsorCheckCompany(name: string): string {
  const slug = name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[()]/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return slug || name.trim().toLowerCase();
}
