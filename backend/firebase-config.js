const admin = require('firebase-admin');
const dotenv = require('dotenv');

dotenv.config();

// Firebase Configuration برای Frontend
const firebaseClientConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID
};

// Firebase Admin SDK Configuration
let serviceAccount;
try {
  serviceAccount = require(process.env.FIREBASE_SERVICE_ACCOUNT_KEY || './firebase-key.json');
} catch (error) {
  console.warn('⚠️ firebase-key.json پیدا نشد. لطفاً آن را دانلود کنید');
}

const adminConfig = {
  credential: serviceAccount 
    ? admin.credential.cert(serviceAccount)
    : admin.credential.applicationDefault(),
  projectId: process.env.FIREBASE_PROJECT_ID,
  databaseURL: `https://${process.env.FIREBASE_PROJECT_ID}.firebaseio.com`
};

module.exports = {
  firebaseClientConfig,
  adminConfig,
  serviceAccount
};
