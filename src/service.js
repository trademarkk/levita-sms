const required = (env, key) => { if (!env[key]) throw new Error(`Missing ${key}`); return env[key]; };
const cleanBase = (value) => { const url = new URL(value); if (url.protocol !== 'https:' || url.username || url.password) throw new Error('HTTPS URL required'); return url.origin; };
const digits = (value) => String(value ?? '').replace(/\D/g, '');
export const normalizePhone = (value) => { const d = digits(value); if (d.length === 11 && d[0] === '8') return `7${d.slice(1)}`; return d.length === 11 && d[0] === '7' ? d : null; };
export function parseEvents(body) {
  const params = typeof body === 'string' ? new URLSearchParams(body) : body instanceof URLSearchParams ? body : new URLSearchParams(Object.entries(body ?? {}).flatMap(([k,v]) => typeof v === 'string' ? [[k,v]] : []));
  const events = [];
  for (const [key, value] of params) {
    const match = /^leads\[(add|status)\]\[(\d+)\]\[(id|pipeline_id|status_id|date_create|created_at|last_modified|updated_at)\]$/.exec(key);
    if (!match) continue;
    const [, action, index, field] = match;
    let item = events.find(x => x.action === action && x.index === index);
    if (!item) { item = { action, index }; events.push(item); }
    item[field] = value;
  }
  return events.filter(x => /^\d+$/.test(x.id ?? ''));
}
async function jsonFetch(url, options = {}) {
  const response = await fetch(url, { ...options, signal: AbortSignal.timeout(12000) });
  const raw = await response.text();
  let body; try { body = JSON.parse(raw); } catch { body = raw; }
  if (!response.ok) throw new Error(`HTTP ${response.status} from ${new URL(url).host}`);
  return body;
}
function fieldValue(fields, id) { return fields?.find(f => String(f.field_id) === String(id))?.values?.[0]?.value; }
const DEFAULT_AFTER_HOURS_TEXT = 'LEVITA: заявку получили. Сейчас не работаем. Свяжемся после 10:00.';
function unixTimeMs(value) {
  const seconds = Number(value);
  return Number.isFinite(seconds) && seconds > 0 ? seconds * 1000 : null;
}
export function selectSmsText(event, lead, env, now = Date.now()) {
  const eventTime = event.action === 'add'
    ? unixTimeMs(event.date_create) ?? unixTimeMs(event.created_at) ?? unixTimeMs(lead.created_at)
    : unixTimeMs(event.last_modified) ?? unixTimeMs(event.updated_at);
  const parts = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/Moscow', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date(eventTime ?? now));
  const hour = Number(parts.find(part => part.type === 'hour').value);
  const minute = Number(parts.find(part => part.type === 'minute').value);
  const minuteOfDay = hour * 60 + minute;
  if (minuteOfDay >= 10 * 60 && minuteOfDay < 21 * 60 + 30) return { text: required(env, 'SMS_TEXT'), slot: 'work_hours' };
  return { text: env.SMS_TEXT_AFTER_HOURS?.trim() || DEFAULT_AFTER_HOURS_TEXT, slot: 'after_hours' };
}
function routeFor(lead, env) {
  const routes = JSON.parse(required(env, 'STUDIO_ROUTES_JSON'));
  const key = env.STUDIO_FIELD_ID ? String(fieldValue(lead.custom_fields_values, env.STUDIO_FIELD_ID) ?? '') : 'default';
  const route = routes[key];
  if (!route) throw new Error(`No sender route for studio ${key}`);
  if (!route.apiUrl || !route.apiKey || !route.userName) throw new Error('Incomplete sender route');
  const u = new URL(route.apiUrl);
  if (u.protocol !== 'https:' || u.username || u.password || !u.hostname.endsWith('.moizvonki.ru') || u.pathname.replace(/\/$/, '') !== '/api/v1' || u.search || u.hash) throw new Error('Invalid МоиЗвонки API URL');
  return { route, key: key || 'default' };
}
export async function sendSms(phone, message, route) {
  const body = { user_name: route.userName, api_key: route.apiKey, action: 'calls.send_sms', to: phone, text: message };
  const result = await jsonFetch(route.apiUrl, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return result;
}
export function prepareWebhook(req, env) {
  if (req.method !== 'POST') return { response: { status: 405, body: { error: 'method_not_allowed' } } };
  const secret = required(env, 'WEBHOOK_SECRET');
  if (req.query?.key !== secret) {
    console.warn(JSON.stringify({ event: 'webhook_rejected', reason: 'invalid_secret' }));
    return { response: { status: 401, body: { error: 'unauthorized' } } };
  }
  const events = parseEvents(req.body);
  if (!events.length) {
    console.info(JSON.stringify({ event: 'webhook_result', processed: 0, reason: 'no_supported_lead_events' }));
    return { response: { status: 200, body: { processed: 0 } } };
  }
  return { events };
}
export async function handle(req, env, { smsGuard, receivedAt = Date.now() } = {}) {
  const prepared = prepareWebhook(req, env);
  if (prepared.response) return prepared.response;
  const { events } = prepared;
  const token = required(env, 'AMO_LONG_LIVED_TOKEN');
  const base = cleanBase(required(env, 'AMO_BASE_URL'));
  const results = [];
  const seen = new Set();
  for (const event of events) {
    const id = event.id;
    if (seen.has(id)) { results.push({ id, state: 'duplicate_in_batch' }); continue; }
    seen.add(id);
    let step = 'lead_read';
    try {
      const lead = await jsonFetch(`${base}/api/v4/leads/${id}?with=contacts`, { headers: { Authorization: `Bearer ${token}` } });
      // A status ID identifies its pipeline; use the event when the deal has moved since delivery.
      const pipelineId = event.pipeline_id ?? (event.status_id ? required(env, 'AMO_PIPELINE_ID') : lead.pipeline_id);
      const statusId = event.status_id ?? lead.status_id;
      const expectedPipelineId = required(env, 'AMO_PIPELINE_ID');
      const expectedStatusId = required(env, 'AMO_STATUS_ID');
      if (String(pipelineId) !== String(expectedPipelineId) || String(statusId) !== String(expectedStatusId)) {
        results.push({ id, state: 'ignored_stage', action: event.action, eventPipelineId: event.pipeline_id ?? null, eventStatusId: event.status_id ?? null, leadPipelineId: lead.pipeline_id, leadStatusId: lead.status_id, expectedPipelineId, expectedStatusId });
        continue;
      }
      const contacts = lead._embedded?.contacts ?? [];
      const contact = contacts.find(c => c.is_main) ?? contacts[0];
      if (!contact) { results.push({ id, state: 'no_contact' }); continue; }
      step = 'contact_read';
      const person = await jsonFetch(`${base}/api/v4/contacts/${contact.id}`, { headers: { Authorization: `Bearer ${token}` } });
      const phoneField = person.custom_fields_values?.find(f => f.field_code === 'PHONE');
      const phone = normalizePhone(phoneField?.values?.[0]?.value);
      if (!phone) { results.push({ id, state: 'invalid_phone' }); continue; }
      step = 'sender_selection';
      const { route, key } = routeFor(lead, env);
      const { text: smsText, slot } = selectSmsText(event, lead, env, receivedAt);
      // This guard is shared by requests in ONE warm function instance, not a database.
      step = 'duplicate_check';
      if (smsGuard && !smsGuard.claim(`${base}/leads/${id}`)) {
        results.push({ id, state: 'duplicate_in_instance' });
        continue;
      }
      try {
        console.info(JSON.stringify({ event: 'sms_dispatch_started', leadId: id, studio: key, slot }));
        await sendSms(phone, smsText, route);
        console.info(JSON.stringify({ event: 'sms_accepted', leadId: id, studio: key, slot }));
        results.push({ id, state: 'accepted' });
      } catch (error) {
        console.error(JSON.stringify({ event: 'sms_review_required', leadId: id, studio: key, slot, message: error.message }));
        results.push({ id, state: 'review_required' });
      }
    } catch (error) {
      console.error(JSON.stringify({ event: 'lead_error', leadId: id, step, message: error.message }));
      results.push({ id, state: 'error' });
    }
  }
  console.info(JSON.stringify({ event: 'webhook_result', results }));
  return { status: 200, body: { results } };
}
