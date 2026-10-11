/** A pipeline.md or shortlist.md text cell as written: scan.mjs and rank-pipeline.mjs escape \\, [ and ] in company, title, location and rank reason too (sanitizeMarkdownField). */
export function unescapeMarkdownCell(cell: string): string {
  return cell.replace(/\\([\\[\]])/g, '$1');
}
