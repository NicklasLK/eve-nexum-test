import { useCallback, useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { api, ApiError } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { charPortrait } from '../../utils/eveImages';
import { timeAgo, DASH } from '../../i18n/format';
import { XIcon } from '../../icons';
import { ConfirmModal } from './ConfirmModal';
import { Select } from './Select';
import styles from './AdminPage.module.css';

// Admin › Jump bridges and Admin › Bridge services: the shared data the fleet
// route planner draws on. Gates arrive from structure readers (an alt with
// Station Manager / Director in the owning corp) or a pasted list; services are
// standby titan / black ops / conduit pilots.

interface Reader { characterId: number; characterName: string; corpId: number | null; corpName: string; role: string; gatesFound: number; lastSyncAt: string | null; lastError: string | null; addedBy: string | null }
interface Bridge { id: number; fromSystemId: number; fromName: string | null; toSystemId: number; toName: string | null; name: string; ownerCorpId: number | null; ownerCorpName: string | null; source: 'esi' | 'manual'; active: boolean; missedSyncs: number; lastSeenAt: string | null; addedBy: string | null; personal: boolean }
interface BridgesResp { shared: Bridge[]; personal: Bridge[]; canManageShared: boolean }
interface BulkResult { added: number; skipped: number; errors: { line: number; text: string; reason: string }[] }

const ROLE_LABEL: Record<string, string> = { Director: 'Director', Station_Manager: 'Station Manager' };

export function JumpBridgesTab() {
  const { t } = useTranslation();
  const [readers, setReaders] = useState<Reader[] | null>(null);
  const [bridges, setBridges] = useState<Bridge[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState('');
  const [syncing, setSyncing] = useState(false);
  const [paste, setPaste] = useState(false);
  const [confirm, setConfirm] = useState<{ message: string; run: () => Promise<void> } | null>(null);

  const load = useCallback(async () => {
    try {
      const [r, b] = await Promise.all([api<{ readers: Reader[] }>('/api/jump-bridges/readers'), api<BridgesResp>('/api/jump-bridges')]);
      setReaders(r.readers); setBridges(b.shared); setError(null);
    } catch { setError(t('fleetRoutes.admin.loadFailed')); }
  }, [t]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  // Back from the structure-reader SSO round trip: toast once, strip the params.
  useEffect(() => {
    const params = new URLSearchParams(window.location.search);
    const ok = params.get('reader') === 'connected', err = params.get('reader_error');
    if (!ok && !err) return;
    const url = new URL(window.location.href);
    url.searchParams.delete('reader'); url.searchParams.delete('reader_error');
    window.history.replaceState({}, '', url.toString());
    if (ok) toast.success(t('fleetRoutes.admin.readerConnected'));
    else toast.error(t('fleetRoutes.admin.readerError', { error: err }));
  }, [t]);

  const syncNow = async () => {
    setSyncing(true);
    try {
      const r = await api<{ results: { characterName: string; ok: boolean; gates: number; error?: string }[] }>('/api/jump-bridges/readers/sync', { method: 'POST' });
      const failed = r.results.filter((x) => !x.ok);
      if (failed.length) toast.error(t('fleetRoutes.admin.syncFailed', { name: failed[0].characterName, error: failed[0].error ?? '' }));
      else toast.success(t('fleetRoutes.admin.synced', { gates: r.results.reduce((n, x) => n + x.gates, 0) }));
      await load();
    } catch { toast.error(t('fleetRoutes.admin.loadFailed')); }
    finally { setSyncing(false); }
  };

  const disconnect = (r: Reader) => setConfirm({
    message: t('fleetRoutes.admin.confirmDisconnect', { name: r.characterName }),
    run: async () => { await api(`/api/jump-bridges/readers/${r.characterId}`, { method: 'DELETE' }); await load(); },
  });
  const setActive = async (b: Bridge, active: boolean) => {
    await api(`/api/jump-bridges/${b.id}`, { method: 'PATCH', body: JSON.stringify({ active }) }).catch(() => toast.error(t('fleetRoutes.saveFailed')));
    await load();
  };
  const remove = (b: Bridge) => setConfirm({
    message: t('fleetRoutes.admin.confirmDelete', { route: `${b.fromName} ⟷ ${b.toName}` }),
    run: async () => { await api(`/api/jump-bridges/${b.id}`, { method: 'DELETE' }); await load(); },
  });

  const q = filter.trim().toLowerCase();
  const shown = (bridges ?? []).filter((b) => !q || [b.fromName, b.toName, b.name, b.ownerCorpName].some((s) => s?.toLowerCase().includes(q)));
  const usable = (b: Bridge) => b.active && b.missedSyncs < 2;
  const nActive = (bridges ?? []).filter(usable).length, nInactive = (bridges ?? []).length - nActive;

  return (
    <>
      <h2 className={styles.pgSectionTitle}>{t('fleetRoutes.admin.bridgesTitle')}</h2>
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '0 0 12px' }}>{t('fleetRoutes.admin.bridgesIntro')}</p>
      {error && <div className={styles.pgError}>{error}</div>}

      <div className={styles.pgSectionBar}>
        <h3 style={{ margin: 0, fontSize: 13 }}>{t('fleetRoutes.admin.readers')}</h3>
        <div className={styles.mActions}>
          <button type="button" className="btn btn--ghost btn--sm" disabled={syncing || !readers?.length} onClick={syncNow}>{syncing ? t('fleetRoutes.admin.syncing') : t('fleetRoutes.admin.syncNow')}</button>
          <a className="btn btn--primary btn--sm" href="/auth/structure-reader">{t('fleetRoutes.admin.connectReader')}</a>
        </div>
      </div>
      {readers === null ? <div className={styles.pgLoading}>…</div> : readers.length === 0 ? (
        <div className={styles.pgEmpty}>{t('fleetRoutes.admin.noReaders')}</div>
      ) : (
        <table className={styles.mTable}>
          <thead><tr>
            <th>{t('fleetRoutes.admin.colCharacter')}</th><th>{t('fleetRoutes.admin.colCorp')}</th><th>{t('fleetRoutes.admin.colRole')}</th>
            <th>{t('fleetRoutes.admin.colGates')}</th><th>{t('fleetRoutes.admin.colLastSync')}</th><th>{t('fleetRoutes.admin.colStatus')}</th><th />
          </tr></thead>
          <tbody>
            {readers.map((r) => (
              <tr key={r.characterId}>
                <td className={styles.mNameCell}><img className={styles.mAvatar} src={charPortrait(r.characterId, 32)} alt="" /> {r.characterName || r.characterId}</td>
                <td>{r.corpName || (r.corpId ?? DASH)}</td>
                <td>{ROLE_LABEL[r.role] ?? (r.role || DASH)}</td>
                <td className={styles.mNum}>{r.gatesFound}</td>
                <td>{r.lastSyncAt ? timeAgo(t, new Date(r.lastSyncAt)) : t('fleetRoutes.admin.never')}</td>
                <td>
                  {r.lastError
                    ? <span className={`${styles.mPill} ${styles.mPillBlocked}`} title={r.lastError}>{t('fleetRoutes.admin.statusError')}</span>
                    : r.lastSyncAt
                      ? <span className={`${styles.mPill} ${styles.mPillOk}`}>OK</span>
                      : <span className={styles.mPill}>{t('fleetRoutes.admin.statusPending')}</span>}
                  {r.lastError && <div style={{ fontSize: 11, color: 'var(--danger-soft)', maxWidth: 260 }}>{r.lastError}</div>}
                </td>
                <td className={styles.mActions}><button type="button" className={`${styles.mAction} ${styles.mDanger}`} onClick={() => disconnect(r)}>{t('fleetRoutes.admin.disconnect')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '8px 0 16px' }}>{t('fleetRoutes.admin.readersHint')}</p>

      <div className={styles.pgSectionBar}>
        <h3 style={{ margin: 0, fontSize: 13 }}>
          {t('fleetRoutes.admin.bridges')} <span style={{ color: 'var(--text-subtle)', fontWeight: 400 }}>· {t('fleetRoutes.admin.nActive', { count: nActive })} · {t('fleetRoutes.admin.nInactive', { count: nInactive })}</span>
        </h3>
        <div className={styles.mActions}>
          <input className="chains-new__name" style={{ width: 220 }} placeholder={t('fleetRoutes.admin.filter')} value={filter} onChange={(e) => setFilter(e.target.value)} />
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setPaste(true)}>{t('fleetRoutes.admin.pasteList')}</button>
        </div>
      </div>
      {bridges === null ? <div className={styles.pgLoading}>…</div> : shown.length === 0 ? (
        <div className={styles.pgEmpty}>{t('fleetRoutes.admin.noBridges')}</div>
      ) : (
        <table className={styles.mTable}>
          <thead><tr>
            <th>{t('fleetRoutes.admin.colGate')}</th><th>{t('fleetRoutes.admin.colRoute')}</th><th>{t('fleetRoutes.admin.colOwner')}</th>
            <th>{t('fleetRoutes.admin.colSource')}</th><th>{t('fleetRoutes.admin.colLastSeen')}</th><th>{t('fleetRoutes.admin.colActive')}</th><th />
          </tr></thead>
          <tbody>
            {shown.map((b) => (
              <tr key={b.id} style={{ opacity: usable(b) ? 1 : 0.6 }}>
                <td>{b.name || DASH}</td>
                <td className={styles.mMono}>{b.fromName ?? b.fromSystemId} ⟷ {b.toName ?? b.toSystemId}</td>
                <td>{b.ownerCorpName ?? (b.ownerCorpId ?? DASH)}</td>
                <td><span className={styles.mPill} style={b.source === 'esi' ? { color: 'var(--accent-light)', borderColor: 'var(--border-accent)' } : undefined}>{b.source === 'esi' ? 'ESI' : t('fleetRoutes.admin.manual')}</span></td>
                <td>
                  {b.source === 'esi'
                    ? (b.lastSeenAt ? timeAgo(t, new Date(b.lastSeenAt)) : DASH)
                    : t('fleetRoutes.admin.addedBy', { name: b.addedBy ?? DASH })}
                  {b.missedSyncs >= 2 && <div style={{ fontSize: 11, color: '#f0a030' }}>{t('fleetRoutes.admin.missingFromEsi')}</div>}
                </td>
                <td><input type="checkbox" checked={b.active} onChange={(e) => setActive(b, e.target.checked)} aria-label={t('fleetRoutes.admin.colActive')} /></td>
                <td className={styles.mActions}>
                  {b.source === 'manual'
                    ? <button type="button" className={`${styles.mAction} ${styles.mDanger}`} onClick={() => remove(b)}>{t('actions.delete')}</button>
                    : <button type="button" className={styles.mAction} onClick={() => setActive(b, !b.active)}>{b.active ? t('fleetRoutes.admin.deactivate') : t('fleetRoutes.admin.reactivate')}</button>}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '8px 0 0' }}>{t('fleetRoutes.admin.pasteHint')}</p>

      {paste && <PasteModal onClose={() => setPaste(false)} onDone={() => { setPaste(false); void load(); }} />}
      {confirm && (
        <ConfirmModal message={confirm.message} showDontAskAgain={false}
          onConfirm={() => { const run = confirm.run; setConfirm(null); void run().catch(() => toast.error(t('fleetRoutes.saveFailed'))); }}
          onCancel={() => setConfirm(null)} />
      )}
    </>
  );
}

function PasteModal({ onClose, onDone }: { onClose: () => void; onDone: () => void }) {
  const { t } = useTranslation();
  const [text, setText] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<BulkResult | null>(null);
  const run = async () => {
    setBusy(true);
    try {
      const r = await api<BulkResult>('/api/jump-bridges/bulk', { method: 'POST', body: JSON.stringify({ text, scope: 'shared' }) });
      setResult(r);
      if (r.added > 0) toast.success(t('fleetRoutes.admin.imported', { added: r.added, skipped: r.skipped }));
      if (r.errors.length === 0) onDone();
    } catch (err) { toast.error(err instanceof ApiError && err.code ? err.code : t('fleetRoutes.saveFailed')); }
    finally { setBusy(false); }
  };
  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" style={{ width: 'min(640px, 94vw)' }} role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('fleetRoutes.admin.pasteTitle')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}><XIcon size={16} weight="bold" /></button>
        </div>
        <div className="modal__body" style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
          <div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('fleetRoutes.admin.pasteBody')}</div>
          <textarea className="chains-new__name" rows={10} style={{ width: '100%', fontFamily: 'ui-monospace, monospace', fontSize: 12, resize: 'vertical' }}
            value={text} onChange={(e) => setText(e.target.value)} placeholder={'X-7OMU » 5ZXX-K - Dreddit JB\nVFK-IV <> 3V8-LJ\nF7C-H0 9-VO0Q'} />
          {result && result.errors.length > 0 && (
            <div style={{ fontSize: 12, color: 'var(--danger-soft)', maxHeight: 140, overflowY: 'auto' }}>
              <div>{t('fleetRoutes.admin.lineErrors', { count: result.errors.length })}</div>
              {result.errors.map((e) => <div key={e.line} className={styles.mMono}>{e.line}: {e.text} — {e.reason}</div>)}
            </div>
          )}
          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose}>{t('actions.close')}</button>
            <button type="button" className="btn btn--primary" disabled={busy || !text.trim()} onClick={run}>{busy ? '…' : t('fleetRoutes.admin.import')}</button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

// ── Bridge services ──────────────────────────────────────────────────────────

type Kind = 'titan' | 'blops' | 'conduit';
interface Service { id: number; systemId: number; systemName: string | null; security: number | null; regionName: string | null; kind: Kind; rangeLy: number; name: string; active: boolean; addedBy: string | null; personal: boolean }
interface ServicesResp { shared: Service[]; personal: Service[]; defaults: Record<Kind, number> }

const KIND_COLOR: Record<Kind, { color: string; border: string }> = {
  titan: { color: '#f5b96a', border: '#5a4020' }, blops: { color: '#4db8c4', border: '#1e4a50' }, conduit: { color: 'var(--accent-light)', border: 'var(--border-accent)' },
};

export function BridgeServicesTab() {
  const { t } = useTranslation();
  const [data, setData] = useState<ServicesResp | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [system, setSystem] = useState(''); const [kind, setKind] = useState<Kind>('titan'); const [range, setRange] = useState(''); const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [confirm, setConfirm] = useState<Service | null>(null);

  const load = useCallback(async () => {
    try { setData(await api<ServicesResp>('/api/bridge-services')); setError(null); }
    catch { setError(t('fleetRoutes.admin.loadFailed')); }
  }, [t]);
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { void load(); }, [load]);

  const add = async () => {
    if (!system.trim()) return;
    setBusy(true);
    try {
      await api('/api/bridge-services', { method: 'POST', body: JSON.stringify({ system: system.trim(), kind, rangeLy: range.trim() || null, name: name.trim(), scope: 'shared' }) });
      setSystem(''); setRange(''); setName(''); await load();
    } catch (err) { toast.error(err instanceof ApiError && err.code ? err.code : t('fleetRoutes.saveFailed')); }
    finally { setBusy(false); }
  };
  const setActive = async (s: Service, active: boolean) => {
    await api(`/api/bridge-services/${s.id}`, { method: 'PATCH', body: JSON.stringify({ active }) }).catch(() => toast.error(t('fleetRoutes.saveFailed')));
    await load();
  };
  const kindLabel = (k: Kind) => t(`fleetRoutes.kind.${k}`);
  const defaults = data?.defaults ?? { titan: 6, blops: 8, conduit: 7 };

  return (
    <>
      <h2 className={styles.pgSectionTitle}>{t('fleetRoutes.admin.servicesTitle')}</h2>
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '0 0 12px' }}>{t('fleetRoutes.admin.servicesIntro')}</p>
      {error && <div className={styles.pgError}>{error}</div>}

      <div style={{ display: 'flex', alignItems: 'flex-end', gap: 10, padding: 12, background: 'var(--surface-well)', border: '1px solid var(--border)', borderRadius: 6, flexWrap: 'wrap', marginBottom: 14 }}>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 200, fontSize: 12, color: 'var(--text-subtle)' }}>
          {t('fleetRoutes.admin.system')}
          <input className="chains-new__name" value={system} onChange={(e) => setSystem(e.target.value)} placeholder={t('fleetRoutes.systemLowNull')} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-subtle)' }}>
          {t('fleetRoutes.admin.service')}
          <Select value={kind} onChange={setKind} ariaLabel={t('fleetRoutes.admin.service')}
            options={(['titan', 'blops', 'conduit'] as Kind[]).map((k) => ({ value: k, label: `${kindLabel(k)} · ${defaults[k]} ly` }))} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, width: 90, fontSize: 12, color: 'var(--text-subtle)' }}>
          {t('fleetRoutes.admin.range')}
          <input className="chains-new__name" type="number" step={0.1} min={0.1} max={20} value={range} onChange={(e) => setRange(e.target.value)} placeholder={String(defaults[kind])} />
        </label>
        <label style={{ display: 'flex', flexDirection: 'column', gap: 4, flex: 1, minWidth: 160, fontSize: 12, color: 'var(--text-subtle)' }}>
          {t('fleetRoutes.admin.notes')}
          <input className="chains-new__name" value={name} onChange={(e) => setName(e.target.value)} placeholder={t('fleetRoutes.admin.notesPlaceholder')} />
        </label>
        <button type="button" className="btn btn--primary" disabled={busy || !system.trim()} onClick={add}>{t('fleetRoutes.admin.addService')}</button>
      </div>

      {data === null ? <div className={styles.pgLoading}>…</div> : data.shared.length === 0 ? (
        <div className={styles.pgEmpty}>{t('fleetRoutes.admin.noServices')}</div>
      ) : (
        <table className={styles.mTable}>
          <thead><tr>
            <th>{t('fleetRoutes.admin.colSystem')}</th><th>{t('fleetRoutes.admin.colService')}</th><th>{t('fleetRoutes.admin.colRange')}</th>
            <th>{t('fleetRoutes.admin.colNotes')}</th><th>{t('fleetRoutes.admin.colAddedBy')}</th><th>{t('fleetRoutes.admin.colActive')}</th><th />
          </tr></thead>
          <tbody>
            {data.shared.map((s) => (
              <tr key={s.id} style={{ opacity: s.active ? 1 : 0.6 }}>
                <td>{s.systemName ?? s.systemId} <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{s.regionName ?? ''}{s.security != null ? ` · ${s.security.toFixed(1)}` : ''}</span></td>
                <td><span className={styles.mPill} style={{ color: KIND_COLOR[s.kind].color, borderColor: KIND_COLOR[s.kind].border }}>{kindLabel(s.kind)}</span></td>
                <td className={styles.mNum}>{s.rangeLy.toFixed(1)} ly</td>
                <td>{s.name || DASH}</td>
                <td>{s.addedBy ?? DASH}</td>
                <td><input type="checkbox" checked={s.active} onChange={(e) => setActive(s, e.target.checked)} aria-label={t('fleetRoutes.admin.colActive')} /></td>
                <td className={styles.mActions}><button type="button" className={`${styles.mAction} ${styles.mDanger}`} onClick={() => setConfirm(s)}>{t('actions.delete')}</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className={styles.pgEmpty} style={{ textAlign: 'left', padding: '8px 0 0' }}>{t('fleetRoutes.admin.servicesHint')}</p>

      {confirm && (
        <ConfirmModal message={t('fleetRoutes.admin.confirmDeleteService', { system: confirm.systemName ?? confirm.systemId })} showDontAskAgain={false}
          onConfirm={() => { const s = confirm; setConfirm(null); void api(`/api/bridge-services/${s.id}`, { method: 'DELETE' }).then(load).catch(() => toast.error(t('fleetRoutes.saveFailed'))); }}
          onCancel={() => setConfirm(null)} />
      )}
    </>
  );
}
