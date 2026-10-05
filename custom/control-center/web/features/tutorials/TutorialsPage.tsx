import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link, getRouteApi, useNavigate, useRouter } from '@tanstack/react-router';
import { useQuery } from '@tanstack/react-query';
import { Md } from '../../components/Md';
import { DataState, Empty, Tabs } from '../../components/ui';
import { apiGetText } from '../../lib/api';
import { useTutorials } from '../../lib/queries';
import { useTheme } from '../../lib/theme';
import { chapterIndexAt, chapterTarget, filterTranscript, formatTimestamp, keyAction, nextPart, resolvePart, type KeyTarget } from '../../lib/tutorials';
import { createProgressTracker, readProgress, resumePoint, type PartProgress, type TutorialProgress } from '../../lib/tutorial-progress';
import { GuideDocs } from './guide/GuideDocs';
import type { GuideLocation, GuideSearchParams } from '../../lib/guide';
import { PartList } from './PartList';
import { UpNext } from './UpNext';
import { useThemedVideo } from './useThemedVideo';
import { useTutorialProgress } from './useTutorialProgress';
import type { Tutorial, TutorialPart, TutorialsRead } from '@shared/api';

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
      <p className="faint small mono wrap-anywhere" style={{ margin: 0 }}>
        {directory}
      </p>
      <pre className="mono small" tabIndex={0}>{example}</pre>
      <ul className="bullets small muted" style={{ margin: 0 }}>
        <li>
          <code className="mono">video</code> (or <code className="mono">parts</code>, below) is required and must be an .mp4. <code className="mono">subtitles</code> is .srt or .vtt, <code className="mono">poster</code> is .jpg or .png, <code className="mono">transcript</code> is .md. Names are plain file names inside the folder.
        </li>
        <li>
          <code className="mono">chapters</code> are <code className="mono">{'{ title, start }'}</code> with start in seconds.
        </li>
        <li>
          A long recording can be split: use <code className="mono">parts</code> instead of <code className="mono">video</code>, each part with its own <code className="mono">id</code>, <code className="mono">title</code>, optional <code className="mono">short</code> label, <code className="mono">video</code>, optional light video, subtitles and posters, its <code className="mono">duration</code> in seconds and its <code className="mono">chapters</code>. The page then shows a playlist and offers the next part when one ends.
        </li>
        <li>
          Optional: <code className="mono">guide</code> names a <code className="mono">guide.json</code> that adds a Quick guide tab: a documentation-style guide of sections and subsections with text, steps, tips, and images or clips in a dark and a light version. Sections and subsections can carry a <code className="mono">short</code> label for the contents.
        </li>
        <li>
          To install one from a recording folder: <code className="mono">node custom/control-center/scripts/install-tutorial.mjs &lt;folder&gt;</code>
        </li>
      </ul>
    </div>
  );
}

function Thumb({ tutorial }: { tutorial: Tutorial }) {
  const { resolved } = useTheme();
  const first = tutorial.parts[0]!;
  const poster = resolved === 'light' && first.posterLight ? first.posterLight : first.poster;
  return poster ? <img className="tut-card__thumb" src={poster.url} alt="" loading="lazy" /> : <span className="tut-card__thumb tut-card__thumb--none" aria-hidden="true" />;
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

interface PlayerProps {
  tutorial: Tutorial;
  part: TutorialPart;
  /** Where to start: a chapter the guide asked for, or 0 for the part that comes up next. Null: where the viewer left off, else the start. */
  startAt: number | null;
  /** Start playing once the part has loaded (moving on to the next part). A blocked play() leaves the poster up. */
  autoplay: boolean;
  onStartApplied: () => void;
  progress: TutorialProgress;
  /** Must be stable across renders: the progress tracker of a part keeps the first one. */
  onProgress: (tutorialId: string, partId: string, progress: PartProgress) => void;
  onOpenPart: (partId: string, opts?: { play: boolean }) => void;
  partHref: (partId: string) => string;
}

function Player({ tutorial, part, startAt, autoplay, onStartApplied, progress, onProgress, onOpenPart, partHref }: PlayerProps) {
  const video = useRef<HTMLVideoElement>(null);
  const cover = useRef<HTMLCanvasElement>(null);
  const themed = useThemedVideo(video, cover, part, startAt);
  const [current, setCurrent] = useState(-1);
  const [captions, setCaptions] = useState(readCaptionsPref);
  const [osd, setOsd] = useState('');
  const [ended, setEnded] = useState(false);
  const [declined, setDeclined] = useState(false);
  const chapters = part.chapters;
  const hasCaptions = part.subtitles !== null;
  const parts = tutorial.parts;
  const index = parts.findIndex((p) => p.id === part.id);
  const inParts = parts.length > 1;
  const next = nextPart(parts, part.id);
  const lengthOf = (v: HTMLVideoElement) => part.duration ?? v.duration;

  const latest = useRef({ onStartApplied });
  useEffect(() => {
    latest.current = { onStartApplied };
  });
  // `onProgress` is stable (the page's state setter), so the tracker made once per part can keep it, with the ids it was made for.
  const [tracker] = useState(() => createProgressTracker(tutorial.id, part.id, { onSave: (p) => onProgress(tutorial.id, part.id, p) }));

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

  const { position, seek, noteSeek, isRestoreSeek } = themed;
  // Every seek the viewer asks for (keys, a chapter) goes through the swap controller, so one made while a theme swap loads sticks,
  // and it dismisses Up next.
  const seekTo = useCallback(
    (seconds: number) => {
      seek(seconds);
      setCurrent(chapterIndexAt(chapters, seconds));
      setEnded(false);
    },
    [seek, chapters],
  );

  // Once, when the part has loaded: go where the page asked (the guide's chapter, or 0 for the next part), else where the viewer left
  // off; then play when moving on. Only the arrival moves the playhead: later renders and chapter edits must not.
  const arrived = useRef(false);
  useEffect(() => {
    const v = video.current;
    if (!v || arrived.current) return;
    const go = () => {
      arrived.current = true;
      const at = startAt ?? resumePoint(readProgress(tutorial.id)[part.id], lengthOf(v));
      if (at !== null) {
        v.currentTime = at;
        setCurrent(chapterIndexAt(chapters, at));
      }
      if (startAt !== null) latest.current.onStartApplied();
      if (autoplay) void v.play()?.catch(() => undefined);
    };
    if (v.readyState >= 1) {
      go();
      return;
    }
    v.addEventListener('loadedmetadata', go, { once: true });
    return () => v.removeEventListener('loadedmetadata', go);
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the arrival seeks
  }, []);

  // Leaving the part (another part, another tutorial or another page) keeps the place it was left at.
  useEffect(() => {
    const v = video.current;
    return () => {
      if (v && v.currentTime > 0) tracker.save(v.currentTime, part.duration ?? v.duration);
    };
  }, [tracker, part.duration]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const v = video.current;
      const action = keyAction({ key: e.key, target: targetKind(e.target), ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey });
      if (!v || !action) return;
      // Capture phase plus stopPropagation: a focused <video> would otherwise also act on the key natively and undo it.
      e.preventDefault();
      e.stopPropagation();
      const now = position() ?? v.currentTime;
      const idx = chapterIndexAt(chapters, now);
      const goChapter = (i: number) => {
        const c = chapters[i];
        if (!c) return;
        seekTo(c.start);
        say(`Chapter ${i + 1}: ${c.title}`);
      };
      switch (action) {
        case 'toggle':
          if (v.paused) void v.play().catch(() => undefined);
          else v.pause();
          break;
        case 'back':
          seekTo(Math.max(0, now - 10));
          say('Back 10 seconds');
          break;
        case 'forward': {
          const length = Number.isFinite(v.duration) ? v.duration : part.duration;
          seekTo(length === null ? now + 10 : Math.min(length, now + 10));
          say('Forward 10 seconds');
          break;
        }
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
  }, [chapters, hasCaptions, part.duration, position, seekTo]);

  const update = () => {
    const v = video.current;
    if (v) setCurrent(chapterIndexAt(chapters, v.currentTime));
  };
  // While a theme swap reloads the element its position reads 0 for a moment; that is not where the viewer is.
  const onTime = () => {
    const v = video.current;
    if (!v) return;
    update();
    if (v.readyState >= 1) tracker.tick(v.currentTime, lengthOf(v));
  };
  const onEnded = () => {
    const v = video.current;
    if (!v) return;
    tracker.save(lengthOf(v), lengthOf(v));
    setEnded(true);
    setDeclined(false);
    // The prompt cannot show over a video in native full screen.
    if (next && document.fullscreenElement) void document.exitFullscreen().catch(() => undefined);
  };

  const chapterList =
    chapters.length === 0 ? (
      <Empty>This tutorial has no chapters.</Empty>
    ) : (
      <ol className={`tut__chapter-list ${inParts ? 'tut-part__chapters' : ''}`}>
        {chapters.map((c, i) => (
          <li key={`${c.start}-${c.title}`}>
            <button type="button" className={`tut__chapter ${i === current ? 'tut__chapter--active' : ''}`} aria-current={i === current ? 'true' : undefined} onClick={() => seekTo(c.start)}>
              <span className="mono tut__time">{formatTimestamp(c.start)}</span>
              <span>{c.title}</span>
            </button>
          </li>
        ))}
      </ol>
    );

  return (
    <div className="stack">
      <div className="tut">
        <div className="stack">
          <div className="tut__stage">
            <video
              ref={video}
              controls
              preload="metadata"
              src={themed.initialSrc}
              poster={themed.poster}
              aria-label={inParts ? `${tutorial.title}, part ${index + 1}: ${part.title}` : tutorial.title}
              onTimeUpdate={onTime}
              onSeeked={update}
              onLoadedMetadata={update}
              onPlay={() => setEnded(false)}
              onSeeking={() => {
                // Any seek dismisses Up next (the native controls too) and becomes the place a theme swap under way restores,
                // except the one the swap makes itself to restore the place.
                const v = video.current;
                if (!v || isRestoreSeek(v.currentTime)) return;
                noteSeek(v.currentTime);
                setEnded(false);
              }}
              onPause={() => {
                const v = video.current;
                if (v && v.readyState >= 1 && !v.ended) tracker.save(v.currentTime, lengthOf(v));
              }}
              onEnded={onEnded}
            >
              {part.subtitles && <track kind="subtitles" srcLang="en" label="English" src={part.subtitles.url} />}
            </video>
            <canvas ref={cover} className="tut__freeze" data-state="off" aria-hidden="true" />
            {osd && (
              <p className="tut__osd" aria-hidden="true">
                {osd}
              </p>
            )}
            {ended && next && !declined && <UpNext next={next} number={index + 2} total={parts.length} onPlay={() => onOpenPart(next.id, { play: true })} onCancel={() => setDeclined(true)} />}
          </div>
          <div className="tut__meta">
            {inParts && (
              <p className="tut__eyebrow">
                Part {index + 1} of {parts.length}
              </p>
            )}
            <div className="row gap" style={{ justifyContent: 'space-between' }}>
              <h2 style={{ margin: 0 }}>{inParts ? part.title : tutorial.title}</h2>
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
            {themed.lightMissing && <p className="faint small tut__note" style={{ margin: 0 }}>No light version; showing the dark video</p>}
            {themed.warning && (
              <p className="small tut__note" role="status" style={{ margin: 0, color: 'var(--warning)' }}>
                {themed.warning}
              </p>
            )}
            <p className="faint small tut__keys" style={{ margin: 0 }}>
              <kbd>Space</kbd> or <kbd>K</kbd> play or pause, <kbd>J</kbd> back 10s, <kbd>L</kbd> forward 10s, <kbd>C</kbd> captions, <kbd>Up</kbd> and <kbd>Down</kbd> previous and next chapter
            </p>
            <p className="sr-only" role="status" aria-live="polite">
              {osd}
            </p>
          </div>
        </div>
        {inParts ? (
          <PartList parts={parts} activeId={part.id} progress={progress} hrefFor={partHref} onOpen={(id) => onOpenPart(id)} activeChapters={chapterList} />
        ) : (
          <aside className="card tut__chapters" aria-labelledby="tut-chapters-title">
            <h2 id="tut-chapters-title">Chapters</h2>
            {chapterList}
          </aside>
        )}
      </div>
      {tutorial.transcript && <Transcript url={tutorial.transcript.url} />}
    </div>
  );
}

const VIEWS = [
  { id: 'video', label: 'Video' },
  { id: 'guide', label: 'Quick guide' },
] as const;

/** Where the page was asked to start a part: tied to the tutorial and the part it was asked for, and used once. */
interface StartIntent {
  id: string;
  part: string;
  at: number;
  play: boolean;
}

function Loaded({ data }: { data: TutorialsRead }) {
  const { t, part, view, section, sub } = route.useSearch();
  const navigate = useNavigate({ from: '/tutorials' });
  const router = useRouter();
  const [intent, setIntent] = useState<StartIntent | null>(null);
  const selected = data.tutorials.find((x) => x.id === t) ?? data.tutorials[0];
  const active = selected ? resolvePart(selected.parts, part) : undefined;
  const guide = selected?.guideDocs ?? null;
  const pending = intent !== null && intent.id === selected?.id && intent.part === active?.id ? intent : null;
  const showGuide = guide !== null && view === 'guide';
  const { progress, record } = useTutorialProgress(selected?.id);
  const inParts = (selected?.parts.length ?? 0) > 1;
  const tutorialParam = t ? { t } : {};
  // The URL carries the tutorial, the part, the view and the section, so every state of the page is a shareable link.
  const go = (to: { view?: 'guide'; section?: string; sub?: string }, replace = false) => void navigate({ search: { ...tutorialParam, ...(part ? { part } : {}), ...to }, replace });
  const searchFor = (loc: GuideLocation): GuideSearchParams => ({ ...tutorialParam, view: 'guide', section: loc.sectionId, ...(loc.subId ? { sub: loc.subId } : {}) });
  const partHref = (partId: string) => router.buildLocation({ to: '/tutorials', search: { ...tutorialParam, part: partId } }).href;
  // A new history entry per part, so Back returns to the part before.
  const openPart = (partId: string, opts: { play: boolean } = { play: false }) => {
    setIntent(selected && opts.play ? { id: selected.id, part: partId, at: 0, play: true } : null);
    void navigate({ search: { ...tutorialParam, part: partId } });
  };
  const setView = (next: 'video' | 'guide') => {
    setIntent(null);
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
                  <span className="tut-card__desc">{x.description || (x.parts.length > 1 ? `${x.parts.length} parts, ${x.chapters.length} chapters` : `${x.chapters.length} chapters`)}</span>
                </span>
              </Link>
            ))}
          </nav>
          {selected?.warnings.map((message) => (
            <p key={message} className="small" style={{ margin: 0, color: 'var(--warning)' }}>
              {message}
            </p>
          ))}
          {selected && guide && <Tabs label="Tutorial view" tabs={[...VIEWS]} value={showGuide ? 'guide' : 'video'} onChange={setView} />}
          {selected && guide && showGuide && (
            <GuideDocs
              key={selected.id}
              tutorialId={selected.id}
              docs={guide}
              chapters={selected.chapters}
              section={section}
              sub={sub}
              searchFor={searchFor}
              onNavigate={(loc, replace) => go({ view: 'guide', section: loc.sectionId, ...(loc.subId ? { sub: loc.subId } : {}) }, replace)}
              onWatch={(chapter) => {
                const target = chapterTarget(selected.chapters, chapter);
                if (!target) return;
                setIntent({ id: selected.id, part: target.part, at: target.start, play: false });
                void navigate({ search: { ...tutorialParam, ...(inParts ? { part: target.part } : {}) } });
              }}
            />
          )}
          {selected && active && !showGuide && (
            <Player
              key={`${selected.id}/${active.id}`}
              tutorial={selected}
              part={active}
              startAt={pending?.at ?? null}
              autoplay={pending?.play ?? false}
              onStartApplied={() => setIntent(null)}
              progress={progress}
              onProgress={record}
              onOpenPart={openPart}
              partHref={partHref}
            />
          )}
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
