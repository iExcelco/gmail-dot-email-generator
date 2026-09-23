import test from 'node:test';
import assert from 'node:assert/strict';
import { generateGmailDotVariants, parseGmailAddress, buildVariantSet, DEFAULT_PLUS_TAGS } from '../gmailDots.js';

test('parseGmailAddress accepts gmail.com and returns normalized parts', () => {
  const parsed = parseGmailAddress('  Jo.Hn+Tag@GMAIL.com  ');

  assert.equal(parsed.domain, 'gmail.com');
  assert.equal(parsed.baseLocal, 'john');
  assert.equal(parsed.plusTag, '+tag');
});

test('parseGmailAddress rejects non-gmail domains', () => {
  assert.equal(parseGmailAddress('name@yahoo.com'), null);
});

test('parseGmailAddress rejects invalid characters in local part', () => {
  assert.equal(parseGmailAddress('ab-cd@gmail.com'), null);
});

test('parseGmailAddress accepts googlemail.com domain', () => {
  const parsed = parseGmailAddress('abc@googlemail.com');

  assert.equal(parsed.domain, 'googlemail.com');
  assert.equal(parsed.baseLocal, 'abc');
});

test('generateGmailDotVariants supports all mode for full permutations', () => {
  const variants = generateGmailDotVariants('abc@gmail.com', { mode: 'all' });
  const expected = new Set([
    'abc@gmail.com',
    'ab.c@gmail.com',
    'a.bc@gmail.com',
    'a.b.c@gmail.com'
  ]);

  assert.equal(variants.length, 4);
  assert.deepEqual(new Set(variants), expected);
});

test('generateGmailDotVariants keeps plus tag on every variant', () => {
  const variants = generateGmailDotVariants('ab+news@gmail.com', { mode: 'all' });

  assert.equal(variants.length, 2);
  assert.deepEqual(variants, ['ab+news@gmail.com', 'a.b+news@gmail.com']);
});

test('generateGmailDotVariants dedupes dots in input before generating', () => {
  const variants = generateGmailDotVariants('a..b@gmail.com', { mode: 'all' });

  assert.deepEqual(variants, ['ab@gmail.com', 'a.b@gmail.com']);
});

test('generateGmailDotVariants throws when permutations exceed cap', () => {
  assert.throws(
    () => generateGmailDotVariants('abcdefghijklmnopqrs@gmail.com', { mode: 'all' }),
    /permutations exceed maxVariants/i
  );
});

test('generateGmailDotVariants defaults to wordSplit mode', () => {
  const variants = generateGmailDotVariants('MicahBerkley@gmail.com');

  assert.deepEqual(variants, ['micah.berkley@gmail.com']);
});

test('wordSplit mode finds likely first-last split for lowercase names', () => {
  const variants = generateGmailDotVariants('markbrown@gmail.com', { mode: 'wordSplit' });

  assert.deepEqual(variants, ['mark.brown@gmail.com']);
});

test('wordSplit mode keeps ambiguous usernames unchanged', () => {
  const variants = generateGmailDotVariants('john@gmail.com', { mode: 'wordSplit' });

  assert.deepEqual(variants, ['john@gmail.com']);
});

test('buildVariantSet: word-split mode -> recommended variant plus default +alias extras', () => {
  const set = buildVariantSet('JohnSmith@gmail.com');
  assert.equal(set.mode, 'wordSplit');
  assert.equal(set.primary, 'john.smith@gmail.com');
  assert.equal(set.noDot, 'johnsmith@gmail.com');
  assert.deepEqual(set.plusTagsUsed, [...DEFAULT_PLUS_TAGS]);
  assert.equal(set.plusVariants.length, DEFAULT_PLUS_TAGS.length * 2);
  assert.deepEqual(set.extras, set.plusVariants, 'word-split mode extras are the +alias variants only');
});

test('buildVariantSet: all mode adds every dot variant except noDot and primary', () => {
  const set = buildVariantSet('abcd@gmail.com', { mode: 'all', plusTags: 'x' });
  const dots = set.extras.filter((v) => !set.plusVariants.includes(v));
  assert.equal(dots.length, 8 - (set.primary === set.noDot ? 1 : 2));
  assert.ok(!set.extras.includes(set.noDot));
  assert.ok(!set.extras.includes(set.primary));
});

test('buildVariantSet: null for an unparseable address; workspace domain honoured', () => {
  assert.equal(buildVariantSet('name@yahoo.com'), null);
  const ws = buildVariantSet('Micah@iexcel.co', { workspaceDomain: 'iexcel.co' });
  assert.equal(ws.isWorkspace, true);
  assert.equal(ws.parsed.domain, 'iexcel.co');
});

test('buildVariantSet: all mode past the permutation limit falls back with a warning', () => {
  const set = buildVariantSet('abcdefghijklmnopqrstu@gmail.com', { mode: 'all' });
  assert.match(set.modeWarning, /exceeds safe permutation limits/);
  assert.deepEqual(set.extras, set.plusVariants);
});

test('classifyAddress: gmail, workspace, typo, non-Google and incomplete addresses', async () => {
  const { classifyAddress } = await import('../gmailDots.js');
  assert.equal(classifyAddress('john@gmail.com').kind, 'gmail');
  assert.equal(classifyAddress('John@GoogleMail.com').kind, 'gmail');
  assert.deepEqual(classifyAddress('micah@iexcel.co'), { kind: 'workspace', domain: 'iexcel.co' });
  assert.deepEqual(classifyAddress('john@gmail.con'), { kind: 'typo', domain: 'gmail.con', suggestion: 'john@gmail.com' });
  assert.deepEqual(classifyAddress('john@yahoo.com'), { kind: 'not-google', domain: 'yahoo.com' });
  assert.equal(classifyAddress('john@').kind, 'invalid');
  assert.equal(classifyAddress('john@localhost').kind, 'invalid');
});

test('buildVariantSet: Workspace addresses keep their dots and only get +tag versions', () => {
  // Dots change a Google Workspace address, so no dot variants may be offered.
  const ws = buildVariantSet('Micah.Berkley@iexcel.co', { mode: 'all', workspaceDomain: 'iexcel.co', plusTags: 'signup, promo' });
  assert.equal(ws.primary, 'micah.berkley@iexcel.co', 'address kept exactly, dots included');
  assert.deepEqual(ws.extras, ['micah.berkley+signup@iexcel.co', 'micah.berkley+promo@iexcel.co']);
  assert.deepEqual(ws.plusVariants, ws.extras);
  assert.ok(ws.extras.every((v) => v.startsWith('micah.berkley+')), 'never the dot-stripped mailbox');
  assert.equal(ws.modeWarning, '');
});

test('ranking: the first dot suggestions are the readable ones', () => {
  const set = buildVariantSet('johnsmith@gmail.com', { mode: 'all' });
  const plus = new Set(set.plusVariants);
  const dots = [set.primary, ...set.extras.filter((v) => !plus.has(v))].map((v) => v.split('@')[0]);
  assert.equal(dots[0], 'john.smith', 'word split is the best pick');
  assert.ok(dots.slice(1, 5).every((v) => v.startsWith('john.') || v.endsWith('.smith')), 'next ones keep the name readable');
  assert.equal(dots.length, 255, 'still every placement except the address as typed');
  assert.ok(dots.indexOf('j.o.h.n.s.m.i.t.h') > 200, 'the least readable comes last');
  assert.ok(set.plusVariants[0].startsWith('john.smith+'), 'readable +tag form first');
});

test('no recognisable name: best pick is a middle split, never the address as typed', () => {
  const set = buildVariantSet('xkqzvwpt@gmail.com', { mode: 'all' });
  assert.equal(set.primary, 'xkqz.vwpt@gmail.com');
  assert.ok(!set.extras.includes('xkqzvwpt@gmail.com'));
});

test('readabilityScore prefers the word boundary, fewer dots and no 1-letter pieces', async () => {
  const { readabilityScore } = await import('../gmailDots.js');
  const s = (v) => readabilityScore(`${v}@gmail.com`, 4);
  assert.ok(s('john.smith') > s('john.smi.th'));
  assert.ok(s('john.smi.th') > s('joh.nsmith'));
  assert.ok(s('joh.nsmith') > s('j.ohnsmith'));
});
