// The paid sponsorship check writes data/immigration/companies/<slug>.md, named by companySlug() in
// custom/immigration/lib.mjs (the control center cannot import it). Every guard of that check keys a company by this
// slug, so two spellings of one company file ("Acme, Inc.", "Acme Inc") are one company: one guard per file.
const LEGAL_SUFFIXES = /\b(inc|llc|ltd|corp|corporation|co|plc|gmbh)\b\.?/g;

/** The company-file slug of `name` as companySlug() computes it, or '' when nothing is left after slugging. */
function companyFileSlug(name: string): string {
  return name
    .toLowerCase()
    .replace(/&/g, ' and ')
    .replace(/[()]/g, ' ')
    .replace(/[.,]/g, ' ')
    .replace(LEGAL_SUFFIXES, ' ')
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/** The company-file slug of `name`, or the trimmed, lowercased name when nothing is left after slugging. */
export function sponsorCheckCompany(name: string): string {
  return companyFileSlug(name) || name.trim().toLowerCase();
}

/**
 * Why a sponsorship check cannot run for `name`, or null when it can. The check saves its company file under the slug,
 * and companySlug() throws for a name that leaves nothing (only legal suffixes, punctuation or non-Latin characters),
 * so such a check would be paid for and never save its file.
 */
export function sponsorCheckRefusal(name: string): string | null {
  if (companyFileSlug(name)) return null;
  return `"${name.trim()}" has no Latin letters or digits besides a legal suffix (inc, llc, ltd, corp, corporation, co, plc, gmbh), so a sponsorship check could not name its company file. Use the company's distinctive name in Latin letters, for example "Acme Ltd" rather than "Ltd".`;
}
