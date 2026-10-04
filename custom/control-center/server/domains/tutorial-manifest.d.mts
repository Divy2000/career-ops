export interface TutorialManifest {
  id: string;
  title: string;
  description: string;
  video: string;
  subtitles?: string;
  poster?: string;
  transcript?: string;
  chapters: Array<{ title: string; start: number }>;
}
export type ManifestResult = { ok: true; manifest: TutorialManifest } | { ok: false; error: string };
export const ID_RE: RegExp;
export function extOf(name: string): string;
export function parseManifest(value: unknown, folder: string): ManifestResult;
