import { describe, expect, it } from 'vitest';
import { parseParamValues, requiredParams } from '../../web/components/CommandPalette';
import type { ActionMeta } from '@shared/api';

const meta = (params: Record<string, unknown>): ActionMeta => ({ id: 'x', label: 'X', cost: 'free', confirm: null, resources: [], claude: false, sync: true, params });

describe('command palette action params', () => {
  it('reads required params from the JSON schema', () => {
    expect(requiredParams(meta({ type: 'object', properties: { n: { type: 'number' } }, required: ['n'] }))).toEqual(['n']);
    expect(requiredParams(meta({ type: 'object', properties: {} }))).toEqual([]);
  });
  it('parses text fields into numbers, booleans and arrays and drops empty optional fields', () => {
    const schema = { properties: { n: { type: 'integer' }, dryRun: { type: 'boolean' }, urls: { type: 'array', items: { type: 'string' } }, model: { type: 'string' }, limit: { type: ['number', 'null'] } } };
    expect(parseParamValues(schema, { n: '4', dryRun: true, urls: 'https://a.example/1\n\nhttps://a.example/2', model: '', limit: '' })).toEqual({ n: 4, dryRun: true, urls: ['https://a.example/1', 'https://a.example/2'] });
  });
});
