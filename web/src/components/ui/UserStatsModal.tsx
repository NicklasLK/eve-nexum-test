import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { XIcon } from '../../icons';
import { useStats, creditsInPeriod, type StatPeriod, type SigBreakdown, type BucketUnit, type WhCredit } from '../../hooks/useStats';

const SPARK_VB_W = 600;
const SPARK_VB_H = 80;
const SPARK_PAD  = { top: 6, right: 6, bottom: 18, left: 28 };
const SPARK_COLOR = '#6ea0ff';

function SigSparkline({ values, unit }: { values: number[]; unit: BucketUnit }) {
  const { t } = useTranslation();
  const n      = values.length;
  const iw     = SPARK_VB_W - SPARK_PAD.left - SPARK_PAD.right;
  const ih     = SPARK_VB_H - SPARK_PAD.top  - SPARK_PAD.bottom;
  const maxVal = Math.max(...values, 1);
  const xOf    = (i: number) => SPARK_PAD.left + (n <= 1 ? iw / 2 : (i / (n - 1)) * iw);
  const yOf    = (v: number) => SPARK_PAD.top  + ih - (v / maxVal) * ih;

  const [hover, setHover] = useState<{ index: number; value: number } | null>(null);

  const polyline = values.map((v, i) => `${xOf(i).toFixed(1)},${yOf(v).toFixed(1)}`).join(' ');
  const areaPath = n > 0
    ? `M${xOf(0).toFixed(1)},${(SPARK_PAD.top + ih).toFixed(1)} L${polyline} L${xOf(n - 1).toFixed(1)},${(SPARK_PAD.top + ih).toFixed(1)} Z`
    : '';

  // Y ticks: 0, mid, max
  const yTicks = [...new Set([0, Math.round(maxVal / 2), maxVal])];
  // Relative label for a bucket, given how many buckets back from the current
  // one it sits (0 = current). Wording follows the series granularity.
  const relLabel = (back: number): string => {
    if (unit === 'hour')  return back === 0 ? t('time.now')       : t('time.hoursAgo',  { value: back });
    if (unit === 'month') return back === 0 ? t('time.thisMonth') : t('time.monthsAgo', { value: back });
    return                       back === 0 ? t('time.today')     : t('time.daysAgo',   { value: back });
  };

  // X ticks: oldest bucket (left) and current bucket (right).
  const xLabels: { x: number; label: string }[] = n > 0 ? [
    { x: xOf(0),     label: relLabel(n - 1) },
    { x: xOf(n - 1), label: relLabel(0) },
  ] : [];

  return (
    <div className="stats-modal__spark">
      <svg
        className="stats-modal__spark-svg"
        viewBox={`0 0 ${SPARK_VB_W} ${SPARK_VB_H}`}
        preserveAspectRatio="none"
        onMouseLeave={() => setHover(null)}
      >
        {/* Grid lines + Y labels */}
        {yTicks.map((v) => (
          <g key={`tick-${v}`}>
            <line
              x1={SPARK_PAD.left} y1={yOf(v)} x2={SPARK_PAD.left + iw} y2={yOf(v)}
              stroke="#1a2535" strokeWidth={0.5}
            />
            <text x={SPARK_PAD.left - 4} y={yOf(v) + 3} textAnchor="end" fontSize={10} fill="#7a90a8">
              {v}
            </text>
          </g>
        ))}

        {n > 0 && (
          <>
            <path d={areaPath} fill={SPARK_COLOR} opacity={0.12} />
            <polyline points={polyline} fill="none" stroke={SPARK_COLOR} strokeWidth={1.5} />
          </>
        )}

        {hover && (
          <line
            x1={xOf(hover.index)} y1={SPARK_PAD.top}
            x2={xOf(hover.index)} y2={SPARK_PAD.top + ih}
            stroke={SPARK_COLOR} strokeWidth={0.8} opacity={0.4}
          />
        )}

        {values.map((v, i) => {
          const cx = xOf(i);
          const cy = yOf(v);
          const isActive = hover?.index === i;
          return (
            <g key={`pt-${i}`}>
              <circle cx={cx} cy={cy} r={isActive ? 3 : 1.8}
                fill={SPARK_COLOR} stroke="#08090f" strokeWidth={0.6}
                pointerEvents="none" />
              <circle cx={cx} cy={cy} r={9}
                fill="transparent"
                onMouseEnter={() => setHover({ index: i, value: v })}
              />
            </g>
          );
        })}

        {xLabels.map((t) => (
          <text key={t.label} x={t.x} y={SPARK_VB_H - 4}
            textAnchor="middle" fontSize={10} fill="#7a90a8">
            {t.label}
          </text>
        ))}
      </svg>
      {hover && (
        <div className="stats-modal__spark-tooltip">
          <strong>{hover.value.toLocaleString()}</strong> sigs · {relLabel(n - 1 - hover.index)}
        </div>
      )}
    </div>
  );
}

const PERIODS: { key: StatPeriod }[] = [
  { key: 'day' },
  { key: 'week' },
  { key: 'month' },
  { key: 'year' },
  { key: 'forever' },
];

const SIG_ROWS: { key: keyof SigBreakdown }[] = [
  { key: 'wormhole' },
  { key: 'data' },
  { key: 'relic' },
  { key: 'gas' },
  { key: 'ore' },
  { key: 'combat' },
  { key: 'ghost' },
];

interface Props { onClose: () => void; }

export function UserStatsModal({ onClose }: Props) {
  const { t, i18n } = useTranslation();
  const [period, setPeriod] = useState<StatPeriod>('day');
  const { stats, loading, error } = useStats(true);

  const current = stats?.[period];

  const periodLabels: Record<StatPeriod, string> = {
    day:     t('stats.period.day'),
    week:    t('stats.period.week'),
    month:   t('stats.period.month'),
    year:    t('stats.period.year'),
    forever: t('stats.period.forever'),
  };
  const sigLabels: Record<string, string> = {
    wormhole: t('sigType.wormhole'),
    data:     t('sigType.data'),
    relic:    t('sigType.relic'),
    gas:      t('sigType.gas'),
    ore:      t('sigType.ore'),
    combat:   t('sigType.combat'),
    ghost:    t('sigType.ghost'),
  };

  // The holes behind the Wormholes card, cut to the selected period the same
  // way the server cut the card (windows count back from generatedAt).
  const credited = stats?.credits ? creditsInPeriod(stats, period) : null;
  const fmtWhen  = (iso: string) => new Date(iso).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' });
  const sysLabel = (name: string | null, cls: string | null) => (
    <>{name ?? '?'}{cls && <span className="stats-modal__credit-class">{cls}</span>}</>
  );
  const creditNote = (c: WhCredit): string => {
    if (c.role === 'both') return t('stats.creditFull');
    const name = c.partnerName ?? t('stats.anotherPilot');
    return c.role === 'jumper' ? t('stats.creditHalfJumped', { name }) : t('stats.creditHalfTyped', { name });
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div className="modal stats-modal" onClick={(e) => e.stopPropagation()}>

        <div className="modal__header">
          <h2 className="modal__title">{t('stats.title')}</h2>
          <button className="icon-btn" onClick={onClose} aria-label={t('actions.close')}><XIcon size={16} weight="bold" /></button>
        </div>

        <div className="stats-modal__periods">
          {PERIODS.map((p) => (
            <button
              key={p.key}
              className={`stats-modal__period-btn${period === p.key ? ' stats-modal__period-btn--active' : ''}`}
              onClick={() => setPeriod(p.key)}
            >
              {periodLabels[p.key]}
            </button>
          ))}
        </div>

        <div className="modal__body">
          {loading && <div className="stats-modal__loading">{t('stats.loading')}</div>}
          {error   && <div className="stats-modal__error">{error}</div>}

          {current && (
            <>
              <div className="stats-modal__summary">
                <div className="stats-modal__card">
                  <span className="stats-modal__card-value">{current.jumps.toLocaleString()}</span>
                  <span className="stats-modal__card-label">{t('stats.jumps')}</span>
                </div>
                <div className="stats-modal__card">
                  <span className="stats-modal__card-value">{current.signatures.total.toLocaleString()}</span>
                  <span className="stats-modal__card-label">{t('stats.signatures')}</span>
                </div>
                <div className="stats-modal__card" title={t('stats.wormholesHint')}>
                  <span className="stats-modal__card-value">{Number.isInteger(current.wormholes) ? current.wormholes.toLocaleString() : current.wormholes.toFixed(1)}</span>
                  <span className="stats-modal__card-label">{t('stats.wormholes')}</span>
                </div>
              </div>

              {stats?.series[period] && stats.series[period].values.some((v) => v > 0) && (
                <>
                  <h3 className="stats-modal__section-title">{t('stats.activity')} — {periodLabels[period]}</h3>
                  <SigSparkline values={stats.series[period].values} unit={stats.series[period].unit} />
                </>
              )}

              <h3 className="stats-modal__section-title">{t('stats.byType')}</h3>
              <table className="stats-modal__table">
                <thead>
                  <tr className="stats-modal__head-row">
                    <th className="stats-modal__th stats-modal__th--type">{t('stats.type')}</th>
                    <th className="stats-modal__th stats-modal__th--count">{t('stats.count')}</th>
                    <th className="stats-modal__th stats-modal__th--pct">%</th>
                    <th className="stats-modal__th stats-modal__th--bar" />
                  </tr>
                </thead>
                <tbody>
                  {SIG_ROWS.map((r) => {
                    const count = current.signatures[r.key];
                    const pct   = current.signatures.total > 0
                      ? Math.round((count / current.signatures.total) * 100)
                      : 0;
                    return (
                      <tr key={r.key} className="stats-modal__row">
                        <td className="stats-modal__row-label">{sigLabels[r.key]}</td>
                        <td className="stats-modal__row-value">{count.toLocaleString()}</td>
                        <td className="stats-modal__row-pct">{pct}%</td>
                        <td className="stats-modal__row-bar">
                          <div className="stats-modal__bar-track">
                            <div className="stats-modal__bar" style={{ width: `${pct}%` }} />
                          </div>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>

              {credited && (
                <>
                  <h3 className="stats-modal__section-title" title={t('stats.wormholesHint')}>
                    {t('stats.creditedWormholes')} — {periodLabels[period]}
                  </h3>
                  {credited.rows.length === 0 ? (
                    <div className="stats-modal__empty">{t('stats.noCredits')}</div>
                  ) : (
                    <div className="stats-modal__credits">
                      <table className="stats-modal__table">
                        <thead>
                          <tr className="stats-modal__head-row">
                            <th className="stats-modal__th">{t('stats.when')}</th>
                            <th className="stats-modal__th">{t('stats.hole')}</th>
                            <th className="stats-modal__th">{t('stats.connection')}</th>
                            <th className="stats-modal__th stats-modal__th--count">{t('stats.credit')}</th>
                          </tr>
                        </thead>
                        <tbody>
                          {credited.rows.map((c) => (
                            <tr key={c.connectionId} className="stats-modal__row" title={c.mapName ?? undefined}>
                              <td className="stats-modal__credit-when">{fmtWhen(c.creditedAt)}</td>
                              <td className="stats-modal__credit-hole">{c.whType}</td>
                              <td className="stats-modal__credit-route">
                                {sysLabel(c.fromSystem, c.fromClass)} → {sysLabel(c.toSystem, c.toClass)}
                              </td>
                              <td className="stats-modal__credit-share">
                                {c.role === 'both' ? '1' : '½'}
                                <span className="stats-modal__credit-note">{creditNote(c)}</span>
                              </td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    </div>
                  )}
                  {credited.incomplete && (
                    <div className="stats-modal__note">{t('stats.creditsTruncated', { n: credited.listed })}</div>
                  )}
                </>
              )}
            </>
          )}
        </div>

      </div>
    </div>
  );
}
