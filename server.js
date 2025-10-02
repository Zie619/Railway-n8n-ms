// server.js — Ad-image scraper tailored for Ynet assignment
// Captures *image* creatives from:
//   - tpc.googlesyndication.com/simgad/...
//   - (images|img).taboola.com/...
// Also collects DOM-hinted <img> under elements with class/id including ad|banner|sponsor.
// 15s budget per page, minimal polite scrolling.

const express = require('express');
const { chromium } = require('playwright');
const { imageSize } = require('image-size');

const app = express();
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true }));
// ---------- constants ----------
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

  // must be image/* or look like one by extension
  const isImageCT = ct.startsWith('image/');
  const looksImageExt = /\.(png|jpe?g|webp|gif|avif)(?:[?#].*|$)/i.test(url);

  // allowlist hosts/patterns
  const isGoogleSimgad = /(^|\/\/)tpc\.googlesyndication\.com\/simgad\//i.test(url);
  const isTaboolaImg   = /(^|\/\/)(images|img)\.taboola\.com\//i.test(url);

  return (isGoogleSimgad || isTaboolaImg) && (isImageCT || looksImageExt);
}

function withinSize(w, h, min = 30) {
  if (w != null && h != null) return w >= min && h >= min;
  // unknown sizes are allowed; we try to compute from bytes
  return true;
}

async function collectDomHintedImages(page) {
  return await page.evaluate(() => {
    const HINT_RE = /(ad|banner|sponsor)/i;
    const out = [];
    const nodes = document.querySelectorAll('img, [style*="background-image"]');
    for (const n of nodes) {
      // walk up to find hinted ancestor
      let p = n, hinted = false;
      for (let i = 0; i < 6 && p; i++, p = p.parentElement) {
        const cls = (p.className || '').toString();
        const id  = (p.id || '').toString();
        if (HINT_RE.test(cls) || HINT_RE.test(id)) { hinted = true; break; }
      }
      if (!hinted) continue;

      // extract URL
      let url = null;
      if (n.tagName === 'IMG' && n.src) url = n.src;
      else {
        const style = window.getComputedStyle(n).backgroundImage || '';
        const m = style.match(/url\((['"]?)([^'")]+)\1\)/i);
        if (m) url = m[2];
      }
      if (!url || !/^https?:\/\//i.test(url)) continue;

      out.push({
        image_url: url,
        via: 'dom:hint',
        referer: document.location.href,
        frame_url: document.location.href,
        placement_hint: 'dom:banner',
      });
    }
    return out;
  });
}

async function scrapeOnce({ url, budgetMs = 15000, maxScrolls = 4, scrollDelayMs = 600 }) {
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: UA,
    viewport: { width: 1366, height: 900 },
    javaScriptEnabled: true,
    bypassCSP: true,
    extraHTTPHeaders: {
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.8',
      'Cache-Control': 'max-age=0',
      'Upgrade-Insecure-Requests': '1',
    },
  });

  const page = await context.newPage();
  const startedAt = Date.now();

  const found = new Map(); // image_url -> record

  page.on('response', async (resp) => {
    try {
      const respUrl = resp.url();
      const headers = resp.headers();
      const ct = (headers['content-type'] || '').toLowerCase();
      if (!isAllowedAdImage(respUrl, ct)) return;

      const req = resp.request();
      const frame = req.frame();
      const referer = req.headers()['referer'] || null;
      const frameUrl = frame?.url() || null;

      // compute width/height from bytes
      let width = null, height = null;
      try {
        const buf = await resp.body();
        if (buf && buf.length >= 1024) {
          const dim = imageSize(buf);
          width = Number(dim?.width) || null;
          height = Number(dim?.height) || null;
        }
      } catch { /* ignore */ }

      if (!withinSize(width, height, 30)) return;

      const host = (() => { try { return new URL(respUrl).hostname; } catch { return null; } })();

      let placement_hint = null;
      if (/tpc\.googlesyndication\.com\/simgad\//i.test(respUrl)) placement_hint = 'iframe:doubleclick';
      if (/(^|\/\/)(images|img)\.taboola\.com\//i.test(respUrl)) placement_hint = 'iframe:taboola';

      found.set(respUrl, {
        image_url: respUrl,
        link_url: null,
        alt: '',
        width,
        height,
        html: null,
        via: 'network:image',
        referer,
        frame_url: frameUrl,
        placement_hint,
        ad_host: host || null,
      });
    } catch { /* ignore a single bad entry */ }
  });

  await page.route('**/*', (route) => route.continue());

  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // trigger lazy loads
  for (let i = 0; i < Math.max(0, maxScrolls); i++) {
    if (Date.now() - startedAt > budgetMs) break;
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(scrollDelayMs);
  }

  // let network idle a bit, but respect budget
  const remaining = Math.max(0, budgetMs - (Date.now() - startedAt));
  if (remaining > 0) {
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(Math.min(remaining, 4000)),
    ]);
  }

  // DOM-hinted images (fallback for anything not caught by network allowlist)
  try {
    const domHints = await collectDomHintedImages(page);
    for (const rec of domHints) {
      const url = rec.image_url;
      if (!url) continue;
      if (!/\.(png|jpe?g|webp|gif)(?:[?#].*|$)/i.test(url)) continue;
      if (url.includes('ynet.co.il')) continue; // ignore ynet-served editorial
      if (!found.has(url)) {
        const host = (() => { try { return new URL(url).hostname; } catch { return null; } })();
        found.set(url, {
          image_url: url,
          link_url: null,
          alt: '',
          width: null,
          height: null,
          html: null,
          via: rec.via,
          referer: rec.referer,
          frame_url: rec.frame_url,
          placement_hint: rec.placement_hint,
          ad_host: host || null,
        });
      }
    }
  } catch { /* dom sweep best-effort */ }

  const ads = uniqBy(Array.from(found.values()), x => x.image_url);

  await context.close();
  await browser.close();
  return ads;
}

// ---------- HTTP API ----------

// helper to coerce to finite number with default
function num(x, d) {
  const n = Number(x);
  return Number.isFinite(n) ? n : d;
}


app.post('/scrape', async (req, res) => {
  try {
    // body may contain strings from n8n — coerce everything
    const raw = req.body || {};
    const url = raw.url;

    if (!url || !/^https?:\/\//i.test(url)) {
      return res.status(400).json({ error: 'Body must include a valid { url }' });
    }

    const maxScrolls   = num(raw.maxScrolls, 4);
    const scrollDelayMs = num(raw.scrollDelayMs, 600);
    const budgetMs     = num(raw.budgetMs, 15000);

    const ads = await scrapeOnce({ url, maxScrolls, scrollDelayMs, budgetMs });
    return res.json({ ads, source: 'playwright', page_url: url });
  } catch (e) {
    console.error('SCRAPE_ERROR', e?.message);
    return res.status(500).json({ error: 'scrape failed', detail: String(e?.message || e) });
  }
});

app.get('/', (_req, res) =>
  res.json({ ok: true, name: 'ad-image-scraper', ts: new Date().toISOString() })
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[ad-scraper] listening on', PORT));
