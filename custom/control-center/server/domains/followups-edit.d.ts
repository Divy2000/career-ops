export type FollowupEdit =
  | { op: 'log.add'; appNum: number; date: string; company: string; role: string; channel: string; contact: string; notes: string }
  | { op: 'log.delete'; num: number }
  | { op: 'pin.set'; appNum: number; date: string; setOn: string }
  | { op: 'pin.clear'; appNum: number };
export type FollowupEditResult = { ok: true; text: string; num?: number } | { ok: false; error: string };
export function applyFollowupEdit(text: string, edit: FollowupEdit): FollowupEditResult;
