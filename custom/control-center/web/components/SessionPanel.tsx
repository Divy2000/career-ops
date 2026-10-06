import { useEffect, useRef, useState, type ReactNode } from 'react';

import { Link } from '@tanstack/react-router';
import { SafeMarkdown } from './Md';
import { Empty, Pill } from './ui';
import { describeError } from '../lib/actions';
import { cancelSession, forkSession, sendTurn, startSession, useSessionStream, type Target, type Transcript } from '../lib/sessions';

export function statusTone(status: string): 'ok' | 'warn' | 'danger' | 'info' | 'neutral' {
  if (status === 'done') return 'ok';
  if (status === 'awaiting_user') return 'warn';
  if (status === 'error') return 'danger';
  if (status === 'running' || status === 'queued') return 'info';
  return 'neutral';
}

export function StatusLabel({ status }: { status: string }) {
  const label = status === 'awaiting_user' ? 'needs your reply' : status;
  return <Pill tone={statusTone(status)}>{label}</Pill>;
}

/** Streaming transcript: visible text updates live; a hidden polite live region announces once per second. */
export function TranscriptView({ transcript, label }: { transcript: Transcript; label: string }) {
  const [announce, setAnnounce] = useState('');
  const last = transcript.turns.at(-1);
  const summary = `${transcript.status}${last?.text ? `: ${last.text.slice(-160)}` : ''}`;
  // At most one announcement per second while text streams in.
  useEffect(() => {
    const timer = setTimeout(() => setAnnounce(summary), 1000);
    return () => clearTimeout(timer);
  }, [summary]);
  return (
    <div className="transcript" role="region" tabIndex={0} aria-label={label}>
      <span className="sr-only" aria-live="polite">
        {announce}
      </span>
      {transcript.turns.length === 0 && <Empty>Waiting for the first event.</Empty>}
      {transcript.turns.map((turn) => (
        <div key={turn.n} className="transcript__turn">
          <div className="faint small">Turn {turn.n}</div>
          {turn.tools.map((tool) => (
            <div key={tool.id} className={`transcript__tool ${tool.ok === false ? 'transcript__tool--err' : ''}`}>
              <Pill tone={tool.ok === null ? 'info' : tool.ok ? 'neutral' : 'danger'}>{tool.name}</Pill> <span className="mono small">{tool.summary}</span>
              {tool.result && <div className="faint small mono">{tool.result.slice(0, 240)}</div>}
            </div>
          ))}
          {turn.text && (
            <div className="prose">
              <SafeMarkdown>
                {turn.text}
              </SafeMarkdown>
            </div>
          )}
          {turn.stderr.length > 0 && (
            <details>
              <summary className="faint small">stderr ({turn.stderr.length})</summary>
              <pre tabIndex={0} className="log mono small">{turn.stderr.join('\n')}</pre>
            </details>
          )}
        </div>
      ))}
      {transcript.denials.length > 0 && (
        <div className="card card--warn" role="status">
          <strong>Permission denied</strong> for {transcript.denials.map((d) => d.tool).join(', ')}: the session stayed inside its write scope.
        </div>
      )}
      {transcript.invalidEnvelopes.length > 0 && (
        <div className="card card--warn" role="status">
          <strong>Ignored malformed envelope:</strong> {transcript.invalidEnvelopes.map((e) => `${e.kind} (${e.error})`).join('; ')}
        </div>
      )}
      {transcript.evaluation.length > 0 && (
        <div className="card">
          <strong>Evaluation result</strong>
          <ul className="bullets">
            {transcript.evaluation.map((r) => (
              <li key={r.num}>
                <span className="mono">{r.file}</span> {r.score !== null ? <Pill tone="accent">{r.score.toFixed(1)}/5</Pill> : <Pill tone="warn">no score in header</Pill>}
              </li>
            ))}
          </ul>
        </div>
      )}
      {transcript.files.length > 0 && (
        <details className="faint small">
          <summary>Files changed ({transcript.files.length})</summary>
          <ul className="bullets mono">
            {transcript.files.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        </details>
      )}
      {transcript.error && (
        <div className="card card--danger" role="alert">
          {transcript.error}
        </div>
      )}
    </div>
  );
}

export interface SessionPanelProps {
  mode: string;
  title?: string;
  target?: Target;
  /** Prefilled prompt; the user can edit it before starting. */
  initialPrompt?: string;
  placeholder?: string;
  /** Attach to an existing session instead of starting a new one. */
  sessionId?: string | null;
  /** Called with every envelope the session emits (kind, payload). */
  onEnvelope?: (kind: string, payload: unknown, turn: number) => void;
  /** Called on every status change, running included, so a host can tell a later turn is live; 'gone' once the server has no such session. */
  onStatus?: (status: string, reason: string | null) => void;
  /** Called when the panel starts or forks a session. */
  onSessionId?: (id: string) => void;
  /** Extra content rendered above the follow-up prompt (for example an answers form). */
  children?: ReactNode;
  autoStart?: boolean;
  startLabel?: string;
  replyLabel?: string;
  blacklistAllowed?: boolean;
  /** Called once the server accepted a start, a turn or a fork sent with this panel's props (blacklistAllowed included). */
  onSent?: () => void;
  /** Called when a start is refused or the session fails to start, so a host waiting for its id stops waiting. */
  onStartFailed?: () => void;
  /** Called as the panel sends a start, before the server answers (onSessionId or onStartFailed follows). */
  onStarting?: () => void;
}

/** Prompt box plus live session for one mode. Host pages embed it; the Sessions page shows the same thing standalone. */
export function SessionPanel(props: SessionPanelProps) {
  // A session id passed by the host wins; otherwise the panel tracks the one it started.
  const [localId, setSessionId] = useState<string | null>(null);
  const sessionId = props.sessionId ?? localId;
  // The host's prompt follows its inputs (Apply builds it from the posting URL) until the user types their own.
  const [editedPrompt, setPrompt] = useState<string | null>(null);
  const prompt = editedPrompt ?? props.initialPrompt ?? '';
  const [reply, setReply] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { transcript, meta, gone } = useSessionStream(sessionId);
  const seen = useRef(0);
  const { onEnvelope, onStatus } = props;
  useEffect(() => {
    if (!onEnvelope) return;
    for (const env of transcript.envelopes.slice(seen.current)) onEnvelope(env.kind, env.payload, env.turn);
    seen.current = transcript.envelopes.length;
  }, [transcript.envelopes, onEnvelope]);
  useEffect(() => {
    // A session the server no longer has reports 'gone', so a host waiting on it does not wait forever.
    onStatus?.(gone ? 'gone' : transcript.status, gone ? null : transcript.reason);
  }, [gone, transcript.status, transcript.reason, onStatus]);
  const start = async (text: string) => {
    props.onStarting?.();
    setBusy(true);
    setError(null);
    try {
      const m = await startSession({ mode: props.mode, target: props.target, prompt: text, blacklistAllowed: props.blacklistAllowed });
      props.onSent?.();
      seen.current = 0;
      setSessionId(m.id);
      props.onSessionId?.(m.id);
      if (m.status === 'error') {
        setError(m.error ?? 'session failed to start');
        props.onStartFailed?.();
      }
    } catch (err) {
      setError(describeError(err));
      props.onStartFailed?.();
    } finally {
      setBusy(false);
    }
  };
  const autoStarted = useRef(false);
  useEffect(() => {
    if (props.autoStart && !sessionId && !autoStarted.current && props.initialPrompt) {
      autoStarted.current = true;
      void start(props.initialPrompt);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.autoStart]);

  const send = async (text: string, fork = false) => {
    if (!sessionId) return;
    setBusy(true);
    setError(null);
    try {
      if (fork) {
        const m = await forkSession(sessionId, text, props.blacklistAllowed);
        props.onSent?.();
        seen.current = 0;
        setSessionId(m.id);
        props.onSessionId?.(m.id);
      } else {
        await sendTurn(sessionId, text, props.blacklistAllowed);
        props.onSent?.();
      }
      setReply('');
    } catch (err) {
      setError(describeError(err));
    } finally {
      setBusy(false);
    }
  };

  const cancel = async () => {
    if (!sessionId) return;
    setError(null);
    try {
      await cancelSession(sessionId);
    } catch (err) {
      setError(`Could not cancel: ${describeError(err)}`);
    }
  };

  const running = transcript.status === 'running' || transcript.status === 'queued';
  return (
    <div className="card session" data-session-id={sessionId ?? undefined}>
      <div className="row gap" style={{ justifyContent: 'space-between' }}>
        <h2 style={{ margin: 0 }}>
          {props.title ?? props.mode} <Pill tone="warn">Uses tokens</Pill>
        </h2>
        <div className="row gap">
          {sessionId && !gone && <StatusLabel status={transcript.status} />}
          {sessionId && !gone && (
            <Link to="/sessions/$id" params={{ id: sessionId }} className="small">
              Open session
            </Link>
          )}
        </div>
      </div>
      {gone ? (
        <p className="muted" style={{ margin: 'var(--space-2) 0 0' }}>
          This session no longer exists.
        </p>
      ) : !sessionId ? (
        <form
          className="stack"
          onSubmit={(e) => {
            e.preventDefault();
            if (prompt.trim()) void start(prompt.trim());
          }}
        >
          <label>
            <span className="sr-only">Prompt for {props.mode}</span>
            <textarea aria-label={`Prompt for ${props.mode}`} value={prompt} onChange={(e) => setPrompt(e.target.value)} placeholder={props.placeholder ?? 'What should this session do?'} rows={3} />
          </label>
          <div className="row gap">
            <button type="submit" disabled={busy || !prompt.trim()}>
              {props.startLabel ?? 'Start session'}
            </button>
            <span className="faint small">mode {props.mode}</span>
          </div>
        </form>
      ) : (
        <div className="stack">
          <TranscriptView transcript={transcript} label={`Transcript for ${props.mode}`} />
          {transcript.reason && !running && <p className="muted small">{transcript.reason}</p>}
          {meta && !running && (
            <p className="faint small mono">
              cost ${transcript.costUsd.toFixed(4)} | {transcript.tokens} tokens | {meta.turns.length} turn{meta.turns.length === 1 ? '' : 's'}
            </p>
          )}
          {props.children}
          <form
            className="row gap"
            onSubmit={(e) => {
              e.preventDefault();
              if (reply.trim()) void send(reply.trim());
            }}
          >
            <input aria-label="Reply to the session" value={reply} onChange={(e) => setReply(e.target.value)} placeholder={transcript.status === 'awaiting_user' ? 'The session asked you a question; reply here' : 'Send another turn'} disabled={running || busy} style={{ flex: 1 }} />
            <button type="submit" disabled={running || busy || !reply.trim()}>
              {props.replyLabel ?? 'Send'}
            </button>
            <button type="button" disabled={running || busy || !reply.trim()} onClick={() => void send(reply.trim(), true)} title="Continue in a new session that shares this history">
              Fork
            </button>
            {running && (
              <button type="button" onClick={() => void cancel()}>
                Cancel
              </button>
            )}
          </form>
        </div>
      )}
      {error && (
        <p role="alert" className="danger-text">
          {error}
        </p>
      )}
    </div>
  );
}
