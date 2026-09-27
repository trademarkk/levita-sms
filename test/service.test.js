import test from 'node:test';
import assert from 'node:assert/strict';
import { parseEvents, normalizePhone, selectSmsText, sendSms, handle } from '../src/service.js';

test('parses amoCRM form webhook batch', () => {
  const input = new URLSearchParams({ 'leads[add][0][id]': '123', 'leads[status][1][id]': '456', 'leads[status][1][pipeline_id]': '12', 'leads[status][1][status_id]': '789', 'contacts[add][0][id]': '777' });
  assert.deepEqual(parseEvents(input), [{ action: 'add', index: '0', id: '123' }, { action: 'status', index: '1', id: '456', pipeline_id: '12', status_id: '789' }]);
});
test('normalizes Russian phone and rejects invalid numbers', () => {
  assert.equal(normalizePhone('8 (918) 123-45-67'), '79181234567');
  assert.equal(normalizePhone('+7 918 123 45 67'), '79181234567');
  assert.equal(normalizePhone('12345'), null);
});
test('selects SMS by amoCRM event time in Krasnodar at every schedule boundary', () => {
  const env = { SMS_TEXT: 'Рабочее время', SMS_TEXT_AFTER_HOURS: 'Нерабочее время' };
  const cases = [
    ['2026-09-27T06:59:00Z', 'after_hours'], // 09:59 MSK
    ['2026-09-27T07:00:00Z', 'work_hours'],  // 10:00 MSK
    ['2026-09-27T18:29:00Z', 'work_hours'], // 21:29 MSK
    ['2026-09-27T18:30:00Z', 'after_hours'], // 21:30 MSK
    ['2026-09-27T21:00:00Z', 'after_hours']  // 00:00 MSK
  ];
  for (const [iso, slot] of cases) {
    const event = { action: 'add', date_create: String(Date.parse(iso) / 1000) };
    assert.equal(selectSmsText(event, {}, env).slot, slot, iso);
  }
  const statusEvent = { action: 'status', date_create: String(Date.parse('2026-09-27T07:00:00Z') / 1000), last_modified: String(Date.parse('2026-09-27T18:30:00Z') / 1000) };
  assert.deepEqual(selectSmsText(statusEvent, {}, env), { text: 'Нерабочее время', slot: 'after_hours' });
  assert.match(selectSmsText({ action: 'add' }, {}, { SMS_TEXT: 'Рабочее время' }, Date.parse('2026-09-27T06:59:00Z')).text, /после 10:00/);
});
test('sends the documented МоиЗвонки request', async () => {
  const original = globalThis.fetch;
  let request;
  globalThis.fetch = async (url, options) => {
    request = { url, method: options.method, contentType: options.headers['Content-Type'], body: JSON.parse(options.body) };
    return new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } });
  };
  try {
    await sendSms('79181234567', 'Тест', { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'studio@example.com', apiKey: 'test-key' });
    assert.deepEqual(request, { url: 'https://company.moizvonki.ru/api/v1', method: 'POST', contentType: 'application/json', body: { user_name: 'studio@example.com', api_key: 'test-key', action: 'calls.send_sms', to: '79181234567', text: 'Тест' } });
  } finally { globalThis.fetch = original; }
});
test('uses a long-lived amoCRM token and sends once per webhook batch', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/api/v4/leads/123')) return new Response(JSON.stringify({ pipeline_id: 1, status_id: 2, custom_fields_values: [{ field_id: 5, values: [{ value: 'Ставропольская' }] }], _embedded: { contacts: [{ id: 9, is_main: true }] } }), { status: 200 });
    if (url.includes('/api/v4/contacts/9')) return new Response(JSON.stringify({ custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 918 123 45 67' }] }] }), { status: 200 });
    return new Response('{}', { status: 200 });
  };
  const env = { WEBHOOK_SECRET: 'secret', AMO_BASE_URL: 'https://example.amocrm.ru', AMO_LONG_LIVED_TOKEN: 'long-token', AMO_PIPELINE_ID: '1', AMO_STATUS_ID: '2', STUDIO_FIELD_ID: '5', STUDIO_ROUTES_JSON: JSON.stringify({ Ставропольская: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'studio@example.com', apiKey: 'key' } }), SMS_TEXT: 'Приняли заявку' };
  const req = { method: 'POST', query: { key: 'secret' }, body: new URLSearchParams({ 'leads[add][0][id]': '123', 'leads[status][0][id]': '123' }) };
  try {
    const response = await handle(req, env);
    assert.deepEqual(response.body.results.map(item => item.state), ['accepted', 'duplicate_in_batch']);
    assert.equal(calls.filter(call => call.url.includes('moizvonki.ru')).length, 1);
    assert.equal(calls.find(call => call.url.includes('/api/v4/leads/123')).options.headers.Authorization, 'Bearer long-token');
    assert.equal(calls.some(call => call.url.includes('upstash') || call.url.includes('oauth2')), false);
    calls.length = 0;
    await handle(req, env);
    assert.equal(calls.filter(call => call.url.includes('moizvonki.ru')).length, 1, 'a later webhook can send another SMS without persistent deduplication');
  } finally { globalThis.fetch = original; }
});
test('uses one default sender when studio is not known yet', async () => {
  const original = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async (url, options) => {
    if (url.includes('/api/v4/leads/123')) return new Response(JSON.stringify({ pipeline_id: 1, status_id: 2, _embedded: { contacts: [{ id: 9, is_main: true }] } }), { status: 200 });
    if (url.includes('/api/v4/contacts/9')) return new Response(JSON.stringify({ custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 918 123 45 67' }] }] }), { status: 200 });
    assert.equal(JSON.parse(options.body).user_name, 'sender@example.com');
    assert.equal(JSON.parse(options.body).text, 'Нерабочее время');
    smsCalls++;
    return new Response('{}', { status: 200 });
  };
  const env = { WEBHOOK_SECRET: 'secret', AMO_BASE_URL: 'https://example.amocrm.ru', AMO_LONG_LIVED_TOKEN: 'long-token', AMO_PIPELINE_ID: '1', AMO_STATUS_ID: '2', STUDIO_ROUTES_JSON: JSON.stringify({ default: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'sender@example.com', apiKey: 'key' } }), SMS_TEXT: 'Рабочее время', SMS_TEXT_AFTER_HOURS: 'Нерабочее время' };
  try {
    const response = await handle({ method: 'POST', query: { key: 'secret' }, body: new URLSearchParams({ 'leads[add][0][id]': '123', 'leads[add][0][date_create]': String(Date.parse('2026-09-27T18:30:00Z') / 1000) }) }, env);
    assert.equal(response.body.results[0].state, 'accepted');
    assert.equal(smsCalls, 1);
  } finally { globalThis.fetch = original; }
});
test('does not use another studio route for an unknown field value', async () => {
  const original = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/api/v4/leads/123')) return new Response(JSON.stringify({ pipeline_id: 1, status_id: 2, custom_fields_values: [{ field_id: 5, values: [{ value: 'Неизвестная студия' }] }], _embedded: { contacts: [{ id: 9 }] } }), { status: 200 });
    if (url.includes('/api/v4/contacts/9')) return new Response(JSON.stringify({ custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 918 123 45 67' }] }] }), { status: 200 });
    smsCalls++;
    return new Response('{}', { status: 200 });
  };
  const env = { WEBHOOK_SECRET: 'secret', AMO_BASE_URL: 'https://example.amocrm.ru', AMO_LONG_LIVED_TOKEN: 'long-token', AMO_PIPELINE_ID: '1', AMO_STATUS_ID: '2', STUDIO_FIELD_ID: '5', STUDIO_ROUTES_JSON: JSON.stringify({ Ставропольская: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'studio@example.com', apiKey: 'key' }, default: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'studio@example.com', apiKey: 'key' } }), SMS_TEXT: 'Приняли заявку' };
  try {
    const response = await handle({ method: 'POST', query: { key: 'secret' }, body: new URLSearchParams({ 'leads[add][0][id]': '123' }) }, env);
    assert.equal(response.body.results[0].state, 'error');
    assert.equal(smsCalls, 0);
  } finally { globalThis.fetch = original; }
});

test('uses the webhook stage when the deal has already moved', async () => {
  const original = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/api/v4/leads/123')) return new Response(JSON.stringify({ pipeline_id: 99, status_id: 99, _embedded: { contacts: [{ id: 9 }] } }), { status: 200 });
    if (url.includes('/api/v4/contacts/9')) return new Response(JSON.stringify({ custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '+7 918 123 45 67' }] }] }), { status: 200 });
    smsCalls++;
    return new Response('{}', { status: 200 });
  };
  const env = { WEBHOOK_SECRET: 'secret', AMO_BASE_URL: 'https://example.amocrm.ru', AMO_LONG_LIVED_TOKEN: 'long-token', AMO_PIPELINE_ID: '1', AMO_STATUS_ID: '2', STUDIO_ROUTES_JSON: JSON.stringify({ default: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'sender@example.com', apiKey: 'key' } }), SMS_TEXT: 'Приняли заявку' };
  try {
    const enteredTarget = new URLSearchParams({ 'leads[status][0][id]': '123', 'leads[status][0][pipeline_id]': '1', 'leads[status][0][status_id]': '2' });
    const result = await handle({ method: 'POST', query: { key: 'secret' }, body: enteredTarget }, env);
    assert.equal(result.body.results[0].state, 'accepted');
    assert.equal(smsCalls, 1);
  } finally { globalThis.fetch = original; }
});

test('ignores an event from another stage even if the deal is now in New', async () => {
  const original = globalThis.fetch;
  let smsCalls = 0;
  globalThis.fetch = async (url) => {
    if (url.includes('/api/v4/leads/123')) return new Response(JSON.stringify({ pipeline_id: 1, status_id: 2, _embedded: { contacts: [{ id: 9 }] } }), { status: 200 });
    smsCalls++;
    return new Response('{}', { status: 200 });
  };
  const env = { WEBHOOK_SECRET: 'secret', AMO_BASE_URL: 'https://example.amocrm.ru', AMO_LONG_LIVED_TOKEN: 'long-token', AMO_PIPELINE_ID: '1', AMO_STATUS_ID: '2', STUDIO_ROUTES_JSON: JSON.stringify({ default: { apiUrl: 'https://company.moizvonki.ru/api/v1', userName: 'sender@example.com', apiKey: 'key' } }), SMS_TEXT: 'Приняли заявку' };
  try {
    const otherStage = new URLSearchParams({ 'leads[status][0][id]': '123', 'leads[status][0][pipeline_id]': '1', 'leads[status][0][status_id]': '3' });
    const result = await handle({ method: 'POST', query: { key: 'secret' }, body: otherStage }, env);
    assert.equal(result.body.results[0].state, 'ignored_stage');
    assert.deepEqual({ eventStatusId: result.body.results[0].eventStatusId, leadStatusId: result.body.results[0].leadStatusId, expectedStatusId: result.body.results[0].expectedStatusId }, { eventStatusId: '3', leadStatusId: 2, expectedStatusId: '2' });
    assert.equal(smsCalls, 0);
  } finally { globalThis.fetch = original; }
});
