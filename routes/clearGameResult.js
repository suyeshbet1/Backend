const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();

const getFirestore = () => {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized');
  }
  return admin.firestore();
};

const getIstNow = () => new Date(new Date().toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));

const formatDdMmYyyy = (d) => {
  const dd = String(d.getDate()).padStart(2, '0');
  const mm = String(d.getMonth() + 1).padStart(2, '0');
  const yyyy = String(d.getFullYear());
  return `${dd}-${mm}-${yyyy}`;
};

const getYesterdayIstDateId = () => {
  const nowIst = getIstNow();
  const y = new Date(nowIst);
  y.setDate(y.getDate() - 1);
  return formatDdMmYyyy(y);
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

// Moves all docs from `todaysCompletedBets` into:
// 1) `Alluserbets/{yesterdayIST}/userbetsD/{betDocId}`
// 2) `users/{userId}/userbets/{betDocId}`
router.get('/Alluserbets-add', async (req, res) => {
  try {
    const db = getFirestore();
    const serverTs = admin.firestore.FieldValue.serverTimestamp();
    const dateId = getYesterdayIstDateId();

    const srcCol = db.collection('todaysCompletedBets');
    const allUserBetsDocRef = db.collection('Alluserbets').doc(dateId);

    // ✅ Ensure parent date document exists
    await allUserBetsDocRef.set(
      {
        dateId,
        sourceCollection: 'todaysCompletedBets',
        createdAt: serverTs,
      },
      { merge: true }
    );

    const PAGE_SIZE = 450;
    const MAX_BATCH_OPS = 450;

    let lastDoc = null;
    let batch = db.batch();
    let opCount = 0;
    let commits = 0;

    let scanned = 0;
    let writtenToAlluserbets = 0;
    let writtenToUsers = 0;
    let deletedFromSource = 0;
    let missingUserId = 0;

    const flush = async () => {
      if (opCount === 0) return;
      await batch.commit();
      batch = db.batch();
      opCount = 0;
      commits++;
    };

    while (true) {
      let query = srcCol
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(PAGE_SIZE);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      for (const doc of snapshot.docs) {
        scanned++;

        const betId = doc.id;
        const betData = doc.data() || {};
        const userId = betData.userId ? String(betData.userId) : '';

        const betPayload = {
          ...betData,
          betId,
          archiveDate: dateId,
          migratedAt: serverTs,
        };

        // 1️⃣ Archive
        const archiveRef = allUserBetsDocRef
          .collection('userbetsD')
          .doc(betId);

        batch.set(archiveRef, betPayload);
        opCount++;
        writtenToAlluserbets++;

        // 2️⃣ Copy to users collection
        if (userId) {
          const userRef = db
            .collection('users')
            .doc(userId)
            .collection('userbets')
            .doc(betId);

          batch.set(userRef, betPayload, { merge: true });
          opCount++;
          writtenToUsers++;
        } else {
          missingUserId++;
        }

        // 3️⃣ DELETE from todaysCompletedBets (TRUE MOVE)
        batch.delete(doc.ref);
        opCount++;
        deletedFromSource++;

        if (opCount >= MAX_BATCH_OPS) {
          await flush();
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    await flush();

    // ✅ Update summary
    await allUserBetsDocRef.set(
      {
        updatedAt: serverTs,
        scanned,
        writtenToAlluserbets,
        writtenToUsers,
        deletedFromSource,
        missingUserId,
        commits,
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      dateId,
      scanned,
      writtenToAlluserbets,
      writtenToUsers,
      deletedFromSource,
      missingUserId,
      commits,
    });

  } catch (err) {
    console.error('Alluserbets-add failed:', err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
});
router.get('/AlluserWithdrawal-add', async (req, res) => {
  try {
    const db = getFirestore();
    const serverTs = admin.firestore.FieldValue.serverTimestamp();
    const dateId = getYesterdayIstDateId();

    const srcCol = db.collection('todaysWithdrawalReq');
    const archiveDocRef = db.collection('AlluserWithdrawal').doc(dateId);

    // ✅ Ensure parent date doc exists
    await archiveDocRef.set(
      {
        dateId,
        sourceCollection: 'todaysWithdrawalReq',
        createdAt: serverTs,
      },
      { merge: true }
    );

    const PAGE_SIZE = 450;
    const MAX_BATCH_OPS = 450;

    let lastDoc = null;
    let batch = db.batch();
    let opCount = 0;
    let commits = 0;

    let scanned = 0;
    let archivedCount = 0;
    let writtenToUsers = 0;
    let deletedFromSource = 0;
    let missingRequestedByUid = 0;

    const flush = async () => {
      if (opCount === 0) return;
      await batch.commit();
      batch = db.batch();
      opCount = 0;
      commits++;
    };

    while (true) {
      let query = srcCol
        .where('status', '==', 'completed')
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(PAGE_SIZE);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      for (const doc of snapshot.docs) {
        scanned++;

        const withdrawalId = doc.id;
        const data = doc.data() || {};

        const requestedByUid = data.requestedByUid
          ? String(data.requestedByUid)
          : '';

        const payload = {
          ...data,
          withdrawalId,
          archiveDate: dateId,
          migratedAt: serverTs,
        };

        // 1️⃣ Archive
        const archiveRef = archiveDocRef
          .collection('userWithdrawalD')
          .doc(withdrawalId);

        batch.set(archiveRef, payload);
        opCount++;
        archivedCount++;

        // 2️⃣ Copy to user
        if (requestedByUid) {
          const userRef = db
            .collection('users')
            .doc(requestedByUid)
            .collection('userWithdrawal')
            .doc(withdrawalId);

          batch.set(userRef, payload, { merge: true });
          opCount++;
          writtenToUsers++;
        } else {
          missingRequestedByUid++;
        }

        // 3️⃣ DELETE from source (true move)
        batch.delete(doc.ref);
        opCount++;
        deletedFromSource++;

        if (opCount >= MAX_BATCH_OPS) {
          await flush();
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    await flush();

    // ✅ Update summary
    await archiveDocRef.set(
      {
        updatedAt: serverTs,
        scanned,
        archivedCount,
        writtenToUsers,
        deletedFromSource,
        missingRequestedByUid,
        commits,
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      dateId,
      scanned,
      archivedCount,
      writtenToUsers,
      deletedFromSource,
      missingRequestedByUid,
      commits,
    });

  } catch (err) {
    console.error('AlluserWithdrawal-add failed:', err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
});


router.get('/Allmanualdeposite-add', async (req, res) => {
  try {
    const db = getFirestore();
    const serverTs = admin.firestore.FieldValue.serverTimestamp();
    const dateId = getYesterdayIstDateId(); // DD-MM-YYYY

    const srcCol = db.collection('todaysmanualdeposite');
    const archiveDocRef = db.collection('Allmanualdeposite').doc(dateId);

    // ✅ Ensure parent date document exists (idempotent)
    await archiveDocRef.set(
      {
        dateId,
        sourceCollection: 'todaysmanualdeposite',
        createdAt: serverTs,
      },
      { merge: true }
    );

    const PAGE_SIZE = 450;
    const MAX_BATCH_OPS = 450;

    let lastDoc = null;
    let batch = db.batch();
    let opCount = 0;
    let commits = 0;

    let scanned = 0;
    let archivedCount = 0;
    let deletedFromSource = 0;

    const flush = async () => {
      if (opCount === 0) return;
      await batch.commit();
      batch = db.batch();
      opCount = 0;
      commits++;
    };

    // 🔁 Pagination loop
    while (true) {
      let query = srcCol
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(PAGE_SIZE);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      for (const doc of snapshot.docs) {
        scanned++;

        const depositId = doc.id;
        const data = doc.data() || {};

        const payload = {
          ...data,
          depositId,
          archiveDate: dateId,
          migratedAt: serverTs,
        };

        // 1️⃣ Archive
        const archiveRef = archiveDocRef
          .collection('AllmanualdepositeD')
          .doc(depositId);

        batch.set(archiveRef, payload);
        opCount++;
        archivedCount++;

        // 2️⃣ Delete from source (TRUE MOVE)
        batch.delete(doc.ref);
        opCount++;
        deletedFromSource++;

        if (opCount >= MAX_BATCH_OPS) {
          await flush();
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    await flush();

    // ✅ Update summary stats
    await archiveDocRef.set(
      {
        updatedAt: serverTs,
        scanned,
        archivedCount,
        deletedFromSource,
        commits,
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      dateId,
      scanned,
      archivedCount,
      deletedFromSource,
      commits,
    });

  } catch (err) {
    console.error('Allmanualdeposite-add failed:', err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
});
router.get('/Allmanualwithdrawal-add', async (req, res) => {
  try {
    const db = getFirestore();
    const serverTs = admin.firestore.FieldValue.serverTimestamp();
    const dateId = getYesterdayIstDateId(); // must return DD-MM-YYYY

    const srcCol = db.collection('todaysmanualwithdrawal');
    const archiveDocRef = db.collection('Allmanualwithdrawal').doc(dateId);

    // ✅ Ensure parent date doc exists (idempotent)
    await archiveDocRef.set(
      {
        dateId,
        sourceCollection: 'todaysmanualwithdrawal',
        createdAt: serverTs,
      },
      { merge: true }
    );

    const PAGE_SIZE = 450;
    const MAX_BATCH_OPS = 450;

    let lastDoc = null;
    let batch = db.batch();
    let opCount = 0;
    let commits = 0;

    let scanned = 0;
    let archivedCount = 0;
    let deletedFromSource = 0;

    const flush = async () => {
      if (opCount === 0) return;
      await batch.commit();
      batch = db.batch();
      opCount = 0;
      commits++;
    };

    while (true) {
      let query = srcCol
        .orderBy(admin.firestore.FieldPath.documentId())
        .limit(PAGE_SIZE);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      for (const doc of snapshot.docs) {
        scanned++;

        const withdrawalId = doc.id;
        const data = doc.data() || {};

        const payload = {
          ...data,
          withdrawalId,
          archiveDate: dateId,
          migratedAt: serverTs,
        };

        // 1️⃣ Archive into Allmanualwithdrawal/{date}/AllmanualwithdrawalD
        const archiveRef = archiveDocRef
          .collection('AllmanualwithdrawalD')
          .doc(withdrawalId);

        batch.set(archiveRef, payload);
        opCount++;
        archivedCount++;

        // 2️⃣ Delete from todaysmanualwithdrawal (TRUE MOVE)
        batch.delete(doc.ref);
        opCount++;
        deletedFromSource++;

        if (opCount >= MAX_BATCH_OPS) {
          await flush();
        }
      }

      lastDoc = snapshot.docs[snapshot.docs.length - 1];
    }

    await flush();

    // ✅ Update summary stats on parent doc
    await archiveDocRef.set(
      {
        updatedAt: serverTs,
        scanned,
        archivedCount,
        deletedFromSource,
        commits,
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      dateId,
      scanned,
      archivedCount,
      deletedFromSource,
      commits,
    });

  } catch (err) {
    console.error('Allmanualwithdrawal-add failed:', err);
    return res.status(500).json({
      ok: false,
      message: err.message,
    });
  }
});
module.exports = router;
