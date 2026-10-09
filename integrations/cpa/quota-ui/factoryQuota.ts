import { apiClient } from '@/services/api/client';
import { pluginsApi } from '@/services/api/plugins';
import { normalizeApiBase } from '@/utils/connection';

export interface FactoryQuotaBucket {
  window: '5h' | 'weekly' | 'monthly';
  remainingFraction: number;
  resetTime?: string;
}

export interface FactoryQuota {
  groups: { displayName: string; buckets: FactoryQuotaBucket[] }[];
  summary: { key: string; value: number; currency: string }[];
  updatedAt?: string;
  extraUsageAllowed?: boolean;
}

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

export function normalizeFactoryQuota(value: unknown): FactoryQuota {
  if (!record(value) || !Array.isArray(value.groups)) throw new Error('Invalid quota response');
  const groups = value.groups.map((group) => {
    if (!record(group) || !['Standard', 'Core'].includes(String(group.displayName)) ||
      !Array.isArray(group.buckets)) throw new Error('Invalid quota group');
    const buckets = group.buckets.map((bucket): FactoryQuotaBucket => {
      if (!record(bucket) || !['5h', 'weekly', 'monthly'].includes(String(bucket.window)) ||
        typeof bucket.remainingFraction !== 'number' || !Number.isFinite(bucket.remainingFraction) ||
        bucket.remainingFraction < 0 || bucket.remainingFraction > 1 ||
        (bucket.resetTime !== undefined && (typeof bucket.resetTime !== 'string' ||
          !Number.isFinite(Date.parse(bucket.resetTime))))) throw new Error('Invalid quota bucket');
      return {
        window: bucket.window as FactoryQuotaBucket['window'],
        remainingFraction: bucket.remainingFraction,
        ...(typeof bucket.resetTime === 'string' ? { resetTime: bucket.resetTime } : {}),
      };
    });
    if (!buckets.length || new Set(buckets.map((bucket) => bucket.window)).size !== buckets.length) {
      throw new Error('Invalid quota windows');
    }
    return { displayName: String(group.displayName), buckets };
  });
  if (!groups.length || new Set(groups.map((group) => group.displayName)).size !== groups.length) {
    throw new Error('Invalid quota groups');
  }
  const summary = Array.isArray(value.summary) ? value.summary.flatMap((metric) =>
    record(metric) && metric.key === 'extra_usage_balance' && metric.currency === 'USD' &&
      typeof metric.value === 'number' && Number.isFinite(metric.value)
      ? [{ key: 'extra_usage_balance', currency: 'USD', value: metric.value }] : []) : [];
  return {
    groups, summary,
    ...(typeof value.updatedAt === 'string' && Number.isFinite(Date.parse(value.updatedAt))
      ? { updatedAt: value.updatedAt } : {}),
    ...(typeof value.extraUsageAllowed === 'boolean' ? { extraUsageAllowed: value.extraUsageAllowed } : {}),
  };
}

export interface FactoryAccountQuota {
  id: string;
  quota: FactoryQuota | null;
}

export function normalizeFactoryAccounts(value: unknown): FactoryAccountQuota[] {
  if (!record(value) || !Array.isArray(value.accounts) ||
    !value.accounts.length || value.accounts.length > 16) throw new Error('Invalid accounts response');
  const ids = new Set<string>();
  return value.accounts.map((account) => {
    if (!record(account) || typeof account.id !== 'string' ||
      !/^factory(?:-[a-z0-9]+)*$/.test(account.id) || ids.has(account.id)) {
      throw new Error('Invalid account identity');
    }
    ids.add(account.id);
    let quota: FactoryQuota | null = null;
    try { quota = normalizeFactoryQuota(account.quota); } catch { /* Account-local failure. */ }
    return { id: account.id, quota };
  });
}

export async function fetchFactoryQuotas(apiBase: string): Promise<FactoryAccountQuota[] | null> {
  const revision = apiClient.getConnectionRevision();
  const plugins = await pluginsApi.list();
  if (revision !== apiClient.getConnectionRevision()) throw new Error('Connection changed');
  if (!plugins.pluginsEnabled || !plugins.plugins.some((plugin) =>
    plugin.id === 'factory-quota' && plugin.registered && plugin.effectiveEnabled)) return null;
  // Plugin-declared path is v0, independently of the UI's native v8 API contract.
  const url = `${normalizeApiBase(apiBase)}/v0/management/plugins/factory-quota/accounts`;
  const result = await apiClient.get<unknown>(url);
  if (revision !== apiClient.getConnectionRevision()) throw new Error('Connection changed');
  return normalizeFactoryAccounts(result);
}
