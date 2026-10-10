/**
 * The actions the Ask drawer accepts from the advisor, with the params its run switch reads. The drawer's allowlist and the
 * advisor's envelope contract are both built from this list, so the advisor is told exactly the names and keys that run.
 */
export interface AskActionParam {
  name: string;
  required: boolean;
  /** What the value is, for the advisor. */
  about: string;
}

export interface AskActionSpec {
  name: string;
  params: AskActionParam[];
  /** It changes a file or spends tokens: the drawer asks the user first. */
  confirm: boolean;
  writes: boolean;
  /** False for actions the drawer only answers with a note to do it by hand; the advisor is not offered those. */
  runs: boolean;
}

const param = (name: string, about: string, required = true): AskActionParam => ({ name, required, about });

export const ASK_ACTION_SPECS = [
  { name: 'navigate', params: [param('to', 'an app path such as /tracker/12 or /pipeline')], confirm: false, writes: false, runs: true },
  { name: 'filterPipeline', params: [param('q', 'text to filter the Inbox by')], confirm: false, writes: false, runs: true },
  { name: 'evaluate', params: [param('url', 'the job posting URL')], confirm: true, writes: true, runs: true },
  { name: 'evaluateCompany', params: [param('company', 'the company name as the pipeline writes it')], confirm: true, writes: true, runs: true },
  { name: 'explore', params: [], confirm: false, writes: false, runs: true },
  { name: 'research', params: [param('topic', 'a company or topic')], confirm: true, writes: true, runs: true },
  { name: 'generatePdf', params: [param('row', 'the tracker row number')], confirm: true, writes: true, runs: true },
  { name: 'setStatus', params: [param('row', 'the tracker row number'), param('state', 'one of the exact statuses: Evaluated, Applied, Responded, Interview, Offer, Hired, Rejected, Discarded, SKIP'), param('note', 'a short note for the status log', false)], confirm: true, writes: true, runs: true },
  { name: 'apply', params: [param('row', 'the tracker row number')], confirm: false, writes: false, runs: true },
  { name: 'setApplyField', params: [param('id', 'the form field id'), param('value', 'the value')], confirm: false, writes: false, runs: false },
  { name: 'remember', params: [param('fact', 'one line (at most 300 characters) to add to modes/_profile.md')], confirm: true, writes: true, runs: true },
  { name: 'setProfile', params: [], confirm: true, writes: true, runs: false },
  { name: 'setPortals', params: [], confirm: true, writes: true, runs: false },
] as const satisfies readonly AskActionSpec[];

export type AskActionName = (typeof ASK_ACTION_SPECS)[number]['name'];

/** One line per action the advisor may propose: `name(param, optional?)`, what each param is, and whether it writes. */
export function askActionsContract(): string {
  return (ASK_ACTION_SPECS as readonly AskActionSpec[])
    .filter((a) => a.runs)
    .map((a) => {
      const sig = `${a.name}(${a.params.map((p) => (p.required ? p.name : `${p.name}?`)).join(', ')})`;
      const about = a.params.map((p) => `${p.name}: ${p.about}`).join('; ');
      return `${sig}${about ? ` -- ${about}` : ''}${a.writes ? ' [writes]' : ''}`;
    })
    .join(' | ');
}
