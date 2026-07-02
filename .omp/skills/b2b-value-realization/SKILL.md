---
name: b2b-value-realization
description: "Analyze B2B product codebases and provide strategic product feedback through the lens of value realization. Use when: reviewing product code for UX/value delivery issues, evaluating B2B product ideas, assessing onboarding flows, analyzing integration architecture, reviewing SDK/API design, auditing time-to-value in enterprise products, or when the user asks things like 'review my product', 'is this the right approach?', 'will customers adopt this?', 'what's wrong with our onboarding?', 'why is activation low?', 'how should we position this?', 'review this PR from a product lens', or 'what would you change about this product?'. Also trigger when the user mentions enterprise pilots, sales engineering, proof of concept, or developer adoption."
allowed-tools: [Read, WebFetch, WebSearch, Grep, Glob, Bash, ListDir]
---

# B2B Value Realization

A codebase-grounded framework for evaluating whether enterprise buyers, champions, and end users will discover clear value in a B2B product.

## What This Skill Does

Analyzes B2B product codebases and provides actionable product feedback. Unlike generic product frameworks, this skill:

- **Reads actual code** to ground analysis in implementation reality, not hypotheticals
- **Addresses multi-stakeholder dynamics** unique to B2B (buyer ≠ user ≠ champion)
- **Evaluates value/friction ratio** — what users gain vs. what adoption costs them
- **Assesses competitive displacement** — incremental value over existing alternatives
- **Produces actionable recommendations**, not just diagnoses

## Core Insight

B2B products fail when any stakeholder in the buying chain can't articulate the value in their own terms:

- **Buyers** need to justify spend: "This saves us $X" or "This mitigates risk Y"
- **Champions** need to sell internally: "This makes our team capable of Z"
- **End users** need motivation to change behavior: "This makes my job easier/better"
- **Procurement/Security** need to not block: "This meets our requirements"

If any layer can't articulate value → deal stalls or adoption fails post-sale.

## Analysis Process

When analyzing a product, follow this sequence:

### Step 0: Codebase Reconnaissance

Before any product analysis, understand what you're looking at.

**Actions:**
```
- Glob for project structure: package.json, README, /src, /docs, /api, /sdk
- Read README, CHANGELOG, and any /docs directory
- Grep for onboarding flows: "setup", "wizard", "getting-started", "quickstart"
- Grep for integration points: "webhook", "api-key", "oauth", "sdk", "plugin"
- Grep for dashboards/reporting: "analytics", "dashboard", "report", "metrics"
- Grep for pricing/plan logic: "tier", "plan", "billing", "usage", "limit"
- Identify the primary user-facing surfaces (UI, API, SDK, CLI, plugin)
```

**Establish:**
1. What is this product? (from code, not assumptions)
2. Who are the distinct user types? (roles, permissions, integration patterns)
3. What is the primary interaction surface? (dashboard, API, SDK, embedded widget)
4. What does the deployment/integration path look like?

### Step 1: Stakeholder Value Map

B2B products serve multiple stakeholders simultaneously. Map each one.

| Stakeholder | Question They Ask | Where to Find Evidence in Code |
|---|---|---|
| **Economic Buyer** (VP/C-suite) | "What's the ROI / risk reduction?" | Reporting dashboards, analytics exports, ROI calculators, executive summary views |
| **Champion** (Manager/Director) | "Will this make my team look good?" | Team features, collaboration flows, shareable reports, admin panels |
| **End User** (Daily operator) | "Does this make my day easier?" | Core UX flows, time-to-task-completion, automation features, integrations with existing tools |
| **Technical Evaluator** (Eng/IT) | "Can we integrate this without pain?" | SDK design, API docs, auth flows, error handling, deployment complexity |
| **Procurement/Security** | "Does this meet our requirements?" | SSO/SAML, audit logs, data residency, compliance certifications, security headers |

**Analysis method:**
- For each stakeholder, identify what exists in the codebase that serves their needs
- Flag gaps: if a stakeholder has no dedicated surface or value artifact, that's a risk
- Assess whether the value each stakeholder receives is **articulable** — can they explain it to their peers?

**Red flags in code:**
- No admin/reporting layer → Champions can't demonstrate value internally
- No analytics/metrics export → Buyers can't measure ROI
- No SSO/audit logs → Procurement will block the deal
- Complex integration with no SDK/examples → Technical evaluators will reject

### Step 2: Time-to-Value Audit

The most critical metric in B2B product adoption. Analyze the path from "account created" to "first value delivered."

**Codebase analysis:**
```
- Map the onboarding flow step by step (read the actual code/components)
- Count required configuration steps before first value
- Identify blocking dependencies (API keys, data imports, team setup, integrations)
- Find the earliest moment the product delivers something useful
- Measure conceptual distance from signup to "aha moment"
```

**Time-to-value tiers:**

| Tier | Time to First Value | Examples | Adoption Friction |
|---|---|---|---|
| **Instant** | < 5 minutes | Stripe test payment, Linear first issue | Minimal — self-serve works |
| **Session** | 5-60 minutes | Figma first design, Datadog first dashboard | Low — free trial converts |
| **Day** | 1-24 hours | Notion team setup, Slack workspace config | Medium — needs champion energy |
| **Week** | 1-7 days | Salesforce configuration, custom integrations | High — needs sales engineering |
| **Month+** | Weeks to months | Data platform migrations, enterprise rollouts | Very high — needs dedicated onboarding |

**The rule:** Every tier increase in time-to-value requires a corresponding increase in perceived value and sales support. A Month+ product with Session-tier perceived value will fail.

**What to look for in code:**
- Required fields/config before any value is shown (fewer = better)
- Seed data, demo modes, sandbox environments (presence = good sign)
- Progressive disclosure vs. configuration walls
- Hard dependencies on external data/integrations vs. standalone value

### Step 3: Value/Friction Ratio

Every B2B product imposes costs on adopters. Value must clearly exceed friction.

**Value side — assess from code:**
- What concrete outcome does the product deliver?
- How is that outcome made visible/measurable? (dashboards, reports, notifications)
- Can the outcome be attributed to the product specifically? (vs. ambient improvement)
- Is the value continuous (ongoing) or one-time?

**Friction side — assess from code:**
- **Integration complexity**: How many systems must be touched? How invasive is the integration?
- **Behavior change required**: Does this replace an existing workflow or add a new one?
- **Learning curve**: How much UI complexity before productive use?
- **Data requirements**: What data must be provided/migrated before value appears?
- **Maintenance burden**: Ongoing configuration, updates, monitoring needed?

**Ratio assessment:**
- Green **High value, low friction**: Product delivers clear outcomes with minimal integration/behavior change
- Yellow **High value, high friction**: Product delivers clear outcomes but adoption is expensive — needs strong sales/onboarding support
- Yellow **Low value, low friction**: Easy to adopt but unclear why you'd bother — "nice to have" territory
- Red **Low value, high friction**: Product requires significant effort for unclear return — dead on arrival

**Code signals for friction:**
- Large number of required ENV variables or configuration files
- Complex multi-step setup scripts
- Dependencies on specific infrastructure (particular databases, message queues, cloud providers)
- No fallbacks, defaults, or graceful degradation
- Tight coupling to customer's existing systems

### Step 4: Competitive Displacement Analysis

B2B products never enter a vacuum. They displace something — even if that something is a spreadsheet, manual process, or doing nothing.

**Analysis method:**
1. **Identify the incumbent**: What are customers doing today without this product?
2. **Assess switching cost**: What must customers give up or change to adopt?
3. **Quantify incremental value**: What specific, measurable improvement does this product offer over the incumbent?
4. **Evaluate lock-in dynamics**: Once adopted, how sticky is this product? What would switching away cost?

**The 10x rule of thumb**: Enterprise buyers generally need to perceive ~10x improvement over their current approach to justify the switching costs (evaluation time, integration work, training, risk). This isn't a rigid law — it's a useful heuristic for B2B.

**What to look for in code:**
- Import/migration tools (makes switching FROM incumbent easier)
- Export tools (reduces perceived lock-in risk, counterintuitively increases adoption)
- Integration with incumbent tools (coexistence strategy vs. rip-and-replace)
- Feature parity with common alternatives in the space

### Step 5: Value Perception & Proof

Enterprise buyers need proof. End users need visible progress. Champions need ammunition for internal advocacy.

**Assess what the product makes visible:**
- **For buyers**: ROI dashboards, usage analytics, cost savings calculators, benchmark comparisons
- **For champions**: Team activity reports, adoption metrics, before/after comparisons, shareable wins
- **For end users**: Task completion indicators, time saved notifications, quality improvements shown inline
- **For renewals**: Trend data, value delivered over time, risk of not renewing

**Code patterns that indicate strong value perception:**
- Analytics/telemetry tracking meaningful outcomes (not just clicks)
- Dashboard components that show business metrics, not just product metrics
- Export/share functionality for reports and results
- Notification systems that surface value proactively ("You saved X hours this month")
- Integration with customer's existing reporting tools (BI platforms, Slack digests)

**Code patterns that indicate weak value perception:**
- Analytics only track product usage (logins, clicks) not business outcomes
- No reporting or dashboard layer
- Value is delivered silently with no confirmation or proof
- No mechanism for champions to share results internally

### Step 6: Synthesis & Recommendations

After analyzing all dimensions, produce a structured assessment:

**Format:**
```
## Product Value Assessment: [Product Name]

### Summary
[2-3 sentence assessment of overall value realization health]

### Stakeholder Value Map
[Table with each stakeholder, their current value clarity, and gaps]

### Time-to-Value: [Tier]
[Current state, what's blocking faster time-to-value, specific code areas to address]

### Value/Friction Ratio: [Green/Yellow/Red]
[What the product delivers vs. what it costs to adopt, specific friction points in code]

### Competitive Position
[What this displaces, incremental value, switching cost assessment]

### Value Perception
[What's visible to each stakeholder, what's invisible, specific gaps]

### Priority Recommendations
1. [Highest impact change — specific, referencing actual code paths]
2. [Second priority — specific, referencing actual code paths]
3. [Third priority — specific, referencing actual code paths]

### Strategic Questions
[2-3 sharp questions that challenge assumptions or require decisions]
```

## B2B-Specific Patterns

### Pattern: The Champion Gap
**Symptom**: Product delivers real value to end users but deals stall or don't renew.
**Diagnosis**: No surface for the champion/buyer to see or prove the value being delivered.
**Code signal**: No admin panel, no team analytics, no exportable reports.
**Fix**: Build a "value proof" layer — even a simple dashboard showing usage + outcomes is often enough to unstick renewals.

### Pattern: The Integration Wall
**Symptom**: Great demo, great pilot kickoff, then silence. Activation never completes.
**Diagnosis**: Integration requires more effort than the champion has political capital to spend.
**Code signal**: Complex setup, many required integrations, no standalone value before full integration.
**Fix**: Find the thinnest possible integration that delivers some value. A JavaScript snippet beats an API integration. A browser extension beats a JavaScript snippet. A PDF report beats all of them.

### Pattern: The Feature Showcase
**Symptom**: Product has impressive capabilities but customers describe it in feature terms, not value terms.
**Diagnosis**: Product is organized around what it can do, not what customers achieve.
**Code signal**: Navigation/IA organized by feature ("Encryption", "Detection", "API") rather than outcome ("Protect Content", "Find Violations", "Prove Authenticity").
**Fix**: Restructure primary navigation and messaging around customer outcomes. Features become the "how," not the "what."

### Pattern: The Invisible Moat
**Symptom**: Product works well but customers view it as replaceable/commodity.
**Diagnosis**: Product's deepest value (data accumulation, network effects, learning) isn't visible to customers.
**Code signal**: Backend intelligence with no user-facing manifestation. Models improve but UI is static.
**Fix**: Surface the compounding value. Show customers what the product knows/does now vs. day one. Make the moat visible.

### Pattern: The Pilot Plateau
**Symptom**: Successful pilots that don't convert to enterprise contracts.
**Diagnosis**: Pilot proves the product works but doesn't prove it works at scale or justifies enterprise pricing.
**Code signal**: No multi-tenant features, no team management, no usage-based pricing hooks, no enterprise compliance features (SSO, audit logs).
**Fix**: Build the pilot-to-production bridge — features that specifically address the gap between "it works" and "it works for our organization."

## Codebase Analysis Checklist

When reviewing a B2B product codebase, always check:

**Onboarding & Activation:**
- [ ] What is the minimum path to first value?
- [ ] Are there setup wizards, quickstart guides, or seed data?
- [ ] How many external dependencies are required before value appears?
- [ ] Is there a sandbox/demo mode?

**Integration Architecture:**
- [ ] What integration methods exist? (SDK, API, webhook, plugin, snippet)
- [ ] What is the lightest possible integration?
- [ ] Are there fallbacks if integrations fail?
- [ ] How well-documented are integration paths?

**Value Surfaces:**
- [ ] Does a dashboard/analytics layer exist?
- [ ] What metrics are tracked — product metrics or business outcomes?
- [ ] Can results be exported or shared?
- [ ] Are there different views for different stakeholders?

**Enterprise Readiness:**
- [ ] SSO/SAML support
- [ ] Audit logging
- [ ] Role-based access control
- [ ] Multi-tenant architecture
- [ ] Data export capabilities

**Competitive Positioning:**
- [ ] Import/migration from alternatives
- [ ] Data export (reduces lock-in fear)
- [ ] Integration with adjacent tools in the customer's stack
- [ ] Clear differentiation visible in the product itself

## When This Framework Is Most Useful

**High applicability:**
- B2B SaaS products (any stage)
- Developer tools and platforms
- Enterprise infrastructure
- API-first products
- Products with complex buying cycles
- Products transitioning from pilot to enterprise sales

**Moderate applicability:**
- B2B2C platforms (analyze the B2B layer, note where B2C dynamics differ)
- Marketplace/platform businesses (multi-sided value dynamics add complexity)
- Open source with commercial layer (community value ≠ enterprise value)

**Lower applicability:**
- Pure consumer products (different buying psychology entirely)
- Commodity/utility products with no switching costs
- Products where regulatory mandate drives adoption (compliance-driven buying)

## Principles

1. **Read the code first.** Opinions without evidence are noise. Ground every observation in something you found in the codebase.
2. **Map all stakeholders.** A product that delights end users but gives champions nothing to show the CFO will churn.
3. **Measure time-to-value honestly.** Count every step, every config, every dependency. The customer does.
4. **Value must exceed friction by a wide margin.** In B2B, the bar is higher because switching costs and organizational inertia are real.
5. **Invisible value is no value.** If the product can't prove what it delivered, the renewal is at risk.
6. **Competitive displacement is the real test.** "Is this better than what I'm doing today?" is the only question that matters. "Today" might be a competitor, a spreadsheet, a manual process, or doing nothing.
7. **Be specific.** Reference file paths, function names, component structures. Vague product advice is worthless.
