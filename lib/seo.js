// Search + AI-answer content in one place, so the visible FAQ, the FAQPage JSON-LD and
// llms.txt can never drift apart. server.js fills the page's markers from here at startup.

export const SITE_URL = 'https://gmaildottrick.co/';
export const LAST_UPDATED = '2026-09-23';
const GOOGLE_DOTS_HELP = 'https://support.google.com/mail/answer/7436150';

// Plain text only (they are escaped for HTML and used verbatim in JSON-LD and llms.txt).
export const FAQ = [
  {
    q: 'Does the Gmail dot trick really deliver to one inbox?',
    a: 'Yes. Google confirms that dots don\'t matter in @gmail.com addresses, so john.smith@gmail.com, jo.hn.smith@gmail.com and johnsmith@gmail.com all deliver to the same Gmail inbox.'
  },
  {
    q: 'How many dot variations does a Gmail address have?',
    a: 'A username with n characters has 2^(n-1) dot placements, because each gap between two characters can hold a dot or not. A 9-character username like johnsmith has 256. This tool lists every one for usernames up to 17 characters (65,536 variations).'
  },
  {
    q: 'Does the dot trick work with Google Workspace or company email?',
    a: 'Dots don\'t: on work, school and other custom-domain Google accounts, dots change the address. Plus addressing does work there, so for a company address this tool keeps your address exactly as typed and lists +tag versions like name+signup@yourcompany.com.'
  },
  {
    q: 'What is the difference between the dot trick and plus addressing?',
    a: 'The dot trick adds dots to the username (j.ohnsmith@gmail.com). Plus addressing adds a tag after a + sign (johnsmith+newsletter@gmail.com). Both reach the same Gmail inbox. Dots only work on @gmail.com; +tags also work on Google Workspace. Some sign-up forms reject the + sign, while a dotted address looks like any normal address.'
  },
  {
    q: 'Does it work for Outlook, Yahoo or iCloud?',
    a: 'No. Only Gmail ignores dots in the username. This tool is built for Gmail and Google Workspace addresses.'
  },
  {
    q: 'What can I use Gmail dot variations for?',
    a: 'Testing without extra inboxes: run welcome series, abandoned-cart and post-purchase flows; submit forms and pop-ups to check tags, list routing and personalization; and give each teammate their own address for parallel QA, while every test email lands in one inbox.'
  },
  {
    q: 'Is this Gmail dot trick generator free?',
    a: 'Yes. No sign-up and no credit card. The address you enter is saved so iExcel can see how the tool is used, and you only get email from iExcel if you click "Email me the list".'
  }
];

const escHtml = (s) => String(s).replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
// JSON inside <script>: stop "</script>" from closing the tag early.
const safeJson = (v) => JSON.stringify(v, null, 2).replace(/</g, '\\u003c');

export function faqHtml() {
  return FAQ.map(({ q, a }) => `<div class="gt-faq-item"><h3>${escHtml(q)}</h3><p>${escHtml(a)}</p></div>`).join('\n            ');
}

export function faqJsonLd() {
  return {
    '@type': 'FAQPage',
    '@id': `${SITE_URL}#faq`,
    mainEntity: FAQ.map(({ q, a }) => ({ '@type': 'Question', name: q, acceptedAnswer: { '@type': 'Answer', text: a } }))
  };
}

const HOWTO_STEPS = [
  ['Paste your address', 'Paste or type your Gmail address. A Google Workspace (company) address works too.'],
  ['Pick Dots or +Tags', 'Recommended shows the 10 most readable dot variations, best pick first; All lists every dot placement in the same order. The +Tags tab lists +alias versions.'],
  ['Copy what you need', 'Click any row to copy one address, use Copy all for the whole list (one per line), or download a CSV.']
];

export function structuredData() {
  const org = { '@type': 'Organization', '@id': 'https://iexcel.co/#organization', name: 'iExcel', url: 'https://iexcel.co', logo: 'https://iexcel.co/iexcel_logo.png' };
  return safeJson({
    '@context': 'https://schema.org',
    '@graph': [
      org,
      { '@type': 'WebSite', '@id': `${SITE_URL}#website`, url: SITE_URL, name: 'Gmail Dot Trick', inLanguage: 'en', publisher: { '@id': org['@id'] } },
      {
        '@type': 'WebPage',
        '@id': `${SITE_URL}#webpage`,
        url: SITE_URL,
        name: 'Gmail Dot Trick Generator: Free Dot & Plus Aliases',
        description: 'Gmail ignores dots, so john.smith@gmail.com and johnsmith@gmail.com reach one inbox. List every dot and +tag variation of your Gmail address, then copy or export them.',
        isPartOf: { '@id': `${SITE_URL}#website` },
        about: { '@id': `${SITE_URL}#app` },
        mainEntity: { '@id': `${SITE_URL}#app` },
        dateModified: LAST_UPDATED,
        inLanguage: 'en',
        citation: GOOGLE_DOTS_HELP
      },
      {
        '@type': 'WebApplication',
        '@id': `${SITE_URL}#app`,
        name: 'Gmail Dot Trick Generator',
        url: SITE_URL,
        applicationCategory: 'UtilitiesApplication',
        operatingSystem: 'Any',
        browserRequirements: 'Requires JavaScript',
        isAccessibleForFree: true,
        offers: { '@type': 'Offer', price: '0', priceCurrency: 'USD' },
        description: 'Free tool that lists every dot variation and +tag alias of a Gmail address. Every variation delivers to the same inbox.',
        featureList: [
          'Every dot placement of a Gmail username (up to 65,536)',
          'Plus-address (+tag) aliases with custom tags',
          'Google Workspace addresses: +tag aliases only, since dots change those addresses',
          'Click any address to copy it; copy all or download a CSV',
          'Email the list to yourself'
        ],
        publisher: { '@id': org['@id'] }
      },
      {
        '@type': 'HowTo',
        '@id': `${SITE_URL}#howto`,
        name: 'How to use the Gmail dot trick generator',
        totalTime: 'PT1M',
        step: HOWTO_STEPS.map(([name, text], i) => ({ '@type': 'HowToStep', position: i + 1, name, text }))
      },
      faqJsonLd()
    ]
  });
}

export function howToHtml() {
  return HOWTO_STEPS.map(([name, text]) => `<li><strong>${escHtml(name)}.</strong> ${escHtml(text)}</li>`).join('\n            ');
}

// Fill the page's markers. Unknown markers are left alone.
export function renderPage(html) {
  return html
    .replace('<!--SEO:FAQ-->', faqHtml())
    .replace('<!--SEO:HOWTO-->', howToHtml())
    .replace('/*SEO:JSONLD*/', structuredData())
    .replace(/<!--SEO:UPDATED-->/g, LAST_UPDATED);
}

// Search engines and AI assistants are all welcome; only the API is off limits.
export function robotsTxt() {
  const agents = [
    '*', 'Googlebot', 'Bingbot', 'GPTBot', 'OAI-SearchBot', 'ChatGPT-User', 'ClaudeBot', 'Claude-SearchBot',
    'Claude-User', 'PerplexityBot', 'Perplexity-User', 'Google-Extended', 'Applebot', 'Applebot-Extended', 'DuckAssistBot'
  ];
  return `${agents.map((a) => `User-agent: ${a}`).join('\n')}\nAllow: /\nDisallow: /api/\n\nSitemap: ${SITE_URL}sitemap.xml\n`;
}

export function sitemapXml() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  <url>
    <loc>${SITE_URL}</loc>
    <lastmod>${LAST_UPDATED}</lastmod>
    <changefreq>monthly</changefreq>
    <priority>1.0</priority>
  </url>
</urlset>
`;
}

// https://llmstxt.org — a plain summary AI assistants can read and cite.
export function llmsTxt() {
  return `# Gmail Dot Trick Generator

> Free tool by iExcel (${SITE_URL}) that lists every dot variation and +tag alias of a Gmail address. Gmail ignores dots in the username, so john.smith@gmail.com and johnsmith@gmail.com deliver to the same inbox.

Last updated: ${LAST_UPDATED}

## Key facts

- Gmail ignores dots before the @ in @gmail.com addresses (Google: ${GOOGLE_DOTS_HELP}).
- A username with n characters has 2^(n-1) dot placements; johnsmith (9 characters) has 256.
- Plus addressing (name+tag@gmail.com) also delivers to the same inbox.
- On Google Workspace (company) addresses dots change the address, but +tags still work.
- Outlook, Yahoo and iCloud do not ignore dots.

## Tool

- [Gmail Dot Trick Generator](${SITE_URL}): paste an address, then click any variation to copy it, copy all, or download a CSV. Free, no sign-up.

## FAQ

${FAQ.map(({ q, a }) => `### ${q}\n\n${a}`).join('\n\n')}

## Publisher

- [iExcel](https://iexcel.co): digital marketing agency.
`;
}
