import { useTranslation } from 'react-i18next';
import { QuotaMeter } from './components/QuotaMeter';
import type { QuotaClassMap } from './types';
import type { CommandQuota } from './commandQuota';
import styles from './FactoryQuotaSection.module.scss';

export function CommandQuotaBody({ quota, classes }: {
  quota: CommandQuota; classes: QuotaClassMap;
}) {
  const { t, i18n } = useTranslation();
  const date = (v: string) => new Date(v).toLocaleString(i18n.language);
  const money = (v: number | undefined) => v === undefined ? t('factory_quota.unknown') :
    new Intl.NumberFormat(i18n.language, { style: 'currency', currency: 'USD',
      maximumFractionDigits: 4 }).format(v);
  return (
    <>
      <div className={styles.groups}>
        {(['5h', 'weekly'] as const).map(window => {
          const row = quota.windows.find(w => w.window === window);
          const percent = row ? Math.round(row.remainingFraction * 1000) / 10 : null;
          return (
            <div key={window} className={styles.window}>
              <div className={styles.row}>
                <span>{t(`factory_quota.window_${window}`)}</span>
                <span>{percent === null ? t('factory_quota.unknown') :
                  t('factory_quota.remaining', { percent })}</span>
              </div>
              <QuotaMeter percent={percent} classes={classes} />
              {row && <small>{t('command_quota.used_cap', {
                used: row.used, cap: row.cap,
              })}</small>}
              <small>{row?.resetTime ? t('factory_quota.reset', { time: date(row.resetTime) }) :
                t('factory_quota.reset_unknown')}</small>
            </div>
          );
        })}
      </div>
      <div className={styles.note}>
        <p>{t('command_quota.balance', { value: money(quota.balance) })}</p>
        {(['monthlyCredits', 'purchasedCredits', 'freeCredits'] as const).map(pool =>
          <p key={pool}>{t(`command_quota.${pool}`, { value: money(quota.credits[pool]) })}</p>
        )}
        <p>{quota.periodEnd ? t('command_quota.period_end', { time: date(quota.periodEnd) }) :
          t('command_quota.period_unknown')}</p>
        {quota.updatedAt && <p>{t('factory_quota.updated', { time: date(quota.updatedAt) })}</p>}
        <p>{t('command_quota.source')}</p>
      </div>
    </>
  );
}
