import { useQuery } from '@tanstack/react-query';
import { apiGet } from './api';
import type {
  ApplicationDetail,
  DashboardRead,
  FollowupCadence,
  ImmigrationOverview,
  PipelineRead,
  ScheduleLogs,
  ShortlistRead,
  SystemStatus,
  TrackerRead,
  TutorialsRead,
  WhatsNewResponse,
} from '@shared/api';

export const useSystemStatus = () => useQuery({ queryKey: ['system', 'status'], queryFn: () => apiGet<SystemStatus>('/api/system/status') });
export const useTracker = () => useQuery({ queryKey: ['tracker'], queryFn: () => apiGet<TrackerRead>('/api/tracker') });
export const useApplication = (n: string) => useQuery({ queryKey: ['tracker', 'row', n], queryFn: () => apiGet<ApplicationDetail>(`/api/tracker/${n}`) });
export const usePipeline = () => useQuery({ queryKey: ['pipeline'], queryFn: () => apiGet<PipelineRead>('/api/pipeline') });
export const useShortlist = () => useQuery({ queryKey: ['shortlist'], queryFn: () => apiGet<ShortlistRead>('/api/shortlist') });
export const useWhatsNew = (days = 7, limit = 12) =>
  useQuery({ queryKey: ['pipeline', 'whats-new', days, limit], queryFn: () => apiGet<WhatsNewResponse>(`/api/whats-new?days=${days}&limit=${limit}`) });
export const useImmigration = () => useQuery({ queryKey: ['immigration'], queryFn: () => apiGet<ImmigrationOverview>('/api/immigration/overview') });
export const useFollowups = () => useQuery({ queryKey: ['followups'], queryFn: () => apiGet<FollowupCadence>('/api/followups') });
export const useDashboard = () => useQuery({ queryKey: ['insights', 'dashboard'], queryFn: () => apiGet<DashboardRead>('/api/insights/dashboard') });
export const useScheduleLogs = () => useQuery({ queryKey: ['immigration', 'logs'], queryFn: () => apiGet<ScheduleLogs>('/api/schedule/logs') });
export const useTutorials = () => useQuery({ queryKey: ['tutorials'], queryFn: () => apiGet<TutorialsRead>('/api/tutorials') });

/** A user-layer file (cv.md, the house rules, the story bank) as GET /api/files/user/:key reads it. */
export interface UserFile {
  key: string;
  path: string;
  kind: 'ok' | 'missing';
  text: string;
  etag: string | null;
}

export const useUserFile = (key: string) => useQuery({ queryKey: ['config', 'user-file', key], queryFn: () => apiGet<UserFile>(`/api/files/user/${key}`) });
