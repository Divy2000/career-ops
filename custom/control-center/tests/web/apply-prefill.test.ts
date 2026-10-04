import { describe, expect, it } from 'vitest';
import { prefillBlockers } from '../../web/features/apply/prefill';

const GREENHOUSE = 'https://boards.greenhouse.io/acme/jobs/123';

describe('prefillBlockers', () => {
  it('has nothing to say when the link is an ATS link and a PDF is chosen', () => {
    expect(prefillBlockers({ url: GREENHOUSE, pdf: 'output/a.pdf', pdfCount: 1, company: 'Acme' })).toEqual({ reasons: [], needsPdf: false });
  });

  it('asks for the link when it is empty', () => {
    expect(prefillBlockers({ url: '', pdf: 'output/a.pdf', pdfCount: 1, company: null }).reasons).toEqual(['Enter the apply link first.']);
  });

  it('explains why a job-board listing will not prefill', () => {
    const { reasons } = prefillBlockers({ url: 'https://www.builtinaustin.com/job/x/1', pdf: 'output/a.pdf', pdfCount: 1, company: null });
    expect(reasons).toHaveLength(1);
    expect(reasons[0]).toContain('www.builtinaustin.com');
  });

  it('says the application has no tailored CV yet and offers another PDF when there are some', () => {
    expect(prefillBlockers({ url: GREENHOUSE, pdf: '', pdfCount: 2, company: 'Northwind' })).toEqual({
      reasons: ['No tailored CV PDF for Northwind yet. Generate it first, or choose another PDF to attach.'],
      needsPdf: true,
    });
    expect(prefillBlockers({ url: GREENHOUSE, pdf: '', pdfCount: 0, company: 'Northwind' }).reasons).toEqual(['No tailored CV PDF for Northwind yet. Generate it first.']);
  });

  it('without an application, asks to choose a PDF or points at the Tracker when output/ has none', () => {
    expect(prefillBlockers({ url: GREENHOUSE, pdf: '', pdfCount: 3, company: null }).reasons).toEqual(['Choose the CV PDF to attach.']);
    expect(prefillBlockers({ url: GREENHOUSE, pdf: '', pdfCount: 0, company: null }).reasons).toEqual(['No CV PDFs in output/ yet. Open the application from the Tracker and generate its tailored CV first.']);
  });

  it('lists every problem at once', () => {
    expect(prefillBlockers({ url: 'https://www.builtinaustin.com/job/x/1', pdf: '', pdfCount: 0, company: 'Northwind' }).reasons).toHaveLength(2);
  });
});
