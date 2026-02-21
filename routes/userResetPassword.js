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

    // ✅ Validate input
    if (!phone || !newPassword) {
      return res.status(400).json({
        success: false,
        message: 'phone and newPassword are required',
      });
    }

    if (String(newPassword).length < 6) {
      return res.status(400).json({
        success: false,
        message: 'Password must be at least 6 characters',
      });
    }

    // ✅ Clean phone
    const cleanPhone = phone.replace(/\D/g, '');

    if (cleanPhone.length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number',
      });
    }

    // ✅ Format Indian phone properly
    const formattedPhone = cleanPhone.startsWith('91')
      ? `+${cleanPhone}`
      : `+91${cleanPhone}`;

    let uid;

    try {
      // ✅ Try to find user by phone (best practice)
      const user = await admin.auth().getUserByPhoneNumber(formattedPhone);
      uid = user.uid;

      await admin.auth().updateUser(uid, {
        password: String(newPassword),
      });

      console.log('Password updated for:', formattedPhone);

    } catch (error) {

      if (error.code === 'auth/user-not-found') {
        console.log('User not found. Creating new user...');

        const newUser = await admin.auth().createUser({
          phoneNumber: formattedPhone,
          password: String(newPassword),
        });

        uid = newUser.uid;
      } else {
        console.error('Firebase Auth Error:', error);
        return res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    }

    // ✅ Update Firestore document
    if (uid) {
      await db.collection('users').doc(uid).set(
        { isResetpassword: false },
        { merge: true }
      );
    }

    return res.json({
      success: true,
      message: 'Password updated successfully',
    });

  } catch (err) {
    console.error('RESET PASSWORD ERROR FULL:', err);

    return res.status(500).json({
      success: false,
      message: err.message || 'Password reset failed',
    });
  }
});

module.exports = router;
