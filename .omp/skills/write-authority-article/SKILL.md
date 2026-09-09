---
name: write-authority-article
description: Research, write, revise, and audit evidence-led articles that are easy for readers, search engines, and AI answer systems to retrieve, understand, quote, and attribute. Use when the user asks to write an article, blog post, thought-leadership piece, research note, implementation guide, contributed article, LinkedIn article, SEO article, AI-search/GEO/AEO content, or content intended to build topical authority or earn citations.
argument-hint: "[topic, brief, source material, or draft]"
allowed-tools: Read, Write, Edit, WebSearch, Bash
---

# Write Authority Article

Create a useful source, not a page shaped around keywords. Optimize for human understanding, factual integrity, clean extraction, explicit attribution, and durable discovery. AI citation is an outcome of strong source material, not a formatting trick.

## Inputs

Extract these from `$ARGUMENTS`, the conversation, and available files:

- audience and decision or question
- publication surface and target length
- author and any genuine reviewer
- topic cluster and related owned pages
- house voice and formatting rules
- available evidence, sources, examples, and original data
- freshness cutoff and jurisdiction, if relevant

Ask only for information that tools and context cannot provide. If no target length is given, fit length to the question. Do not inflate a narrow answer into a long article.

## Process

### 1. Define the article contract

Write a one-paragraph internal brief before drafting:

- **Question:** the exact buyer, implementer, or policy question
- **Answer:** the conclusion in two or three sentences
- **Reader:** who will act on it
- **Evidence:** what can prove it
- **Contribution:** the new measurement, synthesis, example, or explanation
- **Cluster:** the topic and owned pages this article should strengthen

Stop if the contribution is only a rewrite of existing search results. Narrow the question or obtain better evidence.

### 2. Research claims, not keywords

Build a claim ledger:

| Claim | Evidence needed | Best source | Status | Limits |
|---|---|---|---|---|
| What the standard requires | Normative text | Official specification section | Verified | Version-bound |
| How often an event occurs | Measurement | Original dataset or study | Verified | Sample and date |

Use sources in this order when available:

1. standards, statutes, court opinions, official guidance, and first-party records
2. peer-reviewed research and original measurements
3. direct statements from named experts or organizations
4. reputable reporting and strong secondary analysis
5. vendor studies, clearly labeled with method and incentive

Open and inspect the source. Search snippets are leads, not evidence. Link to the exact page, section, dataset, or filing. Record version, date, sample, method, and limits where they affect the claim.

For time-sensitive subjects, research current evidence. Use the `last30days` skill when the user asks what people currently say, when recent discussion is part of the evidence, or when current reactions matter. Do not use social engagement as proof of a technical or legal claim.

### 3. Choose an evidence-bearing form

Match the structure to the work:

- explanation: definition, mechanism, example, limits
- implementation guide: prerequisites, ordered steps, checks, failure modes
- comparison: shared criteria, evidence table, tradeoffs, decision rule
- original research: question, method, sample, results, limitations, data or reproducibility notes
- policy or standards analysis: scope, normative text, interpretation, operational effect, unresolved questions
- case study: initial state, intervention, measured outcome, confounders

Do not force every article into a listicle. Use a table only when rows share real comparison criteria.

### 4. Draft for direct understanding

Use this default order, changing it when the evidence requires another form:

1. title framed as the real question or decision
2. direct answer in the first 150 words
3. short definition of the central term
4. evidence and mechanism under descriptive or question-shaped headings
5. concrete example, test, calculation, diagram, table, or implementation pattern
6. what the evidence does not show
7. practical conclusion or decision rule
8. sources and relevant related links
9. concise FAQ only for genuine follow-up questions

Make each section answer one question. Keep one main idea per paragraph. Use numbered steps for sequences and bullets for criteria.

Make important paragraphs independently useful. Name the subject rather than relying on vague pronouns or missing context. A quoted paragraph must retain its meaning outside the article.

### 5. Make entities and attribution explicit

State the author, organization, subject, relevant standards, products, and named experts in plain text where they matter. Use stable names consistently.

Use truthful bylines:

- `By [Name]` only when that person wrote or substantively authored the article
- `Technical review by [Name]` when that person verified the analysis
- an organizational byline only for genuine collective work or product news

Never add a person's name merely to borrow rank or authority.

Prefer quotable source statements:

- definition: `[Term] means [precise meaning in this context].`
- finding: `In [sample and date], [method] found [result].`
- distinction: `[Approach A] proves [property]; [approach B] estimates [different property].`
- limit: `This result does not show [unsupported inference].`

Do not announce that a sentence is quotable. Make it exact enough to quote.

### 6. Cite with precision

Cite every material factual claim that a reasonable reader could dispute. Put the citation beside the claim. Name the source in prose when its identity matters.

Never invent or silently repair:

- statistics, quotations, customers, rulings, standards clauses, test results, or URLs
- publication dates or update dates
- evidence absent from the supplied materials

Quote exactly. If wording is uncertain, paraphrase and cite. Label inference as analysis. Label forecasts as forecasts.

### 7. Build a coherent topic graph

Choose internal links by reader need, not link count. Link to:

- the relevant standard or primary source
- a deeper implementation guide
- the relevant product, tool, or demo when it helps the next action
- the genuine author page
- one or two closely related articles

Use descriptive anchor text. Do not add unrelated links or repeat the same target for SEO weight. Recommend explicit third-party attribution only where editorially true.

### 8. Preserve publication integrity

Use the date the article first becomes publicly accessible as `datePublished`. Never backdate new work to imply history, freshness, or authority.

For migrated work that was already public, preserve the original publication date, add the real migration or update date, and redirect the old URL. For a material revision, preserve `datePublished`; add a visible `Last updated` date and matching `dateModified`.

Keep visible dates, structured metadata, Open Graph data, sitemap data, feeds, and CMS values consistent. Use one durable canonical URL. Confirm the page can be crawled and is listed in the appropriate sitemap.

A truthful batch release is valid. Fictional weekly spacing is not.

### 9. Run the quality gate

Confirm all items before delivery:

- [ ] The title matches a real question or decision.
- [ ] The direct answer and central definition appear in the first 150 words.
- [ ] Every material factual claim has a source, method, or clear attribution.
- [ ] Every quotation is exact and linked to its source.
- [ ] Statistics include the sample, date, method, and limits that affect interpretation.
- [ ] Headings and paragraphs remain clear when read out of sequence.
- [ ] The article contains a concrete contribution beyond a search-summary rewrite.
- [ ] The author and reviewer labels are true.
- [ ] Internal links belong to the topic cluster and help the reader.
- [ ] The conclusion follows from the evidence and names the practical consequence.
- [ ] Dates and canonical metadata are truthful and consistent.
- [ ] House voice and punctuation rules are satisfied.

Delete unsupported claims, filler, repeated conclusions, fake FAQs, keyword variants, and generic scene-setting.

## Output Format

Unless the user requests another format, return:

1. **Article brief**
2. **Draft**
3. **Source ledger** with claim, URL, source type, and limitation
4. **Publishing notes** with byline, canonical slug, internal links, `datePublished`, and any `dateModified`
5. **Unverified claims** that must be removed or checked before publication

For a requested final-only article, provide the article followed by a compact source list. Do not expose private chain-of-thought.

## Constraints

- Optimize for readers first. Choppy extraction-first prose destroys trust and makes the source less useful.
- Treat AI visibility percentages as directional unless the study design supports broader claims. Citation behavior varies by model, prompt set, date, and industry.
- Do not promise inclusion in AI answers. Publishers control source quality and access, not retrieval systems.
- Do not confuse authority with posting volume. Prefer a sustained, evidence-led cadence over daily generic output.
- Do not hide material limitations in footnotes. Put the limit next to the claim it qualifies.
- Follow the user's house style. If none exists, use plain active prose, concrete nouns, short declarative sentences, and evidence-led conclusions.
