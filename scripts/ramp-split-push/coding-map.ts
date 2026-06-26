import type { Entity, CodingMap } from './types';
import { getRampAccounts, getRampFields, getRampFieldOptions } from './ramp-client';

export async function buildCodingMap(entity: Entity, token: string): Promise<CodingMap> {
  const accounts = await getRampAccounts(entity, token);
  const gl: Record<string, string> = {};
  for (const a of accounts) gl[a.id] = a.id; // QB Account.Id == Ramp option id

  const fields = await getRampFields(entity, token);
  const klassField = fields.find((f) => f.name === 'Class');
  const locField = fields.find((f) => f.name === 'Location');

  const klass: Record<string, string> = {};
  if (klassField) {
    for (const o of await getRampFieldOptions(entity, token, klassField.rampId)) klass[o.id] = o.id;
  }
  const location: Record<string, string> = {};
  if (locField) {
    for (const o of await getRampFieldOptions(entity, token, locField.rampId)) location[o.id] = o.id;
  }

  return { gl, klass, location };
}
