const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
const port = 3000;

app.use(express.json());

// 🔍 Uptime checker
app.get('/uptime', (req, res) => {
  const now = new Date().toISOString();
  console.log(`📶 Uptime ping at ${now}`);
  res.status(200).send(`Uptime ping received at ${now}`);
});

// ✅ Finish redirect from Midtrans Snap
app.get('/finish', (req, res) => {
  res.send(`
    <html>
      <head><title>Pembayaran Selesai</title></head>
      <body style="text-align: center; font-family: sans-serif;">
        <h1>✅ Pembayaran Berhasil!</h1>
        <p>Terima kasih telah menggunakan layanan kami.</p>
        <script>
          setTimeout(() => window.close(), 3000);
        </script>
      </body>
    </html>
  `);
});

// 🔐 Firebase Admin SDK init
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
  universe_domain: process.env.UNIVERSE_DOMAIN || "googleapis.com",
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL,
});


// 🔁 Generate Snap Token
app.post('/snap-token', async (req, res) => {
  const { lokasi, loker, user_id, durasi_jam, order_id } = req.body;

  if (!lokasi || !loker || !user_id || !durasi_jam || !order_id) {
    return res.status(400).send({ error: 'Parameter tidak lengkap' });
  }

  // Ambil nama & email dari database users
  let userNama = '-';
  let userEmail = '-';
  try {
    const userSnap = await admin.database().ref(`users/${user_id}`).once('value');
    const userInfo = userSnap.val() || {};
    userNama = userInfo.nama || '-';
    userEmail = userInfo.email || '-';
  } catch (e) {
    console.warn('⚠️ Tidak bisa mengambil user info:', e.message);
  }

  const hargaTotal = durasi_jam * 5000;

  const snapPayload = {
    transaction_details: {
      order_id,
      gross_amount: hargaTotal,
    },
    customer_details: {
      first_name: userNama,
      email: userEmail,
    },
    callbacks: {
      finish: "https://midtrans-backend-1.onrender.com/finish",
    },
  };

  try {
    const response = await axios.post(
      'https://app.sandbox.midtrans.com/snap/v1/transactions',
      snapPayload,
      {
        headers: {
          'Content-Type': 'application/json',
          Authorization: 'Basic ' + Buffer.from(process.env.MIDTRANS_SERVER_KEY).toString('base64'),
        },
      }
    );

    await admin.database().ref(`pending_sewa/${order_id}`).set({
      lokasi,
      loker,
      user_id,
      durasi_jam,
      user_nama: userNama,
      user_email: userEmail,
    });

    console.log(`✅ Snap Token dibuat & pending_sewa disimpan: ${order_id}`);

    res.json({
      token: response.data.token,
      redirect_url: response.data.redirect_url,
      order_id,
      gross_amount: hargaTotal,
    });
  } catch (error) {
    console.error('❌ SNAP ERROR:', {
      status: error.response?.status,
      data: error.response?.data,
      message: error.message,
    });
    res.status(500).send({ error: 'Gagal mendapatkan Snap Token' });
  }
});


// 📥 Webhook dari Midtrans
app.post('/midtrans-notif', async (req, res) => {
  console.log('📩 Webhook diterima:\n', JSON.stringify(req.body, null, 2));

  try {
    const notif = req.body;
    const transactionStatus = notif.transaction_status;
    const orderId = notif.order_id;

    if (!orderId || !transactionStatus) {
      console.warn('❌ Notifikasi tidak valid:', notif);
      return res.status(400).send({ error: 'Invalid notification payload' });
    }

    const parts = orderId.split('-');
    if (parts.length < 4) {
      console.warn('⚠️ Format order_id tidak valid:', orderId);
      return res.status(200).json({ status: 'ignored (invalid orderId)' });
    }

    const lokasi = parts[0];
    const loker = parts[1];

    const snap = await admin.database().ref(`pending_sewa/${orderId}`).once('value');
    const pendingData = snap.val();

    if (!pendingData || !pendingData.durasi_jam || !pendingData.user_id) {
      console.warn('⚠️ Tidak ada data pending untuk order:', orderId);
      return res.status(200).json({ status: 'ignored (no pending data)' });
    }

    const durasi_jam = pendingData.durasi_jam;
    const user_id = pendingData.user_id;

    // Ambil nama dan email fallback jika tidak ada di pending_sewa
    let user_nama = pendingData.user_nama || '-';
    let user_email = pendingData.user_email || '-';
    if (!pendingData.user_nama || !pendingData.user_email) {
      try {
        const userSnap = await admin.database().ref(`users/${user_id}`).once('value');
        const userInfo = userSnap.val() || {};
        user_nama = userInfo.nama || user_nama;
        user_email = userInfo.email || user_email;
      } catch (e) {
        console.warn('⚠️ Gagal ambil user info dari /users:', e.message);
      }
    }

    if (transactionStatus === 'settlement' || transactionStatus === 'capture') {
      const now = Date.now();
      const expiredAt = now + durasi_jam * 60 * 60 * 1000;
      const harga_total = durasi_jam * 5000;

      await admin.database().ref(`sewa_aktif/${lokasi}/${loker}`).set({
        status: 'terisi',
        user_id,
        user_nama,
        user_email,
        expired_at: expiredAt,
      });

      await admin.database().ref(`sewa_history/${orderId}`).set({
        lokasi_id: lokasi,
        loker_id: loker,
        user_id,
        user_nama,
        user_email,
        waktu_mulai: now,
        durasi_jam,
        harga_total,
      });

      await admin.database().ref(`pending_sewa/${orderId}`).remove();

      console.log('✅ Transaksi sukses & data disimpan.');
    } else {
      console.log(`⚠️ Status transaksi belum settlement: ${transactionStatus}`);
    }

    res.status(200).json({ status: 'ok' });
  } catch (err) {
    console.error('🔥 ERROR saat proses webhook:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});


// 🚀 Jalankan server
app.listen(port, () => {
  console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
