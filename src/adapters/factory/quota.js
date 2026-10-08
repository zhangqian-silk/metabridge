'use strict';
const { queryFactoryQuota } = require('./api');
const WINDOWS = { fiveHour: '5h', weekly: 'weekly', monthly: 'monthly' };

function toCPAQuota(result) {
  const billing = result.billingLimits;
  if (billing?.status !== 'available') throw new Error('Factory billing quota unavailable');
  const groups = [];
  for (const tier of ['standard', 'core']) {
    const buckets = [];
    for (const [window, name] of Object.entries(WINDOWS)) {
      const row = billing.groups?.[tier]?.[window];
      if (!row) continue; // Missing is unknown, not zero consumption.
      if (!Number.isFinite(row.remainingFraction) || row.remainingFraction < 0 ||
          row.remainingFraction > 1) throw new Error('Invalid Factory quota');
      buckets.push({ window: name, remainingFraction: row.remainingFraction,
        ...(row.resetAt ? { resetTime: row.resetAt } : {}) });
    }
    if (buckets.length) groups.push({ displayName: tier === 'standard' ? 'Standard' : 'Core', buckets });
  }
  if (!groups.length) throw new Error('Factory billing quota unavailable');
  return {
    groups, updatedAt: result.updatedAt,
    ...(typeof billing.extraUsageAllowed === 'boolean' ? { extraUsageAllowed: billing.extraUsageAllowed } : {}),
    ...(billing.extraUsageBalance ? { summary: [{
      key: 'extra_usage_balance', label: 'Extra usage balance',
      value: billing.extraUsageBalance.value, format: 'currency', currency: 'USD',
    }] } : {}),
  };
}

function createCPAQuotaReader(config, key, options = {}) {
  let cached;
  let expiresAt = 0;
  let inFlight;
  return async function readQuota() {
    if (!config.quota.billingLimits) throw new Error('Factory billing query disabled');
    if (cached && Date.now() < expiresAt) return cached;
    if (inFlight) return inFlight;
    const billingOnly = { ...config, quota: {
      billingLimits: true, globalLimit: false, userLimits: false, personalUsage: false,
    } };
    inFlight = queryFactoryQuota(billingOnly, key, options).then(result => {
      cached = toCPAQuota(result);
      expiresAt = Date.now() + 30000;
      return cached;
    }).finally(() => { inFlight = undefined; });
    return inFlight;
  };
}
module.exports = { toCPAQuota, createCPAQuotaReader };
