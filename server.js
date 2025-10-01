const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const sleep = ms => new Promise(r => setTimeout(r, ms));

app.post('/scrape', async (req, res) => {
  const {
    url,
    waitSelector = null,
    maxScrolls = 6,
    scrollDelayMs = 1200,
    adSelector = '[data-ad], .ad, [id*="ad-"], [class*="ad-"], a[href*="adclick"], [class*="sponsor"], [data-testid*="ad"] img, img[src*="ads"], img[data-src*="ads"]',
    headless = true,
  } = req.body || {};
  if (!url) return res.status(400).json({ ok:false, error:"Missing 'url'" });

  const browser = await chromium.launch({ headless, args: ['--no-sandbox'] });
  const ctx = await browser.newContext({
    locale: 'en-US',
    timezoneId: 'Asia/Jerusalem',
    userAgent:
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124 Safari/537.36',
  });
  const page = await ctx.newPage();

  try {
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 });
    await page.waitForLoadState('networkidle', { timeout: 20000 }).catch(()=>{});

    for (let i=0;i<maxScrolls;i++){
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await sleep(scrollDelayMs);
      await page.waitForLoadState('networkidle', { timeout: 8000 }).catch(()=>{});
    }

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: 15000 }).catch(()=>{});
    }

    const ads = await page.evaluate((sel) => {
      const candidates = Array.from(document.querySelectorAll(sel));
      const uniq = new Map();
      const linkOf = (el) => el.closest('a')?.href || null;

      for (const el of candidates) {
        const img = el.tagName === 'IMG' ? el : (el.querySelector('img') || el);
        const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
        if (!src) continue;
        const link = linkOf(el) || linkOf(img);
        const key = `${src}|${link||''}`;
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

    res.json({ ok:true, url, count: ads.length, ads });
  } catch (e) {
    res.status(500).json({ ok:false, error: String(e) });
  } finally {
    await browser.close();
  }
});

app.get('/', (_req,res) => res.send('Playwright OK'));
const PORT = process.env.PORT || 3000;   // ★ Railway gives you PORT
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));
