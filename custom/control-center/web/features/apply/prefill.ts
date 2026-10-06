import { prefillUrlProblem } from '@shared/prefill';

/** Every reason the zero-token prefill cannot run yet; needsPdf says the Generate path applies. */
export function prefillBlockers(input: { url: string; pdf: string; pdfCount: number; company: string | null; refused?: string[] }): { reasons: string[]; needsPdf: boolean } {
  const { url, pdf, pdfCount, company, refused = [] } = input;
  const reasons: string[] = [];
  const problem = url ? prefillUrlProblem(url) : 'Enter the apply link first.';
  if (problem) reasons.push(problem);
  const needsPdf = !pdf;
  if (needsPdf) {
    if (company) reasons.push(`No tailored CV PDF for ${company} yet. Generate it first${pdfCount > 0 ? ', or choose another PDF to attach' : ''}.`);
    else reasons.push(pdfCount > 0 ? 'Choose the CV PDF to attach.' : 'No CV PDFs in output/ yet. Open the application from the Tracker and generate its tailored CV first.');
  }
  // A file dropped into output/ by hand can have a name the prefill action's schema refuses ("Acme Resume.pdf").
  for (const file of refused) reasons.push(`Prefill can't take ${file}: its name may only use letters, digits and . _ -. Rename it in output/.`);
  return { reasons, needsPdf };
}
