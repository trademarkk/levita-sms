export default function oauthRedirect(req, res) {
  if (req.method !== 'GET') return res.status(405).end();
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  return res.status(200).send('LEVITA amoCRM integration endpoint');
}
