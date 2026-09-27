import { handleSmsHistory } from '../src/sms-history.js';

export default async function moizvonkiWebhook(req, res) {
  try {
    const result = await handleSmsHistory(req, process.env);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(JSON.stringify({ event: 'sms_history_error', message: error.message }));
    res.status(500).json({ error: 'internal_error' });
  }
}
