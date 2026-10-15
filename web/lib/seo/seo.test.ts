import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";

import { COMPARISONS, OVERVIEW } from "./competitors";
import { HOME_FAQ, MORE_FAQ } from "./faq";
import { llmsFullTxt, llmsTxt } from "./llms";
import { PAGES, crumbs, ogSlug, pageForOgSlug } from "./pages";
import { breadcrumbList, faqPage, softwareApplication } from "./schema";

const MARKETING = join(process.cwd(), "app/(marketing)");

function pageFile(path: string): boolean {
  if (path === "/") return existsSync(join(MARKETING, "page.tsx"));
  if (path.startsWith("/compare/")) return existsSync(join(MARKETING, "compare/[slug]/page.tsx"));
  return existsSync(join(MARKETING, path.slice(1), "page.tsx"));
}

test("every registered page exists, once, with a unique share card", () => {
  const paths = PAGES.map((p) => p.path);
  assert.equal(new Set(paths).size, paths.length);
  const slugs = PAGES.map((p) => ogSlug(p.path));
  assert.equal(new Set(slugs).size, slugs.length);
  for (const p of PAGES) {
    assert.ok(pageFile(p.path), `no page file for ${p.path}`);
    assert.equal(pageForOgSlug(ogSlug(p.path))?.path, p.path);
    assert.match(p.updated, /^\d{4}-\d{2}-\d{2}$/);
    assert.ok(p.description.length >= 50 && p.description.length <= 260, `${p.path} description length ${p.description.length}`);
  }
});

test("every comparison has a registered page", () => {
  for (const c of COMPARISONS) {
    assert.ok(PAGES.some((p) => p.path === `/compare/${c.slug}`), c.slug);
    for (const r of c.rows) assert.equal(r.cells.length, c.columns.length + 1, `${c.slug}: ${r.label}`);
    for (const s of c.sources) assert.match(s.url, /^https:\/\//);
  }
  for (const row of OVERVIEW) assert.equal(row.length, 5);
});

test("breadcrumbs walk from home through registered parents", () => {
  assert.deepEqual(
    crumbs("/compare/visible").map((c) => c.path),
    ["/", "/compare", "/compare/visible"],
  );
  assert.deepEqual(crumbs("/docs/mcp").map((c) => c.name), ["Home", "Docs", "Connect an agent (MCP)"]);
  const list = breadcrumbList("/docs/mcp") as { itemListElement: { position: number; item: string }[] };
  assert.deepEqual(list.itemListElement.map((i) => i.position), [1, 2, 3]);
  assert.match(list.itemListElement[2].item, /\/docs\/mcp$/);
});

test("structured data stays factual: free offer, no ratings or reviews", () => {
  const app = softwareApplication() as { offers: { price: string; priceCurrency: string } };
  assert.equal(app.offers.price, "0");
  assert.equal(app.offers.priceCurrency, "USD");
  const json = JSON.stringify([app, faqPage(HOME_FAQ, "/")]);
  assert.doesNotMatch(json, /aggregateRating|"review"|ratingValue/);
});

test("FAQ structured data matches the visible questions", () => {
  const all = [...HOME_FAQ, ...MORE_FAQ.flatMap((g) => g.items)];
  const qs = all.map((f) => f.q);
  assert.equal(new Set(qs).size, qs.length, "duplicate question");
  const data = faqPage(HOME_FAQ, "/") as { mainEntity: { name: string; acceptedAnswer: { text: string } }[] };
  assert.deepEqual(
    data.mainEntity.map((m) => m.name),
    HOME_FAQ.map((f) => f.q),
  );
  assert.equal(data.mainEntity[0].acceptedAnswer.text, HOME_FAQ[0].a);
});

test("llms.txt states the facts and links every listed page", () => {
  const txt = llmsTxt();
  assert.match(txt, /^# Raisebook\n\n> /);
  for (const fact of ["$0", "20,000 investors", "50 rounds", "AGPL-3.0", "OpenRouter", "Google Calendar", "/v1", "21 tools"]) {
    assert.ok(txt.includes(fact), `llms.txt is missing ${fact}`);
  }
  for (const p of PAGES.filter((x) => x.llms)) assert.ok(txt.includes(`(https://raisebook.org${p.path === "/" ? "" : p.path})`), p.path);
  const full = llmsFullTxt();
  for (const c of COMPARISONS) assert.ok(full.includes(`### Raisebook vs ${c.name}`), c.slug);
  assert.doesNotMatch(full, /\bcustomers love\b|\btrusted by\b|\bstars?\b rating/i);
});
