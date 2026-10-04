import { useState } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '../../lib/api';
import { describeError } from '../../lib/actions';
import { formatLocalMinute } from '../../lib/time';
import { Md } from '../../components/Md';
import { SessionPanel } from '../../components/SessionPanel';
import { Empty, Pill, SponsorPill, alertTone } from '../../components/ui';
import { MAX_COMPANY_QUERY_LENGTH, parseCompanyQuery } from '@shared/companyQuery';
import type { H1bCheck, LookupResult, SearchResult } from '@shared/api';

const route = getRouteApi('/sponsorship');

function useLookup(company: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['sponsorship', 'lookup', company],
    queryFn: () => apiGet<LookupResult>(`/api/sponsorship/lookup?company=${encodeURIComponent(company ?? '')}`),
    enabled: enabled && Boolean(company),
    staleTime: 30_000,
  });
}

function useNameSearch(q: string | undefined, enabled: boolean) {
  return useQuery({
    queryKey: ['sponsorship', 'search', q],
    queryFn: () => apiGet<SearchResult>(`/api/sponsorship/search?q=${encodeURIComponent(q ?? '')}`),
    enabled: enabled && Boolean(q),
    staleTime: 30_000,
  });
}

function Loading() {
  return (
    <div className="card skeleton" aria-busy="true">
      <div className="skeleton__line" />
      <div className="skeleton__line short" />
    </div>
  );
}

function IndexMissing({ message, command }: { message: string | null; command: string | null }) {
  return (
    <div className="card card--warn" role="status">
      <strong>The local H-1B index is not installed.</strong>
      <p className="muted">{message}</p>
      <p className="small muted">Run this in a terminal from the career-ops root. Control Center never runs it for you:</p>
      <pre className="mono" tabIndex={0}>{command}</pre>
    </div>
  );
}

function Totals({ check }: { check: H1bCheck }) {
  const t = check.totals;
  const years = t.first_year && t.last_year ? `${t.first_year} to ${t.last_year}` : (t.last_year ?? t.first_year ?? 'n/a');
  const tiles: Array<[string, string, string?]> = [
    ['LCAs filed', String(t.n_lca)],
    ['Certified', t.n_certified === null ? 'not reported' : String(t.n_certified), t.n_certified === null ? 'The source did not report certifications; that is not zero.' : 'Of the LCAs filed. A denial is not evidence the employer will not sponsor.'],
    ['PWD filings', String(t.n_pwd)],
    ['PERM filings', String(t.n_perm)],
    ['Active years', String(years)],
    ['Green cards', t.does_gc ? 'yes' : 'no'],
  ];
  return (
    <div className="tiles lookup-tiles">
      {tiles.map(([label, value, hint]) => (
        <div className="tile" key={label} title={hint}>
          <span className="tile__label">{label}</span>
          <span className={`tile__value ${value.length > 6 ? 'tile__value--small' : ''}`}>{value}</span>
        </div>
      ))}
    </div>
  );
}

function SponsorCheckLauncher({ company }: { company: string }) {
  const [launched, setLaunched] = useState(false);
  return (
    <div className="card stack">
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <div>
          <h2 style={{ margin: 0 }}>Research with Claude</h2>
          <p className="muted small" style={{ margin: 0 }}>Starts the sponsorship-check session for {company} and saves the result under data/immigration/companies/.</p>
        </div>
        <div className="row gap">
          <button type="button" className="button--primary" disabled={launched} onClick={() => setLaunched(true)}>
            Run sponsorship check <Pill tone="warn">Uses tokens</Pill>
          </button>
          <Link to="/sessions" className="button-link">
            Sessions
          </Link>
        </div>
      </div>
      {launched && (
        <SessionPanel
          mode="sponsorship-check"
          title="Sponsorship check"
          target={{ type: 'company', value: company }}
          autoStart
          initialPrompt={`Check visa sponsorship for ${company} following the procedure in modes/_custom.md, then write the company file under data/immigration/companies/.`}
        />
      )}
    </div>
  );
}

function LocalData({ r }: { r: LookupResult }) {
  const f = r.freshness;
  const refresh = f && typeof f.refresh === 'boolean' ? f.refresh : null;
  return (
    <>
      <div className="card" aria-labelledby="lookup-freshness">
        <h2 id="lookup-freshness">Saved check freshness</h2>
        {!f ? (
          <Empty>Freshness was not checked.</Empty>
        ) : typeof f.error === 'string' ? (
          <p className="danger-text" role="alert">
            {f.error}
          </p>
        ) : (
          <dl className="kv">
            <div className="kv__pair">
              <dt>Checked at</dt>
              <dd className="mono">{typeof f.checked_at === 'string' ? f.checked_at : 'never'}</dd>
            </div>
            <div className="kv__pair">
              <dt>Refresh</dt>
              <dd>{refresh === null ? 'unknown' : <Pill tone={refresh ? 'warn' : 'ok'}>{refresh ? 'yes, refresh' : 'no, still fresh'}</Pill>}</dd>
            </div>
            <div className="kv__pair">
              <dt>Reason</dt>
              <dd>{typeof f.reason === 'string' ? f.reason : ''}</dd>
            </div>
          </dl>
        )}
      </div>
      <div className="card" aria-labelledby="lookup-file">
        <h2 id="lookup-file">Saved company file</h2>
        {r.companyFile && r.markdown !== null ? (
          <>
            <p className="faint small mono">{r.companyFile.path}</p>
            <Md text={r.markdown} />
          </>
        ) : (
          <Empty>No saved check for this company yet. Run the sponsorship check below to create one.</Empty>
        )}
      </div>
      <div className="card" aria-labelledby="lookup-alerts">
        <h2 id="lookup-alerts">Company alerts</h2>
        {r.alerts.length === 0 ? (
          <Empty>No company alerts match this name.</Empty>
        ) : (
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">Date</th>
                  <th scope="col">Company</th>
                  <th scope="col">Status</th>
                  <th scope="col">Headline</th>
                </tr>
              </thead>
              <tbody>
                {r.alerts.map((a, i) => (
                  <tr key={i}>
                    <td className="mono">{a.date}</td>
                    <td>{a.company}</td>
                    <td>
                      <Pill tone={alertTone(a.status ?? '')}>{a.status}</Pill>
                    </td>
                    <td>
                      {a.url ? (
                        <a href={a.url} target="_blank" rel="noreferrer noopener">
                          {a.headline}
                        </a>
                      ) : (
                        a.headline
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </>
  );
}

function LookupView({ query }: { query: string }) {
  const q = useLookup(query, true);
  if (q.isPending) return <Loading />;
  if (q.isError)
    return (
      <div className="card card--danger" role="alert">
        <strong>Lookup failed.</strong> <span className="muted">{describeError(q.error)}</span>
        <div style={{ marginTop: 8 }}>
          <button type="button" onClick={() => void q.refetch()}>
            Retry
          </button>
        </div>
      </div>
    );
  const r = q.data;
  const check = r.check;
  const staffing = check?.redFlags.staffing_shop;
  const company = check?.found ? check.displayName : r.query;
  return (
    <div className="stack">
      {r.state === 'index_missing' && <IndexMissing message={r.error} command={r.installCommand} />}
      {r.state === 'error' && (
        <div className="card card--danger" role="alert">
          <strong>The sponsor check failed.</strong> <span className="muted">{r.error}</span>
        </div>
      )}
      {r.state === 'not_found' && (
        <div className="card card--warn" role="status">
          <strong>No DOL sponsor record for &quot;{r.query}&quot;.</strong>
          <p className="muted">
            The index lists legal entity names, so a brand such as JPMorganChase files as JPMorgan Chase &amp; Co. Search the names to find the exact entity. Unknown is not the same as does not sponsor.
          </p>
          <Link to="/sponsorship" search={{ tab: 'lookup', q: r.query, mode: 'search' }} className="button-link">
            Search names for {r.query}
          </Link>
        </div>
      )}
      {r.state === 'found' && check && (
        <div className="card stack" aria-labelledby="lookup-name">
          <div className="row gap" style={{ justifyContent: 'space-between' }}>
            <div>
              <h2 id="lookup-name" style={{ margin: 0 }}>
                {check.displayName}
              </h2>
              {check.displayName.toLowerCase() !== r.query.toLowerCase() && <p className="muted small" style={{ margin: 0 }}>Matched from &quot;{r.query}&quot;</p>}
            </div>
            <SponsorPill tier={check.friendlinessTier} />
          </div>
          {staffing?.value && (
            <p className="card card--danger" role="status" style={{ margin: 0 }}>
              <strong>Staffing-shop red flag.</strong> {staffing.share !== null ? `${Math.round(staffing.share * 100)}% of filings are at secondary worksites` : 'Most filings are at secondary worksites'}
              {staffing.n_secondary != null && staffing.n_total != null ? ` (${staffing.n_secondary} of ${staffing.n_total})` : ''}. Roles may be placements at client sites.
            </p>
          )}
          <Totals check={check} />
          <p className="faint small mono" style={{ margin: 0 }}>
            Source {check.source ?? 'unknown'} | fetched {formatLocalMinute(check.fetchedAt)}
          </p>
        </div>
      )}
      <LocalData r={r} />
      <SponsorCheckLauncher key={company} company={company} />
    </div>
  );
}

function SearchView({ query }: { query: string }) {
  const q = useNameSearch(query, true);
  if (q.isPending) return <Loading />;
  if (q.isError)
    return (
      <div className="card card--danger" role="alert">
        <strong>Search failed.</strong> <span className="muted">{describeError(q.error)}</span>
      </div>
    );
  const r = q.data;
  if (r.state === 'index_missing') return <IndexMissing message={r.error} command={r.installCommand} />;
  if (r.state === 'error')
    return (
      <div className="card card--danger" role="alert">
        <strong>Search failed.</strong> <span className="muted">{r.error}</span>
      </div>
    );
  return (
    <div className="card" aria-labelledby="search-results">
      <h2 id="search-results">
        {r.shown === 0 ? `No DOL entities match "${r.query}"` : r.total > r.shown ? `${r.shown} of ${r.total} entities match "${r.query}"` : `${r.total} ${r.total === 1 ? 'entity matches' : 'entities match'} "${r.query}"`}
      </h2>
      {r.shown === 0 ? (
        <Empty>Try a shorter query (at least 2 characters) or the legal name without punctuation.</Empty>
      ) : (
        <>
          {r.total > r.shown && <p className="muted small">Narrow the query to see the rest.</p>}
          <div className="table-wrap">
            <table className="table">
              <thead>
                <tr>
                  <th scope="col">DOL entity</th>
                  <th scope="col">Employer id</th>
                </tr>
              </thead>
              <tbody>
                {r.results.map((hit) => (
                  <tr key={hit.id}>
                    <td>
                      <Link to="/sponsorship" search={{ tab: 'lookup', q: hit.name, mode: 'lookup' }} title={`Look up exactly ${hit.name}`}>
                        {hit.name}
                      </Link>
                    </td>
                    <td className="mono muted">{hit.id}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  );
}

export function LookupTab() {
  const { q, mode } = route.useSearch();
  const navigate = useNavigate({ from: '/sponsorship' });
  const [draft, setDraft] = useState(q ?? '');
  const [error, setError] = useState<string | null>(null);
  const [seenQ, setSeenQ] = useState(q);
  if (q !== seenQ) {
    setSeenQ(q);
    setDraft(q ?? '');
    setError(null);
  }
  const submit = (next: 'lookup' | 'search') => {
    const parsed = parseCompanyQuery(draft);
    if (!parsed.ok) {
      setError(parsed.error);
      return;
    }
    setError(null);
    void navigate({ search: { tab: 'lookup', q: parsed.value, mode: next } });
  };
  return (
    <div className="stack">
      <form
        className="card stack"
        aria-labelledby="lookup-title"
        onSubmit={(e) => {
          e.preventDefault();
          submit('lookup');
        }}
      >
        <div>
          <h2 id="lookup-title" style={{ margin: 0 }}>
            H-1B sponsor lookup
          </h2>
          <p className="muted small" style={{ margin: 0 }}>
            Reads the local DOL disclosure index through plugins/h1b-sponsor. Lookups stay on this machine unless H1B_API_BASE is set.
          </p>
        </div>
        <div className="row gap">
          <label style={{ flex: 1 }}>
            <span className="sr-only">Company name</span>
            <input aria-label="Company name" type="text" value={draft} maxLength={MAX_COMPANY_QUERY_LENGTH} placeholder="Company name, for example Acme Robotics" onChange={(e) => setDraft(e.target.value)} aria-invalid={error ? true : undefined} />
          </label>
          <button type="submit" className="button--primary">
            Look up
          </button>
          <button type="button" onClick={() => submit('search')} title="List every DOL entity whose name contains the query">
            Search names
          </button>
        </div>
        {error && (
          <p role="alert" className="danger-text" style={{ margin: 0 }}>
            {error}
          </p>
        )}
      </form>
      {!q ? <Empty>Enter a company to see its DOL filing history, or search names when you only know the brand.</Empty> : mode === 'search' ? <SearchView key={`s:${q}`} query={q} /> : <LookupView key={`l:${q}`} query={q} />}
    </div>
  );
}
