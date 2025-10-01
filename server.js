// server.js (cloud-hardened)
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// --- small helper: wrap an async function with a deadline ---
async function withDeadline(promise, ms, onTimeoutMsg = 'Timed out') {
  let t;
  const timeout = new Promise((_, rej) => (t = setTimeout(() => rej(new Error(onTimeoutMsg)), ms)));
  try { return await Promise.race([promise, timeout]); }
  finally { clearTimeout(t); }
}

// Health
app.get('/', (_req, res) => res.send('Playwright scraper OK'));

// Quick diagnostic: ensures Chromium can launch + fetch a simple page quickly
app.get('/debug', async (_req, res) => {
  let browser;
  try {
    browser = await chromium.launch({
      headless: true,
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-zygote',
        '--single-process',
        '--disable-software-rasterizer',
      ],
    });
    const ctx = await browser.newContext();
    const page = await ctx.newPage();
    await page.goto('https://example.com', { timeout: 15000 });
    const title = await page.title();
    res.json({ ok: true, title });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

/**
 * POST /scrape
 * Body: { url: string (req), waitSelector?, maxScrolls?, scrollDelayMs?, adSelector? }
 */
app.post('/scrape', async (req, res) => {
  // Keep total under ~55s to avoid edge 60s timeouts
  const TOTAL_BUDGET_MS = Math.min(Number(process.env.REPLY_TIMEOUT_MS) || 55000, 110000);

  const started = Date.now();
  const remain = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - started));

  const {
    url,
    waitSelector = null,
    // Lower defaults so we don’t hit the proxy timeout
    maxScrolls = 3,
    scrollDelayMs = 700,
    adSelector = '[data-ad], .ad, [id*="ad-"], [class*="ad-"], a[href*="adclick"], [class*="sponsor"], [data-testid*="ad"] img, img[src*="ads"], img[data-src*="ads"]',
  } = req.body || {};

  if (!url) return res.status(400).json({ ok: false, error: "Missing 'url' in request body" });

  let browser;
  try {
    browser = await withDeadline(
      chromium.launch({
        headless: true,
        args: [
          '--no-sandbox',
          '--disable-setuid-sandbox',
          '--disable-dev-shm-usage',
          '--disable-gpu',
          '--no-zygote',
          '--single-process',
          '--disable-software-rasterizer',
        ],
      }),
      remain(),
      'Browser launch timeout'
    );

    const context = await withDeadline(
      browser.newContext({
        locale: 'en-US',
        timezoneId: 'Asia/Jerusalem',
        userAgent:
          'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
        viewport: { width: 1366, height: 900 },
      }),
      remain(),
      'Context creation timeout'
    );

    const page = await withDeadline(context.newPage(), remain(), 'Page creation timeout');

    // Navigation: use short timeouts to avoid hanging
    await withDeadline(
      page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(remain(), 20000) }),
      remain(),
      'Navigation timeout'
    );
    await page.waitForLoadState('networkidle', { timeout: Math.min(remain(), 8000) }).catch(() => {});

    // Quick scrolls to trigger slots
    for (let i = 0; i < Number(maxScrolls) || 0; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await sleep(Number(scrollDelayMs) || 700);
      await page.waitForLoadState('networkidle', { timeout: Math.min(remain(), 4000) }).catch(() => {});
    }

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: Math.min(remain(), 6000) }).catch(() => {});
    }

    const ads = await withDeadline(
      page.evaluate((SEL) => {
        const candidates = Array.from(document.querySelectorAll(SEL));
        const uniq = new Map();
        const findLink = (el) => {
          let n = el;
          while (n && n !== document.body) {
            if (n.tagName === 'A' && n.href) return n.href;
            n = n.parentElement;
          }
          return null;
        };
        for (const el of candidates) {
          const img = el.tagName === 'IMG' ? el : (el.querySelector('img') || el);
          if (!img) continue;
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (!src) continue;
          const link = findLink(el) || findLink(img);
          const key = `${src}|${link || ''}`;
          if (!uniq.has(key)) {
            uniq.set(key, {
              image_url: src,
              link_url: link || null,
              alt: img.getAttribute('alt') || null,
              width: img.naturalWidth || null,
              height: img.naturalHeight || null,
              html: (el.outerHTML || '').slice(0, 2000),
            });
          }
        }
        return Array.from(uniq.values());
      }, adSelector),
      remain(),
      'Extraction timeout'
    );

    res.json({ ok: true, url, count: ads.length, ads, elapsed_ms: Date.now() - started });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), elapsed_ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));

