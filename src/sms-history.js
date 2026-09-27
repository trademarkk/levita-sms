import { timingSafeEqual } from 'node:crypto';
import { normalizePhone } from './service.js';

const required = (env, key) => { if (!env[key]) throw new Error(`Missing ${key}`); return env[key]; };
const equalSecret = (a, b) => {
  const left = Buffer.from(String(a ?? ''));
  const right = Buffer.from(String(b ?? ''));
  return left.length === right.length && timingSafeEqual(left, right);
};
const phoneValues = contact => (contact.custom_fields_values ?? [])
  .filter(field => field.field_code === 'PHONE')
  .flatMap(field => field.values ?? [])
  .map(value => normalizePhone(value.value))
  .filter(Boolean);

async function amoGet(url, token) {
  const response = await fetch(url, { headers: { Authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(12000) });
  if (response.status === 204) return {};
  if (!response.ok) throw new Error(`amoCRM GET HTTP ${response.status}`);
  return response.json();
}

export function parseSmsEvent(body, accountId) {
  const data = typeof body === 'string' ? JSON.parse(body) : body;
  if (data?.webhook?.action !== 'sms.message' || String(data.webhook.account_id) !== String(accountId)) return null;
  const event = data.event;
  if (!event || Number(event.event_type) !== 32 || Number(event.direction) !== 1) return null;
  const phone = normalizePhone(event.client_number);
  const message = event.text;
  if (!phone || typeof message !== 'string' || !message.trim()) return null;
  return { phone, text: message };
}

export async function findCurrentLead(base, token, phone, pipelineId) {
  const contacts = new Map();
  // amoCRM searches field text, so confirm an exact normalized PHONE match below.
  for (const query of [phone, phone.slice(1)]) {
    for (let page = 1; page <= 5; page++) {
      const url = `${base}/api/v4/contacts?with=leads&query=${encodeURIComponent(query)}&limit=250&page=${page}`;
      const result = await amoGet(url, token);
      for (const contact of result._embedded?.contacts ?? []) {
        if (phoneValues(contact).includes(phone)) contacts.set(contact.id, contact);
      }
      if (!result._links?.next) break;
      if (page === 5) throw new Error('Contact search exceeds safe page limit');
    }
  }
  if (!contacts.size) return { state: 'no_contact' };
  const leadIds = [...new Set([...contacts.values()].flatMap(contact => (contact._embedded?.leads ?? []).map(lead => lead.id)))];
  if (leadIds.length > 20) return { state: 'ambiguous_leads' };
  const leads = [];
  for (const id of leadIds) {
    const lead = await amoGet(`${base}/api/v4/leads/${id}`, token);
    if (String(lead.pipeline_id) === String(pipelineId) && !lead.closed_at && ![142, 143].includes(Number(lead.status_id))) leads.push(lead);
  }
  if (leads.length === 0) return { state: 'no_active_lead' };
  if (leads.length > 1) return { state: 'ambiguous_leads' };
  return { state: 'matched', leadId: leads[0].id };
}

export async function handleSmsHistory(req, env) {
  if (req.method !== 'POST') return { status: 405, body: { error: 'method_not_allowed' } };
  const secret = required(env, 'MOIZVONKI_WEBHOOK_SECRET');
  if (!equalSecret(req.query?.key, secret)) return { status: 401, body: { error: 'unauthorized' } };
  const event = parseSmsEvent(req.body, required(env, 'MOIZVONKI_ACCOUNT_ID'));
  if (!event) return { status: 200, body: { state: 'ignored' } };
  const baseUrl = new URL(required(env, 'AMO_BASE_URL'));
  if (baseUrl.protocol !== 'https:' || baseUrl.username || baseUrl.password || !baseUrl.hostname.endsWith('.amocrm.ru')) throw new Error('Invalid amoCRM base URL');
  const base = baseUrl.origin;
  const token = required(env, 'AMO_LONG_LIVED_TOKEN');
  const match = await findCurrentLead(base, token, event.phone, required(env, 'AMO_PIPELINE_ID'));
  if (match.state !== 'matched') {
    console.info(JSON.stringify({ event: 'sms_history_skipped', reason: match.state }));
    return { status: 200, body: { state: match.state } };
  }
  const response = await fetch(`${base}/api/v4/leads/${match.leadId}/notes`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
    body: JSON.stringify([{ note_type: 'sms_out', params: { text: event.text, phone: `+${event.phone}` }, is_need_to_trigger_digital_pipeline: false }]),
    signal: AbortSignal.timeout(12000)
  });
  if (!response.ok) throw new Error(`amoCRM note HTTP ${response.status}`);
  console.info(JSON.stringify({ event: 'sms_history_added', leadId: match.leadId }));
  return { status: 200, body: { state: 'added' } };
}
