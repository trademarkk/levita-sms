import test from 'node:test';
import assert from 'node:assert/strict';
import { parseSmsEvent, handleSmsHistory } from '../src/sms-history.js';

const payload = (overrides = {}) => ({ webhook: { action: 'sms.message', account_id: '94422' }, event: { event_type: 32, direction: 1, client_number: '+7 (918) 123-45-67', text: 'Здравствуйте!', ...overrides } });
const env = { MOIZVONKI_WEBHOOK_SECRET: 'secret', MOIZVONKI_ACCOUNT_ID: '94422', AMO_BASE_URL: 'https://example.amocrm.ru', AMO_LONG_LIVED_TOKEN: 'token', AMO_PIPELINE_ID: '9879202' };

test('accepts outbound SMS only from configured account', () => {
  assert.deepEqual(parseSmsEvent(payload(), '94422'), { phone: '79181234567', text: 'Здравствуйте!' });
  assert.equal(parseSmsEvent(payload({ direction: 0 }), '94422'), null);
  assert.equal(parseSmsEvent(payload({ client_number: 'bad' }), '94422'), null);
  assert.equal(parseSmsEvent(payload(), 'other-account'), null);
});

test('writes an SMS note to the sole active deal in the configured pipeline', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push({ url, options });
    if (url.includes('/contacts?')) return new Response(JSON.stringify({ _embedded: { contacts: [{ id: 10, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '8 918 123-45-67' }] }], _embedded: { leads: [{ id: 20 }, { id: 21 }] } }] } }), { status: 200 });
    if (url.endsWith('/leads/20')) return new Response(JSON.stringify({ id: 20, pipeline_id: 9879202, status_id: 78540110, closed_at: null }), { status: 200 });
    if (url.endsWith('/leads/21')) return new Response(JSON.stringify({ id: 21, pipeline_id: 9879202, status_id: 142, closed_at: 123 }), { status: 200 });
    if (url.endsWith('/leads/20/notes')) return new Response('{}', { status: 200 });
    throw new Error(`Unexpected ${url}`);
  };
  try {
    const result = await handleSmsHistory({ method: 'POST', query: { key: 'secret' }, body: payload() }, env);
    assert.equal(result.body.state, 'added');
    const note = calls.find(call => call.url.endsWith('/leads/20/notes'));
    assert.deepEqual(JSON.parse(note.options.body), [{ note_type: 'sms_out', params: { text: 'Здравствуйте!', phone: '+79181234567' }, is_need_to_trigger_digital_pipeline: false }]);
  } finally { globalThis.fetch = original; }
});

test('does not put SMS in an arbitrary deal when two are active', async () => {
  const original = globalThis.fetch;
  const calls = [];
  globalThis.fetch = async (url, options) => {
    calls.push(url);
    if (url.includes('/contacts?')) return new Response(JSON.stringify({ _embedded: { contacts: [{ id: 10, custom_fields_values: [{ field_code: 'PHONE', values: [{ value: '79181234567' }] }], _embedded: { leads: [{ id: 20 }, { id: 21 }] } }] } }), { status: 200 });
    return new Response(JSON.stringify({ id: Number(url.split('/').at(-1)), pipeline_id: 9879202, status_id: 78540110 }), { status: 200 });
  };
  try {
    const result = await handleSmsHistory({ method: 'POST', query: { key: 'secret' }, body: payload() }, env);
    assert.equal(result.body.state, 'ambiguous_leads');
    assert.equal(calls.some(url => url.endsWith('/notes')), false);
  } finally { globalThis.fetch = original; }
});

test('rejects wrong secret before reading account data', async () => {
  const result = await handleSmsHistory({ method: 'POST', query: { key: 'wrong' }, body: payload() }, env);
  assert.equal(result.status, 401);
});
