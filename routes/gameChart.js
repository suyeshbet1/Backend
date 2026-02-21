const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();

// router.get('/', (req, res) => {
//   res.json({ feature: 'game chart', message: 'Demo route for retrieving game chart data.' });
// });

router.post('/chart', async (req, res) => {
  try {
    // 🔐 Authorization
    const authHeader = (req.headers.authorization || '').toString();
    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID mismatch' });
    }

    if (!uid || !code || !gameName || !Array.isArray(bets) || bets.length === 0) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    // 🔥 Normalize Game Code
    const upperCode = String(code).toUpperCase().trim();

    const PANEL_CODES = new Set(['SP', 'DP', 'TP']);

    const baseCode = PANEL_CODES.has(upperCode)
      ? 'PANEL'
      : upperCode;

    // 🧠 Parse & Validate Bets
    const parsedBets = bets
      .map((b) => ({
        number: String(b.number || '').trim(),
        points: Number(b.points),
        game: b.game === 'close' ? 'close' : 'open',
      }))
      .filter(
        (b) =>
          b.number &&
          Number.isFinite(b.points) &&
          b.points > 0
      );

    if (parsedBets.length === 0) {
      return res.status(400).json({ error: 'No valid bets found' });
    }

    // 📅 IST Date
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const dd = String(nowIst.getDate()).padStart(2, '0');
    const mm = String(nowIst.getMonth() + 1).padStart(2, '0');
    const yyyy = nowIst.getFullYear();
    const dateId = `${dd}-${mm}-${yyyy}`;

    const serverTs = admin.firestore.FieldValue.serverTimestamp();

    // 🚀 Batch Handling
    const MAX_BATCH_SIZE = 450;
    let batch = db.batch();
    let operationCount = 0;
    const commits = [];

    for (const b of parsedBets) {
      const docId = b.game === 'close'
        ? `${baseCode}close`
        : `${baseCode}open`;

      const numberRef = db
        .collection('gamechart')
        .doc(dateId)
        .collection(gameName)
        .doc(docId)
        .collection('numbers')
        .doc(b.number);

      batch.set(
        numberRef,
        {
          totalAmount: admin.firestore.FieldValue.increment(b.points),
          updatedAt: serverTs,
        },
        { merge: true }
      );

      operationCount++;

      if (operationCount >= MAX_BATCH_SIZE) {
        commits.push(batch.commit());
        batch = db.batch();
        operationCount = 0;
      }
    }

    if (operationCount > 0) {
      commits.push(batch.commit());
    }

    await Promise.all(commits);

    return res.status(200).json({
      ok: true,
      message: 'Chart updated successfully',
      totalProcessed: parsedBets.length,
      storedUnder: baseCode,
    });

  } catch (err) {
    console.error('Chart update error:', err);
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

router.post('/todaymoney', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer '))
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, totalAmount } = req.body;

    if (!decoded.uid || decoded.uid !== uid)
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });

    if (!uid || !Number.isFinite(Number(totalAmount)))
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    // IST DATE
    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const dd = String(nowIst.getDate()).padStart(2, '0');
    const mm = String(nowIst.getMonth() + 1).padStart(2, '0');
    const yyyy = nowIst.getFullYear();
    const dateId = `${dd}-${mm}-${yyyy}`;

    const todayMoneyRef = db.collection('todaymoney').doc(dateId);

    await todayMoneyRef.set(
      {
        todaybetplayedrs: admin.firestore.FieldValue.increment(Number(totalAmount)),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      },
      { merge: true }
    );

    return res.status(200).json({
      ok: true,
      message: 'Today money updated successfully',
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});
router.post('/open-result', async (req, res) => {
  try {
    const { gameId, gameName, rates, resultData } = req.body;

    if (!gameId || !gameName || !rates || !resultData)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();
    const { openAnk, openPanel } = resultData;

    const allowedGamecodes = ['SD', 'SP', 'DP', 'TP'];

    // 🔥 Query open & pending bets
    const betsSnap = await db.collection('todaysBets')
      .where('gameId', '==', gameId)
      .where('gameName', '==', gameName)
      .where('open', '==', true)
      .where('resultstatus', '==', 'pending')
      .get();

    if (betsSnap.empty) {
      return res.json({ message: 'No bets to settle' });
    }

    const userWinningMap = {};
    const betUpdates = [];

    for (const doc of betsSnap.docs) {

      const bet = doc.data();

      // ❌ Skip non-allowed gamecodes
      if (!allowedGamecodes.includes(bet.gamecode)) {
        continue;
      }

      let isWinner = false;
      let winningAmount = 0;

      const betAmount = Number(bet.amount || 0);
      const rate = Number(rates[bet.gamecode] || 0);

      // ===== WINNING LOGIC =====
      if (bet.gamecode === 'SD' && openAnk === bet.SDnumber)
        isWinner = true;

      if (bet.gamecode === 'SP' && openPanel === bet.SPnumber)
        isWinner = true;

      if (bet.gamecode === 'DP' && openPanel === bet.DPnumber)
        isWinner = true;

      if (bet.gamecode === 'TP' && openPanel === bet.TPnumber)
        isWinner = true;

      if (isWinner && rate > 0) {
        winningAmount = betAmount * (rate / 10);

        if (!userWinningMap[bet.userId])
          userWinningMap[bet.userId] = 0;

        userWinningMap[bet.userId] += winningAmount;
      }

      betUpdates.push({
        ref: doc.ref,
        isWinner,
        winningAmount,
      });
    }

    // 🔥 Batch update only allowed gamecodes
    while (betUpdates.length > 0) {
      const batch = db.batch();
      const chunk = betUpdates.splice(0, 500);

      chunk.forEach(bet => {
        batch.update(bet.ref, {
          isWinner: bet.isWinner,
          winningAmount: bet.winningAmount,
          resultstatus: 'complete',
          settledAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      await batch.commit();
    }

    // 🔥 Update wallets
    if (Object.keys(userWinningMap).length > 0) {
      const walletBatch = db.batch();

      for (const userId in userWinningMap) {
        walletBatch.update(
          db.collection('users').doc(userId),
          {
            wallet: admin.firestore.FieldValue.increment(userWinningMap[userId]),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }
        );
      }

      await walletBatch.commit();
    }

    return res.json({
      success: true,
      totalProcessed: betUpdates.length,
      winners: Object.keys(userWinningMap).length,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Settlement failed' });
  }
});

router.post('/close-result', async (req, res) => {
  try {
    const { gameId, gameName, rates, resultData } = req.body;

    if (!gameId || !gameName || !rates || !resultData)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    const { openAnk, openPanel, closeAnk, closePanel, JDAnk } = resultData;

    // 🔥 Query all pending bets for this game
    const betsSnap = await db.collection('todaysBets')
      .where('gameId', '==', gameId)
      .where('gameName', '==', gameName)
      .where('resultstatus', '==', 'pending')
      .get();

    if (betsSnap.empty) {
      return res.json({ message: 'No bets to settle' });
    }

    const userWinningMap = {};
    const betUpdates = [];

    // =========================================
    // 🔥 WINNING CALCULATION LOOP
    // =========================================
    for (const doc of betsSnap.docs) {

      const bet = doc.data();
      let isWinner = false;
      let winningAmount = 0;

      const betAmount = Number(bet.amount || 0);
      const rate = rates[bet.gamecode] || 0;

      // ==============================
      // 🔥 CLOSE RESULT WINNING LOGIC
      // ==============================

      // SD
      if (bet.gamecode === 'SD' &&
          closeAnk === bet.SDnumber &&
          bet.close === true) {
        isWinner = true;
      }

      // SP
      if (bet.gamecode === 'SP' &&
          closePanel === bet.SPnumber &&
          bet.close === true) {
        isWinner = true;
      }

      // DP
      if (bet.gamecode === 'DP' &&
          closePanel === bet.DPnumber &&
          bet.close === true) {
        isWinner = true;
      }

      // TP
      if (bet.gamecode === 'TP' &&
          closePanel === bet.TPnumber &&
          bet.close === true) {
        isWinner = true;
      }

      // JD
      if (bet.gamecode === 'JD' &&
          JDAnk === bet.JDnumber &&
          bet.open === true) {
        isWinner = true;
      }

      // FS (Full Sangam)
      if (bet.gamecode === 'FS' &&
          openPanel === bet.FSOpenPananumber &&
          closePanel === bet.FSClosePananumber &&
          bet.open === true) {
        isWinner = true;
      }

      // HS (Half Sangam - Open Type)
      if (bet.gamecode === 'HS' &&
          openAnk === bet.HSOpenDigitnumber &&
          closePanel === bet.HSClosePananumber &&
          bet.open === true) {
        isWinner = true;
      }

      // HS (Half Sangam - Close Type)
      if (bet.gamecode === 'HS' &&
          closeAnk === bet.HSCloseDigitnumber &&
          openPanel === bet.HSOpenPananumber &&
          bet.close === true) {
        isWinner = true;
      }

      // ==============================
      // 🔥 Calculate Winning
      // ==============================
      if (isWinner) {
        winningAmount = betAmount * (rate / 10);

        if (!userWinningMap[bet.userId])
          userWinningMap[bet.userId] = 0;

        userWinningMap[bet.userId] += winningAmount;
      }

      betUpdates.push({
        ref: doc.ref,
        isWinner,
        winningAmount,
      });
    }

    // =========================================
    // 🔥 Batch Update Bets (500 limit safe)
    // =========================================
    while (betUpdates.length > 0) {
      const batch = db.batch();
      const chunk = betUpdates.splice(0, 500);

      chunk.forEach(bet => {
        batch.update(bet.ref, {
          isWinner: bet.isWinner,
          winningAmount: bet.winningAmount,
          resultstatus: 'complete',
          settledAt: admin.firestore.FieldValue.serverTimestamp(),
        });
      });

      await batch.commit();
    }

    // =========================================
    // 🔥 Grouped Wallet Update
    // =========================================
    const walletBatch = db.batch();

    for (const userId in userWinningMap) {
      const userRef = db.collection('users').doc(userId);

      walletBatch.update(userRef, {
        wallet: admin.firestore.FieldValue.increment(userWinningMap[userId]),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });
    }

    await walletBatch.commit();

    return res.json({
      success: true,
      totalProcessed: betsSnap.size,
      winners: Object.keys(userWinningMap).length,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Settlement failed' });
  }
});
router.post('/shift-close-result', async (req, res) => {
  try {
    const { gameId, gameName } = req.body;

    if (!gameId || !gameName)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    // =========================================
    // 🔥 Get IST Date (dd-mm-yyyy format)
    // =========================================
    const now = new Date();
    const istTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );

    const day = String(istTime.getDate()).padStart(2, '0');
    const month = String(istTime.getMonth() + 1).padStart(2, '0');
    const year = istTime.getFullYear();

    const todayDocId = `${day}-${month}-${year}`;

    // =========================================
    // 🔥 Query completed CLOSE bets
    // =========================================
    const betsSnap = await db.collection('todaysBets')
      .where('gameId', '==', gameId)
      .where('gameName', '==', gameName)
      .where('resultstatus', '==', 'complete')
      .get();

    if (betsSnap.empty) {
      return res.json({ message: 'No completed bets to shift' });
    }

    const docs = [...betsSnap.docs];
    let totalShifted = 0;
    let totalWinningAmount = 0;

    // =========================================
    // 🔥 Process in safe chunks
    // =========================================
    while (docs.length > 0) {

      const chunk = docs.splice(0, 250);
      const batch = db.batch();

      chunk.forEach(doc => {
        const data = doc.data();

        // 🔥 Sum winningAmount
        const winAmt = Number(data.winningAmount || 0);
        if (!isNaN(winAmt)) {
          totalWinningAmount += winAmt;
        }

        // Move to todaysCompletedBets
        const completedRef = db.collection('todaysCompletedBets').doc(doc.id);
        batch.set(completedRef, data);

        // Delete from todaysBets
        batch.delete(doc.ref);
      });

      await batch.commit();
      totalShifted += chunk.length;
    }

    // =========================================
    // 🔥 Update todaymoney collection
    // =========================================
    if (totalWinningAmount > 0) {

      const todayMoneyRef = db.collection('todaymoney').doc(todayDocId);

      await todayMoneyRef.set(
        {
          todaybetWinrs: admin.firestore.FieldValue.increment(totalWinningAmount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true } // create if not exists
      );
    }

    return res.json({
      success: true,
      totalShifted,
      totalWinningAmount,
      todayDocId
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Shift failed' });
  }
});
router.post('/shift-open-result', async (req, res) => {
  try {
    const { gameId, gameName } = req.body;

    if (!gameId || !gameName)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    // ================================
    // 🔥 Get IST Date (dd-mm-yyyy)
    // ================================
    const now = new Date();
    const istTime = new Date(
      now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
    );

    const day = String(istTime.getDate()).padStart(2, '0');
    const month = String(istTime.getMonth() + 1).padStart(2, '0');
    const year = istTime.getFullYear();

    const todayDocId = `${day}-${month}-${year}`;

    // ================================
    // 🔥 Query completed OPEN bets
    // ================================
    const betsSnap = await db.collection('todaysBets')
      .where('gameId', '==', gameId)
      .where('gameName', '==', gameName)
      .where('open', '==', true)
      .where('resultstatus', '==', 'complete')
      .get();

    if (betsSnap.empty) {
      return res.json({ message: 'No open completed bets to shift' });
    }

    const docs = [...betsSnap.docs];
    let totalShifted = 0;
    let totalWinningAmount = 0;

    // ================================
    // 🔥 Process in chunks (safe batch)
    // ================================
    while (docs.length > 0) {

      const chunk = docs.splice(0, 250);
      const batch = db.batch();

      chunk.forEach(doc => {
        const data = doc.data();

        // 🔥 Sum winningAmount
        const winAmt = Number(data.winningAmount || 0);
        if (!isNaN(winAmt)) {
          totalWinningAmount += winAmt;
        }

        // 🔥 Add to todaysCompletedBets
        const completedRef = db.collection('todaysCompletedBets').doc(doc.id);
        batch.set(completedRef, data);

        // 🔥 Delete from todaysBets
        batch.delete(doc.ref);
      });

      await batch.commit();
      totalShifted += chunk.length;
    }

    // ================================
    // 🔥 Update todaymoney collection
    // ================================
    if (totalWinningAmount > 0) {

      const todayMoneyRef = db.collection('todaymoney').doc(todayDocId);

      await todayMoneyRef.set(
        {
          todaybetWinrs: admin.firestore.FieldValue.increment(totalWinningAmount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true } // create if not exists
      );
    }

    return res.json({
      success: true,
      totalShifted,
      totalWinningAmount,
      todayDocId
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Shift open result failed' });
  }
});
router.post('/revert-redeem', async (req, res) => {
  try {
    const { gameId, gameName } = req.body;

    if (!gameId || !gameName)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    let lastDoc = null;
    const pageSize = 500;
    let totalReverted = 0;
    const userRevertMap = {};
    const batchPromises = [];

    while (true) {

      let query = db.collection('todaysCompletedBets')
        .where('gameId', '==', gameId)
        .where('gameName', '==', gameName)
        .where('resultstatus', '==', 'complete')
        .limit(pageSize);

      if (lastDoc) query = query.startAfter(lastDoc);

      const snapshot = await query.get();

      if (snapshot.empty) break;

      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      const docs = snapshot.docs;

      // 🔥 Calculate user revert map
      docs.forEach(doc => {
        const bet = doc.data();
        const winAmt = Number(bet.winningAmount || 0);

        if (winAmt > 0) {
          userRevertMap[bet.userId] =
            (userRevertMap[bet.userId] || 0) + winAmt;
        }
      });

      // 🔥 Move + Delete in same batch
      const batch = db.batch();

      docs.forEach(doc => {
        const data = doc.data();

        delete data.isWinner;
        delete data.winningAmount;
        delete data.settledAt;

        data.resultstatus = 'pending';

        const todayRef = db.collection('todaysBets').doc(doc.id);

        batch.set(todayRef, data);
        batch.delete(doc.ref);
      });

      batchPromises.push(batch.commit());
      totalReverted += docs.length;
    }

    // 🔥 Wait all move operations parallel
    await Promise.all(batchPromises);

    // 🔥 Wallet subtraction (single batch)
    const walletBatch = db.batch();

    for (const userId in userRevertMap) {
      walletBatch.update(
        db.collection('users').doc(userId),
        {
          wallet: admin.firestore.FieldValue.increment(-userRevertMap[userId]),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        }
      );
    }

    await walletBatch.commit();

    return res.json({
      success: true,
      totalReverted,
      affectedUsers: Object.keys(userRevertMap).length,
    });

  } catch (err) {
    console.error(err);
    return res.status(500).json({ error: 'Revert redeem failed' });
  }
});

router.post('/open-revert-redeem', async (req, res) => {
  try {
    const { gameId, gameName } = req.body;

    if (!gameId || !gameName) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();
    const pageSize = 500;

    let lastDoc = null;
    let totalReverted = 0;
    let totalWinningAmount = 0;   // 🔥 NEW
    const userRevertMap = {};

    const excludedGamecodes = ['JD', 'HS', 'FS'];

    while (true) {
      let query = db.collection('todaysCompletedBets')
        .where('gameId', '==', gameId)
        .where('gameName', '==', gameName)
        .where('resultstatus', '==', 'complete')
        .where('open', '==', true)
        .limit(pageSize);

      if (lastDoc) {
        query = query.startAfter(lastDoc);
      }

      const snapshot = await query.get();
      if (snapshot.empty) break;

      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      const batch = db.batch();

      for (const doc of snapshot.docs) {
        const bet = doc.data();

        if (excludedGamecodes.includes(bet.gamecode)) {
          continue;
        }

        const winAmt = Number(bet.winningAmount || 0);

        if (winAmt > 0) {
          totalWinningAmount += winAmt;   // 🔥 SUM HERE

          userRevertMap[bet.userId] =
            (userRevertMap[bet.userId] || 0) + winAmt;
        }

        delete bet.isWinner;
        delete bet.winningAmount;
        delete bet.settledAt;

        bet.resultstatus = 'pending';
        bet.updatedAt = admin.firestore.FieldValue.serverTimestamp();

        const todayRef = db.collection('todaysBets').doc(doc.id);

        batch.set(todayRef, bet, { merge: true });
        batch.delete(doc.ref);

        totalReverted++;
      }

      await batch.commit();
    }

    // =========================================
    // 🔥 Subtract from todaymoney collection
    // =========================================
    if (totalWinningAmount > 0) {

      // IST Date
      const now = new Date();
      const istTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
      );

      const day = String(istTime.getDate()).padStart(2, '0');
      const month = String(istTime.getMonth() + 1).padStart(2, '0');
      const year = istTime.getFullYear();

      const todayDocId = `${day}-${month}-${year}`;

      const todayMoneyRef = db.collection('todaymoney').doc(todayDocId);

      await todayMoneyRef.set(
        {
          todaybetWinrs: admin.firestore.FieldValue.increment(-totalWinningAmount), // 🔥 SUBTRACT
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // =========================================
    // 🔥 Wallet Updates
    // =========================================
    const userIds = Object.keys(userRevertMap);

    for (let i = 0; i < userIds.length; i += 500) {
      const walletBatch = db.batch();
      const chunk = userIds.slice(i, i + 500);

      for (const userId of chunk) {
        walletBatch.update(
          db.collection('users').doc(userId),
          {
            wallet: admin.firestore.FieldValue.increment(
              -userRevertMap[userId]
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }
        );
      }

      await walletBatch.commit();
    }

    return res.json({
      success: true,
      totalReverted,
      totalWinningAmount,
      affectedUsers: userIds.length,
    });

  } catch (error) {
    console.error('Revert Redeem Error:', error);
    return res.status(500).json({
      success: false,
      error: 'Revert redeem failed',
      details: error.message,
    });
  }
});
router.post('/close-revert-redeem', async (req, res) => {
  try {
    const { gameId, gameName } = req.body;

    if (!gameId || !gameName)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    let lastDoc = null;
    const pageSize = 500;
    let totalReverted = 0;
    let totalWinningAmount = 0; // 🔥 NEW
    const userRevertMap = {};

    const skipGamecodes = ['SD', 'SP', 'DP', 'TP'];

    while (true) {
      let query = db.collection('todaysCompletedBets')
        .where('gameId', '==', gameId)
        .where('gameName', '==', gameName)
        .where('resultstatus', '==', 'complete')
        .limit(pageSize);

      if (lastDoc) query = query.startAfter(lastDoc);

      const snapshot = await query.get();
      if (snapshot.empty) break;

      lastDoc = snapshot.docs[snapshot.docs.length - 1];

      const batch = db.batch();

      for (const doc of snapshot.docs) {
        const bet = doc.data();

        // ✅ Skip condition
        if (
          skipGamecodes.includes(bet.gamecode) &&
          bet.open === true
        ) {
          continue;
        }

        const winAmt = Number(bet.winningAmount || 0);

        if (winAmt > 0) {
          totalWinningAmount += winAmt; // 🔥 SUM HERE

          userRevertMap[bet.userId] =
            (userRevertMap[bet.userId] || 0) + winAmt;
        }

        delete bet.isWinner;
        delete bet.winningAmount;
        delete bet.settledAt;

        bet.resultstatus = 'pending';
        bet.updatedAt = admin.firestore.FieldValue.serverTimestamp();

        const todayRef = db.collection('todaysBets').doc(doc.id);

        batch.set(todayRef, bet, { merge: true });
        batch.delete(doc.ref);

        totalReverted++;
      }

      await batch.commit();
    }

    // =========================================
    // 🔥 Subtract from todaymoney collection
    // =========================================
    if (totalWinningAmount > 0) {

      // IST Date
      const now = new Date();
      const istTime = new Date(
        now.toLocaleString("en-US", { timeZone: "Asia/Kolkata" })
      );

      const day = String(istTime.getDate()).padStart(2, '0');
      const month = String(istTime.getMonth() + 1).padStart(2, '0');
      const year = istTime.getFullYear();

      const todayDocId = `${day}-${month}-${year}`;

      const todayMoneyRef = db.collection('todaymoney').doc(todayDocId);

      await todayMoneyRef.set(
        {
          todaybetWinrs: admin.firestore.FieldValue.increment(-totalWinningAmount), // 🔥 SUBTRACT
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );
    }

    // =========================================
    // 🔥 Wallet updates
    // =========================================
    const userIds = Object.keys(userRevertMap);

    for (let i = 0; i < userIds.length; i += 500) {
      const walletBatch = db.batch();
      const chunk = userIds.slice(i, i + 500);

      for (const userId of chunk) {
        walletBatch.update(
          db.collection('users').doc(userId),
          {
            wallet: admin.firestore.FieldValue.increment(
              -userRevertMap[userId]
            ),
            updatedAt: admin.firestore.FieldValue.serverTimestamp(),
          }
        );
      }

      await walletBatch.commit();
    }

    return res.json({
      success: true,
      totalReverted,
      totalWinningAmount,
      affectedUsers: userIds.length,
    });

  } catch (err) {
    console.error('Revert Redeem Error:', err);
    return res.status(500).json({
      success: false,
      error: 'Revert redeem failed',
      details: err.message
    });
  }
});
module.exports = router;
