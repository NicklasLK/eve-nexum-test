import { Fragment, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTranslation } from 'react-i18next';
import type { TFunction } from 'i18next';
import { XIcon } from '../../icons';
import { Select } from './Select';
import { api } from '../../api/client';
import { toast } from '../../utils/toastStore';
import { SystemSearchField, type PickedSystem } from './SystemSearchField';
import { lowNullFilter } from '../../hooks/useEsiSearch';
import { useUserSetting } from '../../hooks/useUserSetting';
import { useAuth } from '../../context/AuthContext';
import { truesecColor } from '../../utils/truesec';

// Fleet Routes. Plans several diverse routes between two systems across
// stargates, the alliance's Ansiblex bridges, wormholes on the maps you can
// see, Thera / Turnur, and standby capital bridges — then pushes the chosen
// route to the in-game autopilot (only the hops the autopilot can't work out
// itself become waypoints). Options persist per user under nexum.fleetRoutes.*.

type Level = 0 | 1 | 2;
type Method = 'stargate' | 'jump_bridge' | 'wormhole' | 'titan_bridge' | 'blops_bridge' | 'carrier_conduit' | 'command_conduit';
// bridge_services.kind; 'command' is a command carrier's conduit (7.5 ly).
type Kind = 'titan' | 'blops' | 'conduit' | 'command';
const KINDS: Kind[] = ['titan', 'blops', 'conduit', 'command'];
const KIND_METHOD: Record<Kind, Method> = { titan: 'titan_bridge', blops: 'blops_bridge', conduit: 'carrier_conduit', command: 'command_conduit' };
type ShipClass = 'frigate' | 'destroyer' | 'cruiser' | 'battlecruiser' | 'battleship' | 'capital';
interface Options {
  useStargates: boolean; useJumpBridges: boolean; useWormholes: boolean; includeThera: boolean; includeTurnur: boolean;
  useTitanBridge: boolean; useBlopsBridge: boolean; useCarrierConduit: boolean; useCommandConduit: boolean;
  avoidHighsec: Level; avoidLowsec: Level; avoidNullsec: Level; avoidWhSpace: Level;
  minBridgeRange: number; maxBridges: number;
}
const DEFAULT_OPTIONS: Options = {
  useStargates: true, useJumpBridges: true, useWormholes: true, includeThera: true, includeTurnur: true,
  useTitanBridge: false, useBlopsBridge: false, useCarrierConduit: false, useCommandConduit: false,
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
  sources: { scoutHoles: number; wormholes: number; bridges: number; services: number; capitalEdges: number };
}
type Picked = PickedSystem;

const CAPITAL = new Set<Method>(['titan_bridge', 'blops_bridge', 'carrier_conduit', 'command_conduit']);
const METHOD_COLOR: Record<Method, string> = {
  stargate: '#56b4e9', jump_bridge: 'var(--accent)', wormhole: '#b06ad0',
  titan_bridge: '#f5b96a', blops_bridge: '#4db8c4', carrier_conduit: '#7ab4f0', command_conduit: '#b48cf5',
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
  // Bumped when the drawer changes bridges/exclusions, so the plan refreshes.
  const [replanTick, setReplanTick] = useState(0);
  const optsKey = JSON.stringify(opts);
  const seq = useRef(0);

  // Plan as soon as both ends are picked, and again whenever an option
  // changes — no button. Debounced a little so a burst of clicks on the
  // option checkboxes becomes one request; late replies are dropped.
  useEffect(() => {
    // Deliberate: clears this pane's own state when its inputs go away.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    if (!from || !to) { setResult(null); setError(null); return; }
    const mine = ++seq.current;
    const fromId = from.id, toId = to.id, options = JSON.parse(optsKey) as Options;
    const handle = setTimeout(async () => {
      setLoading(true); setError(null);
      try {
        const r = await api<PlanResp>('/api/fleet-routes', { method: 'POST', body: JSON.stringify({ from: fromId, to: toId, options, maxRoutes: 6 }) });
        if (mine !== seq.current) return;
        setResult(r); setSelected(0);
        if (!r.routes.length) setError(t('fleetRoutes.errNoRoute'));
      } catch {
        if (mine === seq.current) setError(t('fleetRoutes.errFailed'));
      } finally {
        if (mine === seq.current) setLoading(false);
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [from, to, optsKey, replanTick, t]);

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
      <div className="modal" style={{ maxWidth: 'min(1800px, 96vw)', width: '96vw', maxHeight: '94vh', display: 'flex', flexDirection: 'column' }}>
        <div className="modal__header">
          <h2 className="modal__title">{t('fleetRoutes.title')}</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('fleetRoutes.subtitle')}</span>
            <button className="icon-btn" onClick={onClose} title={t('actions.close')}><XIcon size={14} weight="bold" /></button>
          </div>
        </div>
        <div className="modal__body" style={{ display: 'flex', flexDirection: 'row', alignItems: 'flex-start', gap: 16, overflow: 'auto', minHeight: 0, flex: 1 }}>
          {/* Options column */}
          <div style={{ width: 300, flexShrink: 0, display: 'flex', flexDirection: 'column', gap: 8 }}>
            <SystemSearchField label={t('fleetRoutes.from')} value={from} onPick={setFrom} />
            <SystemSearchField label={t('fleetRoutes.to')} value={to} onPick={setTo} />

            <Section title={t('fleetRoutes.travelBy')}>
              <Check label={t('fleetRoutes.stargates')} checked={opts.useStargates} onChange={(v) => set('useStargates', v)} />
              <Check label={t('fleetRoutes.jumpBridges')} checked={opts.useJumpBridges} onChange={(v) => set('useJumpBridges', v)} />
              <Check label={t('fleetRoutes.wormholes')} checked={opts.useWormholes} onChange={(v) => set('useWormholes', v)} />
              <Check label="Thera" indent muted={!opts.useWormholes} checked={opts.includeThera} onChange={(v) => set('includeThera', v)} />
              <Check label="Turnur" indent muted={!opts.useWormholes} checked={opts.includeTurnur} onChange={(v) => set('includeTurnur', v)} />
              <Check label={t('fleetRoutes.titanBridge')} hint="6 ly" checked={opts.useTitanBridge} onChange={(v) => set('useTitanBridge', v)} />
              <Check label={t('fleetRoutes.blopsBridge')} hint="8 ly" checked={opts.useBlopsBridge} onChange={(v) => set('useBlopsBridge', v)} />
              <Check label={t('fleetRoutes.carrierConduit')} hint="7 ly" checked={opts.useCarrierConduit} onChange={(v) => set('useCarrierConduit', v)} />
              <Check label={t('fleetRoutes.commandConduit')} hint="7.5 ly" checked={opts.useCommandConduit} onChange={(v) => set('useCommandConduit', v)} />
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
              <button type="button" className="btn btn--ghost" onClick={() => setDrawer((d) => !d)}>
                {drawer ? t('fleetRoutes.hideMine') : t('fleetRoutes.mine')}
              </button>
            </div>
          </div>

          {/* Results column */}
          <div style={{ flex: 1, minWidth: 0, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {drawer && <MyBridgesDrawer onChanged={() => setReplanTick((n) => n + 1)} />}
            {loading && <div style={{ fontSize: 12, color: 'var(--text-subtle)' }}>{t('fleetRoutes.planning')}</div>}
            {error && !loading && <div style={{ color: 'var(--cv-conn-expired)', fontSize: 13 }}>{error}</div>}
            {result && result.routes.length > 0 && (
              <>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', fontSize: 13 }}>
                  <span>
                    <strong>{t('fleetRoutes.nRoutes', { count: result.routes.length })}</strong>
                    {' · '}{result.from.name} → {result.to.name} · {t('fleetRoutes.fleetOf', { ship: t(`fleetRoutes.ship.${cls.key}`) })}
                  </span>
                  <span style={{ fontSize: 12, color: 'var(--text-subtle)' }} title={sourcesTitle(result.sources)}>{t('fleetRoutes.sortedByJumps')}</span>
                </div>
                {route && (
                  <div>
                    <div style={{ fontSize: 11, fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em', color: 'var(--text-subtle)', marginBottom: 6 }}>
                      {t('fleetRoutes.selectedRoute', { n: route.id, jumps: route.totalJumps })}
                    </div>
                    <RouteString route={route} shipClass={shipClass} />
                  </div>
                )}
                {result.routes.map((r, i) => (
                  <RouteCard key={r.id} route={r} selected={i === selected} shipClass={shipClass} onSelect={() => setSelected(i)}
                    onSend={() => sendToAutopilot(r)} sending={sending} />
                ))}
              </>
            )}
            {!result && !drawer && !error && !loading && (
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
  const catClass = (c: string) => (c === 'gates_only' ? 'ok' : c === 'via_jb' ? 'jb' : c.endsWith('bridge') || c.endsWith('conduit') ? 'cap' : 'wh');
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
    case 'command_conduit': return `${t('fleetRoutes.hop.command')} ${s.distanceLy?.toFixed(1)} ly`;
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

// The selected route as pearls on a string: one bead per system, evenly
// spaced and wrapping, joined by a line coloured by how the hop is made.
// Hovering a bead or a hop shows the details (wormhole type, mass, time
// left, capacity for the chosen hull class, bridge name, jump distance).
const SHIP_ORDER_DESC: ShipClass[] = ['capital', 'battleship', 'battlecruiser', 'cruiser', 'destroyer', 'frigate'];

type Hover = { seg: Segment | null; sys: Route['systems'][number] | null; x: number; y: number };

function RouteString({ route, shipClass }: { route: Route; shipClass: ShipClass }) {
  const { t } = useTranslation();
  const [hover, setHover] = useState<Hover | null>(null);
  const enter = (seg: Segment | null, sys: Route['systems'][number] | null) => (e: React.MouseEvent) =>
    setHover({ seg, sys, x: e.clientX, y: e.clientY });
  const move = (e: React.MouseEvent) => setHover((h) => (h ? { ...h, x: e.clientX, y: e.clientY } : h));
  const leave = () => setHover(null);
  const last = route.systems.length - 1;
  const used = new Set(route.segments.map((s) => s.method));
  const legend = (color: string, dashed: boolean, label: string) => (
    <span key={label} style={{ display: 'inline-flex', alignItems: 'center', gap: 6 }}>
      <span style={{ display: 'inline-block', width: 16, borderTop: `2px ${dashed ? 'dashed' : 'solid'} ${color}` }} /> {label}
    </span>
  );

  return (
    <div>
      <div style={{ display: 'flex', flexWrap: 'wrap', alignItems: 'flex-start', rowGap: 16, padding: '12px 8px 6px', background: 'var(--surface-well)', border: '1px solid var(--border)', borderRadius: 6 }}>
        {route.systems.map((sys, i) => {
          const seg = i > 0 ? route.segments[i - 1] : null;
          const risk = seg && (seg.timeStatus === 'eol' || seg.massStatus === 'critical');
          const color = seg ? (risk ? 'var(--danger)' : METHOD_COLOR[seg.method]) : '';
          return (
            <Fragment key={`${sys.id}-${i}`}>
              {seg && (
                <div onMouseEnter={enter(seg, null)} onMouseMove={move} onMouseLeave={leave}
                  style={{ flex: '0 0 auto', width: seg.method === 'stargate' ? 26 : 46, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'help' }}>
                  <div style={{ width: '100%', height: 0, marginTop: 7, borderTop: `${seg.method === 'stargate' ? 2 : 3}px ${seg.method === 'stargate' ? 'solid' : 'dashed'} ${color}` }} />
                  {seg.method !== 'stargate' && (
                    <div style={{ fontSize: 10, color, marginTop: 4, whiteSpace: 'nowrap', maxWidth: 46, overflow: 'hidden', textOverflow: 'ellipsis' }}>{linkLabel(seg)}</div>
                  )}
                </div>
              )}
              <div onMouseEnter={enter(null, sys)} onMouseMove={move} onMouseLeave={leave}
                style={{ flex: '0 0 auto', width: 72, display: 'flex', flexDirection: 'column', alignItems: 'center', cursor: 'help' }}>
                <span style={{
                  width: i === 0 || i === last ? 16 : 13, height: i === 0 || i === last ? 16 : 13, marginTop: i === 0 || i === last ? 0 : 1.5,
                  borderRadius: '50%', boxSizing: 'border-box', background: truesecColor(sys.security),
                  boxShadow: '0 0 0 1px rgba(0,0,0,0.35)',
                }} />
                <span style={{ fontSize: 11, marginTop: 4, maxWidth: 72, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', color: i === 0 || i === last ? 'var(--text)' : 'var(--text-subtle)', fontWeight: i === 0 || i === last ? 600 : 400 }}>{sys.name}</span>
              </div>
            </Fragment>
          );
        })}
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 14, fontSize: 11, color: 'var(--text-subtle)', marginTop: 6 }}>
        {legend(METHOD_COLOR.stargate, false, t('fleetRoutes.legend.stargate'))}
        {used.has('jump_bridge') && legend('#5a9af8', true, t('fleetRoutes.legend.bridge'))}
        {used.has('wormhole') && legend(METHOD_COLOR.wormhole, true, t('fleetRoutes.legend.wormhole'))}
        {(used.has('titan_bridge') || used.has('blops_bridge') || used.has('carrier_conduit') || used.has('command_conduit')) && legend(METHOD_COLOR.titan_bridge, true, t('fleetRoutes.legend.capital'))}
        <span>{t('fleetRoutes.hover.hint')}</span>
      </div>
      {hover && createPortal(<HoverCard hover={hover} shipClass={shipClass} />, document.body)}
    </div>
  );
}

function linkLabel(seg: Segment): string {
  switch (seg.method) {
    case 'jump_bridge':     return 'JB';
    case 'wormhole':        return seg.whType ?? 'WH';
    case 'titan_bridge':    return `T ${seg.distanceLy?.toFixed(1)}ly`;
    case 'blops_bridge':    return `B ${seg.distanceLy?.toFixed(1)}ly`;
    case 'carrier_conduit': return `C ${seg.distanceLy?.toFixed(1)}ly`;
    case 'command_conduit': return `CC ${seg.distanceLy?.toFixed(1)}ly`;
    default: return '';
  }
}

function HoverCard({ hover, shipClass }: { hover: Hover; shipClass: ShipClass }) {
  const { t } = useTranslation();
  const W = 300;
  const left = Math.min(hover.x + 16, window.innerWidth - W - 12);
  const top = Math.min(hover.y + 16, window.innerHeight - 220);
  const row = (k: string, v: React.ReactNode, color?: string) => (
    <div key={k} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
      <span style={{ color: 'var(--text-subtle)' }}>{k}</span><span style={{ color: color ?? 'var(--text)', textAlign: 'right' }}>{v}</span>
    </div>
  );
  let title = '', rows: React.ReactNode[] = [];
  const { seg, sys } = hover;
  if (sys) {
    title = sys.name;
    rows = [row(t('fleetRoutes.hover.security'), sys.security.toFixed(1), truesecColor(sys.security))];
    if (sys.wspace) rows.push(row(t('fleetRoutes.hover.space'), t('fleetRoutes.hover.wspaceNoAutopilot')));
  } else if (seg) {
    const from = seg.from.name, to = seg.to.name;
    switch (seg.method) {
      case 'stargate': title = t('fleetRoutes.hover.stargate'); break;
      case 'jump_bridge': title = t('fleetRoutes.hover.bridge'); break;
      case 'wormhole': title = `${t('fleetRoutes.hover.wormhole')} ${seg.whType ?? 'K162'}`; break;
      case 'titan_bridge': title = t('fleetRoutes.kind.titan'); break;
      case 'blops_bridge': title = t('fleetRoutes.kind.blops'); break;
      case 'carrier_conduit': title = t('fleetRoutes.kind.conduit'); break;
      case 'command_conduit': title = t('fleetRoutes.kind.command'); break;
    }
    rows.push(row(t('fleetRoutes.hover.hop'), `${from} → ${to}`));
    if (seg.name) rows.push(row(t('fleetRoutes.hover.name'), seg.name));
    if (seg.distanceLy) rows.push(row(t('fleetRoutes.hover.distance'), `${seg.distanceLy.toFixed(2)} ly`));
    if (seg.method === 'wormhole') {
      if (seg.scout) rows.push(row(t('fleetRoutes.hover.source'), 'EvE-Scout'));
      if (seg.massStatus) rows.push(row(t('fleetRoutes.hover.mass'), t(`fleetRoutes.hover.mass_${seg.massStatus}`), seg.massStatus === 'critical' ? 'var(--danger)' : seg.massStatus === 'reduced' ? '#f0a030' : undefined));
      if (seg.timeStatus) rows.push(row(t('fleetRoutes.hover.time'), t(`fleetRoutes.hover.time_${seg.timeStatus}`), seg.timeStatus === 'eol' ? 'var(--danger)' : undefined));
      if (seg.remainingHours != null) rows.push(row(t('fleetRoutes.hover.remaining'), `~${seg.remainingHours < 10 ? seg.remainingHours.toFixed(1) : Math.round(seg.remainingHours)} h`, seg.remainingHours < 8 ? '#f0a030' : undefined));
      if (seg.maxShipSize) rows.push(row(t('fleetRoutes.hover.maxShip'), seg.maxShipSize));
      if (seg.maxJumpMassKg) rows.push(row(t('fleetRoutes.hover.maxJump'), `${fmtMass(seg.maxJumpMassKg)} kg`));
      if (seg.maxStableMassKg) rows.push(row(t('fleetRoutes.hover.total'), `${fmtMass(seg.maxStableMassKg)} kg`));
      if (seg.capacity) {
        const fits = SHIP_ORDER_DESC.find((c) => seg.capacity![c].perJump);
        rows.push(row(t('fleetRoutes.hover.fits'), fits ? t(`fleetRoutes.ship.${fits}`) : '—'));
        const mine = seg.capacity[shipClass];
        rows.push(row(t('fleetRoutes.hover.capacityFor', { ship: t(`fleetRoutes.ship.${shipClass}`) }),
          mine.perJump ? t('fleetRoutes.passesLeft', { count: mine.totalPasses }) : t('fleetRoutes.hover.tooHeavy'),
          mine.perJump ? undefined : 'var(--danger)'));
      }
    }
  }
  return (
    <div style={{ position: 'fixed', left, top, width: W, zIndex: 10000, pointerEvents: 'none', background: 'var(--surface-panel)', border: '1px solid var(--border-strong)', borderRadius: 6, padding: '8px 10px', fontSize: 12, boxShadow: '0 8px 24px rgba(0,0,0,0.45)', display: 'flex', flexDirection: 'column', gap: 3 }}>
      <div style={{ fontWeight: 600, marginBottom: 2 }}>{title}</div>
      {rows}
    </div>
  );
}

// ── My bridges & exclusions ──────────────────────────────────────────────────

interface Bridge { id: number; fromSystemId: number; fromName: string | null; toSystemId: number; toName: string | null; name: string; source: string; active: boolean; missedSyncs: number; personal: boolean; ownerCorpName?: string | null }
interface Service { id: number; systemId: number; systemName: string | null; kind: Kind; rangeLy: number; name: string; active: boolean; personal: boolean }
interface BridgesResp { shared: Bridge[]; personal: Bridge[]; excludedBridges: number[]; excludedServices: number[]; canManageShared: boolean }
interface ServicesResp { shared: Service[]; personal: Service[]; defaults: Record<string, number> }

function MyBridgesDrawer({ onChanged }: { onChanged: () => void }) {
  const { t } = useTranslation();
  const [bridges, setBridges] = useState<BridgesResp | null>(null);
  const [services, setServices] = useState<ServicesResp | null>(null);
  const [exB, setExB] = useState<Set<number>>(new Set());
  const [exS, setExS] = useState<Set<number>>(new Set());
  const [bFrom, setBFrom] = useState(''); const [bTo, setBTo] = useState('');
  const [sSys, setSSys] = useState<PickedSystem>(null); const [sKind, setSKind] = useState<Kind>('titan'); const [sName, setSName] = useState('');
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
    if (!sSys) return;
    setBusy(true);
    try {
      await api('/api/bridge-services', { method: 'POST', body: JSON.stringify({ system: sSys.id, kind: sKind, name: sName.trim(), scope: 'personal' }) });
      setSSys(null); setSName(''); await load(); onChanged();
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
                  <span style={{ color: METHOD_COLOR[KIND_METHOD[s.kind]] }}>{kindLabel(s.kind)} · {s.rangeLy} ly</span>
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
            <div style={{ flex: '1 1 120px' }}><SystemSearchField value={sSys} onPick={setSSys} filter={lowNullFilter} placeholder={t('fleetRoutes.systemLowNull')} compact /></div>
            <Select value={sKind} onChange={setSKind} ariaLabel={t('fleetRoutes.serviceKind')} options={KINDS.map((k) => ({ value: k, label: kindLabel(k) }))} />
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
