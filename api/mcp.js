// Disneyland Resort data MCP server — stateless Streamable HTTP (JSON-RPC over POST)
// Sources: (1) public disneyland.disney.go.com web endpoints, (2) Disney app backend
// (api.wdpro.disney.go.com) using the anonymous public OAuth grant.

const UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const WEB = 'https://disneyland.disney.go.com';
const APP = 'https://api.wdpro.disney.go.com';
const PARKS = { disneyland: '330339', dca: '336894', dlr: '80008297' };
const QUEUE_TIMES = { disneyland: 16, dca: 17 };

// ---------- helpers ----------
const todayPacific = () =>
  new Date().toLocaleDateString('en-CA', { timeZone: 'America/Los_Angeles' });

let tokenCache = { token: null, exp: 0 };
async function appToken() {
  if (tokenCache.token && Date.now() < tokenCache.exp - 30_000) return tokenCache.token;
  const r = await fetch('https://authorization.go.com/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: 'grant_type=assertion&assertion_type=public&client_id=WDPRO-MOBILE.MDX.DLR.ANDROID-PROD',
  });
  if (!r.ok) throw new Error(`Token request failed: HTTP ${r.status}`);
  const j = await r.json();
  tokenCache = { token: j.access_token, exp: Date.now() + (j.expires_in || 900) * 1000 };
  return tokenCache.token;
}

async function appGet(path) {
  const tok = await appToken();
  const url = path.startsWith('http') ? path : `${APP}/${path.replace(/^\//, '')}`;
  const r = await fetch(url, {
    headers: {
      Authorization: `BEARER ${tok}`,
      Accept: 'application/json;apiversion=1',
      'X-Conversation-Id': 'WDPRO-MOBILE.MDX.CLIENT-PROD',
      'X-App-Id': 'WDW-MDX-ANDROID-3.4.1',
    },
  });
  const text = await r.text();
  let body;
  try { body = JSON.parse(text); } catch { body = text.slice(0, 2000); }
  return { status: r.status, body };
}

async function webGet(path) {
  const r = await fetch(`${WEB}${path}`, { headers: { 'User-Agent': UA, 'Accept-Language': 'en-US,en;q=0.9' } });
  if (!r.ok) throw new Error(`Disney web endpoint returned HTTP ${r.status} for ${path}`);
  return r.json();
}

const hhmm = (t) => (t ? t.slice(0, 5) : t);

// ---------- tool implementations ----------
async function menu({ slug }) {
  const d = await webGet(`/dining/dinemenu/api/menu?searchTerm=${encodeURIComponent(slug)}`);
  if (!d || !d.mealPeriods) {
    return { error: `No menu returned for slug "${slug}". Slugs are the last path segment of the Disney dining URL, e.g. plaza-inn, lamplight-lounge, blue-bayou-restaurant.` };
  }
  const periods = d.mealPeriods.map((mp) => ({
    period: mp.label || mp.name,
    groups: (mp.groups || [])
      .filter((g) => !String(g.type || '').includes('Allergy Friendly') && !String(g.name || '').includes('Allergy'))
      .map((g) => ({
        category: g.name,
        items: (g.items || [])
          .filter((it) => Array.isArray(it.prices) && it.prices.length)
          .map((it) => ({
            item: (it.title || '').trim(),
            price: it.prices[0].withoutTax,
            description: it.description ? String(it.description).replace(/<[^>]+>/g, '').trim() : undefined,
          })),
      }))
      .filter((g) => g.items.length),
  }));
  return { restaurant: d.name, location: d.location, source: `${WEB}/dining/ (slug ${slug})`, pulled: new Date().toISOString(), mealPeriods: periods };
}

async function entertainmentSchedule({ date, filter = 'all', name_contains }) {
  date = date || todayPacific();
  const d = await webGet(`/finder/api/v1/explorer-service/list-ancestor-entities/dlr/80008297;entityType=destination/${date}/entertainment`);
  const needle = name_contains ? name_contains.toLowerCase() : null;
  const out = [];
  for (const e of d.results || []) {
    const types = e.facets?.entertainmentType || [];
    const SHOW = ['stage-show', 'nighttime-spectaculars', 'fireworks', 'parades', 'parade', 'street-performance', 'shows', 'seasonal'];
    const isChar = types.includes('character-experiences') && !types.some((t) => SHOW.includes(t));
    if (filter === 'characters' && !isChar) continue;
    if (filter === 'shows' && (e.entityType !== 'Entertainment' || isChar)) continue;
    if (filter === 'attractions' && e.entityType !== 'Attraction') continue;
    if (needle && !String(e.name).toLowerCase().includes(needle)) continue;
    const scheds = e.schedule?.schedules || [];
    const times = scheds.map((s) => ({ type: s.type, start: hhmm(s.startTime), end: hhmm(s.endTime), closed: s.isClosed || undefined }));
    out.push({ id: e.id, name: e.name, kind: isChar ? 'Character experience' : e.entityType, entertainmentType: types.length ? types : undefined, location: e.locationName, park: e.parkIds, times: times.length ? times : 'no schedule data' });
  }
  return { date, count: out.length, note: 'Character experiences are location+window only; Disney does not expose per-character appearance times publicly.', entries: out };
}

async function parkHours({ park = 'disneyland', date }) {
  date = date || todayPacific();
  const id = PARKS[park];
  if (!id) return { error: `Unknown park "${park}". Use disneyland or dca.` };
  const { status, body } = await appGet(`facility-service/schedules/${id};entityType=theme-park?date=${date}`);
  if (status !== 200) return { error: `App backend returned HTTP ${status}`, body };
  return { park: body.name, date, timeZone: body.timeZone, schedules: (body.schedules || []).map((s) => ({ type: s.type, start: hhmm(s.startTime), end: hhmm(s.endTime) })) };
}

async function entitySchedule({ id, date, type = 'entertainment' }) {
  date = date || todayPacific();
  const { status, body } = await appGet(`facility-service/schedules/${id};type=${type}?date=${date}`);
  if (status !== 200) return { error: `App backend returned HTTP ${status}`, body };
  return { id: body.id, name: body.name, facilityType: body.facilityType, date, schedules: (body.schedules || []).map((s) => ({ type: s.type, start: hhmm(s.startTime), end: hhmm(s.endTime) })) };
}

async function entity({ id, entityType = 'Entertainment' }) {
  const { status, body } = await appGet(`facility-service/${entityType === 'Attraction' ? 'attractions' : 'entertainments'}/${id};entityType=${entityType}`);
  if (status !== 200) return { error: `App backend returned HTTP ${status}`, body };
  return { id: body.id, name: body.name, type: body.type, links: Object.fromEntries(Object.entries(body.links || {}).map(([k, v]) => [k, v.href])), descriptions: body.descriptions, facets: body.facets };
}

let charCache = { at: 0, list: null };
async function characterCatalog({ search, limit = 50 }) {
  if (!charCache.list || Date.now() - charCache.at > 6 * 3600_000) {
    const { status, body } = await appGet('facility-service/characters?park=330339');
    if (status !== 200) return { error: `Catalog returned HTTP ${status}`, body };
    const hrefs = (body.entries || []).map((e) => e.links?.self?.href).filter(Boolean);
    const list = [];
    for (let i = 0; i < hrefs.length; i += 60) {
      const batch = await Promise.all(hrefs.slice(i, i + 60).map(async (h) => {
        try { const r = await appGet(h); return r.status === 200 && r.body?.name ? { id: String(r.body.id).split(';')[0], name: r.body.name, slug: r.body.urlFriendlyId, description: r.body.descriptions?.shortDescriptionMobile?.text } : null; } catch { return null; }
      }));
      list.push(...batch.filter(Boolean));
    }
    charCache = { at: Date.now(), list };
  }
  let rows = charCache.list;
  if (search) { const s = search.toLowerCase(); rows = rows.filter((c) => String(c.name || '').toLowerCase().includes(s)); }
  return { total: rows.length, note: 'Static catalog only — no appearance times/locations (scope-gated by Disney).', characters: rows.slice(0, limit) };
}

async function waitTimes({ park = 'disneyland' }) {
  const id = PARKS[park];
  const disney = await appGet(`facility-service/theme-parks/${id}/wait-times`).catch((e) => ({ status: 0, body: String(e) }));
  if (disney.status === 200 && disney.body?.entries) {
    return { source: 'Disney app backend', park, entries: disney.body.entries.map((e) => ({ name: e.name, status: e.waitTime?.status, minutes: e.waitTime?.postedWaitMinutes })) };
  }
  const r = await fetch(`https://queue-times.com/parks/${QUEUE_TIMES[park]}/queue_times.json`);
  if (!r.ok) return { error: `Disney wait-times blocked (HTTP ${disney.status}) and queue-times.com returned HTTP ${r.status}` };
  const q = await r.json();
  const rides = [];
  for (const land of q.lands || []) for (const ride of land.rides || []) rides.push({ land: land.name, name: ride.name, open: ride.is_open, minutes: ride.wait_time, updated: ride.last_updated });
  return { source: 'queue-times.com (third-party mirror of Disney app data) — Disney backend returned HTTP ' + disney.status, park, rides };
}

async function rawAppGet({ path }) {
  const { status, body } = await appGet(path);
  return { status, body };
}

// ---------- tool registry ----------
const TOOLS = [
  { name: 'dlr_menu', fn: menu, description: 'Full current menu with prices for one Disneyland Resort venue from Disney\'s official dining API. slug = last path segment of the disneyland.disney.go.com/dining URL (e.g. plaza-inn, blue-bayou-restaurant, lamplight-lounge, pym-test-kitchen, hearthstone-lounge).',
    schema: { type: 'object', properties: { slug: { type: 'string', description: 'Venue slug, e.g. carnation-cafe' } }, required: ['slug'] } },
  { name: 'dlr_entertainment_schedule', fn: entertainmentSchedule, description: 'Resort-wide entertainment calendar for a date (parades, fireworks, Fantasmic!, World of Color, shows, character-experience windows, attraction operating hours). Future dates work. Filter by kind or name.',
    schema: { type: 'object', properties: { date: { type: 'string', description: 'YYYY-MM-DD, Pacific. Defaults to today.' }, filter: { type: 'string', enum: ['all', 'characters', 'shows', 'attractions'], description: 'Default all' }, name_contains: { type: 'string', description: 'Case-insensitive substring on the entity name, e.g. "fantasmic"' } } } },
  { name: 'dlr_park_hours', fn: parkHours, description: 'Official park hours (operating, early entry, etc.) for Disneyland Park or Disney California Adventure on a date, from the Disney app backend.',
    schema: { type: 'object', properties: { park: { type: 'string', enum: ['disneyland', 'dca'] }, date: { type: 'string', description: 'YYYY-MM-DD, defaults to today' } } } },
  { name: 'dlr_entity_schedule', fn: entitySchedule, description: 'Schedule for ONE attraction or show by Disney entity id on a date (lightweight per-entity call). Get ids from dlr_entertainment_schedule.',
    schema: { type: 'object', properties: { id: { type: 'string' }, date: { type: 'string' }, type: { type: 'string', description: 'entertainment (default) or attraction' } }, required: ['id'] } },
  { name: 'dlr_entity', fn: entity, description: 'Full Disney app-backend record for an entertainment or attraction entity, including its link map (schedule, scheduleMax, associatedCharacters).',
    schema: { type: 'object', properties: { id: { type: 'string' }, entityType: { type: 'string', enum: ['Entertainment', 'Attraction'] } }, required: ['id'] } },
  { name: 'dlr_character_catalog', fn: characterCatalog, description: 'Static Disneyland character catalog from the app backend (names, ids, descriptions). No appearance times. First call is slow (~400 fetches); cached afterwards.',
    schema: { type: 'object', properties: { search: { type: 'string' }, limit: { type: 'number' } } } },
  { name: 'dlr_wait_times', fn: waitTimes, description: 'Current attraction wait times for a park. Tries the Disney app backend first; falls back to queue-times.com and labels the source.',
    schema: { type: 'object', properties: { park: { type: 'string', enum: ['disneyland', 'dca'] } } } },
  { name: 'dlr_app_raw_get', fn: rawAppGet, description: 'Probe any Disney app-backend path with the anonymous public token and app headers. Returns status + body. For exploring endpoints (e.g. facility-service/associated-characters/401471;entityType=Entertainment).',
    schema: { type: 'object', properties: { path: { type: 'string', description: 'Path under api.wdpro.disney.go.com or a full https URL' } }, required: ['path'] } },
];

// ---------- JSON-RPC / MCP plumbing ----------
const rpc = (id, result) => ({ jsonrpc: '2.0', id, result });
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });

async function handle(msg) {
  const { id, method, params } = msg;
  switch (method) {
    case 'initialize':
      return rpc(id, { protocolVersion: params?.protocolVersion || '2025-03-26', capabilities: { tools: {} }, serverInfo: { name: 'disneyland-resort-data', version: '1.0.0' } });
    case 'ping':
      return rpc(id, {});
    case 'tools/list':
      return rpc(id, { tools: TOOLS.map((t) => ({ name: t.name, description: t.description, inputSchema: t.schema, annotations: { readOnlyHint: true, openWorldHint: true } })) });
    case 'tools/call': {
      const t = TOOLS.find((x) => x.name === params?.name);
      if (!t) return rpcErr(id, -32602, `Unknown tool ${params?.name}`);
      try {
        const result = await t.fn(params.arguments || {});
        return rpc(id, { content: [{ type: 'text', text: JSON.stringify(result, null, 1) }], isError: !!result?.error });
      } catch (e) {
        return rpc(id, { content: [{ type: 'text', text: `Error: ${e.message}` }], isError: true });
      }
    }
    default:
      if (method?.startsWith('notifications/')) return null;
      return rpcErr(id, -32601, `Method not found: ${method}`);
  }
}

export default async function handler(req, res) {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, Mcp-Session-Id, Mcp-Protocol-Version');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, DELETE');
  if (req.method === 'OPTIONS') return res.status(204).end();
  if (req.method === 'GET') return res.status(200).json({ name: 'disneyland-resort-data', transport: 'streamable-http (stateless, POST JSON-RPC)', tools: TOOLS.map((t) => t.name) });
  if (req.method === 'DELETE') return res.status(200).end();
  if (req.method !== 'POST') return res.status(405).end();

  let body = req.body;
  if (typeof body === 'string') { try { body = JSON.parse(body); } catch { return res.status(400).json(rpcErr(null, -32700, 'Parse error')); } }
  if (!body) return res.status(400).json(rpcErr(null, -32700, 'Empty body'));

  const msgs = Array.isArray(body) ? body : [body];
  const results = (await Promise.all(msgs.map(handle))).filter(Boolean);
  if (!results.length) return res.status(202).end();
  res.setHeader('Content-Type', 'application/json');
  return res.status(200).json(Array.isArray(body) ? results : results[0]);
}
