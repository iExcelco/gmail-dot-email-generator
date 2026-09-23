import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import { FAQ, SITE_URL, renderPage, structuredData, robotsTxt, sitemapXml, llmsTxt } from '../lib/seo.js';

const page = renderPage(fs.readFileSync(new URL('../service-page.html', import.meta.url), 'utf8'));

test('rendered page has no unfilled SEO markers', () => {
  assert.ok(!page.includes('SEO:'), 'every <!--SEO:...--> and /*SEO:...*/ marker is filled');
});

test('structured data is valid JSON with the expected types', () => {
  const block = page.match(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/);
  assert.ok(block, 'JSON-LD block present');
  const data = JSON.parse(block[1]);
  const types = data['@graph'].map((n) => n['@type']);
  for (const t of ['Organization', 'WebSite', 'WebPage', 'WebApplication', 'HowTo', 'FAQPage']) assert.ok(types.includes(t), t);
  assert.equal(JSON.parse(structuredData())['@graph'].length, data['@graph'].length);
});

test('visible FAQ and FAQPage JSON-LD say exactly the same thing', () => {
  const data = JSON.parse(structuredData());
  const faqPage = data['@graph'].find((n) => n['@type'] === 'FAQPage');
  assert.equal(faqPage.mainEntity.length, FAQ.length);
  const visible = [...page.matchAll(/<div class="gt-faq-item"><h3>(.*?)<\/h3>/g)].map((m) => m[1].replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/&amp;/g, '&'));
  assert.deepEqual(visible, faqPage.mainEntity.map((q) => q.name));
});

test('one h1, question-style h2s, intro above the tool, canonical on the vanity domain', () => {
  assert.equal((page.match(/<h1[\s>]/g) || []).length, 1);
  assert.ok((page.match(/<h2[\s>]/g) || []).length >= 6);
  assert.ok(page.indexOf('class="gt-lede"') < page.indexOf('id="emailInput"'), 'intro text comes before the tool');
  assert.ok(page.includes(`<link rel="canonical" href="${SITE_URL}" />`));
});

test('robots.txt welcomes search and AI crawlers, blocks the API, and points at the sitemap', () => {
  const robots = robotsTxt();
  for (const bot of ['GPTBot', 'ClaudeBot', 'PerplexityBot', 'Google-Extended']) assert.match(robots, new RegExp(`User-agent: ${bot}`));
  assert.match(robots, /Disallow: \/api\//);
  assert.match(robots, new RegExp(`Sitemap: ${SITE_URL}sitemap.xml`));
});

test('sitemap.xml and llms.txt', () => {
  assert.match(sitemapXml(), new RegExp(`<loc>${SITE_URL}</loc>`));
  const llms = llmsTxt();
  assert.match(llms, /^# Gmail Dot Trick Generator/);
  assert.match(llms, /^> /m, 'llms.txt summary blockquote');
  for (const { q } of FAQ) assert.ok(llms.includes(q), q);
});
