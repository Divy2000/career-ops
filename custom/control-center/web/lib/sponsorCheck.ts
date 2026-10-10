// The paid sponsorship-check session runs from Sponsorship > Lookup and from an application's Sponsorship tab, and
// writes data/immigration/companies/<company>.md either way: both remember it under one key per company, so a check
// started in one place shows in the other and no second check of that company starts beside it.

/**
 * The storage key of a company's last check: one per company, so another company's check is never re-attached. Callers
 * pass the company-file slug (sponsorCheckCompany), so spellings that share a company file share a key; it is encoded
 * here because the slug falls back to the raw name when nothing is left after slugging.
 */
export const sponsorCheckKey = (company: string) => `cc.sponsorship.check:${encodeURIComponent(company.trim().toLowerCase())}`;

export const sponsorCheckPrompt = (company: string) => `Check visa sponsorship for ${company} following the procedure in modes/_custom.md, then write the company file under data/immigration/companies/.`;
