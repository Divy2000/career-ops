import { prefillUrlProblem } from '@shared/prefill';
import { outputFileProblem } from '@shared/output-path';

/**
 * Every reason the zero-token prefill cannot run yet; needsPdf says the Generate path applies. A file dropped into output/
 * by hand is checked by the rule the prefill action applies (shared/output-path.ts), so it is never offered and then
 * refused.
 */
export function prefillBlockers(input: { url: string; pdf: string; cover?: string; pdfCount: number; company: string | null }): { reasons: string[]; needsPdf: boolean } {
  const { url, pdf, cover = '', pdfCount, company } = input;
  const reasons: string[] = [];
  const problem = url ? prefillUrlProblem(url) : 'Enter the apply link first.';
  if (problem) reasons.push(problem);
  const needsPdf = !pdf;
  if (needsPdf) {
    if (company) reasons.push(`No tailored CV PDF for ${company} yet. Generate it first${pdfCount > 0 ? ', or choose another PDF to attach' : ''}.`);
    else reasons.push(pdfCount > 0 ? 'Choose the CV PDF to attach.' : 'No CV PDFs in output/ yet. Open the application from the Tracker and generate its tailored CV first.');
  }
  for (const [file, ext, what] of [[pdf, /\.pdf$/i, 'a .pdf file'], [cover, /\.(txt|md)$/i, 'a .txt or .md file']] as const) {
    const refused = file ? outputFileProblem(file, ext, what) : null;
    if (refused) reasons.push(`Prefill can't take ${file}: ${refused}. Rename it in output/.`);
  }
  return { reasons, needsPdf };
}
