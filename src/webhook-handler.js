import { handle, prepareWebhook } from './service.js';
import { createSmsGuard } from './sms-guard.js';

export function createWebhookHandler({ waitUntil, env = () => process.env, smsGuard = createSmsGuard() }) {
  return function webhook(req, res) {
    try {
      res.setHeader('X-Webhook-Mode', 'background-v1');
      const receivedAt = Date.now();
      const settings = { ...env() };
      const prepared = prepareWebhook(req, settings);
      if (prepared.response) {
        res.status(prepared.response.status).json(prepared.response.body);
        return;
      }
      const snapshot = { method: req.method, query: { key: req.query.key }, body: req.body };
      // Register before ending the response. Vercel keeps the function alive for
      // this promise, while amoCRM receives its acknowledgement immediately.
      let registered = false;
      const task = Promise.resolve().then(() => registered ? handle(snapshot, settings, { smsGuard, receivedAt }) : undefined).catch(error => {
        console.error(JSON.stringify({ event: 'webhook_background_error', message: error.message }));
      });
      waitUntil(task);
      registered = true;
      console.info(JSON.stringify({ event: 'webhook_received', leadIds: [...new Set(prepared.events.map(event => event.id))] }));
      res.status(200).json({ received: true });
    } catch (error) {
      console.error(JSON.stringify({ event: 'webhook_error', message: error.message }));
      res.status(500).json({ error: 'internal_error' });
    }
  };
}
