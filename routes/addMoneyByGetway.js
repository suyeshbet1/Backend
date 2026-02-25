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

module.exports = router;