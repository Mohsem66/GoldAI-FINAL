/**
 * Shared token auth for sensitive MT5 control/execution endpoints.
 * Worker and Dashboard must send: Authorization: Bearer <GOLD_AI_API_TOKEN>
 * or header: X-GoldAI-Token: <GOLD_AI_API_TOKEN>
 *
 * Fail-closed: if GOLD_AI_API_TOKEN is unset/empty, write endpoints reject all requests.
 */
function getExpectedToken() {
  const t = process.env.GOLD_AI_API_TOKEN;
  if (t == null || String(t).trim() === '') return null;
  return String(t).trim();
}

function extractToken(req) {
  const h = req.headers || {};
  const x = h['x-goldai-token'] || h['X-GoldAI-Token'];
  if (x && String(x).trim()) return String(x).trim();
  const auth = h.authorization || h.Authorization || '';
  const m = String(auth).match(/^Bearer\s+(.+)$/i);
  if (m) return m[1].trim();
  if (req.body && req.body.apiToken) return String(req.body.apiToken).trim();
  if (req.query && req.query.apiToken) return String(req.query.apiToken).trim();
  return null;
}

function requireApiToken(req, res, next) {
  const expected = getExpectedToken();
  if (!expected) {
    return res.status(401).json({
      status: 'AUTH_REQUIRED',
      error: 'GOLD_AI_API_TOKEN is not configured on server — write endpoints fail-closed',
      executionState: 'AUTH_REQUIRED'
    });
  }
  const got = extractToken(req);
  if (!got || got !== expected) {
    return res.status(401).json({
      status: 'UNAUTHORIZED',
      error: 'Invalid or missing API token',
      executionState: 'UNAUTHORIZED'
    });
  }
  return next();
}

module.exports = { getExpectedToken, extractToken, requireApiToken };
