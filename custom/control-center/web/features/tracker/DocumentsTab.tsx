import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import { paramAccepts, useActions, useRunAction } from '../../lib/actions';
import { ActionButton, Message } from '../../components/ActionBar';
import { DataState, Empty, Pill, TableScroll } from '../../components/ui';
import type { DocumentsRead } from '@shared/api';

export function DocumentsTab({ n }: { n: number }) {
  const q = useQuery({ queryKey: ['tracker', 'documents', n], queryFn: () => apiGet<DocumentsRead>(`/api/tracker/${n}/documents`) });
  const actions = useActions();
  const { run, message } = useRunAction();
  const render = actions.data?.find((a) => a.id === 'docs.renderPdf');
  return (
    <div className="card stack">
      <h2>Documents</h2>
      <DataState query={q}>
        {q.data && (
          <>
            {!q.data.indexPresent && <p className="faint">No data/pdf-index.tsv yet; showing output/ files that match the company.</p>}
            {q.data.report === null && q.data.files.some((f) => f.html) && <p className="faint">Re-render needs an evaluation report for this application, because the PDF index files every PDF under its report number.</p>}
            {q.data.files.length === 0 ? (
              <Empty>No PDFs yet. Generate one with the pdf mode (Claude engine) or drop files into output/.</Empty>
            ) : (
              <TableScroll label="Generated documents">
                <table className="table" aria-label="Generated documents">
                  <thead>
                    <tr>
                      <th scope="col">Kind</th>
                      <th scope="col">File</th>
                      <th scope="col">Date</th>
                      <th scope="col">
                        <span className="sr-only">Actions</span>
                      </th>
                    </tr>
                  </thead>
                  <tbody>
                    {q.data.files.map((f) => {
                      // A file dropped into output/ by hand can have a name the re-render action's schema refuses ("Acme Resume.html").
                      const nameAccepted = Boolean(f.html) && paramAccepts(render, 'html', f.html!) && paramAccepts(render, 'pdf', f.path);
                      return (
                        <tr key={f.path}>
                          <td>
                            <Pill tone={f.kind === 'cover' ? 'info' : 'accent'}>{f.kind}</Pill>
                          </td>
                          <td className="mono">
                            <a href={`/api/files/serve?path=${encodeURIComponent(f.path)}`} target="_blank" rel="noreferrer noopener">
                              {f.path}
                            </a>
                            {f.source === 'output' && <span className="faint small"> (matched by company)</span>}
                          </td>
                          <td className="mono muted">{f.date ?? ''}</td>
                          <td>
                            <div className="row gap">
                              {f.html && (
                                <a className="button-link" href={`/api/files/serve?path=${encodeURIComponent(f.html)}`} target="_blank" rel="noreferrer noopener">
                                  Open HTML
                                </a>
                              )}
                              {f.html && f.rerenderBlock && <span className="faint small">{f.rerenderBlock}</span>}
                              {f.html && !f.rerenderBlock && !nameAccepted && <span className="faint small">Re-render needs a file name with only letters, digits and . _ -. Rename {f.html} and its PDF in output/.</span>}
                              {f.html && !f.rerenderBlock && nameAccepted && (
                                <ActionButton meta={render} disabled={q.data.report === null} params={{ row: n, report: q.data.report, html: f.html, pdf: f.path, format: f.format === 'a4' ? 'a4' : 'letter' }} onRun={(p) => void run('docs.renderPdf', p, 'Re-render started (see Runs)')}>
                                  Re-render from HTML
                                </ActionButton>
                              )}
                            </div>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </TableScroll>
            )}
            {q.data.jds.length > 0 && (
              <>
                <h3>JD archive</h3>
                <ul className="bullets">
                  {q.data.jds.map((j) => (
                    <li key={j}>
                      <a className="mono" href={`/api/files/serve?path=${encodeURIComponent(j)}`} target="_blank" rel="noreferrer noopener">
                        {j}
                      </a>
                    </li>
                  ))}
                </ul>
              </>
            )}
          </>
        )}
      </DataState>
      <Message message={message} />
    </div>
  );
}
