// Read-only. The Express backend never runs the worker itself and never
// writes to these files — it only reads what backend/worker/signal-worker.js
// already wrote. If this whole Express process is down, the worker keeps
// running and writing signals completely unaffected.
const express = require("express");
const router = express.Router();
const store = require("../worker/store");

router.get("/status", (req, res) => {
  res.json(store.getStatus());
});

router.get("/signal/latest", (req, res) => {
  const j = store.getJournal(1);
  res.json(j.length ? j[j.length - 1] : null);
});

router.get("/journal", (req, res) => {
  const limit = Math.min(Number(req.query.limit) || 100, 2000);
  res.json(store.getJournal(limit));
});

module.exports = router;
