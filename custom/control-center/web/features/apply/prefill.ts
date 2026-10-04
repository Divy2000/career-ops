import { prefillUrlProblem } from '@shared/prefill';

/** Every reason the zero-token prefill cannot run yet; needsPdf says the Generate path applies. */
export function prefillBlockers(input: { url: string; pdf: string; pdfCount: number; company: string | null }): { reasons: string[]; needsPdf: boolean } {
  const { url, pdf, pdfCount, company } = input;
  const reasons: string[] = [];
  const problem = url ? prefillUrlProblem(url) : 'Enter the apply link first.';
  if (problem) reasons.push(problem);
  const needsPdf = !pdf;
  if (needsPdf) {
    if (company) reasons.push(`No tailored CV PDF for ${company} yet. Generate it first${pdfCount > 0 ? ', or choose another PDF to attach' : ''}.`);
    else reasons.push(pdfCount > 0 ? 'Choose the CV PDF to attach.' : 'No CV PDFs in output/ yet. Open the application from the Tracker and generate its tailored CV first.');
  }
  return { reasons, needsPdf };
}
