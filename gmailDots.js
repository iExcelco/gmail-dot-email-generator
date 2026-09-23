import { GMAIL_TYPO_MAP } from './lib/emailValidator.js';

const GMAIL_DOMAINS = new Set(['gmail.com', 'googlemail.com']);
// Big consumer inboxes that are definitely not Google. Dot/+alias tricks don't
// apply there, so these are rejected instead of being treated as Workspace.
const NOT_GOOGLE_DOMAINS = new Set([
  'yahoo.com', 'ymail.com', 'rocketmail.com', 'outlook.com', 'hotmail.com', 'live.com', 'msn.com',
  'icloud.com', 'me.com', 'mac.com', 'aol.com', 'proton.me', 'protonmail.com', 'pm.me',
  'gmx.com', 'gmx.net', 'zoho.com', 'yandex.com', 'yandex.ru', 'mail.com', 'comcast.net',
  'att.net', 'verizon.net', 'sbcglobal.net', 'qq.com', '163.com', 'fastmail.com', 'hey.com'
]);
const DEFAULT_MAX_VARIANTS = 65536;
const DEFAULT_MODE = 'wordSplit';
const MIN_WORD_SPLIT_SCORE = 15;

// Common +alias tags suggested when the user does not specify any of their own.
// Gmail (and any Google Workspace inbox) routes `user+anything@domain` back to
// `user@domain`, so these are useful for tracking where an address was used.
export const DEFAULT_PLUS_TAGS = Object.freeze([
  'signup', 'newsletter', 'promo', 'social', 'shop'
]);

// Gmail/Google Workspace local-part rules (post-dot-strip) only allow a-z 0-9.
// We are intentionally lenient on the +tag so users can pass things like
// "newsletter-1" or "shop_2025".
const PLUS_TAG_REGEX = /^[a-z0-9._-]+$/i;

function isValidWorkspaceDomain(domain) {
  if (typeof domain !== 'string') return false;
  const trimmed = domain.trim().toLowerCase();
  if (!trimmed || trimmed.length > 253) return false;
  // RFC 1035-ish: labels separated by dots, each label 1-63 chars,
  // alphanumeric with internal hyphens, must contain at least one dot,
  // and the TLD must be at least 2 chars and non-numeric.
  if (!/^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?(?:\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)+$/.test(trimmed)) {
    return false;
  }
  const tld = trimmed.split('.').pop();
  if (tld.length < 2 || /^\d+$/.test(tld)) return false;
  return true;
}

export function normalizePlusTags(input) {
  let raw;
  if (Array.isArray(input)) {
    raw = input;
  } else if (typeof input === 'string') {
    raw = input.split(/[\s,;]+/);
  } else if (input == null) {
    return [];
  } else {
    return [];
  }

  const seen = new Set();
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') continue;
    let tag = item.trim().toLowerCase();
    if (!tag) continue;
    if (tag.startsWith('+')) tag = tag.slice(1);
    if (!tag) continue;
    if (!PLUS_TAG_REGEX.test(tag)) continue;
    if (tag.length > 64) continue;
    if (seen.has(tag)) continue;
    seen.add(tag);
    out.push(tag);
  }
  return out;
}

const COMMON_FIRST_NAMES = new Set([
  'alex', 'andrew', 'anna', 'ben', 'chris', 'daniel', 'david', 'emma',
  'ethan', 'james', 'jane', 'john', 'josh', 'katie', 'mark', 'mary',
  'matt', 'michael', 'micah', 'olivia', 'ryan', 'sam', 'sarah', 'william'
]);

const COMMON_LAST_NAMES = new Set([
  'adams', 'anderson', 'berkley', 'brown', 'clark', 'davis', 'doe', 'evans',
  'garcia', 'harris', 'johnson', 'jones', 'lee', 'martin', 'miller', 'moore',
  'roberts', 'smith', 'taylor', 'thomas', 'walker', 'williams', 'wilson'
]);

export function parseGmailAddress(value, options = {}) {
  if (typeof value !== 'string') {
    return null;
  }

  const trimmed = value.trim();
  const atIndex = trimmed.indexOf('@');

  if (atIndex <= 0 || atIndex !== trimmed.lastIndexOf('@')) {
    return null;
  }

  const localRaw = trimmed.slice(0, atIndex);
  const domain = trimmed.slice(atIndex + 1).toLowerCase();

  // Domain acceptance:
  //   - default: gmail.com / googlemail.com (consumer Gmail)
  //   - Google Workspace mode: any valid domain explicitly allowed by the
  //     caller via `options.workspaceDomain` or `options.allowAnyDomain`.
  //     Workspace routes +tags like Gmail but does NOT ignore dots; see
  //     buildVariantSet, which only offers +tag versions for these.
  const allowedWorkspaceDomain = typeof options.workspaceDomain === 'string'
    ? options.workspaceDomain.trim().toLowerCase()
    : '';
  const allowAnyDomain = options.allowAnyDomain === true;

  const isGmailConsumer = GMAIL_DOMAINS.has(domain);
  const isAllowedWorkspace = !!allowedWorkspaceDomain
    && allowedWorkspaceDomain === domain
    && isValidWorkspaceDomain(domain);
  const isAnyValidDomain = allowAnyDomain && isValidWorkspaceDomain(domain);

  if (!isGmailConsumer && !isAllowedWorkspace && !isAnyValidDomain) {
    return null;
  }

  const plusIndex = localRaw.indexOf('+');
  const localBeforePlus = plusIndex === -1 ? localRaw : localRaw.slice(0, plusIndex);
  const plusTag = plusIndex === -1 ? '' : localRaw.slice(plusIndex).toLowerCase();

  // Gmail local part only permits letters, numbers, and dots.
  if (!/^[a-z0-9.]+$/i.test(localBeforePlus)) {
    return null;
  }

  if (plusTag && !/^\+[a-z0-9._-]+$/i.test(plusTag)) {
    return null;
  }

  // Dots are ignored by Gmail; normalize to base characters first.
  const casedLocal = localBeforePlus.replace(/\./g, '');
  const baseLocal = localBeforePlus.toLowerCase().replace(/\./g, '');

  if (!baseLocal) {
    return null;
  }

  return {
    baseLocal,
    casedLocal,
    // Local part exactly as typed (minus any +tag), dots kept. On Google
    // Workspace domains dots are part of the address, so this is the only
    // correct base there.
    rawLocal: localBeforePlus.toLowerCase(),
    plusTag,
    domain,
    isWorkspace: !isGmailConsumer
  };
}

/**
 * Generate +alias variants for a parsed address.
 *
 * Returns an array of unique addresses with each tag injected as a +alias on
 * the address. Includes the dot-stripped baseline first so callers can show
 * "user@domain" alongside the +tag versions.
 *
 * @param {object} parsed       - result of parseGmailAddress()
 * @param {object} [options]
 * @param {string|string[]} [options.tags] - tags to use (defaults to DEFAULT_PLUS_TAGS)
 * @param {string} [options.localOverride] - alternate local part (e.g. dot-split version)
 */
export function generatePlusTagVariants(parsed, options = {}) {
  if (!parsed || typeof parsed !== 'object') return [];

  const local = typeof options.localOverride === 'string' && options.localOverride
    ? options.localOverride
    : parsed.baseLocal;
  const domain = parsed.domain;

  const tags = options.tags === undefined
    ? [...DEFAULT_PLUS_TAGS]
    : normalizePlusTags(options.tags);

  if (!local || !domain) return [];

  const seen = new Set();
  const out = [];
  for (const tag of tags) {
    const addr = `${local}+${tag}@${domain}`.toLowerCase();
    if (seen.has(addr)) continue;
    seen.add(addr);
    out.push(addr);
  }
  return out;
}

function generateAllVariants(parsed) {
  const { baseLocal, plusTag, domain } = parsed;
  const splitPoints = Math.max(baseLocal.length - 1, 0);
  const variantsCount = 2 ** splitPoints;

  if (variantsCount > DEFAULT_MAX_VARIANTS) {
    throw new RangeError(
      `Generated permutations exceed maxVariants (${DEFAULT_MAX_VARIANTS}).`
    );
  }

  const variants = [];

  for (let mask = 0; mask < variantsCount; mask += 1) {
    let local = baseLocal[0];

    for (let i = 0; i < splitPoints; i += 1) {
      if ((mask & (1 << i)) !== 0) {
        local += '.';
      }
      local += baseLocal[i + 1];
    }

    variants.push(`${local}${plusTag}@${domain}`);
  }

  return variants;
}

function isLowerCaseLetter(char) {
  return char >= 'a' && char <= 'z';
}

function isUpperCaseLetter(char) {
  return char >= 'A' && char <= 'Z';
}

function chooseWordSplitIndex(casedLocal) {
  if (casedLocal.length < 2) {
    return null;
  }

  const lowerLocal = casedLocal.toLowerCase();
  let bestIndex = null;
  let bestScore = Number.NEGATIVE_INFINITY;

  for (let i = 1; i < casedLocal.length; i += 1) {
    const leftRaw = casedLocal.slice(0, i);
    const rightRaw = casedLocal.slice(i);
    const left = lowerLocal.slice(0, i);
    const right = lowerLocal.slice(i);

    let score = 0;

    if (isLowerCaseLetter(leftRaw[leftRaw.length - 1]) && isUpperCaseLetter(rightRaw[0])) {
      score += 50;
    }

    if (COMMON_FIRST_NAMES.has(left)) {
      score += 12;
    }

    if (COMMON_LAST_NAMES.has(right)) {
      score += 12;
    }

    if (COMMON_FIRST_NAMES.has(left) && COMMON_LAST_NAMES.has(right)) {
      score += 16;
    }

    if (left.length >= 3 && right.length >= 3) {
      score += 4;
    }

    if (left.length < 2 || right.length < 2) {
      score -= 20;
    }

    score -= Math.abs(left.length - right.length) * 0.8;

    if (score > bestScore) {
      bestScore = score;
      bestIndex = i;
    }
  }

  if (bestScore < MIN_WORD_SPLIT_SCORE) {
    return null;
  }

  return bestIndex;
}

function generateWordSplitVariants(parsed) {
  const { baseLocal, casedLocal, plusTag, domain } = parsed;
  const splitIndex = chooseWordSplitIndex(casedLocal);

  if (!splitIndex || splitIndex <= 0 || splitIndex >= baseLocal.length) {
    return [`${baseLocal}${plusTag}@${domain}`];
  }

  const local = `${baseLocal.slice(0, splitIndex)}.${baseLocal.slice(splitIndex)}`;
  return [`${local}${plusTag}@${domain}`];
}

export function generateGmailDotVariants(value, options = {}) {
  const parsed = parseGmailAddress(value, {
    workspaceDomain: options.workspaceDomain,
    allowAnyDomain: options.allowAnyDomain
  });

  if (!parsed) {
    return [];
  }

  const mode = options.mode ?? DEFAULT_MODE;

  if (mode === 'all') {
    return generateAllVariants(parsed);
  }

  if (mode === 'wordSplit') {
    return generateWordSplitVariants(parsed);
  }

  throw new TypeError(`Unsupported mode "${mode}". Use "wordSplit" or "all".`);
}

function dedupe(values) {
  return [...new Set(values)];
}

/**
 * How readable a dotted address looks, higher is better. Keeps the dot between
 * words (john.smith), prefers fewer dots, and penalises 1- and 2-letter pieces
 * (j.ohnsmith, jo.hnsmith), so the first suggestions look like real addresses.
 *
 * @param {string} address - a dot variant (plus tag, if any, is ignored)
 * @param {number|null} boundary - word-split index into the dot-free username
 */
export function readabilityScore(address, boundary) {
  const local = address.split('@')[0].split('+')[0];
  const segments = local.split('.');
  const dots = segments.length - 1;
  const lengths = segments.map((seg) => seg.length);
  let atBoundary = false;
  let chars = 0;
  for (const len of lengths.slice(0, -1)) {
    chars += len;
    if (chars === boundary) atBoundary = true;
  }
  const ones = lengths.filter((n) => n === 1).length;
  const twos = lengths.filter((n) => n === 2).length;
  return (atBoundary ? 100 : 0)
    - dots * 10
    - ones * 15
    - twos * 4
    + (Math.min(...lengths) >= 3 ? 5 : 0)
    - (Math.max(...lengths) - Math.min(...lengths)) * 0.5;
}

// Most readable first; ties keep their original order (Array#sort is stable).
function rankByReadability(addresses, boundary) {
  return addresses
    .map((address) => ({ address, score: readabilityScore(address, boundary) }))
    .sort((a, b) => b.score - a.score)
    .map((entry) => entry.address);
}

/**
 * Everything one run of the tool produces for an address: the recommended
 * word-split variant (`primary`) plus `extras` (all-mode dot variants and
 * +alias variants). The page renders this and the server persists it, so
 * both always agree on what a run generated.
 *
 * Returns null when the address does not parse.
 *
 * @param {string} address
 * @param {object} [options]
 * @param {'wordSplit'|'all'} [options.mode]
 * @param {string} [options.workspaceDomain] - custom Google Workspace domain, '' for Gmail
 * @param {string|string[]} [options.plusTags] - user tags; DEFAULT_PLUS_TAGS when empty
 */
export function buildVariantSet(address, options = {}) {
  const mode = options.mode === 'all' ? 'all' : 'wordSplit';
  const workspaceDomain = options.workspaceDomain || '';
  const parsed = parseGmailAddress(address, workspaceDomain ? { workspaceDomain } : undefined);
  if (!parsed) return null;

  const userTags = normalizePlusTags(options.plusTags);
  const plusTagsUsed = userTags.length ? userTags : [...DEFAULT_PLUS_TAGS];

  // Google Workspace (company) addresses: Gmail only ignores dots on @gmail.com,
  // so dotted versions of a company address are different mailboxes. Keep the
  // address exactly as typed and offer +tag versions only, which Workspace routes.
  // https://support.google.com/mail/answer/7436150
  if (parsed.isWorkspace) {
    const own = `${parsed.rawLocal}${parsed.plusTag}@${parsed.domain}`;
    const plusVariants = generatePlusTagVariants(parsed, { tags: plusTagsUsed, localOverride: parsed.rawLocal })
      .filter((v) => v !== own);
    return {
      mode,
      parsed,
      noDot: own,
      primary: own,
      extras: plusVariants,
      plusVariants,
      plusTagsUsed,
      workspaceDomain,
      isWorkspace: true,
      modeWarning: ''
    };
  }

  const noDot = `${parsed.baseLocal}${parsed.plusTag}@${parsed.domain}`.toLowerCase();
  const generatorOptions = workspaceDomain ? { workspaceDomain } : {};
  const namedSplit = (generateGmailDotVariants(address, { ...generatorOptions, mode: 'wordSplit' })[0] || noDot).toLowerCase();
  // No recognisable word split (e.g. xkqzvwpt): split in the middle so the best
  // pick is always a real variation, never the address exactly as typed.
  const mid = Math.ceil(parsed.baseLocal.length / 2);
  const wordSplit = namedSplit !== noDot || parsed.baseLocal.length < 2
    ? namedSplit
    : `${parsed.baseLocal.slice(0, mid)}.${parsed.baseLocal.slice(mid)}${parsed.plusTag}@${parsed.domain}`.toLowerCase();

  // +alias variants on the dot-stripped base local AND on the word-split
  // local (e.g. john.smith+signup@gmail.com) so users see both shapes.
  const wordSplitLocal = wordSplit.split('@')[0];
  const plusBase = generatePlusTagVariants(parsed, { tags: plusTagsUsed });
  const plusSplit = wordSplitLocal !== parsed.baseLocal
    ? generatePlusTagVariants(parsed, { tags: plusTagsUsed, localOverride: wordSplitLocal })
    : [];

  let extras = [];
  let modeWarning = '';

  if (mode === 'all') {
    try {
      const all = generateGmailDotVariants(address, { ...generatorOptions, mode: 'all' });
      extras = rankByReadability(
        dedupe(all)
          .map((variant) => variant.toLowerCase())
          .filter((variant) => variant !== noDot && variant !== wordSplit),
        chooseWordSplitIndex(parsed.casedLocal)
      );
    } catch (error) {
      modeWarning = error instanceof RangeError
        ? 'All mode exceeds safe permutation limits for this local-part length. Showing word split only.'
        : 'Unable to generate all-mode variants. Showing word split only.';
    }
  }

  // +alias variants are unique by construction (different "+tag" segment);
  // dedupe against primary/noDot defensively. The readable word-split form
  // (john.smith+signup) comes before the plain one (johnsmith+signup).
  const plusVariants = dedupe([...plusSplit, ...plusBase])
    .filter((v) => v !== noDot && v !== wordSplit);
  extras = dedupe([...extras, ...plusVariants]);

  return {
    mode,
    parsed,
    noDot,
    primary: wordSplit,
    extras,
    plusVariants,
    plusTagsUsed,
    workspaceDomain,
    isWorkspace: !!workspaceDomain,
    modeWarning
  };
}

/**
 * What kind of address this is, so the page can pick the right path without a
 * "Using Google Workspace?" checkbox:
 *   gmail      - gmail.com / googlemail.com
 *   workspace  - any other valid domain (assumed to be Google Workspace)
 *   typo       - a Gmail typo like gmail.con; `suggestion` holds the fix
 *   not-google - a known non-Google inbox (yahoo.com, outlook.com, ...)
 *   invalid    - not an address yet
 */
export function classifyAddress(value) {
  const trimmed = String(value || '').trim();
  const at = trimmed.lastIndexOf('@');
  if (at <= 0 || at === trimmed.length - 1) return { kind: 'invalid', domain: '' };
  const domain = trimmed.slice(at + 1).toLowerCase();
  if (GMAIL_DOMAINS.has(domain)) return { kind: 'gmail', domain };
  if (GMAIL_TYPO_MAP[domain]) {
    return { kind: 'typo', domain, suggestion: `${trimmed.slice(0, at)}@${GMAIL_TYPO_MAP[domain]}` };
  }
  if (NOT_GOOGLE_DOMAINS.has(domain)) return { kind: 'not-google', domain };
  if (!isValidWorkspaceDomain(domain)) return { kind: 'invalid', domain };
  return { kind: 'workspace', domain };
}
