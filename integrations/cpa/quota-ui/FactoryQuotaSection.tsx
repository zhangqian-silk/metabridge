import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { bindQuotaClasses } from './types';
import bodyStyles from './components/QuotaBody.module.scss';
import styles from './FactoryQuotaSection.module.scss';
import { fetchFactoryQuota, type FactoryQuota } from './factoryQuota';
import { FactoryQuotaBody } from './FactoryQuotaBody';

const classes = bindQuotaClasses(bodyStyles, 'FactoryQuotaSection');

export function FactoryQuotaSection() {
  const { t } = useTranslation();
  const apiBase = useAuthStore((state) => state.apiBase);
  const managementKey = useAuthStore((state) => state.managementKey);
  const connected = useAuthStore((state) => state.connectionStatus === 'connected');
  const [quota, setQuota] = useState<FactoryQuota | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(false);
  const [available, setAvailable] = useState(false);
  const requestId = useRef(0);
  const invalidate = useCallback(() => { requestId.current++; }, []);
  const load = useCallback(async () => {
    if (!connected) return;
    const ticket = ++requestId.current;
    const revision = apiClient.getConnectionRevision();
    setLoading(true);
    setError(false);
    try {
      const data = await fetchFactoryQuota(apiBase);
      if (requestId.current !== ticket || revision !== apiClient.getConnectionRevision()) return;
      setQuota(data);
      setAvailable(data !== null);
    } catch {
      if (requestId.current !== ticket || revision !== apiClient.getConnectionRevision()) return;
      setQuota(null); // Never show old successful quota as current after a failed refresh.
      setAvailable(true);
      setError(true);
    } finally {
      if (requestId.current === ticket && revision === apiClient.getConnectionRevision()) setLoading(false);
    }
  }, [apiBase, connected]);
  useEffect(() => {
    setQuota(null);
    setAvailable(false);
    setError(false);
    setLoading(false);
    void load(); // One initial query; no polling and no inference.
    return invalidate;
  }, [invalidate, load, managementKey]);

  if (!connected || (!available && !loading)) return null;
  return (
    <section aria-label={t('factory_quota.title')}>
      <Card title={t('factory_quota.title')} extra={
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => void load()}>
          {t(loading ? 'factory_quota.loading' : 'factory_quota.refresh')}
        </Button>
      }>
        <p className={styles.note}>{t('factory_quota.account_note')}</p>
        {error && <p role="alert" className={styles.error}>{t('factory_quota.error')}</p>}
        {loading && !quota && <p role="status">{t('factory_quota.loading')}</p>}
        {quota && <FactoryQuotaBody quota={quota} classes={classes} styles={{
          groups: styles.groups, group: styles.group, window: styles.window, row: styles.row, note: styles.note,
        }} />}
      </Card>
    </section>
  );
}
