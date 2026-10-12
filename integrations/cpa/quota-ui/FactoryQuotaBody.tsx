import { useTranslation } from 'react-i18next';
import { QuotaMeter } from './components/QuotaMeter';
import type { QuotaClassMap } from './types';
import type { FactoryQuota } from './factoryQuota';

const WINDOWS = ['5h', 'weekly', 'monthly'] as const;
export interface FactoryQuotaBodyProps {
  quota: FactoryQuota;
  classes: QuotaClassMap;
  styles: Record<'groups' | 'group' | 'window' | 'row' | 'note', string>;
}

export function FactoryQuotaBody({ quota, classes, styles }: FactoryQuotaBodyProps) {
  const { t, i18n } = useTranslation();
  const date = (value: string) => new Date(value).toLocaleString(i18n.language);
  const balance = quota.summary.find((metric) => metric.key === 'extra_usage_balance');
  return (
    <>
      <div className={styles.groups}>
        {['Standard', 'Core'].map((tier) => (
          <div className={styles.group} key={tier}>
            <h3>{tier === 'Core' ? 'Droid Core' : tier}</h3>
            {tier === 'Core' && <p className={styles.note}>{t('factory_quota.core_note')}</p>}
            {WINDOWS.map((window) => {
              const bucket = quota.groups.find((group) => group.displayName === tier)
                ?.buckets.find((item) => item.window === window);
              const percent = bucket ? Math.round(bucket.remainingFraction * 1000) / 10 : null;
              return (
                <div key={window} className={styles.window}>
                  <div className={styles.row}>
                    <span>{t(`factory_quota.window_${window}`)}</span>
                    <span>{percent === null ? t('factory_quota.unknown') :
                      t('factory_quota.remaining', { percent })}</span>
                  </div>
                  <QuotaMeter percent={percent} classes={classes} />
                  <small>{bucket?.resetTime
                    ? t('factory_quota.reset', { time: date(bucket.resetTime) })
                    : t('factory_quota.reset_unknown')}</small>
                </div>
              );
            })}
          </div>
        ))}
      </div>
      <div className={styles.note}>
        {balance && <p>{t('factory_quota.balance', { value:
          new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD' }).format(balance.value),
        })}</p>}
        {typeof quota.extraUsageAllowed === 'boolean' && <p>{
          t(quota.extraUsageAllowed ? 'factory_quota.extra_enabled' : 'factory_quota.extra_disabled')
        }</p>}
        {quota.updatedAt && <p>{t('factory_quota.updated', { time: date(quota.updatedAt) })}</p>}
        <p>{t('factory_quota.internal_api')}</p>
      </div>
    </>
  );
}
