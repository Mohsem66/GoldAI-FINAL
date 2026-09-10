const express = require('express');
const router = express.Router();

/**
 * GET /api/fundamental
 * Attempts to provide macro context for XAU.
 * Without a paid calendar API key this returns structured simulated data
 * and sets source: "simulated".
 * Set ECONOMIC_API_URL in .env to point at a real calendar proxy later.
 */
router.get('/', async (req, res) => {
  const external = process.env.ECONOMIC_API_URL;
  if (external) {
    try {
      const fetch = require('node-fetch');
      const r = await fetch(external, { timeout: 4000 });
      if (r.ok) {
        const data = await r.json();
        return res.json({ source: 'live', ...data });
      }
    } catch (e) {
      // fall through to simulated
    }
  }

  const date = new Date();
  const seed = (date.getUTCFullYear() * 10000 + (date.getUTCMonth() + 1) * 100 + date.getUTCDate()) % 7;
  const profiles = [
    { cpi: 'HOT', nfp: 'STRONG', fed: 'HAWKISH', geoRisk: 5.1, bias: 'BEARISH' },
    { cpi: 'COOLING', nfp: 'WEAK_GROWTH', fed: 'DOVISH', geoRisk: 7.5, bias: 'BULLISH' },
    { cpi: 'IN_LINE', nfp: 'IN_LINE', fed: 'NEUTRAL', geoRisk: 6.8, bias: 'NEUTRAL' },
    { cpi: 'COOLING', nfp: 'WEAK_GROWTH', fed: 'DOVISH', geoRisk: 8.2, bias: 'BULLISH' },
    { cpi: 'STAGFLATION', nfp: 'WEAK_GROWTH', fed: 'NEUTRAL', geoRisk: 9.0, bias: 'BULLISH' },
    { cpi: 'HOT', nfp: 'IN_LINE', fed: 'HAWKISH', geoRisk: 4.5, bias: 'BEARISH' },
    { cpi: 'IN_LINE', nfp: 'STRONG', fed: 'NEUTRAL', geoRisk: 6.0, bias: 'NEUTRAL' }
  ];
  const p = profiles[seed];

  res.json({
    source: 'simulated',
    warning: 'Not live economic data — set ECONOMIC_API_URL for real feed',
    asOf: date.toISOString(),
    details: {
      cpi: p.cpi,
      nfp: p.nfp,
      fed: p.fed,
      geoRisk: p.geoRisk
    },
    bias: p.bias
  });
});

module.exports = router;
