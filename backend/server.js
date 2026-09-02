const express = require('express');
const cors = require('cors');
const dotenv = require('dotenv');
const bodyParser = require('body-parser');
const fetch = require('node-fetch');

dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;
const TWELVE_DATA_API_KEY = process.env.TWELVE_DATA_API_KEY;

app.use(cors());
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: true }));

app.get('/api/price', async (req, res) => {
  try {
    if (!TWELVE_DATA_API_KEY || String(TWELVE_DATA_API_KEY).includes('your_twelve_data')) {
      return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not configured in backend/.env' });
    }
    const symbol = req.query.symbol || 'XAU/USD';
    const url = `https://api.twelvedata.com/price?symbol=${encodeURIComponent(symbol)}&apikey=${TWELVE_DATA_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.price) {
      res.json({ price: parseFloat(data.price), source: 'twelve_data' });
    } else {
      res.status(502).json({ error: 'Failed to fetch price', details: data });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/historical', async (req, res) => {
  try {
    if (!TWELVE_DATA_API_KEY || String(TWELVE_DATA_API_KEY).includes('your_twelve_data')) {
      return res.status(503).json({ error: 'TWELVE_DATA_API_KEY not configured in backend/.env' });
    }
    const symbol = req.query.symbol || 'XAU/USD';
    const interval = req.query.interval || '5min';
    const outputsize = req.query.outputsize || 120;
    const url = `https://api.twelvedata.com/time_series?symbol=${encodeURIComponent(symbol)}&interval=${interval}&outputsize=${outputsize}&apikey=${TWELVE_DATA_API_KEY}`;
    const response = await fetch(url);
    const data = await response.json();
    if (data.values) {
      res.json(data);
    } else {
      res.status(502).json({ error: 'Failed to fetch historical data', details: data });
    }
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const admin = require('firebase-admin');
const firebaseConfig = require('./firebase-config');

if (!admin.apps.length) {
  admin.initializeApp(firebaseConfig.adminConfig);
}

const db = admin.firestore();
const auth = admin.auth();

const authRoutes = require('./routes/auth');
const signalRoutes = require('./routes/signals');
const performanceRoutes = require('./routes/performance');
const mt5Routes = require('./routes/mt5');
const fundamentalRoutes = require('./routes/fundamental');
const workerRoutes = require('./routes/worker');

app.use('/api/auth', authRoutes(auth, db));
app.use('/api/signals', signalRoutes(db));
app.use('/api/performance', performanceRoutes(db));
app.use('/api/mt5', mt5Routes);
app.use('/api/fundamental', fundamentalRoutes);
app.use('/api/worker', workerRoutes);

app.get('/api/health', (req, res) => {
  res.json({
    status: 'ok',
    hasApiKey: !!(TWELVE_DATA_API_KEY && !String(TWELVE_DATA_API_KEY).includes('your_twelve_data')),
    timestamp: new Date().toISOString()
  });
});

app.listen(PORT, () => {
  console.log(`GoldAI backend on http://localhost:${PORT}`);
  if (!TWELVE_DATA_API_KEY || String(TWELVE_DATA_API_KEY).includes('your_twelve_data')) {
    console.warn('WARNING: TWELVE_DATA_API_KEY not set');
  }
});

module.exports = { app, db, auth };
