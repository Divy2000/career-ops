// The paid sponsorship check writes data/immigration/companies/<slug>.md, named by companySlug() in
// custom/immigration/lib.mjs (the web cannot import it). Lookup names the company by its DOL entity and an application
// by its tracker name, so both remember their check under this slug: one guard per company file, not per spelling.
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
