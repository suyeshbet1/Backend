const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();

const getFirestore = () => {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized');
  }
  return admin.firestore();
};

router.get('/cleargameresult', async (req, res) => {
  try {
    const db = getFirestore();
    const nowIst = new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const hours = nowIst.getHours();
    const minutes = nowIst.getMinutes();
    const currentMinutes = hours * 60 + minutes;
    const startWindow = 4 * 60 + 45;
    const endWindow = 5 * 60 + 15;

    // Uncomment to enforce the execution window guard rails.
    // if (currentMinutes < startWindow || currentMinutes > endWindow) {
    //   return res.status(413).json({
    //     success: false,
    //     message: 'cleargameresult can only run between 04:45 AM and 05:15 AM IST',
    //     currentTimeIST: nowIst.toTimeString().slice(0, 5),
    //   });
    // }

    const gamesCol = db.collection('games');
    const snap = await gamesCol.get();

    if (snap.empty) {
      return res.status(200).json({
        success: true,
        processed: 0,
        message: 'No games found',
      });
    }

    const BATCH_LIMIT = 500;
    let batch = db.batch();
    let opCount = 0;
    let total = 0;

    for (const doc of snap.docs) {
      const data = doc.data() || {};
      const ref = gamesCol.doc(doc.id);
      const payload = {
        chartLink: data.chartLink ?? null,
        createdAt: data.createdAt ?? null,
        gameId: doc.id,
        orderId: data.orderId ?? null,
        name: data.name ?? doc.id,
        result: '***-**-***',
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        clear_result: true,
        openTime: data.openTime ?? null,
        closeTime: data.closeTime ?? null,
      };

      batch.set(ref, payload, { merge: false });
      opCount++;
      total++;

      if (opCount >= BATCH_LIMIT) {
        await batch.commit();
        batch = db.batch();
        opCount = 0;
      }
    }

    if (opCount > 0) {
      await batch.commit();
    }

    console.log(`cleargameresult: processed ${total} game docs`);

    return res.status(200).json({
      success: true,
      processed: total,
      ranAtIST: nowIst.toTimeString().slice(0, 5),
      windowStartMinutes: startWindow,
      windowEndMinutes: endWindow,
      currentMinutes,
    });
  } catch (err) {
    console.error('cleargameresult failed:', err && err.message ? err.message : err);
    const firebaseMissing = err.message === 'Firebase Admin SDK is not initialized';
    return res.status(firebaseMissing ? 503 : 500).json({
      success: false,
      message: firebaseMissing ? 'Firebase Admin SDK is not configured' : 'Failed to clear game results',
    });
  }
});

module.exports = router;
