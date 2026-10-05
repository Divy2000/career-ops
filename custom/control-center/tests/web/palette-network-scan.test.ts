// Cmd+K > Network scan (dry run): the params dialog is built from the JSON schema the server lists for the action, and
// what it sends must pass the action's own zod schema (R7-16).
import { describe, expect, it } from 'vitest';
import { actionMetadata, findAction } from '../../server/actions/registry';
import { needsParamsDialog, paramOptions, parseParamValues, requiredParams } from '../../web/components/CommandPalette';
import type { ActionMeta } from '@shared/api';

const meta = actionMetadata().find((a) => a.id === 'scan.network') as unknown as ActionMeta;

describe('the palette params dialog for the network scan', () => {
  it('asks only for the fields with no default', () => {
    expect(requiredParams(meta)).toEqual(['ats']);
  });

  it('sends sinceDays as the number the action accepts, and the filled form passes the action schema', () => {
    const params = parseParamValues(meta.params as never, { sinceDays: '7', ats: 'greenhouse' });
    expect(params).toEqual({ sinceDays: 7, ats: ['greenhouse'] });
    const parsed = findAction('scan.network')!.params.safeParse(params);
    expect(parsed.success, JSON.stringify(parsed.error?.issues)).toBe(true);
  });

  it('offers exactly the sinceDays values the action accepts', () => {
    const prop = (meta.params as { properties: Record<string, { anyOf?: Array<{ const: unknown }> }> }).properties.sinceDays!;
    expect(prop.anyOf!.map((o) => o.const)).toEqual([1, 3, 7, 14, 30]);
  });
});

describe('which palette actions open the params dialog', () => {
  const byId = (id: string) => actionMetadata().find((a) => a.id === id) as unknown as ActionMeta;
  it('an action with a required field or a defaulted option opens it; one with only optional fields runs at once', () => {
    expect(needsParamsDialog(byId('scan.network'))).toBe(true);
    expect(needsParamsDialog(byId('scan.portals'))).toBe(true);
    expect(needsParamsDialog(byId('tracker.setStatus'))).toBe(true);
    expect(needsParamsDialog(byId('pipeline.shortlist'))).toBe(false);
    expect(needsParamsDialog(byId('pipeline.prioritize'))).toBe(false);
  });
  it('lists a choice of numbers as options of their own type', () => {
    const props = (byId('scan.network').params as { properties: Record<string, Parameters<typeof paramOptions>[0]> }).properties;
    expect(paramOptions(props.sinceDays!)).toEqual([1, 3, 7, 14, 30]);
    expect(paramOptions(props.roles!)).toBeNull();
  });
});
