// server.js — capture cross-origin ad iframes + network images + bg-images
const express = require('express');
const { chromium } = require('playwright');

const app = express();
app.use(express.json({ limit: '2mb' }));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function withDeadline(promise, ms, msg='Timed out'){ let t; const to=new Promise((_,rej)=>t=setTimeout(()=>rej(new Error(msg)),ms)); try{ return await Promise.race([promise,to]); } finally{ clearTimeout(t); } }

const AD_HOST_RE = /(doubleclick|googlesyndication|googletagservices|gdoubleclick|adnxs|taboola|outbrain|adsystem|adservice|rubicon|criteo|pubmatic|yieldmo|openx|spotx|moat|zeotap|adform|tremor|innovid|adman|adengine|adserver|ads\.)/i;

app.get('/', (_req, res) => res.send('Playwright scraper OK'));

app.post('/scrape', async (req, res) => {
  const TOTAL_BUDGET_MS = Math.min(Number(process.env.REPLY_TIMEOUT_MS) || 55000, 110000);
  const started = Date.now();
  const remain = () => Math.max(0, TOTAL_BUDGET_MS - (Date.now() - started));

  const {
    url,
    waitSelector = null,
    maxScrolls = 4,           // keep modest to avoid 60s proxy limit
    scrollDelayMs = 700,
    adSelector = "[data-ad], .ad, [id*='ad-'], [class*='ad-'], [class*='advert'], [id*='google_ads'], [id^='google_ads'], a[href*='adclick'], [data-testid*='ad'] img, img[src*='ads'], img[data-src*='ads']"
  } = req.body || {};

  if (!url) return res.status(400).json({ ok: false, error: "Missing 'url' in request body" });

  let browser;
  const netImages = [];   // from network responses (image/* or ad hosts)
  const netOther = [];    // any request to ad hosts (e.g., HTML/JS iframes)

  try {
    browser = await withDeadline(chromium.launch({
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
    }), remain(), 'Browser launch timeout');

    const context = await withDeadline(browser.newContext({
      locale: 'he-IL',                       // Ynet is Hebrew; sometimes helps
      timezoneId: 'Asia/Jerusalem',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      viewport: { width: 1366, height: 900 },
    }), remain(), 'Context creation timeout');

    // NETWORK TAP
    context.on('response', async (resp) => {
      try {
        const req = resp.request();
        const url = req.url();
        const ct = resp.headers()['content-type'] || '';
        const frame = req.frame();
        const frameUrl = frame?.url() || null;

        if (ct.startsWith('image/')) {
          netImages.push({ image_url: url, via: 'network:image', referer: req.headers()['referer'] || null, frame_url: frameUrl });
        } else if (AD_HOST_RE.test(url)) {
          netOther.push({ url, via: 'network:adhost', referer: req.headers()['referer'] || null, frame_url: frameUrl, content_type: ct || null });
        }
      } catch {}
    });

    const page = await withDeadline(context.newPage(), remain(), 'Page creation timeout');

    await withDeadline(page.goto(url, { waitUntil: 'domcontentloaded', timeout: Math.min(remain(), 20000) }), remain(), 'Navigation timeout');

    // Let initial JS requests flush
    await page.waitForLoadState('networkidle', { timeout: Math.min(remain(), 8000) }).catch(() => {});

    // Gentle scrolling up & down to trigger lazy ads
    for (let i = 0; i < Number(maxScrolls) || 0; i++) {
      await page.evaluate(() => window.scrollBy(0, document.body.scrollHeight));
      await sleep(Number(scrollDelayMs) || 700);
      await page.waitForLoadState('networkidle', { timeout: Math.min(remain(), 4000) }).catch(() => {});
      await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }));
      await sleep(200);
    }

    if (waitSelector) {
      await page.waitForSelector(waitSelector, { timeout: Math.min(remain(), 6000) }).catch(() => {});
    }

    // 1) TOP-DOM: ad-labeled containers & imgs + CSS background-image
    const domTopAds = await withDeadline(page.evaluate(async (SEL) => {
      const seen = new Map();
      const out = [];

      // direct <img> and containers
      const nodes = Array.from(document.querySelectorAll(SEL));
      for (const el of nodes) {
        const img = el.tagName === 'IMG' ? el : (el.querySelector('img') || null);
        if (img) {
          const src = img.getAttribute('src') || img.getAttribute('data-src') || '';
          if (src) {
            const key = src + '|';
            if (!seen.has(key)) {
              seen.set(key, 1);
              out.push({
                image_url: src,
                link_url: (img.closest('a')?.href) || (el.closest('a')?.href) || null,
                alt: img.getAttribute('alt') || null,
                width: img.naturalWidth || null,
                height: img.naturalHeight || null,
                html: (el.outerHTML || '').slice(0, 2000),
                via: 'dom:img',
              });
            }
          }
        }
        // background-image
        const cs = el.nodeType === 1 ? getComputedStyle(el) : null;
        if (cs) {
          const bg = cs.backgroundImage || '';
          const m = /url\\(["']?([^"')]+)["']?\\)/i.exec(bg);
          if (m && m[1]) {
            const src = m[1];
            const key = src + '|bg';
            if (!seen.has(key)) {
              seen.set(key, 1);
              out.push({
                image_url: src,
                link_url: (el.closest('a')?.href) || null,
                alt: null,
                width: null,
                height: null,
                html: (el.outerHTML || '').slice(0, 2000),
                via: 'dom:bg',
              });
            }
          }
        }
      }
      return out;
    }, adSelector), remain(), 'Top-DOM extraction timeout');

    // 2) IFRAMES: list visible iframes (we can’t pierce cross-origin, but we can record src/rect)
    const iframeInfo = await withDeadline(page.evaluate(() => {
      const ifr = Array.from(document.querySelectorAll('iframe'));
      const out = [];
      for (const f of ifr) {
        const r = f.getBoundingClientRect();
        // only visible-ish iframes with some size
        if (r.width >= 10 && r.height >= 10) {
          out.push({
            iframe_src: f.getAttribute('src') || null,
            width: Math.round(r.width),
            height: Math.round(r.height),
            top: Math.round(r.top + window.scrollY),
            left: Math.round(r.left + window.scrollX),
            id: f.id || null,
            class: f.className || null,
            via: 'dom:iframe'
          });
        }
      }
      return out;
    }), remain(), 'Iframe listing timeout');

    // 3) Merge candidates
    //    - network images (likely creatives)
    //    - DOM top-level ads (imgs/bg)
    //    - attach any adhost network entries for context
    const adSet = new Map();

    const push = (obj) => {
      const key = (obj.image_url || obj.iframe_src || obj.url) + '|' + (obj.link_url || '') + '|' + (obj.via || '');
      if (!adSet.has(key)) adSet.set(key, obj);
    };

    domTopAds.forEach(push);

    netImages.forEach(n => {
      push({
        image_url: n.image_url,
        link_url: null,       // unknown from network alone
        alt: null,
        width: null,
        height: null,
        html: null,
        via: n.via,
        referer: n.referer,
        frame_url: n.frame_url,
      });
    });

    // keep the ad-host hits too (useful for GPT/analytics and de-dupe)
    netOther.forEach(n => push({ url: n.url, via: n.via, referer: n.referer, frame_url: n.frame_url }));

    // visible iframes (just context; many ads live here)
    iframeInfo.forEach(i => push(i));

    const ads = Array.from(adSet.values());

    res.json({
      ok: true,
      url,
      count: ads.length,
      ads,
      elapsed_ms: Date.now() - started
    });
  } catch (e) {
    res.status(500).json({ ok: false, error: String(e), elapsed_ms: Date.now() - started });
  } finally {
    if (browser) await browser.close();
  }
});

const PORT = process.env.PORT || 8080;
app.listen(PORT, '0.0.0.0', () => console.log('Listening on', PORT));
