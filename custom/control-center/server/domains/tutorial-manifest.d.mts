/** One part of a tutorial: its own video and files, its length and its chapters (starts counted from the start of the part). */
export interface TutorialPartManifest {
  id: string;
  title: string;
  /** The playlist label: the part's short label, or its title when it has none. */
  short: string;
  video: string;
  videoLight?: string;
  subtitles?: string;
  poster?: string;
  posterLight?: string;
  /** Seconds; null for the one part of a single-video manifest, which declares no length. */
  duration: number | null;
  chapters: Array<{ title: string; start: number }>;
}
export interface TutorialManifest {
  id: string;
  title: string;
  description: string;
  transcript?: string;
  guide?: string;
  /** At least one; a single-video manifest is one part with id "main". */
  parts: TutorialPartManifest[];
  /** Every part's chapters in part order; a guide's chapter number indexes this list. */
  chapters: Array<{ title: string; start: number; part: string }>;
}
export type ManifestResult = { ok: true; manifest: TutorialManifest } | { ok: false; error: string };
export const ID_RE: RegExp;
export function extOf(name: string): string;
export function parseManifest(value: unknown, folder: string): ManifestResult;
export interface GuideSection {
  id: string;
  title: string;
  summary: string;
  route?: string;
  gif: string;
  poster?: string;
  steps: string[];
  tips?: string[];
  chapter?: number;
}
/** The legacy guide.json (no `version`). */
export interface TutorialGuideFileV1 {
  version?: undefined;
  sections: GuideSection[];
}

export interface GuideTextBlock {
  type: 'text';
  text: string;
}
export interface GuideStepsBlock {
  type: 'steps';
  items: string[];
}
export interface GuideTipsBlock {
  type: 'tips';
  items: string[];
}
interface GuideMediaBase {
  type: 'media';
  alt: string;
  caption?: string;
  width: number;
  height: number;
}
export interface GuideImageBlock extends GuideMediaBase {
  kind: 'image';
  file: string;
  fileLight: string;
}
export interface GuideClipBlock extends GuideMediaBase {
  kind: 'gif';
  file: string;
  fileLight: string;
  poster: string;
  posterLight: string;
}
export type GuideBlock = GuideTextBlock | GuideStepsBlock | GuideTipsBlock | GuideImageBlock | GuideClipBlock;
export interface GuideSubsection {
  id: string;
  title: string;
  /** 1 to 24 characters for the contents panel; the title stands in when it is absent. */
  short?: string;
  summary: string;
  route?: string;
  chapter?: number;
  blocks: GuideBlock[];
}
export interface GuideSectionV2 {
  id: string;
  title: string;
  short?: string;
  summary: string;
  subsections: GuideSubsection[];
}
/** The documentation guide.json (`"version": 2`). */
export interface TutorialGuideFileV2 {
  version: 2;
  sections: GuideSectionV2[];
}
export type TutorialGuideFile = TutorialGuideFileV1 | TutorialGuideFileV2;
export type GuideResult = { ok: true; guide: TutorialGuideFile } | { ok: false; error: string };
export const MAX_GUIDE_SECTIONS: number;
export const MAX_GUIDE_V2_SECTIONS: number;
export const MAX_GUIDE_SUBSECTIONS: number;
export const MAX_GUIDE_BYTES: number;
export function parseGuide(value: unknown, opts: { chapterCount: number }): GuideResult;
export function isGuideV2(guide: TutorialGuideFile): guide is TutorialGuideFileV2;
export type GuideFileKind = 'image' | 'gif' | 'poster' | 'light image' | 'light gif' | 'light poster';
export function guideFileRefs(guide: TutorialGuideFile): Array<{ name: string; kind: GuideFileKind }>;
export function guideFileNames(guide: TutorialGuideFile): string[];

/** A media block as the page reads it: every optional field is present, null when absent. */
export interface GuideMediaDoc {
  type: 'media';
  kind: 'image' | 'gif';
  file: string;
  fileLight: string | null;
  poster: string | null;
  posterLight: string | null;
  alt: string;
  caption: string | null;
  width: number | null;
  height: number | null;
}
export type GuideBlockDoc = GuideTextBlock | GuideStepsBlock | GuideTipsBlock | GuideMediaDoc;
export interface GuideSubsectionDoc {
  id: string;
  title: string;
  /** The contents label: the guide's short label, or the title when it has none. */
  short: string;
  summary: string;
  route: string | null;
  chapter: number | null;
  blocks: GuideBlockDoc[];
}
export interface GuideSectionDoc {
  id: string;
  title: string;
  short: string;
  summary: string;
  subsections: GuideSubsectionDoc[];
}
export interface GuideDocsFile {
  version: 1 | 2;
  legacy: boolean;
  sections: GuideSectionDoc[];
}
export function guideDocs(guide: TutorialGuideFile): GuideDocsFile;
