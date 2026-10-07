import { apiClient } from '@/services/api/client';
import { pluginsApi } from '@/services/api/plugins';
import { normalizeApiBase } from '@/utils/connection';

export interface CommandQuota {
  windows: {
    window: '5h' | 'weekly';
    used: number;
    cap: number;
    remainingFraction: number;
    resetTime?: string;
  }[];
  credits: Partial<Record<'monthlyCredits' | 'purchasedCredits' | 'freeCredits', number>>;
  balance?: number;
  periodEnd?: string;
  updatedAt?: string;
}

const record = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v);
const number = (v: unknown): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v >= 0;
const date = (v: unknown): v is string =>
  typeof v === 'string' && Number.isFinite(Date.parse(v));

export function normalizeCommandQuota(value: unknown): CommandQuota {
  if (!record(value) || !Array.isArray(value.windows) || !record(value.credits)) {
    throw new Error('Invalid Command Code quota');
  }
  const windows = value.windows.map((w): CommandQuota['windows'][number] => {
    if (!record(w) || !['5h', 'weekly'].includes(String(w.window)) || !number(w.used) ||
      !number(w.cap) || w.cap === 0 || !number(w.remainingFraction) || w.remainingFraction > 1 ||
      (w.resetTime !== undefined && !date(w.resetTime))) throw new Error('Invalid quota window');
    return { window: w.window as '5h' | 'weekly', used: w.used, cap: w.cap,
      remainingFraction: w.remainingFraction,
      ...(typeof w.resetTime === 'string' ? { resetTime: w.resetTime } : {}) };
  });
  if (new Set(windows.map(w => w.window)).size !== windows.length) {
    throw new Error('Duplicate quota windows');
  }
  const credits: CommandQuota['credits'] = {};
  for (const pool of ['monthlyCredits', 'purchasedCredits', 'freeCredits'] as const) {
    if (value.credits[pool] !== undefined) {
      if (!number(value.credits[pool])) throw new Error('Invalid credit balance');
      credits[pool] = value.credits[pool];
    }
  }
  if (!windows.length && !Object.keys(credits).length) throw new Error('Empty quota');
  if (value.balance !== undefined && (!number(value.balance) || Object.keys(credits).length !== 3 ||
    Math.abs(value.balance - Object.values(credits).reduce((s, n) => s + n, 0)) > 1e-6)) {
    throw new Error('Invalid total balance');
  }
  if ((value.periodEnd !== undefined && !date(value.periodEnd)) ||
    (value.updatedAt !== undefined && !date(value.updatedAt))) throw new Error('Invalid quota date');
  return { windows, credits,
    ...(number(value.balance) ? { balance: value.balance } : {}),
    ...(date(value.periodEnd) ? { periodEnd: value.periodEnd } : {}),
    ...(date(value.updatedAt) ? { updatedAt: value.updatedAt } : {}) };
}

export async function fetchCommandQuota(apiBase: string): Promise<CommandQuota | null> {
  const revision = apiClient.getConnectionRevision();
  const plugins = await pluginsApi.list();
  if (revision !== apiClient.getConnectionRevision()) throw new Error('Connection changed');
  if (!plugins.pluginsEnabled || !plugins.plugins.some(p =>
    p.id === 'factory-quota' && p.registered && p.effectiveEnabled)) return null;
  const result = await apiClient.get<unknown>(
    `${normalizeApiBase(apiBase)}/v0/management/plugins/factory-quota/command-code`
  );
  if (revision !== apiClient.getConnectionRevision()) throw new Error('Connection changed');
  return normalizeCommandQuota(result);
}
