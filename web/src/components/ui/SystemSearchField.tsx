import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { useEsiSearch, systemResultLabel, type SystemSearchResult } from '../../hooks/useEsiSearch';

export type PickedSystem = { id: number; name: string } | null;

// Solar-system search field: a labelled input with the shared search-results
// dropdown; once a system is picked it shows as a chip with an X to change it.
// `filter` narrows the results (e.g. lowNullFilter for bridge services).
export function SystemSearchField({ label, value, onPick, filter, placeholder, compact }: {
  label?: string;
  value: PickedSystem;
  onPick: (v: PickedSystem) => void;
  filter?: (r: SystemSearchResult) => boolean;
  placeholder?: string;
  /** Tighter chip for inline forms. */
  compact?: boolean;
}) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  const shown = filter ? results.filter(filter) : results;
  const show = query.trim().length >= 2 && (shown.length > 0 || loading);
  return (
    <div style={{ position: 'relative' }}>
      {label && <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 3 }}>{label}</div>}
      {value ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: compact ? '3px 6px' : '5px 8px', minHeight: compact ? 32 : undefined, boxSizing: 'border-box' }}>
          <strong>{value.name}</strong>
          <button type="button" className="icon-btn" onClick={() => onPick(null)} title={t('jumpPlanner.change')}><XIcon size={12} /></button>
        </div>
      ) : (
        <input className="chains-new__name" style={{ width: '100%' }} type="text" value={query}
          placeholder={placeholder ?? t('jumpPlanner.searchSystem')} onChange={(e) => setQuery(e.target.value)} />
      )}
      {!value && show && (
        <ul className="search-results">
          {loading && <li className="search-results__item" style={{ cursor: 'default', opacity: 0.6 }}>{t('jumpPlanner.searching')}</li>}
          {shown.map((r) => (
            <li key={r.id} className="search-results__item" role="option"
              onMouseDown={(e) => { e.preventDefault(); onPick({ id: r.id, name: r.name }); setQuery(''); }}>
              <span>{r.name}</span>
              <span className="search-results__class">{systemResultLabel(r)}</span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
