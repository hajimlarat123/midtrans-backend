const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
const port = 3000;

app.use(express.json());
// Endpoint untuk monitoring ping
app.get('/uptime', (req, res) => {
  const now = new Date().toISOString();
  console.log(`📶 UptimeRobot ping at ${now}`);
  res.status(200).send(`UptimeRobot ping received at ${now}`);
});
// 🔐 Firebase Admin Init
const serviceAccount = {
  type: "service_account",
  project_id: process.env.PROJECT_ID,
  private_key_id: process.env.PRIVATE_KEY_ID,
  private_key: process.env.PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.CLIENT_EMAIL,
  client_id: process.env.CLIENT_ID,
  auth_uri: process.env.AUTH_URI,
  token_uri: process.env.TOKEN_URI,
  auth_provider_x509_cert_url: process.env.AUTH_PROVIDER_CERT_URL,
  client_x509_cert_url: process.env.CLIENT_CERT_URL,
  universe_domain: process.env.UNIVERSE_DOMAIN || "googleapis.com"
};
admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL,
});

// 📌 Generate Snap Token
app.post('/snap-token', async (req, res) => {
  const { lokasi, loker, user_id, durasi_jam, order_id, gross_amount } = req.body;

  if (!lokasi || !loker || !user_id || !durasi_jam || !order_id) {
    return res.status(400).send({ error: 'Parameter tidak lengkap' });
  }

  const snapPayload = {
    transaction_details: {
      order_id,
      gross_amount: gross_amount || durasi_jam * 5000,
    },
    customer_details: {
      first_name: user_id,
    }
  };

  try {
    const response = await axios.post(
      'https://app.sandbox.midtrans.com/snap/v1/transactions',
      snapPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from('SB-Mid-server-xmy8-OZFa7vuhw6KNlc58WYX').toString('base64'),
        }
      }
    );

    // 💾 Simpan pending sewa
    await admin.database().ref(`pending_sewa/${order_id}`).set({
      lokasi,
      loker,
      user_id,
      durasi_jam,
    });

    res.json({
      token: response.data.token,
      redirect_url: response.data.redirect_url,
      order_id,
      gross_amount,
    });
  } catch (error) {
    console.error('❌ SNAP ERROR:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message
    });
    res.status(500).send({ error: 'Gagal mendapatkan Snap Token' });
  }
});

// 📌 Webhook dari Midtrans
app.post('/midtrans-notif', async (req, res) => {
  const notif = req.body;
  console.log('📩 Webhook diterima:\n', JSON.stringify(notif, null, 2));

  const transactionStatus = notif.transaction_status;
  const orderId = notif.order_id;

  if (!orderId || !transactionStatus) {
    return res.status(400).send({ error: 'Invalid notification payload' });
  }

  const parts = orderId.split('-');
  if (parts.length < 4) {
    console.log('⚠️ Bukan format order_id valid, mungkin test manual Midtrans:', orderId);
    return res.status(200).json({ status: 'ok (test ignored)' });
  }

  const lokasi = parts[0];
  const loker = parts[1];

  // Ambil data pending
  const snap = await admin.database().ref(`pending_sewa/${orderId}`).once('value');
  const pendingData = snap.val();

  if (!pendingData || !pendingData.durasi_jam || !pendingData.user_id) {
    console.warn('⚠️ Ini mungkin notifikasi test dari Midtrans. Tidak ada data pending sewa:', orderId);
    return res.status(200).json({ status: 'ok (ignored test)' });
  }

  const userId = pendingData.user_id;

  if (transactionStatus === 'settlement' || transactionStatus === 'capture') {
    const now = Date.now();
    const expiredAt = now + pendingData.durasi_jam * 60 * 60 * 1000;

    await admin.database().ref(`sewa_aktif/${lokasi}/${loker}`).set({
      status: 'terisi',
      user_id: userId,
      expired_at: expiredAt,
    });

    console.log(`✅ Loker ${lokasi}/${loker} disewa oleh ${userId} sampai ${new Date(expiredAt).toLocaleString()}`);

    await admin.database().ref(`pending_sewa/${orderId}`).remove();
  } else {
    console.log(`⚠️ Transaksi belum settlement: status = ${transactionStatus}`);
  }

  // ✅ balas JSON untuk sukses ke Midtrans
  res.status(200).json({ status: 'ok' });
  console.log("Server time:", new Date().toISOString());
});


// ✅ Jalankan Server
app.listen(port, () => {
  console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
