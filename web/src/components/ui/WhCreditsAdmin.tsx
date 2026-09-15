import { useCallback, useEffect, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { api } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { charPortrait } from '../../utils/eveImages';
import { timeAgo } from '../../i18n/format';
import { Select } from './Select';
import styles from './AdminPage.module.css';

// Admin › Wormhole credits: the monthly report and the excluded regions.
//
// A hole credits the pilot who jumped it and the pilot who named its code —
// one wormhole when that is the same pilot, half each otherwise. The ISK per
// wormhole is typed in here each month and multiplied on the page only; it is
// remembered in this browser and never sent to the server. Payouts happen
// elsewhere. A hole with either end in an excluded region earns nothing.
// See plans/wh-scan-bounties.md.

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

export function WhCreditsTab({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  return (
    <>
      <h2 className={styles.pgSectionTitle}>{t('admin.whCredits.title')}</h2>
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '0 0 12px' }}>{t('admin.whCredits.intro')}</p>
      <MonthlyReport />
      <ExcludedRegions isAdmin={isAdmin} />
    </>
  );
}

function MonthlyReport() {
  const { t } = useTranslation();
  const [month, setMonth] = useState(LAST_MONTH);
  const [data, setData]   = useState<Resp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isk, setIsk]     = useState<string>(readIsk);

  useEffect(() => {
    let cancelled = false;
    api<Resp>('/api/admin/reports/wormholes?month=' + encodeURIComponent(month))
      .then((d) => { if (!cancelled) { setData(d); setError(null); } })
      .catch((e) => { if (!cancelled) setError(e instanceof Error ? e.message : t('admin.whCredits.loadFailed')); });
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
        <label className={styles.pgFilterLabel}>{t('admin.whCredits.month')}</label>
        <Select value={month} onChange={(v) => setMonth(v)} options={MONTH_OPTIONS} />
      </div>
      <div className={styles.pgFilterGroup}>
        <label className={styles.pgFilterLabel} title={t('admin.whCredits.iskPerWhHint')}>{t('admin.whCredits.iskPerWh')}</label>
        <input className="chains-new__name" style={{ width: 150 }} inputMode="numeric" placeholder="0"
          value={isk} onChange={(e) => changeIsk(e.target.value)} title={t('admin.whCredits.iskPerWhHint')} />
      </div>
      <div className={styles.pgFilterSpacer} />
      {data && data.rows.length > 0 && (
        <button className="btn btn--ghost btn--sm" onClick={downloadCsv}>↓ {t('admin.exportCsv')}</button>
      )}
    </div>
  );

  const card = (label: string, value: string, accent = false) => (
    <div className={`admin-page__stat-card${accent ? ' admin-page__stat-card--accent' : ''}`}>
      <span className="admin-page__stat-card-value">{value}</span>
      <span className="admin-page__stat-card-label">{label}</span>
    </div>
  );

  return (
    <>
      <div className={styles.pgSectionBar}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{t('admin.whCredits.report')}</h3>
      </div>
      {controls}
      {error && <div className={styles.pgError}>{error}</div>}
      {!error && (!data || !totals) && <div className={styles.pgLoading}>{t('admin.loading')}</div>}
      {!error && data && totals && (
        <>
          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', marginBottom: 16 }}>
            {card(t('admin.whCredits.totalHoles'), data.totalHoles.toLocaleString(), true)}
            {card(t('admin.whCredits.pilots'), String(totals.pilots))}
            {card(t('admin.whCredits.totalWormholes'), fmtWh(totals.wormholes))}
            {iskPer > 0 && card(t('admin.whCredits.totalIsk'), fmtIsk(totals.wormholes * iskPer))}
          </div>
          {data.rows.length === 0 ? (
            <div className={styles.pgEmpty}>{t('admin.whCredits.empty')}</div>
          ) : (
            <table className={styles.mTable}>
              <thead><tr>
                <th>{t('admin.whCredits.colCharacter')}</th>
                <th>{t('admin.whCredits.colCorp')}</th>
                <th className={styles.mNum}>{t('admin.whCredits.colJumped')}</th>
                <th className={styles.mNum}>{t('admin.whCredits.colTyped')}</th>
                <th className={styles.mNum}>{t('admin.whCredits.colWormholes')}</th>
                {iskPer > 0 && <th className={styles.mNum}>{t('admin.whCredits.colIsk')}</th>}
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
      )}
    </>
  );
}

// ── Excluded regions ─────────────────────────────────────────────────────────

interface Excluded { regionId: number; regionName: string; addedBy: string | null; createdAt: string }
interface RegionOption { id: number; name: string; kspace: boolean }

const MAX_REGION_RESULTS = 8;

function ExcludedRegions({ isAdmin }: { isAdmin: boolean }) {
  const { t } = useTranslation();
  const [excluded, setExcluded] = useState<Excluded[] | null>(null);
  const [regions, setRegions]   = useState<RegionOption[]>([]);
  const [query, setQuery]       = useState('');
  const [error, setError]       = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      const r = await api<{ regions: Excluded[] }>('/api/admin/reports/wormholes/excluded-regions');
      setExcluded(r.regions); setError(null);
    } catch { setError(t('admin.whCredits.loadFailed')); }
  }, [t]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // The full region list is only needed by an admin who can add one.
  useEffect(() => {
    if (!isAdmin) return;
    api<{ regions: RegionOption[] }>('/api/admin/wh-credits/regions')
      .then((r) => setRegions(r.regions))
      .catch(() => undefined);
  }, [isAdmin]);

  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const taken = new Set((excluded ?? []).map((e) => e.regionId));
    return regions.filter((r) => !taken.has(r.id) && r.name.toLowerCase().includes(q)).slice(0, MAX_REGION_RESULTS);
  }, [query, regions, excluded]);

  const add = async (r: RegionOption) => {
    setQuery('');
    await api(`/api/admin/wh-credits/excluded-regions/${r.id}`, { method: 'PUT' })
      .catch(() => toast.error(t('admin.whCredits.saveFailed')));
    await load();
  };
  const remove = async (e: Excluded) => {
    await api(`/api/admin/wh-credits/excluded-regions/${e.regionId}`, { method: 'DELETE' })
      .catch(() => toast.error(t('admin.whCredits.saveFailed')));
    await load();
  };

  return (
    <>
      <div className={styles.pgSectionBar} style={{ marginTop: 24 }}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{t('admin.whCredits.excluded')}</h3>
        {isAdmin && (
          <div className="search-field" style={{ width: 280 }}>
            <div className="search-field__wrap">
              <input
                type="text"
                className="search-field__input"
                value={query}
                placeholder={t('admin.whCredits.addRegion')}
                autoComplete="off"
                onChange={(e) => setQuery(e.target.value)}
              />
            </div>
            {results.length > 0 && (
              <ul className="search-results" role="listbox">
                {results.map((r) => (
                  <li key={r.id} className="search-results__item" role="option" aria-selected={false}
                    onMouseDown={(e) => { e.preventDefault(); void add(r); }}>
                    <span>{r.name}</span>
                    <span className="search-results__class">{t(r.kspace ? 'admin.whCredits.kspace' : 'admin.whCredits.jspace')}</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '0 0 12px' }}>{t('admin.whCredits.excludedHint')}</p>
      {error && <div className={styles.pgError}>{error}</div>}
      {excluded === null ? <div className={styles.pgLoading}>…</div> : excluded.length === 0 ? (
        <div className={styles.pgEmpty}>{t('admin.whCredits.excludedEmpty')}</div>
      ) : (
        <table className={styles.mTable}>
          <thead><tr>
            <th>{t('admin.whCredits.colRegion')}</th><th>{t('admin.whCredits.colSpace')}</th>
            <th>{t('admin.whCredits.colAddedBy')}</th><th>{t('admin.whCredits.colSince')}</th>{isAdmin && <th />}
          </tr></thead>
          <tbody>
            {excluded.map((e) => (
              <tr key={e.regionId}>
                <td>{e.regionName || e.regionId}</td>
                <td><span className={styles.mPill}>{t(e.regionId < 11000000 ? 'admin.whCredits.kspace' : 'admin.whCredits.jspace')}</span></td>
                <td>{e.addedBy ?? '—'}</td>
                <td>{timeAgo(t, new Date(e.createdAt))}</td>
                {isAdmin && (
                  <td className={styles.mActions}>
                    <button type="button" className={`${styles.mAction} ${styles.mDanger}`} onClick={() => void remove(e)}>{t('admin.whCredits.removeRegion')}</button>
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  );
}
