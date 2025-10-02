// server.js — Playwright-based ad-image scraper focused on simgad (Google) + Taboola images
// Captures only image/* responses from tpc.googlesyndication.com/simgad and *images.taboola.com
// 15s budget per page; returns unique creatives with basic metadata.

const express = require('express');
const { chromium } = require('playwright');
const { imageSize } = require('image-size'); // npm i image-size
const app = express();

app.use(express.json({ limit: '2mb' }));

// ---------- helpers ----------
const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
  '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

function uniqBy(arr, keyFn) {
  const seen = new Set();
  const out = [];
  for (const x of arr) {
    const k = keyFn(x);
    if (!k || seen.has(k)) continue;
    seen.add(k);
    out.push(x);
  }
  return out;
}

function isAllowedAdImage(url, contentType) {
  if (!url || !url.startsWith('http')) return false;
  const ct = (contentType || '').toLowerCase();

  // Must be image/* (jpeg/png/webp/gif/avif)
  const isImageCT = ct.startsWith('image/');
  const looksImageExt = /\.(png|jpe?g|webp|gif|avif)(?:[?#].*|$)/i.test(url);

  // Sources we want:
  // 1) Google display image CDN: .../simgad/...
  const isGoogleSimgad =
    /(^|\/\/)tpc\.googlesyndication\.com\/simgad\//i.test(url);
  // 2) Taboola images CDN (some deployments use images.taboola.com / img.taboola.com)
  const isTaboolaImg =
    /(^|\/\/)(images|img)\.taboola\.com\//i.test(url);

  // Only pass if it’s one of our target hosts and looks like an image
  const fromAllowedHost = isGoogleSimgad || isTaboolaImg;

  return fromAllowedHost && (isImageCT || looksImageExt);
}

function withinSize(w, h, min = 30) {
  // filter out tracking pixels/super small assets
  if (w != null && h != null) {
    return w >= min && h >= min;
  }
  // unknown sizes are allowed (we'll try to compute from buffer), let later logic decide
  return true;
}

// ---------- core scrape ----------
async function scrapeOnce({ url, budgetMs = 15000, maxScrolls = 4, scrollDelayMs = 600 }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    javaScriptEnabled: true,
    bypassCSP: true,
    // Accept headers tuned for images (helps some CDNs)
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  const page = await context.newPage();
  const startedAt = Date.now();

  const found = new Map(); // key: image_url → ad record

  // Listen to all network responses and pick the ad images we care about
  page.on('response', async (resp) => {
    try {
      const respUrl = resp.url();
      const headers = resp.headers();
      const ct = (headers['content-type'] || '').toLowerCase();

      if (!isAllowedAdImage(respUrl, ct)) return;

      // Pull some metadata
      const req = resp.request();
      const frame = req.frame();
      const referer = req.headers()['referer'] || null;
      const frameUrl = frame?.url() || null;

      // Read bytes to try to compute width/height
      let width = null, height = null;
      try {
        const buf = await resp.body();
        if (buf && buf.length >= 1024) {
          const dim = imageSize(buf);
          width = Number(dim?.width) || null;
          height = Number(dim?.height) || null;
        }
      } catch {
        // swallow dimension errors; leave as null
      }

      // quick small filter (if we actually measured)
      if (!withinSize(width, height, 30)) return;

      const rec = {
        image_url: respUrl,
        link_url: null,
        alt: '',
        width,
        height,
        html: null,
        via: 'network:image',
        referer,
        frame_url: frameUrl,
        placement_hint: null,
      };

      found.set(respUrl, rec);
    } catch {
      // ignore a single bad response
    }
  });

  // Go to page and wait a bit for networks
  await page.route('**/*', (route) => {
    // light politeness: block heavy video if needed (optional)
    // if (route.request().resourceType() === 'media') return route.abort();
    route.continue();
  });

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Trigger lazy loads (limited scrolls within budget)
  for (let i = 0; i < Math.max(0, maxScrolls); i++) {
    if (Date.now() - startedAt > budgetMs) break;
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(scrollDelayMs);
  }

  // Let network settle but respect 15s budget
  const remaining = Math.max(0, budgetMs - (Date.now() - startedAt));
  if (remaining > 0) {
    // networkidle can hang; race with timeout
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(Math.min(remaining, 4000)),
    ]);
  }

  const ads = uniqBy(Array.from(found.values()), x => x.image_url);

  await context.close();
  await browser.close();

  return ads;
}

// ---------- HTTP API ----------
app.post('/scrape', async (req, res) => {
  const {
    url,
    maxScrolls = 4,
    scrollDelayMs = 600,
    budgetMs = 15000,
  } = req.body || {};

  if (!url || !/^https?:\/\//i.test(url)) {
    return res.status(400).json({ error: 'Body must include a valid { url }' });
  }

  try {
    const ads = await scrapeOnce({ url, maxScrolls, scrollDelayMs, budgetMs });
    return res.json({ ads, source: 'playwright', page_url: url });
  } catch (e) {
    console.error('SCRAPE_ERROR', e?.message);
    return res.status(500).json({ error: 'scrape failed', detail: String(e?.message || e) });
  }
});

app.get('/', (_req, res) => res.json({ ok: true, name: 'ad-image-scraper', ts: new Date().toISOString() }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('[ad-scraper] listening on', PORT));
