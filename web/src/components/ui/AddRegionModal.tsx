import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { api } from '../../api/client';
import { useMapStore } from '../../store/mapStore';
import { toast } from '../../utils/toastStore';

interface Region {
  id: number;
  name: string;
  systemCount: number;
  positionedCount: number;
}

const MAX_REGION_RESULTS = 8;

// "Add region" modal: appends a whole K-space region to the ACTIVE map
// (POST /api/maps/:id/seed-region). Systems already on the map are skipped and
// the regional gates to them are drawn, so seeding neighbouring regions one
// after another builds a connected multi-region map. Mirrors the region search
// in CreateMapModal.
export function AddRegionModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const mapId     = useMapStore((s) => s.activeMapId);
  const mapName   = useMapStore((s) => s.map.name);
  const switchMap = useMapStore((s) => s.switchMap);

  const [regions, setRegions] = useState<Region[]>([]);
  const [query, setQuery]     = useState('');
  const [region, setRegion]   = useState<Region | null>(null);
  const [busy, setBusy]       = useState(false);
  const [error, setError]     = useState<string | null>(null);

  // Load the region list once (K-space only, from the server).
  useEffect(() => {
    api<{ regions: Region[] }>('/api/regions')
      .then((r) => setRegions(r.regions))
      .catch(() => setError(t('addRegion.loadFailed')));
  }, [t]);

  // Type-to-filter results, hidden once a region is chosen.
  const results = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q || region) return [];
    return regions.filter((r) => r.name.toLowerCase().includes(q)).slice(0, MAX_REGION_RESULTS);
  }, [query, region, regions]);

  function selectRegion(r: Region) { setRegion(r); setQuery(r.name); }
  function clearRegion()           { setRegion(null); setQuery(''); }

  const canSubmit = !busy && !!mapId && !!region;

  async function submit() {
    if (!canSubmit || !mapId || !region) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api<{ systems: number; connections: number; skipped: number; region: string }>(
        `/api/maps/${mapId}/seed-region`,
        { method: 'POST', body: JSON.stringify({ regionId: region.id }) },
      );
      // Bulk change: re-fetch the map authoritatively (other viewers get a
      // map.resync from the server), then re-route connection handles and fit
      // the enlarged canvas into view once the new nodes have mounted.
      await switchMap(mapId);
      setTimeout(() => {
        const s = useMapStore.getState();
        s.optimizeConnections();
        s.requestFitView();
      }, 500);
      toast.success(r.systems === 0
        ? t('addRegion.nothingNew', { region: r.region })
        : t('addRegion.added', { systems: r.systems, connections: r.connections, region: r.region }));
      onClose();
    } catch (e) {
      setError(e instanceof Error ? e.message : t('addRegion.failed'));
    } finally {
      setBusy(false);
    }
  }

  return createPortal(
    <div className="modal-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className="modal" role="dialog" aria-modal="true">
        <div className="modal__header">
          <h2 className="modal__title">{t('addRegion.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}>
            <XIcon size={16} weight="bold" />
          </button>
        </div>

        <div className="modal__body">
          <div className="field">
            <span>{t('addRegion.regionLabel')}</span>
            <div className="search-field">
              <div className="search-field__wrap">
                <input
                  type="text"
                  className={`search-field__input${region ? ' search-field__input--selected' : ''}`}
                  value={query}
                  placeholder={t('addRegion.regionPlaceholder')}
                  autoComplete="off"
                  autoFocus
                  readOnly={!!region}
                  onChange={(e) => setQuery(e.target.value)}
                />
                {region && (
                  <button type="button" className="search-field__clear" onClick={clearRegion} aria-label={t('addRegion.clearRegion')}>
                    ✕
                  </button>
                )}
              </div>
              {results.length > 0 && (
                <ul className="search-results" role="listbox">
                  {results.map((r) => (
                    <li
                      key={r.id}
                      className="search-results__item"
                      role="option"
                      aria-selected={false}
                      onMouseDown={(e) => { e.preventDefault(); selectRegion(r); }}
                    >
                      <span>{r.name}</span>
                      <span className="search-results__class">{t('units.systems', { count: r.systemCount })}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {region && (
            <div className="map-sidebar__hint">
              {t('addRegion.hint', { count: region.systemCount, region: region.name, map: mapName })}
            </div>
          )}
          {error && <div className="map-sidebar__hint map-sidebar__hint--error">{error}</div>}

          <div className="modal__actions">
            <button type="button" className="btn btn--ghost" onClick={onClose} disabled={busy}>{t('actions.cancel')}</button>
            <button type="button" className="btn btn--primary" onClick={submit} disabled={!canSubmit}>
              {busy ? t('addRegion.adding') : t('addRegion.add')}
            </button>
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
