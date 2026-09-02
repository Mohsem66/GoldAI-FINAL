const express = require('express');
const axios = require('axios');
const router = express.Router();

const MT5_CONFIG = {
  server: process.env.MT5_SERVER || 'ICMarkets-Demo',
  login: process.env.MT5_LOGIN,
  password: process.env.MT5_PASSWORD
};

const PYTHON_SERVER = (process.env.MT5_BRIDGE_URL || 'http://localhost:5001').replace(/\/$/, '');

router.post('/send-signal', async (req, res) => {
  try {
    const { signal, entry, sl, tp1, tp2, tp3, volume } = req.body;
    let bridgeOnline = true;
    const response = await axios.post(`${PYTHON_SERVER}/execute-trade`, {
      signal, entry, stopLoss: sl, tp1, tp2, tp3, volume,
      server: MT5_CONFIG.server, login: MT5_CONFIG.login
    }, { timeout: 5000 }).catch((err) => {
      bridgeOnline = false;
      return { data: { status: 'DISCONNECTED', message: 'MT5 Python bridge offline', error: err.message } };
    });
    const status = response.data.status || (bridgeOnline ? 'PENDING' : 'DISCONNECTED');
    res.json({
      message: bridgeOnline ? 'Signal forwarded to MT5 bridge' : 'MT5 bridge not available — trade NOT executed',
      status,
      executionState: status,
      details: response.data
    });
  } catch (error) {
    res.status(500).json({ error: error.message, executionState: 'ERROR' });
  }
});

router.get('/current-price', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';
    const response = await axios.get(`${PYTHON_SERVER}/current-price`, { params: { symbol }, timeout: 3000 }).catch(() => ({
      data: { price: 0, status: 'unavailable' }
    }));
    res.json({ price: response.data.price, status: response.data.status || 'ok', timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

const MT5_TIMEFRAMES = ['M1', 'M5', 'M15', 'M30', 'H1', 'H4', 'D1'];

router.get('/candles', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';
    const timeframe = String(req.query.timeframe || 'M5').toUpperCase();
    if (!MT5_TIMEFRAMES.includes(timeframe)) {
      return res.status(400).json({ status: 'error', message: `unsupported timeframe ${timeframe}`, candles: [] });
    }
    let count = parseInt(req.query.count, 10);
    if (!Number.isFinite(count)) count = 120;
    count = Math.max(10, Math.min(count, 5000));

    const response = await axios.get(`${PYTHON_SERVER}/candles`, {
      params: { symbol, timeframe, count },
      timeout: 20000 // large backtest pulls (up to 5000 bars) need more than the old 8s
    }).catch(() => ({
      data: { status: 'unavailable', message: 'MT5 Python bridge unreachable', candles: [] }
    }));

    res.json(response.data);
  } catch (error) {
    res.status(500).json({ status: 'error', error: error.message, candles: [] });
  }
});

router.get('/account-info/:uid', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_SERVER}/account-info`, { timeout: 3000 }).catch(() => ({
      data: { balance: 0, equity: 0, freeMargin: 0, status: 'unavailable' }
    }));
    res.json({ ...response.data, timestamp: new Date().toISOString() });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

router.get('/symbol-info', async (req, res) => {
  try {
    const symbol = req.query.symbol || 'XAUUSD';
    const response = await axios.get(`${PYTHON_SERVER}/symbol-info`, { params: { symbol }, timeout: 3000 });
    res.json(response.data);
  } catch (e) {
    res.json({
      status: 'unavailable',
      message: 'MT5 bridge offline — using approximate lot sizing',
      executionState: 'DISCONNECTED'
    });
  }
});

router.get('/health', async (req, res) => {
  try {
    const response = await axios.get(`${PYTHON_SERVER}/health`, { timeout: 2000 });
    res.json({ status: 'online', bridge: 'connected', executionState: 'READY', details: response.data });
  } catch (e) {
    res.json({
      status: 'degraded',
      bridge: 'DISCONNECTED',
      executionState: 'DISCONNECTED',
      message: 'Python MT5 bridge not reachable on port 5001'
    });
  }
});

module.exports = router;
