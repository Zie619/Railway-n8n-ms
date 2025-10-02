// server.js — Ynet Ads Image Scraper (Playwright)
// - Listens to DevTools network (page.on('response')).
// - Keeps only real image creatives from known ad hosts:
//     * doubleclick / googlesyndication (e.g., tpc.googlesyndication.com/simgad/...)
//     * taboola   ((images|img).taboola.com/...)
//     * outbrain  (outbrainimg.com | images.outbrain.com | im.outbrain.com)
//   and also allows any image/* if the *frame* is one of those hosts.
// - Adds DOM-hinted sweep: <img> under ancestor with class/id ~ /(ad|banner|sponsor)/.
// - Computes width/height from bytes using `image-size` (no “0×0”).
// - 15s budget per page; polite scrolling to trigger lazy loads.
// - Returns one record per unique creative with placement_hint & ad_host.

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

const MIN_W = 30;
const MIN_H = 30;

// Core known ad hosts (image or iframe)
const KNOWN_IMAGE_HOSTS = [
  // Google Display creatives:
  'tpc.googlesyndication.com', // /simgad/...
  // Taboola creatives CDN:
  'images.taboola.com',
  'img.taboola.com',
  // Outbrain creatives CDN:
  'outbrainimg.com',
  'images.outbrain.com',
  'im.outbrain.com',
];

const KNOWN_IFRAME_HOSTS = [
  // Google ad iframes:
  'googlesyndication.com',
  'g.doubleclick.net',
  'doubleclick.net',
  'ad.doubleclick.net',
  'pagead2.googlesyndication.com',
  'safeframe.googlesyndication.com',
  // Taboola:
  'taboola.com',
  'trc.taboola.com',
  // Outbrain:
  'outbrain.com',
  'widgets.outbrain.com',
];

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

function hostOf(u) {
  try { return new URL(u).hostname.toLowerCase(); } catch { return null; }
}

function isKnownImageHost(host) {
  if (!host) return false;
  return KNOWN_IMAGE_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function isKnownIframeHost(host) {
  if (!host) return false;
  return KNOWN_IFRAME_HOSTS.some(h => host === h || host.endsWith('.' + h));
}

function looksLikeImageExt(url) {
  return /\.(png|jpe?g|webp|gif|avif)(?:[?#].*|$)/i.test(url || '');
}

function isAllowedAdImage(url, contentType, frameUrl) {
  if (!url || !url.startsWith('http')) return false;

  const ct = (contentType || '').toLowerCase();
  const host = hostOf(url);
  const frameHost = hostOf(frameUrl);

  // 1) allow any image/* or URL with an image extension
  const isImageCT = ct.startsWith('image/');
  const looksImage = looksLikeImageExt(url);

  // 2) allow by direct image host (googlesyndication/taboola/outbrain)
  if ((isImageCT || looksImage) && isKnownImageHost(host)) return true;

  // 3) OR allow if image/* and it came from a known ad iframe host (doubleclick/googlesyndication/taboola/outbrain)
  if (isImageCT && isKnownIframeHost(frameHost)) return true;

  // 4) special: Google simgad path hint even if CT missing
  if (/tpc\.googlesyndication\.com\/simgad\//i.test(url)) return true;

  return false;
}

function withinSize(w, h, min = 30) {
  if (w != null && h != null) return w >= min && h >= min;
  // unknown → let it pass; we’ll try to infer from bytes or keep null
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

// ---------- core scrape ----------
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
  const t0 = Date.now();
  const found = new Map(); // image_url -> record

  page.on('response', async (resp) => {
    try {
      const respUrl = resp.url();
      const headers = resp.headers();
      const ct = (headers['content-type'] || '').toLowerCase();

      const req = resp.request();
      const frame = req.frame();
      const frameUrl = frame?.url() || null;
      const referer = req.headers()['referer'] || null;

      if (!isAllowedAdImage(respUrl, ct, frameUrl)) return;

      // compute width/height from bytes where possible
      let width = null, height = null;
      try {
        const buf = await resp.body();
        if (buf && buf.length >= 1024) {
          const dim = imageSize(buf);
          width = Number(dim?.width) || null;
          height = Number(dim?.height) || null;
        }
      } catch { /* ignore */ }

      if (!withinSize(width, height, MIN_W)) return;

      const host = hostOf(respUrl);
      let placement_hint = null;

      // placement by frame host first (iframe family), else by URL
      const fhost = hostOf(frameUrl);
      if (isKnownIframeHost(fhost)) {
        if (/doubleclick|g\.doubleclick|safeframe|googlesyndication/i.test(fhost || '')) placement_hint = 'iframe:doubleclick';
        if (/taboola/i.test(fhost || '')) placement_hint = 'iframe:taboola';
        if (/outbrain/i.test(fhost || '')) placement_hint = 'iframe:outbrain';
      }
      if (!placement_hint) {
        if (/tpc\.googlesyndication\.com\/simgad\//i.test(respUrl)) placement_hint = 'iframe:doubleclick';
        else if (/(^|\/\/)(images|img)\.taboola\.com\//i.test(respUrl)) placement_hint = 'iframe:taboola';
        else if (/outbrainimg\.com|images\.outbrain\.com|im\.outbrain\.com/i.test(respUrl)) placement_hint = 'iframe:outbrain';
      }

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
    } catch { /* ignore one-off errors */ }
  });

  await page.route('**/*', (route) => route.continue());
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });

  // Trigger lazy loads
  for (let i = 0; i < Math.max(0, maxScrolls); i++) {
    if (Date.now() - t0 > budgetMs) break;
    await page.mouse.wheel(0, 1200);
    await page.waitForTimeout(scrollDelayMs);
  }

  // Let network settle briefly without exceeding budget
  const remaining = Math.max(0, budgetMs - (Date.now() - t0));
  if (remaining > 0) {
    await Promise.race([
      page.waitForLoadState('networkidle').catch(() => {}),
      page.waitForTimeout(Math.min(remaining, 4000)),
    ]);
  }

  // DOM-hinted fallback (ads with ad/banner/sponsor ancestors)
  try {
    const domHints = await collectDomHintedImages(page);
    for (const rec of domHints) {
      const u = rec.image_url;
      if (!u) continue;
      // only keep real-looking images; skip ynet-hosted editorial
      if (!looksLikeImageExt(u)) continue;
      if ((hostOf(u) || '').endsWith('ynet.co.il')) continue;

      if (!found.has(u)) {
        found.set(u, {
          image_url: u,
          link_url: null,
          alt: '',
          width: null,
          height: null,
          html: null,
          via: rec.via, // 'dom:hint'
          referer: rec.referer,
          frame_url: rec.frame_url,
          placement_hint: rec.placement_hint, // 'dom:banner'
          ad_host: hostOf(u),
        });
      }
    }
  } catch { /* best-effort */ }

  const ads = uniqBy(Array.from(found.values()), x => x.image_url);

  await context.close();
  await browser.close();
  return ads;
}

// ---------- route (with numeric coercion for n8n) ----------
function num(x, d) { const n = Number(x); return Number.isFinite(n) ? n : d; }

app.post('/scrape', async (req, res) => {
  try {
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
  res.json({ ok: true, name: 'ynet-ad-image-scraper', ts: new Date().toISOString() })
);

const PORT = process.env.PORT || 8080;
app.listen(PORT, () => console.log('[ad-scraper] listening on', PORT));
