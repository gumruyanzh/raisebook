/**
 * schema.org structured data (JSON-LD) for the public pages. Facts only: no ratings, reviews,
 * user counts or awards, because Raisebook has none to cite.
 */

import { REPO_URL, SITE_URL } from "@/components/marketing/site";

import { DEFINITION, FEATURES, OPERATOR } from "./facts";
import type { FaqItem } from "./faq";
import { crumbs, ogPath, page } from "./pages";

type Json = Record<string, unknown>;

const ORG_ID = `${SITE_URL}/#organization`;
const APP_ID = `${SITE_URL}/#software`;
const SITE_ID = `${SITE_URL}/#website`;
const LICENSE = "https://www.gnu.org/licenses/agpl-3.0.html";

export const abs = (path: string) => `${SITE_URL}${path === "/" ? "" : path}`;

export function organization(): Json {
  return {
    "@type": "Organization",
    "@id": ORG_ID,
    name: "Raisebook",
    url: SITE_URL,
    logo: `${SITE_URL}/apple-icon.png`,
    email: OPERATOR.email,
    sameAs: [REPO_URL],
    founder: { "@type": "Person", name: OPERATOR.name },
    contactPoint: { "@type": "ContactPoint", contactType: "customer support", email: OPERATOR.email },
  };
}

export function website(): Json {
  return {
    "@type": "WebSite",
    "@id": SITE_ID,
    name: "Raisebook",
    url: SITE_URL,
    description: DEFINITION,
    publisher: { "@id": ORG_ID },
    inLanguage: "en",
  };
}

export function softwareApplication(): Json {
  return {
    "@type": "SoftwareApplication",
    "@id": APP_ID,
    name: "Raisebook",
    url: SITE_URL,
    description: DEFINITION,
    applicationCategory: "BusinessApplication",
    applicationSubCategory: "Investor CRM",
    operatingSystem: "Web",
    isAccessibleForFree: true,
    license: LICENSE,
    offers: { "@type": "Offer", price: "0", priceCurrency: "USD", availability: "https://schema.org/InStock" },
    featureList: FEATURES.map((f) => f.name),
    keywords: "investor CRM, fundraising CRM, investor pipeline tracker, seed round tracker, open source CRM, MCP server",
    publisher: { "@id": ORG_ID },
    author: { "@id": ORG_ID },
    sameAs: [REPO_URL],
  };
}

export function sourceCode(): Json {
  return {
    "@type": "SoftwareSourceCode",
    name: "Raisebook",
    codeRepository: REPO_URL,
    license: LICENSE,
    programmingLanguage: ["Python", "TypeScript"],
    targetProduct: { "@id": APP_ID },
    author: { "@id": ORG_ID },
  };
}

export function faqPage(items: FaqItem[], path: string): Json {
  return {
    "@type": "FAQPage",
    "@id": `${abs(path)}#faq`,
    mainEntity: items.map((it) => ({
      "@type": "Question",
      name: it.q,
      acceptedAnswer: { "@type": "Answer", text: it.a },
    })),
  };
}

export function breadcrumbList(path: string): Json {
  return {
    "@type": "BreadcrumbList",
    itemListElement: crumbs(path).map((c, i) => ({
      "@type": "ListItem",
      position: i + 1,
      name: c.name,
      item: abs(c.path),
    })),
  };
}

/** The page node: TechArticle for docs, Article for guides and comparisons, else WebPage. */
export function webPage(path: string): Json {
  const p = page(path);
  const type = p.section === "docs" ? "TechArticle" : p.section === "guide" || p.section === "compare" ? "Article" : "WebPage";
  const node: Json = {
    "@type": type,
    "@id": `${abs(path)}#page`,
    url: abs(path),
    name: p.absoluteTitle ?? p.title,
    description: p.description,
    dateModified: p.updated,
    inLanguage: "en",
    isPartOf: { "@id": SITE_ID },
    about: { "@id": APP_ID },
    image: `${SITE_URL}${ogPath(path)}`,
  };
  if (type !== "WebPage") {
    node.headline = p.title;
    node.author = { "@id": ORG_ID };
    node.publisher = { "@id": ORG_ID };
  }
  return node;
}

/** A graph for one page: the page and its breadcrumbs, plus anything extra. */
export function graph(...nodes: Json[]): Json {
  return { "@context": "https://schema.org", "@graph": nodes };
}

export function pageGraph(path: string, ...extra: Json[]): Json {
  return graph(webPage(path), breadcrumbList(path), ...extra);
}
