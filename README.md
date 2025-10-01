# Railway Playwright Scraper + Analyzer

A microservice that:
- `/scrape` → Uses Playwright to load Ynet (or any site), scroll, capture ads (DOM, iframes, network).
- `/analyze` → Downloads ad image, computes palette, OCR text, CTA words.
- `/generate` → Generates Guardio mockups (PNG banners) as a ZIP.

## Run locally

```bash
npm install
node server.js
