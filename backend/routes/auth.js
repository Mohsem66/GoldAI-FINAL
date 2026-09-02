const express = require('express');
const bcrypt = require('bcryptjs');
const router = express.Router();

module.exports = (auth, db) => {
  
  // ثبت نام کاربر جدید
  router.post('/register', async (req, res) => {
    try {
      const { email, password, capital, riskPercent } = req.body;
      
      // Validation
      if (!email || !password) {
        return res.status(400).json({ error: 'ایمیل و رمز عبور الزامی هستند' });
      }

      // ایجاد کاربر در Firebase Auth
      const userRecord = await auth.createUser({
        email: email,
        password: password
      });

      // ذخیره داده‌های کاربر در Firestore
      await db.collection('users').doc(userRecord.uid).set({
        email: email,
        capital: capital || 1000,
        riskPercent: riskPercent || 2,
        lot: 0.01,
        createdAt: new Date(),
        lastLogin: new Date(),
        settings: {
          theme: 'dark',
          notifications: true,
          language: 'fa'
        }
      });

      res.status(201).json({
        message: '✅ ثبت نام موفق',
        uid: userRecord.uid,
        email: email
      });

    } catch (error) {
      console.error('خطای ثبت نام:', error);
      res.status(500).json({ 
        error: 'خطا در ثبت نام',
        details: error.message 
      });
    }
  });

  // ورود کاربر
  router.post('/login', async (req, res) => {
    try {
      const { email, password } = req.body;
      
      if (!email || !password) {
        return res.status(400).json({ error: 'ایمیل و رمز عبور الزامی هستند' });
      }

      // بررسی کاربر (Firebase Admin نتواند مستقیم لاگین کند)
      // باید کلاینت از firebase-auth استفاده کند
      
      res.json({
        message: '✅ برای لاگین از Firebase Client SDK استفاده کنید',
        redirect: '/login'
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // دریافت پروفایل کاربر
  router.get('/profile/:uid', async (req, res) => {
    try {
      const { uid } = req.params;
      
      const userDoc = await db.collection('users').doc(uid).get();
      
      if (!userDoc.exists) {
        return res.status(404).json({ error: 'کاربر پیدا نشد' });
      }

      res.json({
        uid: uid,
        ...userDoc.data()
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  // بروزرسانی تنظیمات کاربر
  router.put('/profile/:uid', async (req, res) => {
    try {
      const { uid } = req.params;
      const { capital, riskPercent, lot } = req.body;

      await db.collection('users').doc(uid).update({
        capital: capital,
        riskPercent: riskPercent,
        lot: lot,
        updatedAt: new Date()
      });

      res.json({ 
        message: '✅ تنظیمات بروزرسانی شد',
        capital, riskPercent, lot
      });

    } catch (error) {
      res.status(500).json({ error: error.message });
    }
  });

  return router;
};
