// Cloudflare Worker: relay for EvE-Scout's public Thera / Turnur feed.
//
// Why: some hosting networks cannot open a TCP connection to api.eve-scout.com
// (Azure Front Door drops it). Cloudflare's edge can, so this worker fetches the
// feed and serves the identical JSON, cached for 60 s so eve-scout is not hit
// harder than a single client would.
//
// Deploy: Cloudflare dashboard → Workers & Pages → Create → paste this file →
// add a route/custom domain such as scout-relay.evecore.app → then set
// EVE_SCOUT_URL=https://scout-relay.evecore.app/v2/public/signatures on the
// Nexum API service. Optional: set a RELAY_TOKEN variable on the worker and the
// same value in X-Relay-Token from Nexum (see below) to keep the relay private.

const UPSTREAM = 'https://api.eve-scout.com';
const CACHE_TTL_SECONDS = 60;

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    // Only the public signature feed is relayed; everything else is a 404.
    if (request.method !== 'GET' || !url.pathname.startsWith('/v2/public/signatures')) {
      return new Response('not found', { status: 404 });
    }
    if (env.RELAY_TOKEN && request.headers.get('x-relay-token') !== env.RELAY_TOKEN) {
      return new Response('forbidden', { status: 403 });
    }

    const upstreamUrl = UPSTREAM + url.pathname + url.search;
    const cache = caches.default;
    const cacheKey = new Request(upstreamUrl, { method: 'GET' });
    const hit = await cache.match(cacheKey);
    if (hit) return hit;

    const res = await fetch(upstreamUrl, {
      headers: {
        'User-Agent': 'Eve-Nexum scout relay (+https://github.com/GQuantrill/eve-nexum)',
        'Accept': 'application/json',
      },
      cf: { cacheTtl: CACHE_TTL_SECONDS, cacheEverything: true },
    });
    if (!res.ok) {
      return new Response(`upstream ${res.status}`, { status: 502 });
    }
    const body = await res.arrayBuffer();
    const out = new Response(body, {
      status: 200,
      headers: {
        'Content-Type': 'application/json; charset=utf-8',
        'Cache-Control': `public, max-age=${CACHE_TTL_SECONDS}`,
      },
    });
    ctx.waitUntil(cache.put(cacheKey, out.clone()));
    return out;
  },
};
