// Static action registry: the only way the client runs anything. Every entry
// builds an argv array; the client never sends a command string.
import { z } from 'zod';
import type { Cost } from '../runner/store.js';
import { cliScriptPath } from '../core/adapter.js';

export type Resource = 'tracker' | 'pipeline' | 'portals' | 'profile' | 'followups' | 'cv' | 'blacklist' | 'launchd' | `immigration:${string}`;

export interface ActionContext {
  codeRoot: string;
  dataRoot: string;
}

export interface Command {
  bin: string;
  args: string[];
  cwd: string;
}

export interface ActionDef<S extends z.ZodType = z.ZodType> {
  id: string;
  label: string;
  cost: Cost;
  /** Confirmation text shown before running; undefined means no confirm. */
  confirm?: string;
  resources: Resource[];
  claude: boolean;
  /** Sync actions run inline under a 30 s timeout and return their output. */
  sync: boolean;
  params: S;
  build: (params: z.infer<S>, ctx: ActionContext) => Command;
  /** Exit code to HTTP status for sync actions (default: non-zero is 500). */
  exitMap?: Record<number, number>;
}

export const TRACKER_STATES = ['Evaluated', 'Applied', 'Responded', 'Interview', 'Offer', 'Hired', 'Rejected', 'Discarded', 'SKIP'] as const;

const node = (ctx: ActionContext, id: Parameters<typeof cliScriptPath>[1], args: string[]): Command => ({
  bin: process.execPath,
  args: [cliScriptPath(ctx.codeRoot, id), ...args],
  cwd: ctx.codeRoot,
});

function define<S extends z.ZodType>(def: ActionDef<S>): ActionDef<S> {
  return def;
}

export const ACTIONS: ActionDef[] = [
  define({
    id: 'tracker.setStatus',
    label: 'Set application status',
    cost: 'free',
    resources: ['tracker'],
    claude: false,
    sync: true,
    params: z.object({
      row: z.number().int().positive(),
      state: z.enum(TRACKER_STATES),
      note: z.string().max(500).optional(),
      on: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
    }),
    build: (p, ctx) => node(ctx, 'setStatus', ['--row', String(p.row), p.state, '--source', 'web', '--json', ...(p.note ? ['--note', p.note] : []), ...(p.on ? ['--on', p.on] : [])]),
    exitMap: { 1: 400, 2: 404, 3: 409, 4: 503 },
  }),
  define({
    id: 'tracker.verify',
    label: 'Verify tracker and pipeline',
    cost: 'free',
    resources: [],
    claude: false,
    sync: false,
    params: z.object({}),
    build: (_p, ctx) => node(ctx, 'verifyPipeline', []),
  }),
  define({
    id: 'system.doctor',
    label: 'Doctor',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({}),
    build: (_p, ctx) => node(ctx, 'doctor', ['--json']),
  }),
  define({
    id: 'insights.stats',
    label: 'Stats',
    cost: 'free',
    resources: [],
    claude: false,
    sync: true,
    params: z.object({}),
    build: (_p, ctx) => node(ctx, 'stats', []),
  }),
  define({
    id: 'pipeline.prioritize',
    label: 'Prioritize pipeline',
    cost: 'free',
    resources: ['pipeline'],
    claude: false,
    sync: false,
    params: z.object({}),
    build: (_p, ctx) => node(ctx, 'prioritize', []),
  }),
  define({
    id: 'pipeline.shortlist',
    label: 'Rebuild shortlist',
    cost: 'free',
    resources: ['pipeline'],
    claude: false,
    sync: false,
    params: z.object({ minRank: z.number().min(0).max(5).optional(), top: z.number().int().positive().max(500).optional() }),
    build: (p, ctx) => node(ctx, 'shortlist', [...(p.minRank !== undefined ? ['--min-rank', String(p.minRank)] : []), ...(p.top !== undefined ? ['--top', String(p.top)] : [])]),
  }),
  define({
    id: 'daily.runNow',
    label: 'Run the daily job now',
    cost: 'tokens',
    confirm: 'Runs the full daily job (policy watch with Claude, portal scan, prioritize, rank, shortlist). Continue?',
    resources: ['pipeline', 'tracker', 'immigration:policy'],
    claude: true,
    sync: false,
    params: z.object({}),
    build: (_p, ctx) => ({ bin: '/bin/bash', args: [`${ctx.codeRoot}/custom/immigration/run-daily.sh`], cwd: ctx.codeRoot }),
  }),
];

export function findAction(id: string): ActionDef | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export function actionMetadata() {
  return ACTIONS.map((a) => ({
    id: a.id,
    label: a.label,
    cost: a.cost,
    confirm: a.confirm ?? null,
    resources: a.resources,
    claude: a.claude,
    sync: a.sync,
    params: z.toJSONSchema(a.params),
  }));
}
