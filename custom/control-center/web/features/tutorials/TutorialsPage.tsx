import { useEffect, useMemo, useRef, useState } from 'react';
import { Link, getRouteApi, useNavigate } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Md } from '../../components/Md';
import { DataState, Empty, Tabs } from '../../components/ui';
import { apiGetText } from '../../lib/api';
import { useTutorials } from '../../lib/queries';
import { chapterIndexAt, filterTranscript, formatTimestamp, keyAction, type KeyTarget } from '../../lib/tutorials';
import { QuickGuide } from './QuickGuide';
import type { Tutorial, TutorialsRead } from '@shared/api';

const route = getRouteApi('/tutorials');

const CAPTIONS_KEY = 'cc.tutorials.captions';
const readCaptionsPref = (): boolean => {
  try {
    return window.localStorage.getItem(CAPTIONS_KEY) !== 'off';
  } catch {
    return true;
  }
};
const writeCaptionsPref = (on: boolean) => {
  try {
    window.localStorage.setItem(CAPTIONS_KEY, on ? 'on' : 'off');
  } catch {
    /* a blocked store only means the choice is not remembered */
  }
};

function targetKind(el: EventTarget | null): KeyTarget {
  if (!(el instanceof HTMLElement)) return 'body';
  if (el.isContentEditable) return 'editable';
  const tag = el.tagName.toLowerCase();
  if (tag === 'input' || tag === 'textarea' || tag === 'select') return tag;
  if (tag === 'button' || tag === 'summary') return 'button';
  if (tag === 'a') return 'link';
  return 'body';
}

function EmptyState({ directory }: { directory: string }) {
  const example = `{
  "id": "my-tutorial",
  "title": "Getting started",
  "description": "A walk through the Control Center.",
  "video": "my-tutorial.mp4",
  "subtitles": "my-tutorial.srt",
  "poster": "poster.jpg",
  "transcript": "script.md",
  "chapters": [
    { "title": "Intro", "start": 0 },
    { "title": "Launching", "start": 130.2 }
  ]
}`;
  return (
    <div className="card stack" aria-labelledby="tut-empty">
      <h2 id="tut-empty" style={{ margin: 0 }}>
        No tutorials yet
      </h2>
      <p className="muted" style={{ margin: 0 }}>
        Each tutorial is a folder under <code className="mono">data/control-center/tutorials/</code> in your data root, with a <code className="mono">tutorial.json</code> that names its files. The folder name must equal the manifest <code className="mono">id</code>. Nothing here is committed to git.
      </p>
      <p className="faint small mono" style={{ margin: 0 }}>
        {directory}
      </p>
      <pre className="mono small" tabIndex={0}>{example}</pre>
      <ul className="bullets small muted" style={{ margin: 0 }}>
        <li>
          <code className="mono">video</code> is required and must be an .mp4. <code className="mono">subtitles</code> is .srt or .vtt, <code className="mono">poster</code> is .jpg or .png, <code className="mono">transcript</code> is .md. Names are plain file names inside the folder.
        </li>
        <li>
          <code className="mono">chapters</code> are <code className="mono">{'{ title, start }'}</code> with start in seconds.
        </li>
        <li>
          Optional: <code className="mono">guide</code> names a <code className="mono">guide.json</code> that adds a Quick guide tab, one section per feature with a .gif or .webp, steps and a link into the app.
        </li>
        <li>
          To install one from a recording folder: <code className="mono">node custom/control-center/scripts/install-tutorial.mjs &lt;folder&gt;</code>
        </li>
      </ul>
    </div>
  );
}

function Thumb({ tutorial }: { tutorial: Tutorial }) {
  return tutorial.poster ? <img className="tut-card__thumb" src={tutorial.poster.url} alt="" loading="lazy" /> : <span className="tut-card__thumb tut-card__thumb--none" aria-hidden="true" />;
}

function Transcript({ url }: { url: string }) {
  const [open, setOpen] = useState(false);
  const [term, setTerm] = useState('');
  const q = useQuery({ queryKey: ['tutorials', 'transcript', url], queryFn: () => apiGetText(url), enabled: open, staleTime: 60_000 });
  const filtered = useMemo(() => (q.data === undefined ? null : filterTranscript(q.data, term)), [q.data, term]);
  return (
    <div className="card stack" aria-labelledby="tut-transcript-title">
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 id="tut-transcript-title" style={{ margin: 0 }}>
          <button type="button" className="tut-disclosure" aria-expanded={open} aria-controls="tut-transcript-body" onClick={() => setOpen((o) => !o)}>
            <span aria-hidden="true">{open ? '▾' : '▸'}</span> Transcript
          </button>
        </h2>
        {open && (
          <label className="tut-search">
            <span className="sr-only">Search the transcript</span>
            <input type="search" aria-label="Search the transcript" placeholder="Search the transcript" value={term} onChange={(e) => setTerm(e.target.value)} />
          </label>
        )}
      </div>
      {open && (
        <div id="tut-transcript-body">
          {q.isPending && <div className="card skeleton" aria-busy="true"><div className="skeleton__line" /><div className="skeleton__line short" /></div>}
          {q.isError && <p className="danger-text" role="alert">Could not load the transcript: {(q.error as Error).message}</p>}
          {filtered && filtered.matches !== null && (
            <p className="muted small" role="status">
              {filtered.matches === 0 ? 'No matches.' : `${filtered.matches} ${filtered.matches === 1 ? 'match' : 'matches'}`}
            </p>
          )}
          {filtered && filtered.text && (
            <div className="tut-transcript">
              <Md text={filtered.text} />
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function Player({ tutorial, startAt }: { tutorial: Tutorial; startAt: number | null }) {
  const video = useRef<HTMLVideoElement>(null);
  const [current, setCurrent] = useState(-1);
  const [captions, setCaptions] = useState(readCaptionsPref);
  const [osd, setOsd] = useState('');
  const chapters = tutorial.chapters;
  const hasCaptions = tutorial.subtitles !== null;

  useEffect(() => {
    const v = video.current;
    if (!v) return;
    for (const track of Array.from(v.textTracks)) track.mode = captions ? 'showing' : 'disabled';
  }, [captions, tutorial.id]);

  // The native caption menu changes the track too; keep the toggle and the remembered choice in step with it.
  useEffect(() => {
    const v = video.current;
    if (!v) return;
    const sync = () => {
      const showing = Array.from(v.textTracks).some((t) => t.mode === 'showing');
      setCaptions((prev) => {
        if (prev !== showing) writeCaptionsPref(showing);
        return showing;
      });
    };
    v.textTracks.addEventListener('change', sync);
    return () => v.textTracks.removeEventListener('change', sync);
  }, [tutorial.id]);

  const osdTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const say = (text: string) => {
    setOsd(text);
    if (osdTimer.current) clearTimeout(osdTimer.current);
    osdTimer.current = setTimeout(() => setOsd(''), 1800);
  };
  useEffect(() => () => void (osdTimer.current && clearTimeout(osdTimer.current)), []);

  const seekTo = (seconds: number) => {
    const v = video.current;
    if (!v) return;
    v.currentTime = seconds;
    setCurrent(chapterIndexAt(chapters, seconds));
  };

  // Arriving from the Quick guide: start at that chapter once the video knows its length.
  useEffect(() => {
    const v = video.current;
    if (!v || startAt === null) return;
    const go = () => {
      v.currentTime = startAt;
      setCurrent(chapterIndexAt(chapters, startAt));
    };
    if (v.readyState >= 1) {
      go();
      return;
    }
    v.addEventListener('loadedmetadata', go, { once: true });
    return () => v.removeEventListener('loadedmetadata', go);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the arrival seeks; later chapter edits must not move the playhead
  }, [startAt]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = video.current;
      const action = keyAction({ key: e.key, target: targetKind(e.target), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
      if (!v || !action) return;
      // Capture phase plus stopPropagation: a focused <video> would otherwise also act on the key natively and undo it.
      e.preventDefault();
      e.stopPropagation();
      const idx = chapterIndexAt(chapters, v.currentTime);
      const goChapter = (i: number) => {
        const c = chapters[i];
        if (!c) return;
        v.currentTime = c.start;
        setCurrent(i);
        say(`Chapter ${i + 1}: ${c.title}`);
      };
      switch (action) {
        case 'toggle':
          if (v.paused) void v.play().catch(() => undefined);
          else v.pause();
          break;
        case 'back':
          v.currentTime = Math.max(0, v.currentTime - 10);
          say('Back 10 seconds');
          break;
        case 'forward':
          v.currentTime = Number.isFinite(v.duration) ? Math.min(v.duration, v.currentTime + 10) : v.currentTime + 10;
          say('Forward 10 seconds');
          break;
        case 'captions':
          if (hasCaptions) {
            const next = !Array.from(v.textTracks).some((t) => t.mode === 'showing');
            setCaptions(next);
            writeCaptionsPref(next);
            say(next ? 'Captions on' : 'Captions off');
          }
          break;
        case 'prevChapter':
          goChapter(Math.max(0, idx - 1));
          break;
        case 'nextChapter':
          goChapter(Math.min(chapters.length - 1, idx + 1));
          break;
      }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [chapters, hasCaptions]);

  const update = () => {
    const v = video.current;
    if (v) setCurrent(chapterIndexAt(chapters, v.currentTime));
  };

  return (
    <div className="stack">
      <div className="tut">
        <div className="stack">
          <div className="tut__stage">
            <video ref={video} controls preload="metadata" poster={tutorial.poster?.url} aria-label={tutorial.title} onTimeUpdate={update} onSeeked={update} onLoadedMetadata={update}>
              <source src={tutorial.video.url} type="video/mp4" />
              {tutorial.subtitles && <track kind="subtitles" srcLang="en" label="English" src={tutorial.subtitles.url} />}
            </video>
            {osd && (
              <p className="tut__osd" aria-hidden="true">
                {osd}
              </p>
            )}
          </div>
          <div className="tut__meta">
            <div className="row gap" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{tutorial.title}</h2>
              {hasCaptions && (
                <button
                  type="button"
                  aria-pressed={captions}
                  onClick={() => {
                    setCaptions(!captions);
                    writeCaptionsPref(!captions);
                  }}
                >
                  Captions: {captions ? 'on' : 'off'}
                </button>
              )}
            </div>
            {tutorial.description && <p className="muted" style={{ margin: 0 }}>{tutorial.description}</p>}
            <p className="faint small tut__keys" style={{ margin: 0 }}>
              <kbd>Space</kbd> or <kbd>K</kbd> play or pause, <kbd>J</kbd> back 10s, <kbd>L</kbd> forward 10s, <kbd>C</kbd> captions, <kbd>Up</kbd> and <kbd>Down</kbd> previous and next chapter
            </p>
            <p className="sr-only" role="status" aria-live="polite">
              {osd}
            </p>
            {tutorial.warnings.map((w) => (
              <p key={w} className="small" style={{ margin: 0, color: 'var(--warning)' }}>
                {w}
              </p>
            ))}
          </div>
        </div>
        <aside className="card tut__chapters" aria-labelledby="tut-chapters-title">
          <h2 id="tut-chapters-title">Chapters</h2>
          {chapters.length === 0 ? (
            <Empty>This tutorial has no chapters.</Empty>
          ) : (
            <ol className="tut__chapter-list">
              {chapters.map((c, i) => (
                <li key={`${c.start}-${c.title}`}>
                  <button type="button" className={`tut__chapter ${i === current ? 'tut__chapter--active' : ''}`} aria-current={i === current ? 'true' : undefined} onClick={() => seekTo(c.start)}>
                    <span className="mono tut__time">{formatTimestamp(c.start)}</span>
                    <span>{c.title}</span>
                  </button>
                </li>
              ))}
            </ol>
          )}
        </aside>
      </div>
      {tutorial.transcript && <Transcript url={tutorial.transcript.url} />}
    </div>
  );
}

const VIEWS = [
  { id: 'video', label: 'Video' },
  { id: 'guide', label: 'Quick guide' },
] as const;

function Loaded({ data }: { data: TutorialsRead }) {
  const { t, view, section } = route.useSearch();
  const navigate = useNavigate({ from: '/tutorials' });
  const [startAt, setStartAt] = useState<number | null>(null);
  const selected = data.tutorials.find((x) => x.id === t) ?? data.tutorials[0];
  const guide = selected?.guide ?? null;
  const showGuide = guide !== null && view === 'guide';
  // The URL carries the tutorial, the view and the section, so every state of the page is a shareable link.
  const go = (to: { view?: 'guide'; section?: string }, replace = false) => void navigate({ search: { ...(t ? { t } : {}), ...to }, replace });
  const setView = (next: 'video' | 'guide') => {
    setStartAt(null);
    go(next === 'guide' ? { view: 'guide' } : {});
  };
  return (
    <div className="stack">
      {data.warnings.length > 0 && (
        <div className="card card--warn" role="status" aria-labelledby="tut-warnings">
          <strong id="tut-warnings">
            {data.warnings.length} tutorial {data.warnings.length === 1 ? 'folder was' : 'folders were'} skipped
          </strong>
          <ul className="bullets small" style={{ margin: 0 }}>
            {data.warnings.map((w) => (
              <li key={w.folder}>
                <span className="mono">{w.folder}</span>: {w.message}
              </li>
            ))}
          </ul>
        </div>
      )}
      {data.tutorials.length === 0 ? (
        <EmptyState directory={data.directory} />
      ) : (
        <>
          <nav aria-label="Tutorials" className="tut-list">
            {data.tutorials.map((x) => (
              <Link key={x.id} to="/tutorials" search={{ t: x.id }} className={`tut-card ${x.id === selected?.id ? 'tut-card--active' : ''}`} aria-current={x.id === selected?.id ? 'true' : undefined}>
                <Thumb tutorial={x} />
                <span className="tut-card__body">
                  <span className="tut-card__title">{x.title}</span>
                  <span className="tut-card__desc">{x.description || `${x.chapters.length} chapters`}</span>
                </span>
              </Link>
            ))}
          </nav>
          {selected && guide && <Tabs label="Tutorial view" tabs={[...VIEWS]} value={showGuide ? 'guide' : 'video'} onChange={setView} />}
          {selected && guide && showGuide && (
            <QuickGuide
              key={selected.id}
              tutorialId={selected.id}
              guide={guide}
              chapters={selected.chapters}
              sectionId={section}
              onSelect={(id, replace) => go({ view: 'guide', section: id }, replace)}
              onWatch={(start) => {
                setStartAt(start);
                go({});
              }}
            />
          )}
          {selected && !showGuide && <Player key={selected.id} tutorial={selected} startAt={startAt} />}
        </>
      )}
    </div>
  );
}

export function TutorialsPage() {
  const q = useTutorials();
  return (
    <section aria-labelledby="page-title">
      <div className="page-header">
        <h1 id="page-title">Tutorials</h1>
      </div>
      <DataState query={q}>{q.data && <Loaded data={q.data} />}</DataState>
    </section>
  );
}
