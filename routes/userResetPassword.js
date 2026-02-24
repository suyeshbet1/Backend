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

    // ✅ Clean phone (remove +, spaces, etc.)
    const cleanPhone = phone.replace(/\D/g, '');

    if (cleanPhone.length < 10) {
      return res.status(400).json({
        success: false,
        message: 'Invalid phone number',
      });
    }

    // ✅ Convert phone to your email format
    const formattedEmail = cleanPhone.startsWith('91')
      ? `${cleanPhone}@userapp.com`
      : `91${cleanPhone}@userapp.com`;

    let userRecord;

    try {
      // ✅ Find user by email (NOT phone)
      userRecord = await admin.auth().getUserByEmail(formattedEmail);
    } catch (error) {
      if (error.code === 'auth/user-not-found') {
        return res.status(404).json({
          success: false,
          message: 'User not found',
        });
      } else {
        console.error('Firebase Lookup Error:', error);
        return res.status(500).json({
          success: false,
          message: error.message,
        });
      }
    }

    // ✅ Update password
    await admin.auth().updateUser(userRecord.uid, {
      password: String(newPassword),
    });

    // ✅ Update Firestore flag
    await db.collection('users').doc(userRecord.uid).set(
      { isResetpassword: false },
      { merge: true }
    );

    console.log('Password updated for:', formattedEmail);

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
