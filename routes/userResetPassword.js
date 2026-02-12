const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();

const getFirestore = () => {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized');
  }
  return admin.firestore();
};

router.post('/user/reset-password', async (req, res) => {
  console.log('REQUEST BODY:', req.body);
  try {
    const db = getFirestore();
    const { phone, newPassword } = req.body;

    if (!phone || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'phone and newPassword are required',
      });
    }

    const cleanPhone = phone.replace(/\D/g, '');
    const email = `${cleanPhone}@userapp.com`;
    let uid = null;

    try {
      const user = await admin.auth().getUserByEmail(email);
      uid = user.uid;
      await admin.auth().updateUser(user.uid, { password: String(newPassword) });
    } catch (e) {
      if (e.code === 'auth/user-not-found') {
        const created = await admin.auth().createUser({
          email,
          phoneNumber: `+91${cleanPhone}`,
          password: String(newPassword),
        });
        uid = created.uid;
      } else {
        throw e;
      }
    }

    try {
      if (uid) {
        await db.collection('users').doc(uid).set({ isResetpassword: false }, { merge: true });
      }
    } catch (e) {
      console.warn('Failed to clear isResetpassword flag for uid', uid, e.message || e);
    }

    return res.json({ success: true, message: 'Password updated' });
  } catch (err) {
    console.error('RESET PASSWORD ERROR:', err && err.message ? err.message : err);
    const firebaseMissing = err.message === 'Firebase Admin SDK is not initialized';
    return res.status(firebaseMissing ? 503 : 500).json({
      success: false,
      message: firebaseMissing ? 'Firebase Admin SDK is not configured' : 'Password reset failed',
    });
  }
});

module.exports = router;
