---
name: gsc-report
description: Query Google Search Console data for encypher.com — search analytics (clicks, impressions, CTR, position per page), URL indexing status, and coverage reports. Use when the user asks about SEO performance, indexing issues, search rankings, crawl status, which pages are indexed, Search Console data, or when investigating why a page isn't appearing in Google. Also triggers for "check indexing", "search performance", "GSC", or "coverage report".
argument-hint: "[analytics|inspect|coverage] [options]"
allowed-tools: Bash, Read
---

# Google Search Console Report

Query live Search Console data for encypher.com via the authenticated API.

## Prerequisites

The script at `scripts/gsc_report.py` must exist in the encypherai-commercial repo and a valid token must be cached at `scripts/.gsc_token.json`. If the token is missing or expired, inform the user they need to re-authenticate interactively.

## Commands

Run all commands with the uv binary at `/home/developer/.local/bin/uv` and set the env var `OAUTHLIB_INSECURE_TRANSPORT=1`.

### Search analytics (clicks, impressions, CTR, position)

```bash
OAUTHLIB_INSECURE_TRANSPORT=1 /home/developer/.local/bin/uv run scripts/gsc_report.py analytics --days 28
```

Options:
- `--days N` — lookback period (default: 28)
- `--limit N` — max rows (default: 100)
- `--query STRING` — filter URLs containing this string
- `--csv PATH` — export to CSV

### URL indexing inspection

```bash
OAUTHLIB_INSECURE_TRANSPORT=1 /home/developer/.local/bin/uv run scripts/gsc_report.py inspect --urls /platform /pricing /blog
```

Options:
- `--urls /path1 /path2` — specific URLs to inspect (default: all sitemap URLs)
- `--csv PATH` — export to CSV

Rate limit: 2000 URL inspections per day per property.

### Full coverage report (analytics + inspect)

```bash
OAUTHLIB_INSECURE_TRANSPORT=1 /home/developer/.local/bin/uv run scripts/gsc_report.py coverage --days 28
```

## How to interpret results

### Analytics output
- **Clicks**: actual visits from Google search
- **Impressions**: times the page appeared in search results
- **CTR**: click-through rate (clicks / impressions)
- **Position**: average ranking position (1 = top result)

### Inspect output
- **PASS**: page is indexed and serving in search results
- **NEUTRAL**: page was discovered but Google chose not to index it
- **FAIL**: page has an issue preventing indexing
- **Coverage states**: "Submitted and indexed" (good), "Crawled - currently not indexed" (Google saw it but skipped it), "Discovered - currently not indexed" (in queue but not yet crawled)

## When to use each command

| Scenario | Command |
|----------|---------|
| "How are our pages performing in search?" | `analytics` |
| "Is /platform indexed?" | `inspect --urls /platform` |
| "Which pages aren't indexed?" | `inspect` (all sitemap URLs) |
| "Full SEO health check" | `coverage` |
| "How did our blog do last week?" | `analytics --days 7 --query /blog` |

## Constraints

- Always run from the encypherai-commercial repo root (the script reads `.env.local` relative to repo root).
- The inspect command hits the URL Inspection API which has a 2000/day limit. For full sitemap inspections, warn the user about this limit.
- If authentication fails, do not attempt to re-authenticate programmatically. Tell the user to run the script interactively in their terminal.
