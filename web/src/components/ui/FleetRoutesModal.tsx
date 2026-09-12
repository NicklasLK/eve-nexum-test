import { Fragment, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { XIcon } from '../../icons';
import { Select } from './Select';
import { api } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { useEsiSearch, systemResultLabel } from '../../hooks/useEsiSearch';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useAuth } from '../../context/AuthContext';
import { truesecColor } from '../../utils/truesec';

// Fleet Routes. Plans several diverse routes between two systems across
// stargates, the alliance's Ansiblex bridges, wormholes on the maps you can
// see, Thera / Turnur, and standby capital bridges — then pushes the chosen
// route to the in-game autopilot (only the hops the autopilot can't work out
// itself become waypoints). Options persist per user under nexum.fleetRoutes.*.

type Level = 0 | 1 | 2;
type Method = 'stargate' | 'jump_bridge' | 'wormhole' | 'titan_bridge' | 'blops_bridge' | 'carrier_conduit';
type ShipClass = 'frigate' | 'destroyer' | 'cruiser' | 'battlecruiser' | 'battleship' | 'capital';
interface Options {
  useStargates: boolean; useJumpBridges: boolean; useWormholes: boolean; includeThera: boolean; includeTurnur: boolean;
  useTitanBridge: boolean; useBlopsBridge: boolean; useCarrierConduit: boolean;
  avoidHighsec: Level; avoidLowsec: Level; avoidNullsec: Level; avoidWhSpace: Level;
  minBridgeRange: number; maxBridges: number;
}
const DEFAULT_OPTIONS: Options = {
  useStargates: true, useJumpBridges: true, useWormholes: true, includeThera: true, includeTurnur: true,
  useTitanBridge: false, useBlopsBridge: false, useCarrierConduit: false,
  avoidHighsec: 0, avoidLowsec: 0, avoidNullsec: 0, avoidWhSpace: 0,
  minBridgeRange: 3, maxBridges: 2,
};
// Stable default reference: useUserSetting caches whatever default it first
// sees, so an inline {} would be a fresh object per render.
const NO_OPTIONS: Partial<Options> = {};
const SHIP_CLASSES: { key: ShipClass; mass: string }[] = [
  { key: 'frigate', mass: '1.2M' }, { key: 'destroyer', mass: '1.8M' }, { key: 'cruiser', mass: '12M' },
  { key: 'battlecruiser', mass: '15M' }, { key: 'battleship', mass: '100M' }, { key: 'capital', mass: '1.2B' },
];

interface SysRef { id: number; name: string; security: number }
interface Segment {
  from: SysRef; to: SysRef; method: Method; distanceLy?: number; name?: string;
  whType?: string | null; massStatus?: 'stable' | 'reduced' | 'critical' | null; timeStatus?: 'stable' | 'eol' | null;
  maxShipSize?: string | null; maxJumpMassKg?: number; maxStableMassKg?: number; remainingHours?: number; scout?: boolean;
  capacity?: Record<ShipClass, { perJump: boolean; totalPasses: number }>;
}
interface Route {
  id: number; categories: string[]; totalJumps: number;
  securitySummary: { highsec: number; lowsec: number; nullsec: number; wh: number };
  bottleneck: { description: string; maxShipClass: ShipClass | null } | null;
  segments: Segment[]; systems: (SysRef & { wspace: boolean })[]; warnings: string[]; fatigueMinutes?: number;
}
interface PlanResp {
  from: { id: number; name: string }; to: { id: number; name: string }; routes: Route[];
  coords: Record<number, { x: number; y: number }>;
  sources: { scoutHoles: number; wormholes: number; bridges: number; services: number; capitalEdges: number };
}
type Picked = { id: number; name: string } | null;

const CAPITAL = new Set<Method>(['titan_bridge', 'blops_bridge', 'carrier_conduit']);
const METHOD_COLOR: Record<Method, string> = {
  stargate: '#56b4e9', jump_bridge: 'var(--accent)', wormhole: '#b06ad0',
  titan_bridge: '#f5b96a', blops_bridge: '#4db8c4', carrier_conduit: '#7ab4f0',
};

export function FleetRoutesModal({ onClose }: { onClose: () => void }) {
  const { t } = useTranslation();
  const { user } = useAuth();
  const [from, setFrom] = useState<Picked>(() => (user?.lastKnownSystem?.name ? { id: user.lastKnownSystem.id, name: user.lastKnownSystem.name } : null));
  const [to, setTo]     = useState<Picked>(null);
  const [saved, setSaved] = useUserSetting<Partial<Options>>('nexum.fleetRoutes.options', NO_OPTIONS);
  const [shipClass, setShipClass] = useUserSetting<ShipClass>('nexum.fleetRoutes.shipClass', 'battleship');
  const opts: Options = useMemo(() => ({ ...DEFAULT_OPTIONS, ...saved }), [saved]);
  const set = <K extends keyof Options>(k: K, v: Options[K]) => setSaved({ ...opts, [k]: v });
  const [result, setResult] = useState<PlanResp | null>(null);
  const [selected, setSelected] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [drawer, setDrawer] = useState(false);
  const [sending, setSending] = useState(false);

  const plan = async () => {
    if (!from || !to) return;
    setLoading(true); setError(null);
    try {
      const r = await api<PlanResp>('/api/fleet-routes', { method: 'POST', body: JSON.stringify({ from: from.id, to: to.id, options: opts, maxRoutes: 6 }) });
      setResult(r); setSelected(0);
      if (!r.routes.length) setError(t('fleetRoutes.errNoRoute'));
    } catch { setError(t('fleetRoutes.errFailed')); }
    finally { setLoading(false); }
  };

  const sendToAutopilot = async (route: Route) => {
    setSending(true);
    try {
      const r = await api<{ ok: boolean; set: number; total: number }>('/api/fleet-routes/waypoints', { method: 'POST', body: JSON.stringify({ segments: route.segments }) });
      if (r.ok) toast.success(t('fleetRoutes.autopilotSet', { count: r.total }));
      else toast.error(t('fleetRoutes.autopilotPartial', { set: r.set, total: r.total }));
    } catch { toast.error(t('routeToast.failed')); }
    finally { setSending(false); }
  };

  const route = result?.routes[selected] ?? null;
  const cls = SHIP_CLASSES.find((c) => c.key === shipClass) ?? SHIP_CLASSES[4];

  return createPortal(
    <div className="modal-overlay" onClick={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="modal" style={{ maxWidth: 'min(1120px, 96vw)', width: '96vw', maxHeight: '92vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal__header">
          <h2 className="modal__title">{t('fleetRoutes.title')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('fleetRoutes.subtitle')}</span>
            <button className="icon-btn" onClick={onClose} title={t('actions.close')}><XIcon size={14} weight="bold" /></button>
          </div>
        </div>
        <div className="modal__body" style={{ display: 'flex', gap: 16, overflow: 'auto', minHeight: 0, flex: 1 }}>
          {/* Options column */}
          <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SystemField label={t('fleetRoutes.from')} value={from} onPick={setFrom} />
            <SystemField label={t('fleetRoutes.to')} value={to} onPick={setTo} />

            <Section title={t('fleetRoutes.travelBy')}>
              <Check label={t('fleetRoutes.stargates')} checked={opts.useStargates} onChange={(v) => set('useStargates', v)} />
              <Check label={t('fleetRoutes.jumpBridges')} checked={opts.useJumpBridges} onChange={(v) => set('useJumpBridges', v)} />
              <Check label={t('fleetRoutes.wormholes')} checked={opts.useWormholes} onChange={(v) => set('useWormholes', v)} />
              <Check label="Thera" indent muted={!opts.useWormholes} checked={opts.includeThera} onChange={(v) => set('includeThera', v)} />
              <Check label="Turnur" indent muted={!opts.useWormholes} checked={opts.includeTurnur} onChange={(v) => set('includeTurnur', v)} />
              <Check label={t('fleetRoutes.titanBridge')} hint="6 ly" checked={opts.useTitanBridge} onChange={(v) => set('useTitanBridge', v)} />
              <Check label={t('fleetRoutes.blopsBridge')} hint="8 ly" checked={opts.useBlopsBridge} onChange={(v) => set('useBlopsBridge', v)} />
              <Check label={t('fleetRoutes.carrierConduit')} hint="7 ly" checked={opts.useCarrierConduit} onChange={(v) => set('useCarrierConduit', v)} />
            </Section>

            <Section title={t('fleetRoutes.security')}>
              <Tri label={t('fleetRoutes.highsec')} value={opts.avoidHighsec} onChange={(v) => set('avoidHighsec', v)} />
              <Tri label={t('fleetRoutes.lowsec')} value={opts.avoidLowsec} onChange={(v) => set('avoidLowsec', v)} />
              <Tri label={t('fleetRoutes.nullsec')} value={opts.avoidNullsec} onChange={(v) => set('avoidNullsec', v)} />
              <Tri label={t('fleetRoutes.wspace')} value={opts.avoidWhSpace} onChange={(v) => set('avoidWhSpace', v)} />
              <div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('fleetRoutes.securityHint')}</div>
            </Section>

            <Section title={t('fleetRoutes.bridgesAndFleet')}>
              <Row label={t('fleetRoutes.minBridgeRange')}>
                <input className="chains-new__name" type="number" min={0} max={20} style={{ width: 56, textAlign: 'center' }} value={opts.minBridgeRange}
                  onChange={(e) => set('minBridgeRange', Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
              </Row>
              <Row label={t('fleetRoutes.maxBridges')}>
                <input className="chains-new__name" type="number" min={0} max={10} style={{ width: 56, textAlign: 'center' }} value={opts.maxBridges}
                  onChange={(e) => set('maxBridges', Math.max(0, Math.min(10, Number(e.target.value) || 0)))} />
              </Row>
              <Row label={t('fleetRoutes.shipClass')}>
                <Select value={shipClass} onChange={setShipClass} ariaLabel={t('fleetRoutes.shipClass')}
                  options={SHIP_CLASSES.map((c) => ({ value: c.key, label: `${t(`fleetRoutes.ship.${c.key}`)} · ${c.mass} kg` }))} />
              </Row>
            </Section>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 4 }}>
              <button type="button" className="btn btn--primary" disabled={!from || !to || loading} onClick={plan}>
                {loading ? t('fleetRoutes.planning') : t('fleetRoutes.plan')}
              </button>
              <button type="button" className="btn btn--ghost" onClick={() => setDrawer((d) => !d)}>
                {drawer ? t('fleetRoutes.hideMine') : t('fleetRoutes.mine')}
              </button>
            </div>
          </div>

          {/* Results column */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {drawer && <MyBridgesDrawer onChanged={() => { if (result) void plan(); }} />}
            {error && <div style={{ color: 'var(--cv-conn-expired)', fontSize: 13 }}>{error}</div>}
            {result && result.routes.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                  <span>
                    <strong>{t('fleetRoutes.nRoutes', { count: result.routes.length })}</strong>
                    {' · '}{result.from.name} → {result.to.name} · {t('fleetRoutes.fleetOf', { ship: t(`fleetRoutes.ship.${cls.key}`) })}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-subtle)' }} title={sourcesTitle(result.sources)}>{t('fleetRoutes.sortedByJumps')}</span>
                </div>
                {result.routes.map((r, i) => (
                  <RouteCard key={r.id} route={r} selected={i === selected} shipClass={shipClass} onSelect={() => setSelected(i)}
                    onSend={() => sendToAutopilot(r)} sending={sending} />
                ))}
                {route && <RouteMap route={route} coords={result.coords} />}
              </>
            )}
            {!result && !drawer && !error && (
              <div className="map-sidebar__hint" style={{ margin: 0 }}>{t('fleetRoutes.empty')}</div>
            )}
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}

function sourcesTitle(s: PlanResp['sources']): string {
  return `${s.bridges} bridges · ${s.wormholes} mapped wormholes · ${s.scoutHoles} scout holes · ${s.services} bridge services`;
}

// ── Route card ───────────────────────────────────────────────────────────────

function RouteCard({ route, selected, shipClass, onSelect, onSend, sending }: {
  route: Route; selected: boolean; shipClass: ShipClass; onSelect: () => void; onSend: () => void; sending: boolean;
}) {
  const { t } = useTranslation();
  const counts = { gates: 0, bridges: 0, wh: 0, capital: 0 };
  for (const s of route.segments) {
    if (s.method === 'stargate') counts.gates++;
    else if (s.method === 'jump_bridge') counts.bridges++;
    else if (s.method === 'wormhole') counts.wh++;
    else counts.capital++;
  }
  const parts = [
    counts.gates && t('fleetRoutes.nGates', { count: counts.gates }),
    counts.bridges && t('fleetRoutes.nBridges', { count: counts.bridges }),
    counts.wh && t('fleetRoutes.nWhJumps', { count: counts.wh }),
    counts.capital && t('fleetRoutes.nCapital', { count: counts.capital }),
  ].filter(Boolean);
  const tight = route.segments.filter((s) => s.method === 'wormhole' && s.maxJumpMassKg).sort((a, b) => (a.maxJumpMassKg ?? 0) - (b.maxJumpMassKg ?? 0))[0];
  const cap = tight?.capacity?.[shipClass];
  const catLabel = (c: string) => t(`fleetRoutes.cat.${c}`, { defaultValue: c });
  const catClass = (c: string) => (c === 'gates_only' ? 'ok' : c === 'via_jb' ? 'jb' : c.endsWith('bridge') || c === 'carrier_conduit' ? 'cap' : 'wh');
  const TAG: Record<string, { color: string; border: string }> = {
    ok: { color: 'var(--success-bright)', border: '#1e3a28' }, jb: { color: 'var(--accent)', border: 'var(--border-accent)' },
    cap: { color: '#f5b96a', border: '#5a4020' }, wh: { color: '#b06ad0', border: '#4a2e7a' },
  };
  return (
    <div onClick={onSelect} style={{
      background: selected ? '#141c2e' : 'var(--surface-panel)', border: `1px solid ${selected ? 'var(--border-accent-strong)' : 'var(--border)'}`,
      borderRadius: 6, padding: '10px 12px', display: 'flex', flexDirection: 'column', gap: 6, cursor: 'pointer',
    }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, flexWrap: 'wrap' }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
          {route.categories.map((c) => {
            const s = TAG[catClass(c)];
            return <span key={c} style={{ fontSize: 11, padding: '2px 7px', borderRadius: 3, border: `1px solid ${s.border}`, background: 'var(--surface-well)', color: s.color }}>{catLabel(c)}</span>;
          })}
          <span style={{ fontSize: 13, fontWeight: 600, marginLeft: 4 }}>{t('fleetRoutes.nJumps', { count: route.totalJumps })}</span>
          <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>· {parts.join(' · ')}</span>
          {route.fatigueMinutes != null && <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>· {t('fleetRoutes.fatigue', { min: route.fatigueMinutes })}</span>}
        </div>
        <button type="button" className="btn btn--primary btn--sm" disabled={sending} onClick={(e) => { e.stopPropagation(); onSend(); }}>
          {t('fleetRoutes.setDestination')}
        </button>
      </div>
      <Strip route={route} />
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', lineHeight: 1.4 }}>
        {route.systems[0]?.name}
        {route.segments.map((s, i) => (
          <Fragment key={i}>
            {s.method === 'stargate'
              ? ' → '
              : <span style={{ color: s.timeStatus === 'eol' || s.massStatus === 'critical' ? 'var(--danger)' : METHOD_COLOR[s.method] }}> ⟶ {hopLabel(t, s)} </span>}
            {s.to.name}{route.systems[i + 1]?.wspace && s.to.name.startsWith('J') ? '' : ''}
          </Fragment>
        ))}
      </div>
      {(tight || route.warnings.length > 0) && (
        <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap', fontSize: 12, color: 'var(--text-subtle)' }}>
          {tight && (
            <span>
              {t('fleetRoutes.tightest')}: <strong style={{ color: 'var(--text)' }}>{tight.whType ?? '?'} · {fmtMass(tight.maxJumpMassKg ?? 0)} kg {t('fleetRoutes.perJump')}</strong>
              {route.bottleneck?.maxShipClass && <> · {t('fleetRoutes.fitsUpTo', { ship: t(`fleetRoutes.ship.${route.bottleneck.maxShipClass}`) })}</>}
              {cap && <> · {cap.perJump
                ? <strong style={{ color: 'var(--text)' }}>{t('fleetRoutes.passesLeft', { count: cap.totalPasses })}</strong>
                : <span style={{ color: 'var(--danger)' }}>{t('fleetRoutes.doesNotFit', { ship: t(`fleetRoutes.ship.${shipClass}`) })}</span>}</>}
            </span>
          )}
          {route.warnings.map((w) => <span key={w} style={{ color: '#f0a030' }}>{w}</span>)}
        </div>
      )}
    </div>
  );
}

function hopLabel(t: TFunction, s: Segment): string {
  switch (s.method) {
    case 'jump_bridge':     return s.name ? `${t('fleetRoutes.hop.bridge')} (${s.name})` : t('fleetRoutes.hop.bridge');
    case 'wormhole':        return `${s.whType ?? 'WH'}${s.timeStatus === 'eol' ? ' (EOL)' : ''}${s.massStatus === 'critical' ? ' (crit)' : s.massStatus === 'reduced' ? ' (reduced)' : ''}`;
    case 'titan_bridge':    return `${t('fleetRoutes.hop.titan')} ${s.distanceLy?.toFixed(1)} ly`;
    case 'blops_bridge':    return `${t('fleetRoutes.hop.blops')} ${s.distanceLy?.toFixed(1)} ly`;
    case 'carrier_conduit': return `${t('fleetRoutes.hop.conduit')} ${s.distanceLy?.toFixed(1)} ly`;
    default: return '';
  }
}

function fmtMass(kg: number): string {
  if (kg >= 1e9) return `${(kg / 1e9).toFixed(kg % 1e9 ? 2 : 0)}B`;
  if (kg >= 1e6) return `${Math.round(kg / 1e6)}M`;
  return kg.toLocaleString();
}

/** Coloured square per system; a diamond in the gap before every non-gate hop. */
function Strip({ route }: { route: Route }) {
  return (
    <div className="scout-route" style={{ marginTop: 0 }}>
      {route.systems.map((sys, i) => {
        const seg = i > 0 ? route.segments[i - 1] : null;
        const special = seg && seg.method !== 'stargate';
        const risk = seg && (seg.timeStatus === 'eol' || seg.massStatus === 'critical');
        return (
          <Fragment key={`${sys.id}-${i}`}>
            {special && (
              <span className={`scout-route__link${seg.method === 'jump_bridge' ? ' scout-route__link--ansiblex' : ''}${risk ? ' scout-route__link--risk' : ''}`}
                style={CAPITAL.has(seg.method) ? { background: METHOD_COLOR[seg.method] } : undefined}
                data-tooltip={seg.name || seg.method} aria-label={seg.name || seg.method} />
            )}
            <span className="scout-route__square" style={{ background: truesecColor(sys.security) }}
              data-tooltip={`${sys.name} ${sys.security.toFixed(1)}`} aria-label={`${sys.name} ${sys.security.toFixed(1)}`} />
          </Fragment>
        );
      })}
    </div>
  );
}

// Route on CCP's 2D star-map projection. J-space systems have no projection
// coordinates; they are placed halfway between their k-space neighbours.
function RouteMap({ route, coords }: { route: Route; coords: Record<number, { x: number; y: number }> }) {
  const { t } = useTranslation();
  const pts: { x: number; y: number; name: string; id: number; wspace: boolean }[] = [];
  const raw = route.systems.map((s) => ({ ...s, c: coords[s.id] ?? null }));
  for (let i = 0; i < raw.length; i++) {
    let c = raw[i].c;
    if (!c) {
      const prev = raw.slice(0, i).reverse().find((r) => r.c)?.c, next = raw.slice(i + 1).find((r) => r.c)?.c;
      if (prev && next) c = { x: (prev.x + next.x) / 2, y: (prev.y + next.y) / 2 + 1 };
      else if (prev) c = { x: prev.x + 1, y: prev.y }; else if (next) c = { x: next.x - 1, y: next.y }; else c = { x: i, y: 0 };
    }
    pts.push({ x: c.x, y: c.y, name: raw[i].name, id: raw[i].id, wspace: raw[i].wspace });
  }
  if (pts.length < 2) return null;
  const W = 760, H = 170, PAD = 34;
  const xs = pts.map((p) => p.x), ys = pts.map((p) => p.y);
  const minX = Math.min(...xs), maxX = Math.max(...xs), minY = Math.min(...ys), maxY = Math.max(...ys);
  const spanX = maxX - minX || 1, spanY = maxY - minY || 1;
  const scale = Math.min((W - 2 * PAD) / spanX, (H - 2 * PAD) / spanY);
  const ox = (W - spanX * scale) / 2, oy = (H - spanY * scale) / 2;
  const sx = (x: number) => ox + (x - minX) * scale;
  const sy = (y: number) => oy + (maxY - y) * scale;
  const sp = pts.map((p) => ({ ...p, X: sx(p.x), Y: sy(p.y) }));
  const used = new Set(route.segments.map((s) => s.method));
  const legend = (color: string, dashed: boolean, label: string) => (
    <div key={label} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-block', width: 14, borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }} /> {label}
    </div>
  );
  return (
    <div style={{ position: 'relative', borderRadius: 6, overflow: 'hidden' }}>
      <svg viewBox={`0 0 ${W} ${H}`} style={{ width: '100%', height: 170, background: '#0d1117', display: 'block' }}>
        {sp.slice(1).map((p, i) => {
          const m = route.segments[i].method;
          return <line key={i} x1={sp[i].X} y1={sp[i].Y} x2={p.X} y2={p.Y} stroke={METHOD_COLOR[m]} strokeWidth={2} opacity={0.9}
            strokeDasharray={m === 'stargate' ? undefined : '6 4'} />;
        })}
        {sp.map((p, i) => {
          const first = i === 0, last = i === sp.length - 1;
          return (
            <g key={`${p.id}-${i}`}>
              <circle cx={p.X} cy={p.Y} r={first || last ? 6 : 5} fill={first ? '#3ddc84' : last ? '#e69f00' : '#161b22'} stroke={p.wspace ? '#b06ad0' : '#56b4e9'} strokeWidth={2} />
              {(first || last || sp.length <= 14) && (
                <text x={p.X} y={p.Y + (i % 2 === 0 ? 18 : -9)} fill="#c9d1d9" fontSize={11} textAnchor="middle" stroke="#0d1117" strokeWidth={3} paintOrder="stroke">{p.name}</text>
              )}
            </g>
          );
        })}
      </svg>
      <div style={{ position: 'absolute', top: 8, right: 10, display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, color: 'var(--text-subtle)', background: 'rgba(13,17,23,0.7)', padding: '5px 8px', borderRadius: 5 }}>
        {legend(METHOD_COLOR.stargate, false, t('fleetRoutes.legend.stargate'))}
        {used.has('jump_bridge') && legend('#5a9af8', true, t('fleetRoutes.legend.bridge'))}
        {used.has('wormhole') && legend(METHOD_COLOR.wormhole, true, t('fleetRoutes.legend.wormhole'))}
        {(used.has('titan_bridge') || used.has('blops_bridge') || used.has('carrier_conduit')) && legend(METHOD_COLOR.titan_bridge, true, t('fleetRoutes.legend.capital'))}
      </div>
    </div>
  );
}

// ── My bridges & exclusions ──────────────────────────────────────────────────

interface Bridge { id: number; fromSystemId: number; fromName: string | null; toSystemId: number; toName: string | null; name: string; source: string; active: boolean; missedSyncs: number; personal: boolean; ownerCorpName?: string | null }
interface Service { id: number; systemId: number; systemName: string | null; kind: 'titan' | 'blops' | 'conduit'; rangeLy: number; name: string; active: boolean; personal: boolean }
interface BridgesResp { shared: Bridge[]; personal: Bridge[]; excludedBridges: number[]; excludedServices: number[]; canManageShared: boolean }
interface ServicesResp { shared: Service[]; personal: Service[]; defaults: Record<string, number> }

function MyBridgesDrawer({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [bridges, setBridges] = useState<BridgesResp | null>(null);
  const [services, setServices] = useState<ServicesResp | null>(null);
  const [exB, setExB] = useState<Set<number>>(new Set());
  const [exS, setExS] = useState<Set<number>>(new Set());
  const [bFrom, setBFrom] = useState(''); const [bTo, setBTo] = useState('');
  const [sSys, setSSys] = useState(''); const [sKind, setSKind] = useState<'titan' | 'blops' | 'conduit'>('titan'); const [sName, setSName] = useState('');
  const [busy, setBusy] = useState(false);

  const load = async () => {
    const [b, s] = await Promise.all([api<BridgesResp>('/api/jump-bridges'), api<ServicesResp>('/api/bridge-services')]);
    setBridges(b); setServices(s);
    setExB(new Set(b.excludedBridges)); setExS(new Set(b.excludedServices));
  };
  // eslint-disable-next-line react-hooks/set-state-in-effect
  useEffect(() => { load().catch(() => {}); }, []);

  const saveExclusions = async (nb: Set<number>, ns: Set<number>) => {
    setExB(nb); setExS(ns);
    await api('/api/jump-bridges/exclusions', { method: 'PUT', body: JSON.stringify({ bridges: [...nb], services: [...ns] }) }).catch(() => toast.error(t('fleetRoutes.saveFailed')));
    onChanged();
  };
  const toggleB = (id: number) => { const n = new Set(exB); if (n.has(id)) n.delete(id); else n.add(id); void saveExclusions(n, exS); };
  const toggleS = (id: number) => { const n = new Set(exS); if (n.has(id)) n.delete(id); else n.add(id); void saveExclusions(exB, n); };

  const addBridge = async () => {
    if (!bFrom.trim() || !bTo.trim()) return;
    setBusy(true);
    try {
      await api('/api/jump-bridges', { method: 'POST', body: JSON.stringify({ from: bFrom.trim(), to: bTo.trim(), scope: 'personal' }) });
      setBFrom(''); setBTo(''); await load(); onChanged();
    } catch { toast.error(t('fleetRoutes.unknownSystem')); }
    finally { setBusy(false); }
  };
  const addService = async () => {
    if (!sSys.trim()) return;
    setBusy(true);
    try {
      await api('/api/bridge-services', { method: 'POST', body: JSON.stringify({ system: sSys.trim(), kind: sKind, name: sName.trim(), scope: 'personal' }) });
      setSSys(''); setSName(''); await load(); onChanged();
    } catch { toast.error(t('fleetRoutes.unknownSystem')); }
    finally { setBusy(false); }
  };
  const del = async (path: string) => { await api(path, { method: 'DELETE' }).catch(() => {}); await load(); onChanged(); };

  const kindLabel = (k: Service['kind']) => t(`fleetRoutes.kind.${k}`);
  const rowStyle = { display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, padding: '3px 0' } as const;
  return (
    <div style={{ background: 'var(--surface-panel)', border: '1px solid var(--border)', borderRadius: 6, padding: 12, display: 'flex', flexDirection: 'column', gap: 12 }}>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('fleetRoutes.mineHint')}</div>
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 16 }}>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', marginBottom: 4 }}>{t('fleetRoutes.sharedBridges')}</div>
          {!bridges ? <div style={{ fontSize: 12 }}>…</div> : bridges.shared.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('fleetRoutes.noneShared')}</div> : (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {bridges.shared.map((b) => (
                <label key={b.id} style={{ ...rowStyle, opacity: b.active && b.missedSyncs < 2 ? 1 : 0.5 }}>
                  <input type="checkbox" checked={!exB.has(b.id)} onChange={() => toggleB(b.id)} />
                  <span style={{ fontFamily: 'ui-monospace, monospace' }}>{b.fromName} ⟷ {b.toName}</span>
                  {b.name && <span style={{ color: 'var(--text-faint)' }}>{b.name}</span>}
                </label>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', margin: '10px 0 4px' }}>{t('fleetRoutes.myBridges')}</div>
          {bridges?.personal.map((b) => (
            <div key={b.id} style={rowStyle}>
              <span style={{ fontFamily: 'ui-monospace, monospace', flex: 1 }}>{b.fromName} ⟷ {b.toName}</span>
              <button type="button" className="icon-btn" onClick={() => del(`/api/jump-bridges/${b.id}`)} title={t('actions.delete')}><XIcon size={11} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4 }}>
            <input className="chains-new__name" style={{ flex: 1 }} placeholder={t('fleetRoutes.fromSystem')} value={bFrom} onChange={(e) => setBFrom(e.target.value)} />
            <input className="chains-new__name" style={{ flex: 1 }} placeholder={t('fleetRoutes.toSystem')} value={bTo} onChange={(e) => setBTo(e.target.value)} />
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={addBridge}>{t('actions.add', { defaultValue: 'Add' })}</button>
          </div>
        </div>
        <div>
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', marginBottom: 4 }}>{t('fleetRoutes.sharedServices')}</div>
          {!services ? <div style={{ fontSize: 12 }}>…</div> : services.shared.length === 0 ? <div style={{ fontSize: 12, color: 'var(--text-faint)' }}>{t('fleetRoutes.noneShared')}</div> : (
            <div style={{ maxHeight: 180, overflowY: 'auto' }}>
              {services.shared.map((s) => (
                <label key={s.id} style={{ ...rowStyle, opacity: s.active ? 1 : 0.5 }}>
                  <input type="checkbox" checked={!exS.has(s.id)} onChange={() => toggleS(s.id)} />
                  <span>{s.systemName}</span>
                  <span style={{ color: METHOD_COLOR[s.kind === 'titan' ? 'titan_bridge' : s.kind === 'blops' ? 'blops_bridge' : 'carrier_conduit'] }}>{kindLabel(s.kind)} · {s.rangeLy} ly</span>
                  {s.name && <span style={{ color: 'var(--text-faint)' }}>{s.name}</span>}
                </label>
              ))}
            </div>
          )}
          <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', margin: '10px 0 4px' }}>{t('fleetRoutes.myServices')}</div>
          {services?.personal.map((s) => (
            <div key={s.id} style={rowStyle}>
              <span style={{ flex: 1 }}>{s.systemName} · {kindLabel(s.kind)} · {s.rangeLy} ly {s.name && <span style={{ color: 'var(--text-faint)' }}>{s.name}</span>}</span>
              <button type="button" className="icon-btn" onClick={() => del(`/api/bridge-services/${s.id}`)} title={t('actions.delete')}><XIcon size={11} /></button>
            </div>
          ))}
          <div style={{ display: 'flex', gap: 6, marginTop: 4, flexWrap: 'wrap' }}>
            <input className="chains-new__name" style={{ flex: '1 1 90px' }} placeholder={t('fleetRoutes.systemLowNull')} value={sSys} onChange={(e) => setSSys(e.target.value)} />
            <Select value={sKind} onChange={setSKind} ariaLabel={t('fleetRoutes.serviceKind')} options={(['titan', 'blops', 'conduit'] as const).map((k) => ({ value: k, label: kindLabel(k) }))} />
            <input className="chains-new__name" style={{ flex: '1 1 90px' }} placeholder={t('fleetRoutes.notes')} value={sName} onChange={(e) => setSName(e.target.value)} />
            <button type="button" className="btn btn--ghost btn--sm" disabled={busy} onClick={addService}>{t('actions.add', { defaultValue: 'Add' })}</button>
          </div>
        </div>
      </div>
    </div>
  );
}

// ── Small controls ───────────────────────────────────────────────────────────

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div style={{ borderTop: '1px solid var(--border)', paddingTop: 10, display: 'flex', flexDirection: 'column', gap: 4 }}>
      <div style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-subtle)', textTransform: 'uppercase', letterSpacing: '0.06em', marginBottom: 2 }}>{title}</div>
      {children}
    </div>
  );
}
function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 24, fontSize: 13 }}>
      <span>{label}</span>{children}
    </div>
  );
}
function Check({ label, hint, checked, onChange, indent, muted }: { label: string; hint?: string; checked: boolean; onChange: (v: boolean) => void; indent?: boolean; muted?: boolean }) {
  return (
    <label style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, minHeight: 22, fontSize: 13, paddingLeft: indent ? 14 : 0, color: muted ? 'var(--text-faint)' : undefined, cursor: 'pointer' }}>
      <span>{label}{hint && <span style={{ fontSize: 12, color: 'var(--text-subtle)', marginLeft: 6 }}>{hint}</span>}</span>
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
    </label>
  );
}
function Tri({ label, value, onChange }: { label: string; value: Level; onChange: (v: Level) => void }) {
  const { t } = useTranslation();
  const opts: { v: Level; k: 'permit' | 'avoid' | 'exclude' }[] = [{ v: 0, k: 'permit' }, { v: 1, k: 'avoid' }, { v: 2, k: 'exclude' }];
  return (
    <Row label={label}>
      <span style={{ display: 'inline-flex', border: '1px solid var(--border)', borderRadius: 5, overflow: 'hidden' }}>
        {opts.map((o) => (
          <button key={o.v} type="button" onClick={() => onChange(o.v)} style={{
            fontSize: 11, padding: '3px 8px', border: 'none', borderLeft: o.v ? '1px solid var(--border)' : 'none', cursor: 'pointer',
            background: value === o.v ? '#1a3a6a' : 'var(--surface-well)', color: value === o.v ? 'var(--accent-light)' : 'var(--text-subtle)',
          }}>{t(`fleetRoutes.${o.k}`)}</button>
        ))}
      </span>
    </Row>
  );
}

/** Any-system search field (k-space and J-space alike). */
function SystemField({ label, value, onPick }: { label: string; value: Picked; onPick: (v: Picked) => void }) {
  const { t } = useTranslation();
  const [query, setQuery] = useState('');
  const { results, loading } = useEsiSearch(query);
  const show = query.trim().length >= 2 && (results.length > 0 || loading);
  return (
    <div style={{ position: 'relative' }}>
      <div style={{ fontSize: 12, color: 'var(--text-subtle)', marginBottom: 3 }}>{label}</div>
      {value ? (
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: 8, border: '1px solid var(--border)', borderRadius: 6, padding: '5px 8px' }}>
          <strong>{value.name}</strong>
          <button type="button" className="icon-btn" onClick={() => onPick(null)} title={t('jumpPlanner.change')}><XIcon size={12} /></button>
        </div>
      ) : (
        <input className="chains-new__name" style={{ width: '100%' }} type="text" value={query}
          placeholder={t('jumpPlanner.searchSystem')} onChange={(e) => setQuery(e.target.value)} />
      )}
      {!value && show && (
        <ul className="search-results">
          {loading && <li className="search-results__item" style={{ cursor: 'default', opacity: 0.6 }}>{t('jumpPlanner.searching')}</li>}
          {results.map((r) => (
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
