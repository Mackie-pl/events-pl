# Google-fidelity SERP API pricing comparison

Verified against vendor pricing pages, 30 July 2026. All rates normalized to **USD per 1,000 queries at default depth (top 10 results, US locale)**.

---

## 1. Headline: cost per 1,000 queries by plan

### Serper — prepaid credit packs
| Pack | Price | Credits | $/1k |
|---|---|---|---|
| Free | $0 | 2,500 | — |
| Starter | $50 | 50,000 | **$1.00** |
| Standard | $375 | 500,000 | **$0.75** |
| Scale | $1,250 | 2,500,000 | **$0.50** |
| Ultimate | $3,750 | 12,500,000 | **$0.30** |

⚠️ Two gotchas: **credits expire 6 months** after purchase, and a query returning **11–100 results costs 2 credits** — doubling every rate above if you need depth >10.
⚠️ Pack prices are not on a public vendor page (`serper.dev/pricing` 404s as of July 2026); figures come from third-party breakdowns. Confirm in-account before committing.

### DataForSEO — pay-as-you-go, priced per SERP (10 results)
| Mode | Latency | $/SERP | $/1k |
|---|---|---|---|
| Standard, normal priority | ~5 min avg (45 min guaranteed) | $0.0006 | **$0.60** |
| Standard, high priority | ~1 min avg | $0.0012 | **$1.20** |
| **Live** | ~6 s avg | $0.002 | **$2.00** |

$50 minimum deposit. Credits **never expire**. Search operators (`site:`, `intitle:` …) multiply base price ×5.

### Bright Data — SERP API
| Plan | $/1k |
|---|---|
| Pay-as-you-go | **$1.50** |
| Scale ($499/mo) | **$1.30** |

5,000 free records/month. Bills only successful requests; retries, async "collect" calls, parsing and bandwidth all included.

### SearchApi.io — monthly subscription
| Plan | Price | Searches | $/1k |
|---|---|---|---|
| Developer | $40 | 10,000 | **$4.00** |
| Production | $100 | 35,000 | **$2.86** |
| BigData | $250 | 100,000 | **$2.50** |
| Scale | $500 | 250,000 | **$2.00** |
| Octo 500K | $900 | 500,000 | **$1.80** |
| Octo 1M | $1,500 | 1,000,000 | **$1.50** |
| Octo 2M | $2,800 | 2,000,000 | **$1.40** |
| Octo 5M | $5,000 | 5,000,000 | **$1.00** |

100 free requests. Only 200-status responses billed. **Rate cap: max 20% of plan credits per hour.** Legal Protection Guarantee (up to $2M, worldwide, US law) from Production tier up.

### ScraperAPI — credit-based; **Google costs 25 credits per request**
| Plan | Price | Credits | Google queries | $/1k |
|---|---|---|---|---|
| Hobby | $49 | 100,000 | 4,000 | **$12.25** |
| Startup | $149 | 1,000,000 | 40,000 | **$3.73** |
| Business | $299 | 3,000,000 | 120,000 | **$2.49** |
| Scaling | $475 | 5,000,000 | 200,000 | **$2.38** |
| Professional | $975 | 10,500,000 | 420,000 | **$2.32** |
| Advanced | $1,975 | 21,500,000 | 860,000 | **$2.30** |

The 25× Google multiplier is the whole story here — the advertised "$49 for 100k credits" is really 4,000 Google searches. Credits don't roll over. ScraperAPI acquired Traject Data (ValueSERP / ScaleSERP) — those brands now sit under the same roof.

### SerpApi — monthly subscription
| Plan | Price | Searches | $/1k | Throughput |
|---|---|---|---|---|
| Free | $0 | 250 | — | 50/hr |
| Starter | $25 | 1,000 | **$25.00** | 200/hr |
| Developer | $75 | 5,000 | **$15.00** | 1,000/hr |
| Production | $150 | 15,000 | **$10.00** | 3,000/hr |
| Big Data | $275 | 30,000 | **$9.17** | 6,000/hr |
| Enterprise | custom | custom | — | custom |

Cached/errored/failed searches not counted. Unused allowance resets monthly. SOC 2 Type II + ISO 27001, ZeroTrace mode, up to 99.97% uptime SLA.

---

## 2. Cost at three realistic volumes

Monthly cost for **live, synchronous** Google queries at depth 10 — i.e. what a user-facing search box actually needs.

| Provider | 10k/mo | 100k/mo | 1M/mo |
|---|---|---|---|
| **Serper** | $50 pack (≈$10 used) | ~$75–100 | **$300–500** |
| **DataForSEO (Live)** | **$20** | $200 | $2,000 |
| **DataForSEO (Standard queue)** | $6 | $60 | $600 — *but 5–45 min latency* |
| **Bright Data** | $15 | $150 (or $499 Scale) | $1,300–1,500 |
| **SearchApi** | $40 | $250 | $1,500 |
| **ScraperAPI** | $149 (Startup) | $299 | ~$2,300+ (Enterprise) |
| **SerpApi** | $150 | ~$900+ (Enterprise) | Enterprise quote |

Rough ordering by value for live search: **Serper < DataForSEO Live ≈ Bright Data < SearchApi < ScraperAPI < SerpApi.**

---

## 3. The latency trap

DataForSEO's headline $0.60/1k is the **async Standard queue**: ~5 minutes average, 45 minutes guaranteed. That's fine for nightly rank tracking, useless behind a search box. The apples-to-apples number for an app is **Live at $2.00/1k**, which puts DataForSEO mid-pack rather than cheapest.

Serper's positioning is the opposite: 1–2 second responses, and it's the cheapest per query. For a synchronous in-app search feature that combination is hard to beat.

---

## 4. Legal status — this changed in July 2026

Google sued SerpApi under the DMCA in December 2025. On **20 July 2026** the U.S. District Court for the Northern District of California (Chief Judge Yvonne Gonzalez Rogers) **granted SerpApi's motion to dismiss**:

- Anti-circumvention claims over standard organic results (URLs, snippets, factual index data) were dismissed **permanently** — these are publicly accessible facts, not copyrightable creative works.
- Claims touching genuinely copyrighted elements (e.g. licensed images in Knowledge Panels) were dismissed **with leave to amend** — Google has 21 days to show it was acting on behalf of the actual copyright owners.
- **No injunction was granted.** SerpApi continues operating.

This materially de-risks the whole category, though it's a district-court ruling that Google may amend or appeal. Note the ruling addresses *copyright/DMCA*; it doesn't resolve breach-of-ToS or CFAA theories, and it doesn't change your own obligations for how you use the data.

**Indemnification on offer:** SerpApi ("U.S. Legal Shield", all plans) and SearchApi (up to $2M, worldwide, Production tier and up) both accept legal responsibility for collection and parsing. Neither covers your use of the data. Serper, DataForSEO, Bright Data and ScraperAPI publish no comparable guarantee.

---

## 5. Hidden cost multipliers to check before you commit

| Multiplier | Who it hits |
|---|---|
| Depth >10 results doubles cost | Serper (2 credits for 11–100) |
| Google = 25 credits, not 1 | ScraperAPI |
| Search operators (`site:`, `intitle:`) ×5 | DataForSEO |
| Credits expire in 6 months | Serper |
| Allowance resets monthly, no rollover | SerpApi, SearchApi, ScraperAPI |
| Credits never expire | DataForSEO, Bright Data (PAYG) |
| Hourly throughput cap | SerpApi (by plan), SearchApi (20% of plan/hr) |
| $50 minimum deposit / pack | DataForSEO, Serper |

Also relevant: Google removed the `num=100` parameter, so deep result sets are now paginated multi-request jobs across every provider. Budget accordingly if you need more than the first page.

---

## 6. Recommendation

- **Prototype / <10k queries a month:** start on Serper's 2,500 free queries, then the $50 pack. Cheapest, fastest, lowest friction.
- **Production app, price-sensitive:** Serper at $0.50–0.75/1k, assuming you'll consume the pack inside six months and don't need depth >10.
- **Production app, want an indemnity:** SearchApi Production+ ($2.00–2.86/1k with the $2M guarantee) is the cheapest way to buy legal cover. SerpApi offers the strongest compliance posture (SOC 2, ISO 27001, ZeroTrace) but costs 4–10× more.
- **Batch/offline enrichment, latency-tolerant:** DataForSEO Standard queue at $0.60/1k is unbeatable, and credits never expire.
- **Avoid ScraperAPI for pure SERP work** unless you're already using it for general scraping — the 25× Google multiplier makes it uncompetitive per query.

---

## Sources

- [SerpApi — Plans and Pricing](https://serpapi.com/pricing)
- [SearchApi — Pricing](https://www.searchapi.io/pricing)
- [ScraperAPI — Pricing](https://www.scraperapi.com/pricing/) (Google = 25 credits, per pricing FAQ)
- [DataForSEO — SERP API cost explained](https://dataforseo.com/help-center/serp-api-cost-explained)
- [Bright Data — SERP pricing & billing docs](https://docs.brightdata.com/scraping-automation/serp-api/pricing-and-billing)
- [Serper.dev](https://serper.dev/) (free tier, speed claims) — pack prices via [ColdIQ](https://coldiq.com/blog/serper-pricing) / [Serpent API analysis](https://apiserpent.com/blog/serper-pricing-credits-explained)
- [SerpApi — Court Granted Our Motion to Dismiss (21 Jul 2026)](https://serpapi.com/blog/google-v-serpapi-the-court-granted-our-motion-to-dismiss/) + [court order PDF](https://serpapi.com/blog/content/files/2026/07/Order-Granting-Motion-to-Dismiss---Google-v.-SerpApi.pdf)
- [Google Custom Search JSON API — closed to new customers, EOL 1 Jan 2027](https://developers.google.com/custom-search/v1/overview)
