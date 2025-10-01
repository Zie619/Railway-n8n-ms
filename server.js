// server.js — Playwright scraper + image analysis + ad generator
const express = require('express');
const { chromium } = require('playwright');
const crypto = require('crypto');
const sharp = require('sharp');
const { createCanvas, loadImage } = require('canvas');
const Tesseract = require('tesseract.js');
const archiver = require('archiver');

const app = express();
app.use(express.json({ limit: '10mb' }));

const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const sha1 = (buf) => crypto.createHash('sha1').update(buf).digest('hex');

// ---------------------
//  /scrape (Playwright)
// ---------------------
const AD_HOST_RE = /(doubleclick|googlesyndication|taboola|outbrain|adnxs|rubicon|pubmatic|criteo|openx|spotx|moat|yieldmo|ads\.)/i;

app.get('/', (_req, res) => res.send('Scraper server OK'));

app.post('/scrape', async (req, res) => {
  const { url, maxScrolls = 3, scrollDelayMs = 700 } = req.body || {};
  if (!url) return res.status(400).json({ ok: false, error: "Missing 'url'" });

  let browser;
  const netImages = [], netOther = [];
  const started = Date.now();
  try {
    browser = await chromium.launch({ headless: true, args: ['--no-sandbox'] });
    const context = await browser.newContext({
      locale: 'he-IL',
      userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36',
      viewport: { width: 1366, height: 900 }
    });

    context.on('response', async (resp) => {
      const req = resp.request();
      const u = req.url(); const ct = resp.headers()['content-type'] || '';
      if (ct.startsWith('image/')) {
        netImages.push({ image_url: u, via: 'network:image', referer: req.headers()['referer']||null });
      } else if (AD_HOST_RE.test(u)) {
        netOther.push({ url: u, via: 'network:adhost', referer: req.headers()['referer']||null });
      }
    });

    const page = await context.newPage();
    await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 20000 });
    await page.waitForLoadState('networkidle').catch(()=>{});

    for (let i=0;i<maxScrolls;i++) {
      await page.evaluate(()=>window.scrollBy(0,document.body.scrollHeight));
      await sleep(scrollDelayMs);
      await page.waitForLoadState('networkidle',{timeout:4000}).catch(()=>{});
      await page.evaluate(()=>window.scrollTo(0,0));
    }

    const domAds = await page.evaluate(()=>{
      const out=[]; const sel="[data-ad], .ad, img[src*='ads']";
      for (const el of document.querySelectorAll(sel)) {
        const img = el.tagName==='IMG'?el:el.querySelector('img');
        if (img) out.push({ image_url: img.src, via:'dom:img', alt: img.alt||null });
      }
      return out;
    });

    const ads = [...domAds, ...netImages, ...netOther];
    res.json({ ok:true, url, count: ads.length, ads, elapsed_ms: Date.now()-started });
  } catch(e) {
    res.status(500).json({ ok:false, error:String(e) });
  } finally {
    if (browser) await browser.close();
  }
});

// ----------------------
//  /analyze (features)
// ----------------------
const CTA_WORDS = ["לחצו","לפרטים","הירשם","קנה","Buy","Shop","Install","Sign","Up","Try","Free","Protect","Secure"];

app.post('/analyze', async (req,res)=>{
  try {
    const { image_url } = req.body;
    if (!image_url) return res.status(400).json({ ok:false,error:"image_url required" });

    const resp = await require('axios').get(image_url,{responseType:'arraybuffer',timeout:15000});
    const buf = Buffer.from(resp.data);
    const hash = sha1(buf);
    const meta = await sharp(buf).metadata();
    const palette = await sharp(buf).resize(32,32).raw().toBuffer().then(raw=>{
      // average color only for demo
      const [r,g,b]=[raw[0],raw[1],raw[2]];
      return [`#${r.toString(16)}${g.toString(16)}${b.toString(16)}`];
    });

    const img = await loadImage(buf);
    const c=createCanvas(img.width,img.height); const x=c.getContext('2d');
    x.drawImage(img,0,0);
    const ocr=await Tesseract.recognize(buf,"heb+eng");
    const words=(ocr.data.words||[]).map(w=>w.text);
    const ctas=CTA_WORDS.filter(c=>words.join(" ").toLowerCase().includes(c.toLowerCase()));

    res.json({
      ok:true,image_url,sha1:hash,
      width:meta.width,height:meta.height,
      palette,ocr_text:ocr.data.text.trim(),
      cta_words:ctas,has_cta:ctas.length>0,
      analyzed_ts:new Date().toISOString()
    });
  } catch(e){ res.status(500).json({ok:false,error:String(e)}); }
});

// ----------------------
//  /generate (mockups)
// ----------------------
app.post('/generate', async (req,res)=>{
  try {
    const { brand="Guardio", palettes=["#0b5fff","#10b981","#f59e0b"], ctaWords=["Protect","Secure"] } = req.body||{};
    res.setHeader("Content-Type","application/zip");
    res.setHeader("Content-Disposition","attachment; filename=ads.zip");
    const archive=archiver("zip"); archive.pipe(res);

    function draw(w,h,bg,cta){
      const c=createCanvas(w,h);const x=c.getContext("2d");
      x.fillStyle=bg;x.fillRect(0,0,w,h);
      x.fillStyle="#fff";x.font=`${Math.floor(h*0.15)}px sans-serif`;
      x.fillText(brand, w*0.1,h*0.3); x.fillText(cta,w*0.1,h*0.6);
      return c.toBuffer();
    }
    [[300,250],[728,90],[1080,1080]].forEach(([w,h],i)=>{
      archive.append(draw(w,h,palettes[i%palettes.length], ctaWords[i%ctaWords.length]),{name:`ad_${w}x${h}.png`});
    });
    await archive.finalize();
  } catch(e){ res.status(500).json({ok:false,error:String(e)}); }
});

// ----------------------
const PORT=process.env.PORT||8080;
app.listen(PORT,()=>console.log("Listening on",PORT));
