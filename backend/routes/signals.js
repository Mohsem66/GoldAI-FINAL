const express = require('express');
const router = express.Router();

module.exports = (db) => {
  
  // ذخیره سیگنال جدید
  router.post('/save', async (req, res) => {
    try {
      const { uid, signal, entry, sl, tp1, tp2, tp3, confidence, quality, reason } = req.body;

      if (!uid) {
        return res.status(400).json({ error: 'uid الزامی است' });
      }

      // اضافه کردن سیگنال جدید
      const signalRef = await db.collection('signals')
        .doc(uid)
        .collection('history')
        .add({
          id: Date.now(),
          time: new Date(),
          signal: signal,      // BUY, SELL, WAIT
          entry: entry,
          sl: sl,
          tp1: tp1,
          tp2: tp2,
          tp3: tp3,
          confidence: confidence,
          quality: quality,
          reason: reason,
          result: null,         // بعداً پر می‌شود
          profit: 0,
          status: "PENDING",    // PENDING, WIN, LOSS
          updatedAt: new Date()
        });

      // بروزرسانی Performance (شمار کنندگان)
      await db.collection('performance').doc(uid).update({
        totalSignals: db.FieldValue.increment(1),
        [`total${signal}`]: db.FieldValue.increment(1),
        updatedAt: new Date()
      }).catch(() => {
        // اگر Performance وجود ندارد، آن را ایجاد کن
        return db.collection('performance').doc(uid).set({
          totalSignals: 1,
          totalBUY: signal === 'BUY' ? 1 : 0,
          totalSELL: signal === 'SELL' ? 1 : 0,
          totalWAIT: signal === 'WAIT' ? 1 : 0,
          winCount: 0,
          lossCount: 0,
          totalProfit: 0,
          totalLoss: 0,
          createdAt: new Date(),
          updatedAt: new Date()
        });
      });

      // بررسی و حذف سیگنال‌های قدیم (فقط ۱۰ تا نگه دار)
      const allSignals = await db.collection('signals')
        .doc(uid)
        .collection('history')
        .orderBy('time', 'asc')
        .get();

      if (allSignals.size > 10) {
        const toDelete = allSignals.docs[0];
        await toDelete.ref.delete();
      }

      res.status(201).json({
        message: '✅ سیگنال ذخیره شد',
        id: signalRef.id,
        signal: signal
      });

    } catch (error) {
      console.error('خطا:', error);
      res.status(500).json({ error: error.message });
    }
  });

  // دریافت آخرین ۱۰ سیگنال
  router.get('/latest/:uid', async (req, res) => {
    try {
      const { uid } = req.params;

      const signals = await db.collection('signals')
        .doc(uid)
        .collection('history')
        .orderBy('time', 'desc')
        .limit(10)
        .get();

      const signalsList = signals.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        total: signalsList.length,
        signals: signalsList
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // بروزرسانی نتیجه سیگنال (WIN/LOSS)
  router.put('/result/:uid/:signalId', async (req, res) => {
    try {
      const { uid, signalId } = req.params;
      const { status, profit, exitPrice } = req.body;

      // بروزرسانی سیگنال
      await db.collection('signals')
        .doc(uid)
        .collection('history')
        .doc(signalId)
        .update({
          status: status,    // WIN یا LOSS
          profit: profit,
          exitPrice: exitPrice,
          result: {
            status: status,
            profit: profit,
            closedAt: new Date()
          }
        });

      // بروزرسانی Performance
      if (status === 'WIN') {
        await db.collection('performance').doc(uid).update({
          winCount: db.FieldValue.increment(1),
          totalProfit: db.FieldValue.increment(profit)
        });
      } else if (status === 'LOSS') {
        await db.collection('performance').doc(uid).update({
          lossCount: db.FieldValue.increment(1),
          totalLoss: db.FieldValue.increment(-Math.abs(profit))
        });
      }

      res.json({ 
        message: '✅ نتیجه سیگنال بروزرسانی شد',
        status: status,
        profit: profit
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
