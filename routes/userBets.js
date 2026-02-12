const express = require('express');
const admin = require('firebase-admin');

const router = express.Router();

router.get('/', (req, res) => {
  res.json({ feature: 'user bets', message: 'Demo route for user bets module.' });
});

router.post('/singledigitbets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer '))
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid)
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });

    if (!uid || !Array.isArray(bets) || code !== 'SD' || !gameId)
      return res.status(400).json({ error: 'Invalid payload' });

    const db = admin.firestore();

    // ======================
    // ✅ Parse Bets
    // ======================
    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0
    );

    // ======================
    // 🔥 Time Validation (IST)
    // ======================
    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists)
      return res.status(400).json({ error: 'Game not found' });

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime || null;
    const closeTimeStr = gameData.closeTime || null;

    const parseTime12h = (t) => {
      if (!t) return null;
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) return null;

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) h = 0;
      if (mer === 'PM') h += 12;

      return { hours: h, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffset = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffset);

    const isAfterTime = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) return false;
      const target = new Date(nowIst);
      target.setHours(parsed.hours, parsed.minutes, 0, 0);
      return nowIst.getTime() > target.getTime();
    };

    if (parsedBets.some((b) => b.game === 'open') && isAfterTime(openTimeStr))
      return res.status(400).json({ error: 'your request is delayed for open bit' });

    if (parsedBets.some((b) => b.game === 'close') && isAfterTime(closeTimeStr))
      return res.status(400).json({ error: 'your request is delayed for close bit' });

    // ======================
    // 🔥 Helper: IST Date ID
    // ======================
    const getIstDateId = () => {
      const dd = String(nowIst.getDate()).padStart(2, '0');
      const mm = String(nowIst.getMonth() + 1).padStart(2, '0');
      const yyyy = nowIst.getFullYear();
      return `${dd}-${mm}-${yyyy}`;
    };

    const dateId = getIstDateId();

    // ======================
    // 🔥 Transaction Start
    // ======================
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');

      const userData = userSnap.data();
      let wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount)
        throw new Error('Insufficient wallet balance');

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const amount = b.points;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        // 1️⃣ Save Bet
        const betDoc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          open: b.game === 'open',
          close: b.game === 'close',
          SDnumber: String(b.number),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        tx.set(todaysBetsRef.doc(), betDoc);

        // 2️⃣ Update Game Chart
        const numberRef = db
          .collection('gamechart')
          .doc(dateId)
          .collection(gameName)
          .doc(code)
          .collection('values')  
          .doc(String(b.number));

        tx.set(
          numberRef,
          {
            totalAmount: admin.firestore.FieldValue.increment(amount),
            updatedAt: serverTs,
          },
          { merge: true }
        );

        currBalance = postBalance;
      }

      // 3️⃣ Update Wallet
      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });

  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});


router.post('/jodidigitsbets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    if (!uid || !Array.isArray(bets) || code !== 'JD' || !gameId) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0,
    );

    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime ? String(gameData.openTime) : null;

    const parseTime12h = (t) => {
      if (!t || typeof t !== 'string') {
        return null;
      }
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) {
        return null;
      }

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) {
        h = 0;
      }
      const hours24 = mer === 'PM' ? h + 12 : h;

      return { hours24, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const isAfterTimeStr = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) {
        return false;
      }

      const target = new Date(nowIst);
      target.setHours(parsed.hours24, parsed.minutes, 0, 0);

      return nowIst.getTime() > target.getTime();
    };

    if (parsedBets.length > 0 && openTimeStr && isAfterTimeStr(openTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for bit' });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const userData = userSnap.data() || {};
      const wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount) {
        throw new Error('Insufficient wallet balance');
      }

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const amount = Number.isFinite(b.points) ? b.points : 0;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        const betDoc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          open: b.game === 'open',
          close: b.game === 'close',
          JDnumber: String(b.number),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        tx.set(todaysBetsRef.doc(), betDoc);

        currBalance = postBalance;
      }

      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

router.post('/singlepanadigitsbets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    if (!uid || !Array.isArray(bets) || code !== 'SP' || !gameId) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0,
    );

    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime ? String(gameData.openTime) : null;
    const closeTimeStr = gameData.closeTime ? String(gameData.closeTime) : null;

    const parseTime12h = (t) => {
      if (!t || typeof t !== 'string') {
        return null;
      }
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) {
        return null;
      }

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) {
        h = 0;
      }
      const hours24 = mer === 'PM' ? h + 12 : h;

      return { hours24, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const isAfterTimeStr = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) {
        return false;
      }

      const target = new Date(nowIst);
      target.setHours(parsed.hours24, parsed.minutes, 0, 0);

      return nowIst.getTime() > target.getTime();
    };

    const hasOpen = parsedBets.some((b) => b.game === 'open');
    if (hasOpen && openTimeStr && isAfterTimeStr(openTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for open bit' });
    }

    const hasClose = parsedBets.some((b) => b.game === 'close');
    if (hasClose && closeTimeStr && isAfterTimeStr(closeTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for close bit' });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const userData = userSnap.data() || {};
      const wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount) {
        throw new Error('Insufficient wallet balance');
      }

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const amount = Number.isFinite(b.points) ? b.points : 0;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        const betDoc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          open: b.game === 'open',
          close: b.game === 'close',
          SPnumber: String(b.number),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        tx.set(todaysBetsRef.doc(), betDoc);

        currBalance = postBalance;
      }

      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

router.post('/doublepanadigitsbets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    if (!uid || !Array.isArray(bets) || code !== 'DP' || !gameId) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0,
    );

    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime ? String(gameData.openTime) : null;
    const closeTimeStr = gameData.closeTime ? String(gameData.closeTime) : null;

    const parseTime12h = (t) => {
      if (!t || typeof t !== 'string') {
        return null;
      }
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) {
        return null;
      }

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) {
        h = 0;
      }
      const hours24 = mer === 'PM' ? h + 12 : h;

      return { hours24, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const isAfterTimeStr = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) {
        return false;
      }

      const target = new Date(nowIst);
      target.setHours(parsed.hours24, parsed.minutes, 0, 0);

      return nowIst.getTime() > target.getTime();
    };

    const hasOpen = parsedBets.some((b) => b.game === 'open');
    if (hasOpen && openTimeStr && isAfterTimeStr(openTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for open bit' });
    }

    const hasClose = parsedBets.some((b) => b.game === 'close');
    if (hasClose && closeTimeStr && isAfterTimeStr(closeTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for close bit' });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const userData = userSnap.data() || {};
      const wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount) {
        throw new Error('Insufficient wallet balance');
      }

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const amount = Number.isFinite(b.points) ? b.points : 0;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        const betDoc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          open: b.game === 'open',
          close: b.game === 'close',
          DPnumber: String(b.number),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        tx.set(todaysBetsRef.doc(), betDoc);

        currBalance = postBalance;
      }

      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

router.post('/triplepanadigitsbets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    if (!uid || !Array.isArray(bets) || code !== 'TP' || !gameId) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0,
    );

    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime ? String(gameData.openTime) : null;
    const closeTimeStr = gameData.closeTime ? String(gameData.closeTime) : null;

    const parseTime12h = (t) => {
      if (!t || typeof t !== 'string') {
        return null;
      }
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) {
        return null;
      }

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) {
        h = 0;
      }
      const hours24 = mer === 'PM' ? h + 12 : h;

      return { hours24, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const isAfterTimeStr = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) {
        return false;
      }

      const target = new Date(nowIst);
      target.setHours(parsed.hours24, parsed.minutes, 0, 0);

      return nowIst.getTime() > target.getTime();
    };

    const hasOpen = parsedBets.some((b) => b.game === 'open');
    if (hasOpen && openTimeStr && isAfterTimeStr(openTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for open bit' });
    }

    const hasClose = parsedBets.some((b) => b.game === 'close');
    if (hasClose && closeTimeStr && isAfterTimeStr(closeTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for close bit' });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const userData = userSnap.data() || {};
      const wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount) {
        throw new Error('Insufficient wallet balance');
      }

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const amount = Number.isFinite(b.points) ? b.points : 0;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        const betDoc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          open: b.game === 'open',
          close: b.game === 'close',
          TPnumber: String(b.number),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        tx.set(todaysBetsRef.doc(), betDoc);

        currBalance = postBalance;
      }

      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

router.post('/halfsangambets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    if (!uid || !Array.isArray(bets) || code !== 'HS' || !gameId) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0,
    );

    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime ? String(gameData.openTime) : null;

    const parseTime12h = (t) => {
      if (!t || typeof t !== 'string') {
        return null;
      }
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) {
        return null;
      }

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) {
        h = 0;
      }
      const hours24 = mer === 'PM' ? h + 12 : h;

      return { hours24, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const isAfterTimeStr = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) {
        return false;
      }

      const target = new Date(nowIst);
      target.setHours(parsed.hours24, parsed.minutes, 0, 0);

      return nowIst.getTime() > target.getTime();
    };

    if (parsedBets.length > 0 && openTimeStr && isAfterTimeStr(openTimeStr)) {
      return res.status(400).json({
        error: 'your request is delayed for open and close bit',
      });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const userData = userSnap.data() || {};
      const wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount) {
        throw new Error('Insufficient wallet balance');
      }

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const parts = String(b.number).split('-');
        const first = parts[0] || '';
        const second = parts[1] || '';

        const amount = Number.isFinite(b.points) ? b.points : 0;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        const doc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        if (b.game === 'open') {
          doc.HSOpenDigitnumber = String(first);
          doc.HSClosePananumber = String(second);
          doc.open = true;
          doc.close = false;
        } else {
          doc.HSCloseDigitnumber = String(first);
          doc.HSOpenPananumber = String(second);
          doc.open = false;
          doc.close = true;
        }

        tx.set(todaysBetsRef.doc(), doc);

        currBalance = postBalance;
      }

      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

router.post('/fullsangambets', async (req, res) => {
  try {
    const authHeader = (req.headers.authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();
    const decoded = await admin.auth().verifyIdToken(idToken);

    const { uid, code, gameId, gameName, bets } = req.body;

    if (!decoded.uid || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    if (!uid || !Array.isArray(bets) || code !== 'FS' || !gameId) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = admin.firestore();

    const parsedBets = bets.map((b) => ({
      number: String(b.number),
      points: Number(b.points),
      game: b.game === 'close' ? 'close' : 'open',
    }));

    const totalAmount = parsedBets.reduce(
      (sum, b) => sum + (Number.isFinite(b.points) ? b.points : 0),
      0,
    );

    const gameRef = db.collection('games').doc(String(gameId));
    const gameSnap = await gameRef.get();

    if (!gameSnap.exists) {
      return res.status(400).json({ error: 'Game not found' });
    }

    const gameData = gameSnap.data() || {};
    const openTimeStr = gameData.openTime ? String(gameData.openTime) : null;

    const parseTime12h = (t) => {
      if (!t || typeof t !== 'string') {
        return null;
      }
      const m = t.trim().match(/^(\d{1,2}):(\d{2})\s*(AM|PM)$/i);
      if (!m) {
        return null;
      }

      let h = parseInt(m[1], 10);
      const min = parseInt(m[2], 10);
      const mer = m[3].toUpperCase();

      if (h === 12) {
        h = 0;
      }
      const hours24 = mer === 'PM' ? h + 12 : h;

      return { hours24, minutes: min };
    };

    const now = new Date();
    const utc = now.getTime() + now.getTimezoneOffset() * 60000;
    const istOffsetMs = (5 * 60 + 30) * 60000;
    const nowIst = new Date(utc + istOffsetMs);

    const isAfterTimeStr = (timeStr) => {
      const parsed = parseTime12h(timeStr);
      if (!parsed) {
        return false;
      }

      const target = new Date(nowIst);
      target.setHours(parsed.hours24, parsed.minutes, 0, 0);

      return nowIst.getTime() > target.getTime();
    };

    if (parsedBets.length > 0 && openTimeStr && isAfterTimeStr(openTimeStr)) {
      return res.status(400).json({ error: 'your request is delayed for bit' });
    }

    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {
      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) {
        throw new Error('User not found');
      }

      const userData = userSnap.data() || {};
      const wallet = Number(userData.wallet || 0);

      if (wallet < totalAmount) {
        throw new Error('Insufficient wallet balance');
      }

      let currBalance = wallet;
      const todaysBetsRef = db.collection('todaysBets');
      const serverTs = admin.firestore.FieldValue.serverTimestamp();

      for (const b of parsedBets) {
        const parts = String(b.number).split('-');
        const first = parts[0] || '';
        const second = parts[1] || '';

        const amount = Number.isFinite(b.points) ? b.points : 0;
        const preBalance = currBalance;
        const postBalance = currBalance - amount;

        const doc = {
          amount,
          gameId: String(gameId),
          gameName: gameName || null,
          gamecode: String(code),
          username: userData.name || null,
          userId: uid,
          mobile: userData.phone || null,
          resultstatus: 'pending',
          inChart: false,
          createdAt: serverTs,
          preBalance,
          postBalance,
        };

        if (b.game === 'open') {
          doc.FSOpenPananumber = String(first);
          doc.FSClosePananumber = String(second);
          doc.open = true;
          doc.close = false;
        } else {
          doc.FSClosePananumber = String(first);
          doc.FSOpenPananumber = String(second);
          doc.open = false;
          doc.close = true;
        }

        tx.set(todaysBetsRef.doc(), doc);

        currBalance = postBalance;
      }

      tx.update(userRef, {
        wallet: currBalance,
        updatedAt: serverTs,
      });
    });

    return res.status(200).json({
      ok: true,
      deducted: totalAmount,
    });
  } catch (err) {
    return res.status(500).json({
      error: err.message || 'Internal Server Error',
    });
  }
});

module.exports = router;
