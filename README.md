# 📊 Journey Budget (`journey-budget`)

**Data-Cost Budget for User Journeys** A local-first TypeScript/Node.js CLI and CI/CD automation tool that measures browser-observed network transfer, elapsed duration, cache efficiency, and estimated mobile data cost across multi-step web user journeys.

---

## 🎯 The Problem We Solve

Developers often inspect a single page load in browser DevTools, but real users complete **multi-step journeys**: signing in, searching for a product, submitting a form, loading dashboard data, or completing checkout.

A single code change such as a heavier JavaScript chunk, missing `gzip`/`brotli` compression, unoptimized images, duplicate API fetches, or broken `Cache-Control` headers can silently multiply the network data required to complete a user flow. This is especially critical for users on metered or expensive mobile data plans.

`journey-budget` helps engineering teams answer five practical questions automatically locally and on every GitHub Pull Request:
1. **How much network data did this user journey transfer (upload + download)?**
2. **How long did the journey take under controlled test conditions?**
3. **Which journey step and resource types (`Script`, `Stylesheet`, `Font`, `Image`, `Fetch`) contributed most to the total?**
4. **How does a repeat visit (`warm` cache) compare with a first visit (`cold` cache), or how does this run compare with an approved baseline?**
5. **Did the journey exceed the data transfer or duration budgets configured by the team?**

---

## 🚀 Quick Start

### 1. Install in Your Project

```bash
npm install --save-dev journey-budget
npx playwright install chromium
```

### 2. Initialize Configuration & GitHub Actions CI Workflow

Run `init` with `--ci` to generate both a starter `journey-budget.config.json` and a ready-to-use `.github/workflows/journey-budget.yml` pipeline:

```bash
npx journey-budget init --ci
```

### 3. Configure Your User Journey (`journey-budget.config.json`)

```json
{
  "baseUrl": "http://localhost:3000",
  "journeys": [
    {
      "name": "login",
      "steps": [
        { "name": "open-login", "action": "navigate", "url": "/login" },
        { "name": "enter-email", "action": "fill", "selector": "input[type=\"email\"]", "value": "user@example.com" },
        { "name": "enter-password", "action": "fill", "selector": "input[type=\"password\"]", "value": "secret" },
        { "name": "submit-login", "action": "click", "selector": "button[type=\"submit\"]" },
        { "name": "wait-for-dashboard", "action": "wait-for", "selector": "[data-testid=dashboard]" }
      ]
    }
  ],
  "budgets": {
    "login": {
      "maxTransferMB": 0.5,
      "maxDurationMs": 4000
    }
  },
  "pricing": {
    "currency": "NGN",
    "pricePerGB": 500
  },
  "measurement": {
    "browser": "chromium",
    "cacheMode": "cold",
    "headless": true
  }
}
```

---

## 💻 CLI Commands

| Command | Description |
| :--- | :--- |
| `npx journey-budget init [--ci]` | Creates a starter `journey-budget.config.json` (and `.github/workflows/journey-budget.yml` when `--ci` is passed). |
| `npx journey-budget run [--save-baseline]` | Executes configured journeys in Chromium, prints the breakdown report, and saves results to `.journey-budget/runs/`. |
| `npx journey-budget report <journey>` | Displays the latest saved report for a journey without re-running the browser. |
| `npx journey-budget compare <journey>` | Compares the latest run of a journey against its saved baseline (enforcing cache-mode compatibility). |
| `npx journey-budget check` | Runs journeys, evaluates configured budgets, writes a Markdown table to `$GITHUB_STEP_SUMMARY` in CI, and exits with a non-zero code on failure. |

### Exit Codes (`journey-budget check`)
* **`0`**: All journeys succeeded and stayed within configured budgets.
* **`1`**: One or more configured data transfer or duration budgets were exceeded.
* **`2`**: Configuration validation error or browser/journey execution failure.

---

## 🏗️ Technical Architecture & Engineering Design

`journey-budget` is structured as a modular local-first pipeline:

```text
Developer Config (journey-budget.config.json)
  ↓
CLI & Runtime Validation (Commander.js + Zod Discriminated Unions)
  ↓
Playwright Journey Runner (Cold & Warm BrowserContext Lifecycle)
  ↓
CDP Network Collector (Chrome DevTools Protocol Network.* Events)
  ↓
Step Attribution & Resource Aggregation (Zero Double-Counting)
  ↓
Cost Estimation + Budget Evaluation + Baseline Comparison
  ↓
Privacy-Redacted Local Storage (.journey-budget/) + Terminal & GitHub PR Summary
```

### 1. Why Chrome DevTools Protocol (CDP) Instead of Playwright's `request.sizes()`?
Standard Playwright `request.sizes()` computes `responseBodySize = encodedDataLength - responseHeadersSize`. On HTTP cache hits (`encodedDataLength = 0`), Playwright subtracts cached header sizes from zero producing **negative body sizes** (e.g., `-216 B`) and hiding `304 Not Modified` wire revalidations behind `200 OK` page statuses.

`journey-budget` attaches a dedicated CDP session (`context.newCDPSession(page)`) and listens directly to `Network.*` events without enabling request interception (`page.route()`), preserving native browser HTTP caching:
* **`receivedBytes`**: Measured from `Network.loadingFinished.encodedDataLength` (exact response status line + headers + compressed body received over the wire).
* **`encodedBodyBytes` vs. `decodedBodyBytes`**: Distinguishes compressed wire bytes (`gzip`/`br`) from uncompressed resource sizes (`Network.dataReceived.dataLength`).
* **`requestHeaderBytes` & `requestBodyBytes`**: Reconstructed from `Network.requestWillBeSentExtraInfo` and `postData` / `postDataEntries`.
* **`transferBytes`**: `receivedBytes + requestHeaderBytes + requestBodyBytes` (total download + upload).
* **Explicit Cache Classification**: Distinguishes `network`, `network-revalidated` (`304`), `disk-cache`, `memory-cache`, `prefetch-cache`, and `service-worker` using explicit Chromium flags rather than guessing from zero byte counts.

### 2. Step Attribution Without Double-Counting
As the runner executes each configured step (`navigate`, `fill`, `click`, `wait-for`), it updates the active step on `StepNetworkCollector`.
* Every request records both `startedAtStep` and `completedAtStep`.
* Bytes are attributed to `startedAtStep`, while requests that remain in-flight across step boundaries are counted in `crossBoundaryRequestCount`.
* Journey totals are computed directly from underlying observations ensuring step totals and resource-type totals sum to 100% of the journey total without double-counting.

### 3. Cold Cache vs. Warm Cache Scenarios
* **`"cold"`**: Runs the journey in a fresh `BrowserContext` with an empty HTTP cache (measuring a first-time visit).
* **`"warm"`**: Executes an unmeasured warm-up pass in a fresh `BrowserContext` to populate the HTTP disk cache, closes the warm-up page, and measures the repeat journey in the same context (measuring how much data returning users save).

### 4. Data Cost Estimation & Privacy Redaction
* **Cost Formula**: Uses decimal gigabytes ($1\text{ GB} = 1,000,000,000\text{ bytes}$):
  $$\text{estimatedCost} = \left(\frac{\text{transferBytes}}{1,000,000,000}\right) \times \text{pricePerGB}$$
  *(Note: Browser-observed transfer measures HTTP application-layer bytes and does not claim to equal exact mobile carrier billing, which includes TCP/IP, TLS handshakes, and packet retransmissions.)*
* **Privacy Redaction**: Before saving reports to `.journey-budget/runs/` or `.journey-budget/baselines/`, sensitive query parameters (`token`, `access_token`, `api_key`, `key`, `secret`, `password`, `auth`, `code`, `session`, `signature`) are automatically redacted (`REDACTED`), and response bodies are never stored.

---

## 🧪 Development & Testing

```bash
# Run typecheck
npm run typecheck

# Run the full unit and integration test suite (Vitest + local HTTP socket fixture server)
npm test

# Build the CLI to dist/
npm run build
```

## 📄 License

ISC
