import { handle } from '../src/service.js';

export default async function webhook(req, res) {
  try {
    const result = await handle(req, process.env);
    res.status(result.status).json(result.body);
  } catch (error) {
    console.error(JSON.stringify({ event: 'webhook_error', message: error.message }));
    res.status(500).json({ error: 'internal_error' });
  }
}
