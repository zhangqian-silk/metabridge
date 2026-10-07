import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Card } from '@/components/ui/Card';
import { Button } from '@/components/ui/Button';
import { useAuthStore } from '@/stores';
import { apiClient } from '@/services/api/client';
import { bindQuotaClasses } from './types';
import bodyStyles from './components/QuotaBody.module.scss';
import styles from './FactoryQuotaSection.module.scss';
import { fetchCommandQuota, type CommandQuota } from './commandQuota';
import { CommandQuotaBody } from './CommandQuotaBody';

const classes = bindQuotaClasses(bodyStyles, 'CommandQuotaSection');

export function CommandQuotaSection() {
  const { t } = useTranslation();
  const apiBase = useAuthStore(s => s.apiBase);
  const managementKey = useAuthStore(s => s.managementKey);
  const connected = useAuthStore(s => s.connectionStatus === 'connected');
  const [quota, setQuota] = useState<CommandQuota | null>(null);
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
      const data = await fetchCommandQuota(apiBase);
      if (ticket !== requestId.current || revision !== apiClient.getConnectionRevision()) return;
      setQuota(data);
      setAvailable(data !== null);
    } catch {
      if (ticket !== requestId.current || revision !== apiClient.getConnectionRevision()) return;
      setQuota(null);
      setAvailable(true);
      setError(true);
    } finally {
      if (ticket === requestId.current && revision === apiClient.getConnectionRevision()) {
        setLoading(false);
      }
    }
  }, [apiBase, connected]);
  useEffect(() => {
    setQuota(null);
    setAvailable(false);
    setError(false);
    setLoading(false);
    void load();
    return invalidate;
  }, [invalidate, load, managementKey]);

  if (!connected || (!available && !loading)) return null;
  return (
    <section aria-label={t('command_quota.title')}>
      <Card title={t('command_quota.title')} extra={
        <Button variant="secondary" size="sm" disabled={loading} onClick={() => void load()}>
          {t(loading ? 'factory_quota.loading' : 'factory_quota.refresh')}
        </Button>
      }>
        <p className={styles.note}>{t('command_quota.account_note')}</p>
        {error && <p role="alert" className={styles.error}>{t('command_quota.error')}</p>}
        {loading && !quota && <p role="status">{t('factory_quota.loading')}</p>}
        {quota && <CommandQuotaBody quota={quota} classes={classes} />}
      </Card>
    </section>
  );
}
