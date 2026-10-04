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
export type { SessionMeta, SessionTurn, SessionStatus, StoredEvent } from '../server/claude/sessions.js';
export type { Envelope, EnvelopeKind } from '../server/claude/envelopes.js';
export type { ConfigRead } from '../server/routes/config.js';
export type { YamlOp } from '../server/domains/yamlOps.js';
export type { BlacklistRow, BlacklistRead } from '../server/domains/blacklist.js';
export type { PluginInfo, PluginsRead } from '../server/domains/plugins.js';
export type { ScheduleState, ScheduleInput } from '../server/system/schedule.js';
export type { AppSettings } from '../server/domains/settings.js';
export type { UsageRead, UsageWindow } from '../server/domains/usage.js';
export type { InsightRead } from '../server/domains/insightsCache.js';
export type { ContactsRead, ContactRow, InterviewsRead, PrepDoc } from '../server/domains/contacts.js';
export type { TextRead } from '../server/domains/files.js';

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
import type { AppSettings } from '../server/domains/settings.js';
import type { UsageRead } from '../server/domains/usage.js';

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
  /** Pure cadence defaults; present on an empty tracker, where the CLI reports no other config. */
  cadenceDefaults?: Record<string, number>;
}

export type DashboardRead = { kind: 'ok'; dashboard: Dashboard } | { kind: 'missing' | 'malformed'; path: string };

export interface WhatsNewResponse {
  offers: FreshOffer[];
  count: number;
}

export interface ScheduleLogs {
  job: string;
  dates: string[];
  latest: (DailyLog & { raw: string }) | null;
}

export interface CadenceRead {
  kind: 'ok' | 'missing';
  etag: string | null;
  cadence: Record<string, number>;
  keys: string[];
  parseError: string | null;
}

export type AppSettingsRead = AppSettings & { problem: string | null };
export type UsageResponse = UsageRead & { budgets: AppSettings['usageBudgets'] };
export type { LookupResult, SearchResult, SearchHit, H1bCheck } from '../server/domains/sponsorshipLookup.js';
export type { Tutorial, TutorialsRead } from '../server/domains/tutorials.js';
