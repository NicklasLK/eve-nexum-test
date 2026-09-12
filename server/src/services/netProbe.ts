// Opt-in outbound connectivity probe, for diagnosing "fetch failed" against a
// specific host from inside a deployment where you cannot get a shell. Set
// NEXUM_NET_PROBE=host1[,host2] and, once at boot, each host is resolved and
// every returned address gets a raw TCP connect and a TLS handshake on :443,
// each timed and logged separately — so a stall shows up as "lookup", "tcp" or
// "tls" rather than as one opaque connect timeout. Never runs when unset.
import dns from 'node:dns/promises';
import net from 'node:net';
import tls from 'node:tls';
import { createLogger } from '../utils/logger.js';

const log = createLogger('net-probe');
const STEP_TIMEOUT_MS = 8_000;

function tcpProbe(address: string, family: number): Promise<string> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    const sock = net.connect({ host: address, port: 443, family });
    sock.setTimeout(STEP_TIMEOUT_MS);
    sock.once('connect', () => { sock.destroy(); resolve(`tcp ok ${Date.now() - t0}ms`); });
    sock.once('timeout', () => { sock.destroy(); resolve(`tcp TIMEOUT after ${Date.now() - t0}ms`); });
    sock.once('error', (e: NodeJS.ErrnoException) => { resolve(`tcp ERROR ${e.code ?? e.message} after ${Date.now() - t0}ms`); });
  });
}

// Handshake variants, so a stall can be tied to one property of the
// ClientHello (protocol version, SNI, size, ALPN) rather than "TLS".
const TLS_VARIANTS: { label: string; opts: tls.ConnectionOptions & { noSni?: boolean } }[] = [
  { label: 'default',          opts: {} },
  { label: 'tls1.2-only',      opts: { maxVersion: 'TLSv1.2' } },
  { label: 'tls1.3-only',      opts: { minVersion: 'TLSv1.3' } },
  { label: 'no-sni',           opts: { noSni: true } },
  { label: 'tiny-hello',       opts: { minVersion: 'TLSv1.3', ciphers: 'TLS_AES_128_GCM_SHA256', ecdhCurve: 'X25519' } },
  { label: 'alpn-http/1.1',    opts: { ALPNProtocols: ['http/1.1'] } },
  { label: 'alpn-h2',          opts: { ALPNProtocols: ['h2', 'http/1.1'] } },
];

function tlsProbe(address: string, family: number, servername: string, variant: tls.ConnectionOptions & { noSni?: boolean } = {}): Promise<string> {
  return new Promise((resolve) => {
    const t0 = Date.now();
    // tls.connect has no `family` option: open the TCP socket ourselves so the
    // address family is pinned, then hand it to TLS (it waits for 'connect').
    const raw = net.connect({ host: address, port: 443, family });
    raw.once('error', (e: NodeJS.ErrnoException) => { resolve(`tls ERROR (tcp) ${e.code ?? e.message} after ${Date.now() - t0}ms`); });
    const { noSni, ...tlsOpts } = variant;
    const sock = tls.connect({ socket: raw, ...(noSni ? {} : { servername }), ...tlsOpts });
    sock.setTimeout(STEP_TIMEOUT_MS);
    sock.once('secureConnect', () => {
      const out = `tls ok ${Date.now() - t0}ms ${sock.getProtocol() ?? ''} ${sock.getCipher()?.name ?? ''} alpn=${sock.alpnProtocol || '-'} authorized=${sock.authorized}`;
      sock.destroy(); resolve(out);
    });
    sock.once('timeout', () => { sock.destroy(); resolve(`tls TIMEOUT after ${Date.now() - t0}ms`); });
    sock.once('error', (e: NodeJS.ErrnoException) => { resolve(`tls ERROR ${e.code ?? e.message} after ${Date.now() - t0}ms`); });
  });
}

export async function runNetProbe(spec: string): Promise<void> {
  const hosts = spec.split(',').map((h) => h.trim()).filter(Boolean);
  for (const host of hosts) {
    const t0 = Date.now();
    let addrs: { address: string; family: number }[];
    try {
      addrs = await dns.lookup(host, { all: true, verbatim: true });
    } catch (e) {
      log.warn(`${host}: lookup FAILED ${(e as NodeJS.ErrnoException).code ?? String(e)} after ${Date.now() - t0}ms`);
      continue;
    }
    const uniq = [...new Map(addrs.map((a) => [a.address, a])).values()];
    log.info(`${host}: lookup ${Date.now() - t0}ms -> ${uniq.map((a) => a.address).join(', ')}`);
    for (const a of uniq) {
      log.info(`${host} [${a.address}] ${await tcpProbe(a.address, a.family)}`);
      for (const v of TLS_VARIANTS) {
        log.info(`${host} [${a.address}] ${v.label}: ${await tlsProbe(a.address, a.family, host, v.opts)}`);
      }
    }
    const t1 = Date.now();
    try {
      const res = await fetch(`https://${host}/`, { method: 'HEAD', signal: AbortSignal.timeout(15_000), redirect: 'manual' });
      log.info(`${host}: fetch HEAD / -> HTTP ${res.status} in ${Date.now() - t1}ms`);
    } catch (e) {
      const cause = (e as { cause?: { code?: string; message?: string } }).cause;
      log.warn(`${host}: fetch FAILED ${cause?.code ?? cause?.message ?? String(e)} after ${Date.now() - t1}ms`);
    }
  }
}
