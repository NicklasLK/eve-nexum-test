import { useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { charPortrait } from '../../utils/eveImages';
import { Select } from './Select';
import styles from './AdminPage.module.css';

// Admin › Reports › Wormholes: credits per pilot for one calendar month (UTC).
// A hole credits the pilot who jumped it and the pilot who named its code —
// one wormhole when that is the same pilot, half each otherwise. The ISK per
// wormhole is typed in here each month and multiplied on the page only; it is
// remembered in this browser and never sent to the server. Payouts happen
// elsewhere. See plans/wh-scan-bounties.md.

interface Row {
  userId: number; characterId: number; characterName: string;
  corpId: number | null; corpTicker: string | null; corpName: string | null;
  jumped: number; typed: number; wormholes: number;
}
interface Resp { month: string; totalHoles: number; rows: Row[] }

const ISK_KEY = 'nexum.reports.iskPerWormhole';

function monthKey(d: Date): string {
  return `${d.getUTCFullYear()}-${String(d.getUTCMonth() + 1).padStart(2, '0')}`;
}

// The current month plus the twelve before it, newest first. Computed once
// when the module loads; a page that stays open across a month boundary just
// needs a reload to see the new one.
const MONTH_OPTIONS = (() => {
  const now = new Date();
  const out: { value: string; label: string }[] = [];
  for (let i = 0; i <= 12; i++) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth() - i, 1));
    out.push({ value: monthKey(d), label: d.toLocaleString(undefined, { month: 'long', year: 'numeric', timeZone: 'UTC' }) });
  }
  return out;
})();
const LAST_MONTH = MONTH_OPTIONS[1]?.value ?? MONTH_OPTIONS[0].value;

function readIsk(): string {
  try { return localStorage.getItem(ISK_KEY) ?? ''; } catch { return ''; }
}

const fmtWh = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(1));
const fmtIsk = (n: number) => Math.round(n).toLocaleString();

export function WormholesReport() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(LAST_MONTH);
  const [data, setData]   = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isk, setIsk]     = useState<string>(readIsk);

  useEffect(() => {
    let cancelled = false;
    api<Resp>('/api/admin/reports/wormholes?month=' + encodeURIComponent(month))
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('admin.reports.wormholes.loadFailed')); });
    return () => { cancelled = true; };
  }, [month, t]);

  const iskPer = Number(isk.replace(/[^0-9.]/g, '')) || 0;
  const changeIsk = (v: string) => {
    setIsk(v);
    try { localStorage.setItem(ISK_KEY, v); } catch { /* remembered only when storage allows */ }
  };

  const totals = useMemo(() => (data
    ? { pilots: data.rows.length, wormholes: data.rows.reduce((s, r) => s + r.wormholes, 0) }
    : null), [data]);

  function downloadCsv() {
    if (!data) return;
    const head = ['Character', 'Corp', 'Jumped', 'Typed', 'Wormholes'].concat(iskPer > 0 ? ['ISK'] : []);
    const lines = data.rows.map((r) => [
      r.characterName, r.corpTicker ?? '', String(r.jumped), String(r.typed), fmtWh(r.wormholes),
    ].concat(iskPer > 0 ? [String(Math.round(r.wormholes * iskPer))] : []));
    const csv = [head, ...lines].map((cells) => cells.map((c) => '"' + c.replace(/"/g, '""') + '"').join(',')).join('\n');
    const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
    const url  = URL.createObjectURL(blob);
    const a    = document.createElement('a');
    a.href     = url;
    a.download = 'nexum_wormholes_' + month + '.csv';
    a.click();
    URL.revokeObjectURL(url);
  }

  const controls = (
    <div className={styles.pgFilterBar}>
      <div className={styles.pgFilterGroup}>
        <label className={styles.pgFilterLabel}>{t('admin.reports.wormholes.month')}</label>
        <Select value={month} onChange={(v) => setMonth(v)} options={MONTH_OPTIONS} />
      </div>
      <div className={styles.pgFilterGroup}>
        <label className={styles.pgFilterLabel} title={t('admin.reports.wormholes.iskPerWhHint')}>{t('admin.reports.wormholes.iskPerWh')}</label>
        <input className="chains-new__name" style={{ width: 150 }} inputMode="numeric" placeholder="0"
          value={isk} onChange={(e) => changeIsk(e.target.value)} title={t('admin.reports.wormholes.iskPerWhHint')} />
      </div>
      <div className={styles.pgFilterSpacer} />
      {data && data.rows.length > 0 && (
        <button className="btn btn--ghost btn--sm" onClick={downloadCsv}>↓ {t('admin.exportCsv')}</button>
      )}
    </div>
  );

  if (error) return <>{controls}<div className={styles.pgError}>{error}</div></>;
  if (!data || !totals) return <>{controls}<div className={styles.pgLoading}>{t('admin.loading')}</div></>;

  const card = (label: string, value: string, accent = false) => (
    <div className={`admin-page__stat-card${accent ? ' admin-page__stat-card--accent' : ''}`}>
      <span className="admin-page__stat-card-value">{value}</span>
      <span className="admin-page__stat-card-label">{label}</span>
    </div>
  );

  return (
    <>
      {controls}
      <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
        {card(t('admin.reports.wormholes.totalHoles'), data.totalHoles.toLocaleString(), true)}
        {card(t('admin.reports.wormholes.pilots'), String(totals.pilots))}
        {card(t('admin.reports.wormholes.totalWormholes'), fmtWh(totals.wormholes))}
        {iskPer > 0 && card(t('admin.reports.wormholes.totalIsk'), fmtIsk(totals.wormholes * iskPer))}
      </div>
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '0 0 12px' }}>{t('admin.reports.wormholes.hint')}</p>
      {data.rows.length === 0 ? (
        <div className={styles.pgEmpty}>{t('admin.reports.wormholes.empty')}</div>
      ) : (
        <table className={styles.mTable}>
          <thead><tr>
            <th>{t('admin.reports.wormholes.colCharacter')}</th>
            <th>{t('admin.reports.wormholes.colCorp')}</th>
            <th className={styles.mNum}>{t('admin.reports.wormholes.colJumped')}</th>
            <th className={styles.mNum}>{t('admin.reports.wormholes.colTyped')}</th>
            <th className={styles.mNum}>{t('admin.reports.wormholes.colWormholes')}</th>
            {iskPer > 0 && <th className={styles.mNum}>{t('admin.reports.wormholes.colIsk')}</th>}
          </tr></thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.userId}>
                <td className={styles.mNameCell}><img className={styles.mAvatar} src={charPortrait(r.characterId, 32)} alt="" /> {r.characterName}</td>
                <td title={r.corpName ?? undefined}>{r.corpTicker ? <span className={styles.mTicker}>[{r.corpTicker}]</span> : '—'}</td>
                <td className={styles.mNum}>{r.jumped}</td>
                <td className={styles.mNum}>{r.typed}</td>
                <td className={styles.mNum}>{fmtWh(r.wormholes)}</td>
                {iskPer > 0 && <td className={styles.mNum}>{fmtIsk(r.wormholes * iskPer)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
