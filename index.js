const express = require('express');
const axios = require('axios');
const admin = require('firebase-admin');
const app = express();
const port = 3000;

app.use(express.json());

// 🔍 Ping endpoint for uptime monitor
app.get('/uptime', (req, res) => {
  const now = new Date().toISOString();
  console.log(`📶 UptimeRobot ping at ${now}`);
  res.status(200).send(`UptimeRobot ping received at ${now}`);
});

// 🔐 Firebase Admin Initialization
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

console.log("🔐 PRIVATE_KEY starts with:", process.env.PRIVATE_KEY?.slice(0, 30));

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.DATABASE_URL,
});

// 📌 SNAP TOKEN REQUEST
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

    // Simpan ke pending_sewa
    try {
      await admin.database().ref(`pending_sewa/${order_id}`).set({
        lokasi,
        loker,
        user_id,
        durasi_jam,
      });
      console.log(`💾 pending_sewa disimpan: ${order_id}`);
    } catch (err) {
      console.error('🔥 Gagal menyimpan pending_sewa:', err);
    }

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

// 📌 MIDTRANS NOTIFICATION HANDLER
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

    const userId = pendingData.user_id;

    // Ambil nama dan email user dari /users/{user_id}
    let userNama = null;
    let userEmail = null;

    try {
      const userSnap = await admin.database().ref(`users/${userId}`).once('value');
      const userInfo = userSnap.val();
      userNama = userInfo?.nama || null;
      userEmail = userInfo?.email || null;
    } catch (e) {
      console.warn('⚠️ Gagal mengambil nama/email dari /users:', e);
    }

    if (transactionStatus === 'settlement' || transactionStatus === 'capture') {
      const now = Date.now();
      const expiredAt = now + pendingData.durasi_jam * 60 * 60 * 1000;

      console.log(`📦 Simpan ke sewa_aktif/${lokasi}/${loker}, expired at: ${expiredAt}`);

      try {
        await admin.database().ref(`sewa_aktif/${lokasi}/${loker}`).set({
          status: 'terisi',
          user_id: userId,
          user_nama: userNama,
          user_email: userEmail,
          expired_at: expiredAt,
        });
        
        console.log('✅ Berhasil menyimpan ke sewa_aktif');
        
        // Hitung total harga
        const hargaTotal = (pendingData.durasi_jam || 1) * 5000;
        
        // Simpan ke sewa_history/{order_id}
        await admin.database().ref(`sewa_history/${orderId}`).set({
          lokasi_id: lokasi,
          loker_id: loker,
          user_id: userId,
          user_nama: userNama,
          user_email: userEmail,
          waktu_mulai: Date.now(),
          durasi_jam: pendingData.durasi_jam,
          harga_total: hargaTotal,
        });
        console.log('📝 Ditambahkan ke sewa_history');
        
        // Hapus dari pending
        await admin.database().ref(`pending_sewa/${orderId}`).remove();
        console.log('🧹 pending_sewa dihapus');

        console.log('✅ Berhasil menyimpan ke sewa_aktif');
        await admin.database().ref(`pending_sewa/${orderId}`).remove();
        console.log('🧹 pending_sewa dihapus');
      } catch (err) {
        console.error('🔥 Gagal menyimpan ke Firebase:', err);
      }
    } else {
      console.log(`⚠️ Transaksi belum settlement. Status: ${transactionStatus}`);
    }

    res.status(200).json({ status: 'ok' });
    console.log("✅ Webhook selesai diproses:", new Date().toISOString());

  } catch (err) {
    console.error('🔥 ERROR saat proses webhook:', err);
    res.status(500).json({ error: 'Webhook processing failed' });
  }
});

// ✅ Start Server
app.listen(port, () => {
  console.log(`🚀 Server berjalan di http://localhost:${port}`);
});
