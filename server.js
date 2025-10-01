/**
 * Ads Inspector Server — paste & run
 * - Load a JSON file with shape like your uploaded test.json (url/count/ads[])
 * - REST API with filters, stats, CSV export, Swagger UI
 */

require('dotenv').config();

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const express = require('express');
const helmet = require('helmet');
const cors = require('cors');
const morgan = require('morgan');
const compression = require('compression');
const rateLimit = require('express-rate-limit');
const swaggerUi = require('swagger-ui-express');

// ---------- Config ----------
const PORT = process.env.PORT || 3000;
const DATA_PATH = process.env.DATA_PATH || path.resolve(__dirname, 'test.json');
const WATCH_DATA = (process.env.WATCH_DATA ?? '1') !== '0';
const ADMIN_TOKEN = process.env.ADMIN_TOKEN || null;

// ---------- Util ----------
const stripWww = (s) => (s || '').replace(/^www\./i, '');
function hostFromUrl(u) {
  try {
    if (!u) return null;
    const url = new URL(u);
    return url.hostname || null;
  } catch (_) {
    return null;
  }
}
function shortId(str) {
  return crypto.createHash('md5').update(String(str || '')).digest('hex').slice(0, 12);
}
function isThirdParty(imageHost, pageHost) {
  if (!imageHost || !pageHost) return null;
  const ih = stripWww(imageHost).toLowerCase();
  const ph = stripWww(pageHost).toLowerCase();
  return !(ih === ph || ih.endsWith('.' + ph) || ph.endsWith('.' + ih));
}
function classify(ad) {
  const h = (ad.image_host || '').toLowerCase();
  const u = (ad.image_url || '').toLowerCase();

  const trackerSignals = [
    'px.gif', 'pixel', 'collect', 'analytics', 'beacon', 'log', 'viewthrough', 'gen_204',
    'googleadservices', 'doubleclick', 'clarity.ms', 'chartbeat', 'skimresources',
    'ad-delivery.net', 'trc.taboola', 'taboola.com', 'ib.adnxs', 'pagead2.googlesyndication'
  ];
  const adSignals = [
    'doubleclick', 'googlesyndication', 'adnxs', 'pubmatic', 'taboola',
    'vidazoo', 'ad-delivery', 'adsrvr', 'adservice', 'securepubads', 'outbrain', 'criteo'
  ];

  const is1x1 = (ad.width === 1 && ad.height === 1);
  const hasTrackerHints = is1x1 || trackerSignals.some(s => h.includes(s) || u.includes(s));
  const hasAdHints = adSignals.some(s => h.includes(s) || u.includes(s));

  return hasTrackerHints ? 'tracker' : (hasAdHints ? 'ad' : 'asset');
}
function safeInt(val, fallback = null) {
  const n = Number.parseInt(val, 10);
  return Number.isFinite(n) ? n : fallback;
}
function countBy(items, pick) {
  const map = new Map();
  for (const it of items) {
    const k = pick(it) ?? 'unknown';
    map.set(k, (map.get(k) || 0) + 1);
  }
  return map;
}
function sortDescEntries(map) {
  return [...map.entries()].sort((a, b) => b[1] - a[1]);
}
function toCsv(rows, header) {
  const esc = (v) => {
    if (v === null || v === undefined) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  };
  return [header, ...rows.map(r => r.map(esc).join(','))].join('\n');
}

// ---------- Data state ----------
const state = {
  dataFile: DATA_PATH,
  pageHost: null,
  raw: null,
  ads: [],
  index: new Map(),
  lastLoaded: null
};

function normalize(raw) {
  const pageHost = hostFromUrl(raw.url);
  const ads = (raw.ads || []).map(a => {
    const image_url = a.image_url || null;
    const referer = a.referer || null;
    const frame_url = a.frame_url || null;

    const image_host = hostFromUrl(image_url);
    const referer_host = hostFromUrl(referer);
    const frame_host = hostFromUrl(frame_url);

    const id = shortId([image_url, referer, frame_url].join('|'));
    const width = safeInt(a.width, null);
    const height = safeInt(a.height, null);

    const base = {
      id,
      image_url,
      image_host,
      link_url: a.link_url || null,
      alt: a.alt || null,
      width,
      height,
      via: a.via || null,
      referer,
      referer_host,
      frame_url,
      frame_host
    };
    return {
      ...base,
      type: classify(base),
      third_party: isThirdParty(image_host, pageHost)
    };
  });
  return { pageHost, ads };
}

function reload(forceFile) {
  if (forceFile) state.dataFile = forceFile;
  if (!fs.existsSync(state.dataFile)) {
    console.warn(`[WARN] Data file not found at ${state.dataFile}. Starting with empty dataset.`);
    state.pageHost = null;
    state.raw = null;
    state.ads = [];
    state.index = new Map();
    state.lastLoaded = new Date();
    return;
  }
  const json = JSON.parse(fs.readFileSync(state.dataFile, 'utf8'));
  state.raw = json;
  const { pageHost, ads } = normalize(json);
  state.pageHost = pageHost;
  state.ads = ads;
  state.index = new Map(ads.map(a => [a.id, a]));
  state.lastLoaded = new Date();
  console.log(`[DATA] Loaded ${ads.length} items from ${state.dataFile} (pageHost=${pageHost || 'N/A'})`);
}

// initial load
reload();

// optional auto-reload on file changes
if (WATCH_DATA && fs.existsSync(state.dataFile)) {
  try {
    fs.watchFile(state.dataFile, { interval: 2000 }, (curr, prev) => {
      if (curr.mtimeMs !== prev.mtimeMs) {
        console.log('[DATA] Change detected, reloading...');
        try { reload(); } catch (e) { console.error('Reload failed:', e.message); }
      }
    });
  } catch (_) {}
}

// allow CI sanity check
if (process.argv.includes('--check')) {
  console.log(JSON.stringify({
    ok: true,
    file: state.dataFile,
    pageHost: state.pageHost,
    count: state.ads.length
  }, null, 2));
  process.exit(0);
}

// ---------- App ----------
const app = express();
app.set('trust proxy', true);
app.use(helmet());
app.use(cors());
app.use(compression());
app.use(morgan('dev'));
app.use(rateLimit({ windowMs: 60_000, max: 120 }));

// Health
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    now: new Date().toISOString(),
    dataset: {
      file: state.dataFile,
      lastLoaded: state.lastLoaded,
      pageHost: state.pageHost,
      total: state.ads.length
    }
  });
});

// List ads with filters
app.get('/ads', (req, res) => {
  const q = String(req.query.q || '').toLowerCase();
  const type = req.query.type ? String(req.query.type).toLowerCase() : null; // ad|tracker|asset
  const host = req.query.host ? String(req.query.host).toLowerCase() : null; // image_host contains
  const referer = req.query.referer ? String(req.query.referer).toLowerCase() : null; // referer_host contains
  const frame = req.query.frame ? String(req.query.frame).toLowerCase() : null; // frame_host contains
  const via = req.query.via ? String(req.query.via).toLowerCase() : null;

  const page = Math.max(1, safeInt(req.query.page, 1));
  const pageSize = Math.min(1000, Math.max(1, safeInt(req.query.pageSize, 50)));

  const sort = String(req.query.sort || 'type');
  const order = String(req.query.order || 'asc').toLowerCase() === 'desc' ? 'desc' : 'asc';
  const sortable = new Set(['type','image_host','referer_host','frame_host','third_party','width','height','via','id']);

  let list = state.ads;

  if (type) list = list.filter(a => a.type === type);
  if (host) list = list.filter(a => (a.image_host || '').toLowerCase().includes(host));
  if (referer) list = list.filter(a => (a.referer_host || '').toLowerCase().includes(referer));
  if (frame) list = list.filter(a => (a.frame_host || '').toLowerCase().includes(frame));
  if (via) list = list.filter(a => (a.via || '').toLowerCase().includes(via));
  if (q) {
    list = list.filter(a =>
      (a.image_url || '').toLowerCase().includes(q) ||
      (a.referer || '').toLowerCase().includes(q) ||
      (a.frame_url || '').toLowerCase().includes(q) ||
      (a.alt || '').toLowerCase().includes(q)
    );
  }

  if (sortable.has(sort)) {
    list = list.slice().sort((a, b) => {
      const A = a[sort];
      const B = b[sort];
      if (A === B) return 0;
      if (A === undefined || A === null) return 1;
      if (B === undefined || B === null) return -1;
      return A > B ? 1 : -1;
    });
    if (order === 'desc') list.reverse();
  }

  const total = list.length;
  const start = (page - 1) * pageSize;
  const data = list.slice(start, start + pageSize);

  res.json({ page, pageSize, total, data });
});

// Single ad
app.get('/ads/:id', (req, res) => {
  const ad = state.index.get(String(req.params.id));
  if (!ad) return res.status(404).json({ error: 'Not found' });
  res.json(ad);
});

// Stats
app.get('/ads/stats', (req, res) => {
  const total = state.ads.length;
  const byType = Object.fromEntries(countBy(state.ads, a => a.type));
  const byVia = Object.fromEntries(sortDescEntries(countBy(state.ads, a => a.via)).slice(0, 20));
  const byImageHost = Object.fromEntries(sortDescEntries(countBy(state.ads, a => a.image_host)).slice(0, 20));
  const byRefererHost = Object.fromEntries(sortDescEntries(countBy(state.ads, a => a.referer_host)).slice(0, 20));
  const oneByOne = state.ads.filter(a => a.width === 1 && a.height === 1).length;
  const thirdParty = state.ads.filter(a => a.third_party === true).length;

  res.json({
    total,
    pageHost: state.pageHost,
    counts: { oneByOne, thirdParty },
    byType,
    top: { byVia, byImageHost, byRefererHost }
  });
});

// CSV export
app.get('/export/csv', (req, res) => {
  const header = [
    'id','type','third_party','image_url','image_host','via',
    'referer','referer_host','frame_url','frame_host','width','height'
  ];
  const rows = state.ads.map(a => [
    a.id, a.type, a.third_party, a.image_url, a.image_host, a.via,
    a.referer, a.referer_host, a.frame_url, a.frame_host, a.width ?? '', a.height ?? ''
  ]);
  const csv = toCsv(rows, header.join(','));
  res.setHeader('Content-Type', 'text/csv; charset=utf-8');
  res.setHeader('Content-Disposition', 'attachment; filename="ads-export.csv"');
  res.send(csv);
});

// Admin reload (optional X-Admin-Token)
app.post('/reload', express.json({ limit: '1mb' }), (req, res) => {
  if (ADMIN_TOKEN && (req.get('x-admin-token') !== ADMIN_TOKEN)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  const newPath = req.body?.path;
  try {
    reload(newPath);
    res.json({ ok: true, file: state.dataFile, total: state.ads.length });
  } catch (e) {
    res.status(400).json({ ok: false, error: String(e.message || e) });
  }
});

// Swagger (minimal OpenAPI)
const openapi = {
  openapi: '3.0.0',
  info: {
    title: 'Ads Inspector API',
    version: '1.0.0',
    description: 'Explore ad/trackers parsed from a crawl JSON'
  },
  servers: [{ url: '/' }],
  paths: {
    '/health': { get: { summary: 'Health', responses: { '200': { description: 'OK' } } } },
    '/ads': {
      get: {
        summary: 'List ads with filters',
        parameters: [
          { name: 'q', in: 'query', schema: { type: 'string' } },
          { name: 'type', in: 'query', schema: { type: 'string', enum: ['ad','tracker','asset'] } },
          { name: 'host', in: 'query', schema: { type: 'string' } },
          { name: 'referer', in: 'query', schema: { type: 'string' } },
          { name: 'frame', in: 'query', schema: { type: 'string' } },
          { name: 'via', in: 'query', schema: { type: 'string' } },
          { name: 'sort', in: 'query', schema: { type: 'string' } },
          { name: 'order', in: 'query', schema: { type: 'string', enum: ['asc','desc'] } },
          { name: 'page', in: 'query', schema: { type: 'integer', default: 1 } },
          { name: 'pageSize', in: 'query', schema: { type: 'integer', default: 50 } }
        ],
        responses: { '200': { description: 'OK' } }
      }
    },
    '/ads/{id}': {
      get: {
        summary: 'Get a single ad by id',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' } }],
        responses: { '200': { description: 'OK' }, '404': { description: 'Not found' } }
      }
    },
    '/ads/stats': { get: { summary: 'Aggregate stats', responses: { '200': { description: 'OK' } } } },
    '/export/csv': { get: { summary: 'Download CSV export', responses: { '200': { description: 'CSV' } } } },
    '/reload': {
      post: {
        summary: 'Reload data file (optionally switch path)',
        requestBody: {
          content: { 'application/json': { schema: { type: 'object', properties: { path: { type: 'string' } } } } }
        },
        responses: { '200': { description: 'OK' }, '401': { description: 'Unauthorized' } }
      }
    }
  }
};
app.use('/docs', swaggerUi.serve, swaggerUi.setup(openapi));

// 404 & error handler
app.use((req, res) => res.status(404).json({ error: 'Not found' }));
app.use((err, req, res, _next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal error' });
});

app.listen(PORT, () => {
  console.log(`✅ Ads Inspector listening on http://localhost:${PORT}  (data: ${state.dataFile})`);
});
