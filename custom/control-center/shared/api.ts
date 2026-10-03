// API response shapes shared by server and client (type-only re-exports).
export type { TrackerRow, TrackerRead } from '../server/domains/tracker.js';
export type { ReportFull, ReportSummary, ReportRead, ReportSection } from '../server/domains/reports.js';
export type { PipelineRow, PipelineRead } from '../server/domains/pipeline.js';
export type { ShortlistRow, ShortlistRead, ExcludedRow } from '../server/domains/shortlist.js';
export type { ImmigrationOverview, DailyLog, CompanyFile, DigestSection } from '../server/domains/immigration.js';
export type { FreshOffer } from '../server/domains/whatsNew.js';
export type { Dashboard, StatusLogRow } from '../server/domains/insights.js';
export type { FollowupEntry, NextOverride } from '../server/domains/followups.js';
export type { ModePolicy } from '../server/claude/modes.js';
export type { SystemStatus } from './types.js';
export type { RunMeta, RawLine, RunStatus } from '../server/runner/store.js';
export type { DocumentsRead, DocumentFile } from '../server/domains/documents.js';
export type { DailyStatus } from '../server/system/daily.js';
export type { SessionEvent } from '../server/claude/stream-parse.js';
export type { Envelope, EnvelopeKind } from '../server/claude/envelopes.js';

export interface ActionMeta {
  id: string;
  label: string;
  cost: 'free' | 'network' | 'tokens';
  confirm: string | null;
  resources: string[];
  claude: boolean;
  sync: boolean;
  params: Record<string, unknown>;
}

import type { TrackerRow } from '../server/domains/tracker.js';
import type { ReportRead } from '../server/domains/reports.js';
import type { Dashboard, StatusLogRow } from '../server/domains/insights.js';
import type { FollowupEntry, NextOverride } from '../server/domains/followups.js';
import type { CompanyFile, DailyLog } from '../server/domains/immigration.js';
import type { FreshOffer } from '../server/domains/whatsNew.js';

export interface ApplicationDetail {
  row: TrackerRow;
  report: ReportRead | { kind: 'none' };
  timeline: { statusLog: StatusLogRow[]; followups: FollowupEntry[]; pin: NextOverride | null };
  companyHistory: TrackerRow[];
  sponsorship: { companyFile: CompanyFile | null; alert: Record<string, unknown> | null };
}

export interface FollowupCadenceEntry {
  num: number;
  company: string;
  role: string;
  status: string;
  score: string;
  appliedDate: string;
  daysSinceApplication: number | null;
  daysSinceLastFollowup: number | null;
  followupCount: number;
  urgency: string;
  nextFollowupDate: string | null;
  daysUntilNext: number | null;
  nextOverride: unknown;
  contacts: unknown[];
  followups: FollowupEntry[];
}

export interface FollowupCadence {
  metadata: { analysisDate: string; totalTracked: number; actionable: number; overdue: number; urgent: number; cold: number; waiting: number; retired: number };
  entries: FollowupCadenceEntry[];
}

export type DashboardRead = { kind: 'ok'; dashboard: Dashboard } | { kind: 'missing' | 'malformed'; path: string };

export interface WhatsNewResponse {
  offers: FreshOffer[];
  count: number;
}

export interface ScheduleLogs {
  dates: string[];
  latest: DailyLog | null;
}
