import test from 'node:test';
import assert from 'node:assert/strict';
import { createWebhookHandler } from '../src/webhook-handler.js';
import { createSmsGuard } from '../src/sms-guard.js';

const settings = {
  WEBHOOK_SECRET: 'test-secret', AMO_BASE_URL: 'https://example.amocrm.ru',
  AMO_LONG_LIVED_TOKEN: 'test-token', AMO_PIPELINE_ID: '1', AMO_STATUS_ID: '2',
  SMS_TEXT: 'Test SMS', SMS_TEXT_MORNING: 'Morning SMS', SMS_TEXT_AFTER_HOURS: 'Night SMS',
  STUDIO_ROUTES_JSON: JSON.stringify({ default: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'test@example.com', apiKey: 'test-api-key' } })
};
const request = () => ({ method: 'POST', query: { key: 'test-secret' }, body: new URLSearchParams({
  'leads[status][0][id]': '123', 'leads[status][0][pipeline_id]': '1', 'leads[status][0][status_id]': '2'
}) });
function response() {
  return { setHeader() {}, status(code) { this.code = code; return this; }, json(body) { this.body = body; } };
}
function fixtureFetch(counts, { smsFailure = false, noContact = false } = {}) {
  return async url => {
    if (url.includes('/api/v4/leads/')) {
      counts.leads++;
      return new Response(JSON.stringify({ pipeline_id: 1, status_id: 2, _embedded: { contacts: noContact ? [] : [{ id: 9, is_main: true }] } }));
    }
    if (url.includes('/api/v4/contacts/')) return new Response(JSON.stringify({ custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 918 123 45 67' }] }] }));
    counts.sms++;
    if (smsFailure) throw new Error('fetch failed');
    return new Response('{}');
  };
}

test('acknowledges before slow amoCRM requests finish, and background SMS survives the acknowledgement', async () => {
  const original = globalThis.fetch;
  const counts = { leads: 0, sms: 0 };
  const tasks = [];
  let resolveLead;
  const delayedLead = new Promise(resolve => { resolveLead = resolve; });
  const fixture = fixtureFetch(counts);
  globalThis.fetch = async url => {
    if (url.includes('/api/v4/leads/')) await delayedLead;
    return fixture(url);
  };
  try {
    const webhook = createWebhookHandler({ env: () => settings, waitUntil: task => tasks.push(task) });
    const res = response();
    const started = performance.now();
    webhook(request(), res);
    assert.equal(res.code, 200);
    assert.deepEqual(res.body, { received: true });
    assert.ok(performance.now() - started < 500, 'acknowledgement must not wait for the CRM or SMS API');
    await Promise.resolve();
    assert.equal(counts.sms, 0);
    resolveLead();
    await Promise.all(tasks);
    assert.equal(counts.sms, 1);
  } finally { resolveLead(); globalThis.fetch = original; }
});

test('four concurrent deliveries and a later repeat dispatch once within the same instance', async () => {
  const original = globalThis.fetch;
  const counts = { leads: 0, sms: 0 };
  const tasks = [];
  globalThis.fetch = fixtureFetch(counts);
  try {
    const webhook = createWebhookHandler({ env: () => settings, waitUntil: task => tasks.push(task) });
    for (let i = 0; i < 4; i++) { const res = response(); webhook(request(), res); assert.equal(res.code, 200); }
    await Promise.all(tasks);
    assert.equal(counts.sms, 1);
    webhook(request(), response());
    await Promise.all(tasks);
    assert.equal(counts.sms, 1);
  } finally { globalThis.fetch = original; }
});

test('does not re-dispatch after an ambiguous SMS API failure', async () => {
  const original = globalThis.fetch;
  const counts = { leads: 0, sms: 0 };
  const tasks = [];
  globalThis.fetch = fixtureFetch(counts, { smsFailure: true });
  try {
    const webhook = createWebhookHandler({ env: () => settings, waitUntil: task => tasks.push(task) });
    webhook(request(), response()); await Promise.all(tasks);
    webhook(request(), response()); await Promise.all(tasks);
    assert.equal(counts.sms, 1);
  } finally { globalThis.fetch = original; }
});

test('missing contact does not consume the SMS guard; a corrected deal can send', async () => {
  const original = globalThis.fetch;
  const counts = { leads: 0, sms: 0 };
  const tasks = [];
  try {
    const webhook = createWebhookHandler({ env: () => settings, waitUntil: task => tasks.push(task) });
    globalThis.fetch = fixtureFetch(counts, { noContact: true });
    webhook(request(), response()); await Promise.all(tasks);
    globalThis.fetch = fixtureFetch(counts);
    webhook(request(), response()); await Promise.all(tasks);
    assert.equal(counts.sms, 1);
  } finally { globalThis.fetch = original; }
});

test('GET, invalid secret and empty probe start no background API work', async () => {
  const tasks = [];
  const webhook = createWebhookHandler({ env: () => settings, waitUntil: task => tasks.push(task) });
  for (const [req, code] of [
    [{ ...request(), method: 'GET' }, 405],
    [{ ...request(), query: { key: 'wrong' } }, 401],
    [{ ...request(), body: 'diagnostic_probe=1' }, 200]
  ]) { const res = response(); webhook(req, res); assert.equal(res.code, code); }
  assert.equal(tasks.length, 0);
});

test('failed background registration starts no network work', async () => {
  const original = globalThis.fetch;
  let networkCalls = 0;
  globalThis.fetch = async () => { networkCalls++; throw new Error('unexpected network'); };
  try {
    const webhook = createWebhookHandler({ env: () => settings, waitUntil: () => { throw new Error('runtime unavailable'); } });
    const res = response(); webhook(request(), res);
    await Promise.resolve();
    assert.equal(res.code, 500);
    assert.equal(networkCalls, 0);
  } finally { globalThis.fetch = original; }
});

test('instance guard expires, stays bounded and keeps CRM accounts separate', () => {
  let time = 0;
  const guard = createSmsGuard({ now: () => time, ttlMs: 100, maxEntries: 2 });
  assert.equal(guard.claim('account-a/123'), true);
  assert.equal(guard.claim('account-a/123'), false);
  assert.equal(guard.claim('account-b/123'), true);
  assert.throws(() => guard.claim('account-a/456'), /capacity/);
  time = 101;
  assert.equal(guard.claim('account-a/123'), true);
});

test('separate instances cannot guarantee deduplication without shared storage', () => {
  const first = createSmsGuard();
  const second = createSmsGuard();
  assert.equal(first.claim('account/123'), true);
  assert.equal(second.claim('account/123'), true);
});

test('production entry registers background work through the installed Vercel SDK', async () => {
  const originalFetch = globalThis.fetch;
  const symbol = Symbol.for('@vercel/request-context');
  const originalContext = globalThis[symbol];
  const originalEnv = Object.fromEntries(Object.keys(settings).map(key => [key, process.env[key]]));
  const originalStudio = process.env.STUDIO_FIELD_ID;
  const counts = { leads: 0, sms: 0 };
  const tasks = [];
  globalThis[symbol] = { get: () => ({ waitUntil: task => tasks.push(task) }) };
  globalThis.fetch = fixtureFetch(counts);
  Object.assign(process.env, settings);
  delete process.env.STUDIO_FIELD_ID;
  try {
    const { default: webhook } = await import('../api/webhook.js');
    const res = response();
    webhook(request(), res);
    assert.equal(res.code, 200);
    assert.equal(tasks.length, 1, 'real SDK must receive the background promise');
    assert.equal(counts.sms, 0, 'response must be ready before dispatch');
    await Promise.all(tasks);
    assert.equal(counts.sms, 1);
  } finally {
    globalThis.fetch = originalFetch;
    if (originalContext === undefined) delete globalThis[symbol]; else globalThis[symbol] = originalContext;
    for (const [key, value] of Object.entries(originalEnv)) {
      if (value === undefined) delete process.env[key]; else process.env[key] = value;
    }
    if (originalStudio === undefined) delete process.env.STUDIO_FIELD_ID; else process.env.STUDIO_FIELD_ID = originalStudio;
  }
});
