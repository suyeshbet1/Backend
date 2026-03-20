const express = require('express');
const admin = require('firebase-admin');
const axios = require('axios');
const querystring = require('querystring');

const router = express.Router();

const getFirestore = () => {
  if (!admin.apps.length) {
    throw new Error('Firebase Admin SDK is not initialized');
  }
  return admin.firestore();
};

router.post('/create-add-money-order', async (req, res) => {
  try {
    const {
      userId,
      amount,
      customer_name,
      customer_email,
      customer_mobile,
    } = req.body;

    // ✅ Validate fields
    if (!userId || !amount) {
      return res.status(400).json({ error: "Missing fields" });
    }

    const db = getFirestore();
    const userRef = db.collection("users").doc(userId);
    const userSnap = await userRef.get();

    // ✅ Check user exists
    if (!userSnap.exists) {
      return res.status(404).json({ error: "User not found" });
    }

    const preBalance = Number(userSnap.data().wallet || 0);
    const client_txn_id = "txn_" + Date.now();

    // 🔹 Save in Top-Level Collection
    const txnRef = await db
      .collection("TodaysAddMoneyByGetway")
      .add({
        userId,
        customer_name,
        customer_email,
        customer_mobile,
        amount: Number(amount),
        preBalance,
        paymentstatus: "pending",
        client_txn_id,
        createdAt: admin.firestore.FieldValue.serverTimestamp(),
      });

    // 🔹 EKQR API call
    const EKQR_KEY = "b86c32c1-982f-48c0-b7cb-2aa2e8209e9d";

    const payload = {
      key: EKQR_KEY,
      client_txn_id,
      amount: amount.toString(),
      p_info: "Wallet Topup",
      customer_name,
      customer_email,
      customer_mobile,
      redirect_url: "https://github.com/",
    };

    const response = await axios.post(
      "https://api.ekqr.in/api/v2/create_order",
      payload
    );

    return res.status(200).json({
      ...response.data,
      firestoreTxnId: txnRef.id,
    });

  } catch (err) {
    console.error("createAddMoneyOrder error:", err.response?.data || err.message);

    return res.status(500).json({
      error: err.response?.data || err.message,
    });
  }
});

router.post('/upi-webhook', async (req, res) => {
  try {
    let body = req.body;

    // Handle form-urlencoded
    if (!body || Object.keys(body).length === 0) {
      body = querystring.parse(req.rawBody?.toString() || '');
    }

    const { client_txn_id, status, upi_txn_id, amount } = body;

    if (!client_txn_id) {
      return res.status(400).send("Missing client_txn_id");
    }

    const db = getFirestore();

    // 🔍 Find transaction
    const txnSnap = await db
      .collection("TodaysAddMoneyByGetway")
      .where("client_txn_id", "==", client_txn_id)
      .limit(1)
      .get();

    if (txnSnap.empty) {
      return res.status(404).send("Transaction not found");
    }

    const txnDoc = txnSnap.docs[0];
    const txnData = txnDoc.data();
    const userRef = db.collection("users").doc(txnData.userId);

    if (status === "success") {

      const numericAmount = Number(amount);
      const postBalance =
        Number(txnData.preBalance) + numericAmount;

      // ✅ IST Date Calculation
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utc + 5.5 * 60 * 60000);

      const pad = (n) => String(n).padStart(2, '0');

      const istDateDocId =
        `${pad(ist.getDate())}-${pad(ist.getMonth() + 1)}-${ist.getFullYear()}`;

      const hh24 = ist.getHours();
      const hh12 = ((hh24 + 11) % 12) + 1;
      const ampm = hh24 >= 12 ? 'PM' : 'AM';

      const paymentReceivedTime =
        `${hh12}:${pad(ist.getMinutes())} ${ampm}`;

      // 🔹 Update Transaction
      await txnDoc.ref.update({
        paymentstatus: "success",
        upi_txn_id,
        postBalance,
        paymentReceivedDate: istDateDocId,
        paymentReceivedTime,
      });

      // 🔹 Update Wallet
      await userRef.update({
        wallet: admin.firestore.FieldValue.increment(numericAmount),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // 🔹 Update todaymoney collection
      const todayRef = db.collection("todaymoney").doc(istDateDocId);

      await todayRef.set(
        {
          date: istDateDocId,
          todaysgetwaydeposite:
            admin.firestore.FieldValue.increment(numericAmount),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true } // creates if not exists
      );
    } else {
      await txnDoc.ref.update({
        paymentstatus: "failure",
      });
    }

    return res.status(200).send("OK");

  } catch (err) {
    console.error("upiWebhook error:", err);
    return res.status(500).send("Webhook error");
  }
});


// Helper → Get IST Date (DD-MM-YYYY)
const getISTDate = () => {
  const now = new Date();
  const utc = now.getTime() + now.getTimezoneOffset() * 60000;
  const ist = new Date(utc + 5.5 * 60 * 60000);

  const pad = (n) => String(n).padStart(2, '0');

  return `${pad(ist.getDate())}-${pad(ist.getMonth() + 1)}-${ist.getFullYear()}`;
};

router.get('/AllAddMoneyByGetway', async (req, res) => {
  try {
    const db = getFirestore();
    const BATCH_LIMIT = 150; // Safe limit (500 / 3 ops)
    const istDateDocId = getISTDate();

    let totalProcessed = 0;
    let hasMore = true;

    while (hasMore) {
      const snapshot = await db
        .collection("TodaysAddMoneyByGetway")
        .limit(BATCH_LIMIT)
        .get();

      if (snapshot.empty) {
        hasMore = false;
        break;
      }

      const batch = db.batch();

      snapshot.docs.forEach((doc) => {
        const data = doc.data();
        const docId = doc.id;

        // 1️⃣ Archive into date-based doc
        const archiveRef = db
          .collection("AllAddMoneyByGetway")
          .doc(istDateDocId)
          .collection("userAddMoneyByGetwayD")
          .doc(docId);

        batch.set(archiveRef, data);

        // 2️⃣ Copy to user's subcollection
        const userSubRef = db
          .collection("users")
          .doc(data.userId)
          .collection("AddMoneyByGetway")
          .doc(docId);

        batch.set(userSubRef, data);

        // 3️⃣ Delete from today collection
        batch.delete(doc.ref);
      });

      await batch.commit();

      totalProcessed += snapshot.size;

      console.log(`Processed batch of ${snapshot.size}`);
    }

    return res.status(200).json({
      message: "Migration completed successfully",
      archiveDate: istDateDocId,
      totalProcessed,
    });

  } catch (err) {
    console.error("Migration error:", err);
    return res.status(500).json({
      error: "Migration failed",
    });
  }
});



router.post('/withdrawal-request', async (req, res) => {
  try {
    const authHeader =
      (req.headers.authorization || req.headers.Authorization || '').toString();

    if (!authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Missing or invalid Authorization header' });
    }

    const idToken = authHeader.split('Bearer ')[1].trim();

    let decoded;
    try {
      decoded = await admin.auth().verifyIdToken(idToken);
    } catch (err) {
      return res.status(401).json({ error: 'Invalid ID token' });
    }

    const { uid, amount } = req.body;

    if (!decoded || decoded.uid !== uid) {
      return res.status(403).json({ error: 'Caller UID does not match provided uid' });
    }

    const numAmount = Number(amount);

    if (!uid || !Number.isFinite(numAmount) || numAmount <= 0) {
      return res.status(400).json({ error: 'Invalid payload' });
    }

    const db = getFirestore();
    const userRef = db.collection('users').doc(uid);

    await db.runTransaction(async (tx) => {

      const userSnap = await tx.get(userRef);
      if (!userSnap.exists) throw new Error('User not found');

      const userData = userSnap.data() || {};

      const wallet =
        typeof userData.wallet === 'number'
          ? userData.wallet
          : Number(userData.wallet || 0);

      if (wallet < numAmount) {
        throw new Error('Insufficient wallet balance');
      }

      const name = userData.name || null;
      const phoneNumber = userData.phone || null;

      const bankRef = userRef.collection('bank').doc('details');
      const bankSnap = await tx.get(bankRef);

      if (!bankSnap.exists) {
        throw new Error('Bank details not found');
      }

      const bank = bankSnap.data() || {};

      // ===== IST DATE & TIME =====
      const now = new Date();
      const utc = now.getTime() + now.getTimezoneOffset() * 60000;
      const ist = new Date(utc + 5.5 * 60 * 60000);

      const pad = (n) => String(n).padStart(2, '0');

      const dateStr = `${pad(ist.getDate())}-${pad(
        ist.getMonth() + 1
      )}-${ist.getFullYear()}`;

      const hh24 = ist.getHours();
      const hh12 = ((hh24 + 11) % 12) + 1;
      const ampm = hh24 >= 12 ? 'PM' : 'AM';

      const timeStr = `${hh12}:${pad(ist.getMinutes())} ${ampm}`;

      const prebalance = wallet;
      const postbalance = wallet - numAmount;

      const todaysWithdrawalRef = db
        .collection('todaysWithdrawalReq')
        .doc();

      tx.set(todaysWithdrawalRef, {
        withdrawalammount: numAmount,
        DateofReq: dateStr,
        TimeofReq: timeStr,

        name,
        phoneNumber,

        accountNo: bank.accountNo || null,
        ifsc: bank.ifsc || null,
        holderName: bank.holderName || null,
        phone: bank.phone || null,
        upiId: bank.upiId || null,
        method: bank.method || null,

        prebalance,
        postbalance,
        status: 'pending',
        requestedByUid: uid,

        createdAt: admin.firestore.FieldValue.serverTimestamp(),
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Deduct wallet
      tx.update(userRef, {
        wallet: postbalance,
        updatedAt: admin.firestore.FieldValue.serverTimestamp(),
      });

      // Update todaymoney
      const todayMoneyRef = db.collection('todaymoney').doc(dateStr);

      tx.set(
        todayMoneyRef,
        {
          date: dateStr,
          todaysWithdrawalreq: admin.firestore.FieldValue.increment(1),
          todayspendingWithdrawalreq: admin.firestore.FieldValue.increment(1),
          updatedAt: admin.firestore.FieldValue.serverTimestamp(),
        },
        { merge: true }
      );

    });

    return res.status(200).json({ ok: true });

  } catch (err) {
    console.error('withdrawal-request error', err);
    return res.status(500).json({ error: err.message || String(err) });
  }
});


router.post('/send-notification-all-users', async (req, res) => {
  try {

    const { title, body } = req.body;
console.log("Project:", admin.app().options.projectId);
    if (!title || !body) {
      return res.status(400).json({
        error: "title and body are required",
      });
    }

    const db = getFirestore();

    // Fetch all users
    const snapshot = await db.collection("users").get();
console.log(`Fetched ${snapshot.size} users for notification`);
    if (snapshot.empty) {
      return res.status(200).json({
        message: "No users found"
      });
    }

    const messages = [];

    snapshot.forEach(doc => {
      const token = doc.data()?.fcmToken;

      if (typeof token === "string" && token.trim()) {
        messages.push({
          token: token.trim(),
          notification: {
            title: String(title),
            body: String(body),
          },
          android: {
            priority: "high",
            collapseKey: "GAME_STATUS",
            notification: {
              tag: "GAME_STATUS",
              channelId: "game_updates",
              sound: "default",
            },
          },
        });
      }
    });

    if (!messages.length) {
      return res.status(200).json({
        message: "No FCM tokens found"
      });
    }

    const response = await admin.messaging().sendEach(messages);

    let successCount = 0;
    let failureCount = 0;
    const invalidTokens = [];

    response.responses.forEach((r, idx) => {
      if (r.success) {
        successCount++;
      } else {
        failureCount++;

        if (r.error?.code === "messaging/registration-token-not-registered") {
          invalidTokens.push(messages[idx].token);
        }
      }
    });

    // Remove invalid tokens
    if (invalidTokens.length) {

      const userRef = db.collection("users");

      const cleanup = snapshot.docs.map(doc => {
        if (invalidTokens.includes(doc.data()?.fcmToken)) {
          return userRef.doc(doc.id).update({
            fcmToken: admin.firestore.FieldValue.delete(),
          });
        }
        return null;
      });

      await Promise.all(cleanup.filter(Boolean));
    }

    return res.status(200).json({
      success: true,
      successCount,
      failureCount,
    });

  } catch (error) {
    console.error("Notification failed", error);

    return res.status(500).json({
      error: "Failed to send notification",
    });
  }
});
module.exports = router;