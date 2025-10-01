// server.js
// Minimal Playwright HTTP API for JS-rendered scraping.
// Works on Railway (binds 0.0.0.0 and uses process.env.PORT).

const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * POST /scrape
 * Body: {
 *   url: string (required),
 *   waitSelector?: string,
 *   maxScrolls?: number,
 *   scrollDelayMs?: number,
 *   adSelector?: string
 * }
 */
app.post('/scrape', async (req, res) => {
  const {
    url,
    waitSelector = null,
    maxScrolls = 6,
    scrollDelayMs = 1200,
    adSelector = '[data-ad], .ad, [id*="ad-"], [class*="ad-"], a[href*="adclick"], [class*="sponsor"], [data-testid*="ad"] img, img[src*="ads"], img[data-src*="ads"]',
  } = req.body || {};

  if (!url) return res.status(400).json({ ok: false, error: "Missing 'url' in request body" });

  const browser = await chromium.launch({
    headless: true,
    args: [
      '--no-sandbox',
      '--disable-dev-shm-usage',   // safer in small /dev/shm containers
    ],
  });

  const context = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Jerusalem',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    viewport: { width: 1366, height: 900 },
  });

  const page = await context.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60_000 });
    await page.waitForLoadState('networkidle', { timeout: 20_000 }).catch(() => {});

    // Trigger lazy/infinite loading so ad slots populate
    for (let i = 0; i < Number(maxScrolls) || 0; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await sleep(Number(scrollDelayMs) || 1200);
      await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
    }

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 15_000 }).catch(() => {});
    }

    // Extract likely ads. Tweak adSelector per target site.
    const ads = await page.evaluate((SEL) => {
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
        // Prefer a concrete <img> inside container
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
    }, adSelector);

    res.json({ ok: true, url, count: ads.length, ads });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e) });
  } finally {
    await browser.close();
  }
});

// Simple health check
app.get('/', (_req, res) => res.send('Playwright scraper OK'));

// Railway provides PORT – bind to 0.0.0.0
const PORT = process.env.PORT || 3000;
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));

// Graceful shutdown (Railway deploys/tears down containers)
process.on('SIGTERM', () => process.exit(0));
process.on('SIGINT', () => process.exit(0));
