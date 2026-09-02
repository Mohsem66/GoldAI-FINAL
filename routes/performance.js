const express = require('express');
const router = express.Router();

module.exports = (db) => {
  
  // دریافت گزارش عملکرد کامل
  router.get('/report/:uid', async (req, res) => {
    try {
      const { uid } = req.params;

      // دریافت اطلاعات Performance
      const perfDoc = await db.collection('performance').doc(uid).get();
      
      if (!perfDoc.exists) {
        return res.json({
          uid: uid,
          message: 'هنوز سیگنالی ثبت نشده',
          totalSignals: 0
        });
      }

      const perf = perfDoc.data();

      // محاسبات اضافی
      const winRate = perf.totalSignals > 0 
        ? Math.round((perf.winCount / perf.totalSignals) * 100)
        : 0;

      const netProfit = (perf.totalProfit || 0) + (perf.totalLoss || 0);
      
      const profitFactor = (perf.totalLoss || 0) !== 0
        ? Math.abs((perf.totalProfit || 0) / (perf.totalLoss || 0))
        : 0;

      const averageWin = perf.winCount > 0
        ? (perf.totalProfit || 0) / perf.winCount
        : 0;

      const averageLoss = perf.lossCount > 0
        ? (perf.totalLoss || 0) / perf.lossCount
        : 0;

      res.json({
        uid: uid,
        // شمار کنندگان
        totalSignals: perf.totalSignals || 0,
        totalBUY: perf.totalBUY || 0,
        totalSELL: perf.totalSELL || 0,
        totalWAIT: perf.totalWAIT || 0,
        
        // نتایج
        winCount: perf.winCount || 0,
        lossCount: perf.lossCount || 0,
        winRate: `${winRate}%`,
        
        // سود و ضرر
        totalProfit: parseFloat((perf.totalProfit || 0).toFixed(2)),
        totalLoss: parseFloat((perf.totalLoss || 0).toFixed(2)),
        netProfit: parseFloat(netProfit.toFixed(2)),
        
        // نسبت‌ها
        profitFactor: parseFloat(profitFactor.toFixed(2)),
        averageWin: parseFloat(averageWin.toFixed(2)),
        averageLoss: parseFloat(averageLoss.toFixed(2)),
        
        // تاریخ
        createdAt: perf.createdAt,
        updatedAt: perf.updatedAt
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // دریافت گزارش تفصیلی شامل آخرین ۱۰ سیگنال
  router.get('/detailed/:uid', async (req, res) => {
    try {
      const { uid } = req.params;

      // عملکرد
      const perfDoc = await db.collection('performance').doc(uid).get();
      const perf = perfDoc.exists ? perfDoc.data() : null;

      // آخرین ۱۰ سیگنال
      const signalsSnapshot = await db.collection('signals')
        .doc(uid)
        .collection('history')
        .orderBy('time', 'desc')
        .limit(10)
        .get();

      const signals = signalsSnapshot.docs.map(doc => ({
        id: doc.id,
        ...doc.data()
      }));

      res.json({
        uid: uid,
        performance: perf || { totalSignals: 0 },
        recentSignals: signals,
        totalRecentSignals: signals.length
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // ریست کردن آمار (توجه: داده‌های سیگنال حذف نمی‌شود)
  router.post('/reset/:uid', async (req, res) => {
    try {
      const { uid } = req.params;

      await db.collection('performance').doc(uid).set({
        totalSignals: 0,
        totalBUY: 0,
        totalSELL: 0,
        totalWAIT: 0,
        winCount: 0,
        lossCount: 0,
        totalProfit: 0,
        totalLoss: 0,
        resetAt: new Date()
      });

      res.json({
        message: '✅ آمار ریست شد (سیگنال‌های قبلی حفظ شدند)'
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
