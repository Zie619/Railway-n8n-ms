# Railway Playwright Scraper

A minimal HTTP microservice that loads real web pages with Playwright, waits for JS to finish, scrolls to trigger ad slots, and returns extracted ad objects. Designed to be called from n8n (HTTP Request node).

## Endpoints

### `GET /`
Health check. Returns plain text.

### `POST /scrape`
**Body (JSON):**
```json
{
  "url": "https://example.com",
  "waitSelector": ".ad, [data-ad]",
  "maxScrolls": 6,
  "scrollDelayMs": 1200,
  "adSelector": "[data-ad], .ad, [id*=\"ad-\"], [class*=\"ad-\"]"
}
