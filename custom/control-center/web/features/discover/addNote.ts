/** What an add to the pipeline did, from POST /api/pipeline/add's own counts: the route skips URLs the pipeline already lists. */
export function addNote(added: number, skipped: number): string {
  return `Added ${added} to the pipeline${skipped ? `; ${skipped} ${skipped === 1 ? 'was' : 'were'} already there` : ''}`;
}
