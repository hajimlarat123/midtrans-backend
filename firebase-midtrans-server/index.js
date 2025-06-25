import express from 'express';
import axios from 'axios';
import admin from 'firebase-admin';

const app = express();
app.use(express.json());

// 🔐 Inisialisasi Firebase Admin dari ENV
const serviceAccount = {
  type: "service_account",
  project_id: process.env.FB_PROJECT_ID,
  private_key_id: process.env.FB_PRIVATE_KEY_ID,
  private_key: process.env.FB_PRIVATE_KEY.replace(/\\n/g, '\n'),
  client_email: process.env.FB_CLIENT_EMAIL,
  client_id: process.env.FB_CLIENT_ID,
  auth_uri: "https://accounts.google.com/o/oauth2/auth",
  token_uri: "https://oauth2.googleapis.com/token",
  auth_provider_x509_cert_url: "https://www.googleapis.com/oauth2/v1/certs",
  client_x509_cert_url: process.env.FB_CLIENT_CERT_URL,
  universe_domain: "googleapis.com"
};

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount),
  databaseURL: process.env.FB_DATABASE_URL
});

app.post('/snap-token', async (req, res) => {
  const { lokasi, loker, user_id, durasi_jam, order_id, gross_amount } = req.body;

  if (!lokasi || !loker || !user_id || !durasi_jam || !order_id) {
    return res.status(400).send({ error: 'Parameter tidak lengkap' });
  }

  const payload = {
    transaction_details: {
      order_id,
      gross_amount: gross_amount || durasi_jam * 5000,
    },
    customer_details: {
      first_name: user_id,
    },
  };

  try {
    const midtransAuth = Buffer.from(process.env.MIDTRANS_SERVER_KEY + ":").toString('base64');
    const response = await axios.post(
      'https://app.sandbox.midtrans.com/snap/v1/transactions',
      payload,
      {
        headers: {
          'Content-Type': 'application/json',
          'Authorization': `Basic ${midtransAuth}`,
        },
      }
    );

    await admin.database().ref(`pending_sewa/${order_id}`).set({
      lokasi,
      loker,
      user_id,
      durasi_jam
    });

    res.json({
      token: response.data.token,
      redirect_url: response.data.redirect_url,
      order_id,
      gross_amount,
    });
  } catch (error) {
    console.error('SNAP ERROR:', error.response?.data || error.message);
    res.status(500).send({ error: 'Gagal mendapatkan Snap Token' });
  }
});

app.post('/midtrans-notif', async (req, res) => {
  const notif = req.body;
  const orderId = notif.order_id;
  const status = notif.transaction_status;

  if (!orderId || !status) return res.status(400).json({ error: 'Invalid payload' });

  const [lokasi, loker] = orderId.split('-');

  const snapshot = await admin.database().ref(`pending_sewa/${orderId}`).once('value');
  const pendingData = snapshot.val();

  if (!pendingData) return res.status(200).json({ status: 'ignored (no data)' });

  const now = Date.now();
  const expiredAt = now + pendingData.durasi_jam * 60 * 60 * 1000;

  if (status === 'settlement' || status === 'capture') {
    await admin.database().ref(`sewa_aktif/${lokasi}/${loker}`).set({
      status: 'terisi',
      user_id: pendingData.user_id,
      expired_at: expiredAt,
    });
    await admin.database().ref(`pending_sewa/${orderId}`).remove();
    console.log(`✅ Loker ${lokasi}/${loker} aktif`);
  }

  res.status(200).json({ status: 'ok' });
});

app.listen(3000, () => {
  console.log('🚀 Server berjalan di port 3000');
});
