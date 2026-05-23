const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const axios = require('axios');
const cors = require('cors');
require('dotenv').config();

const app = express();
app.use(express.json());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'OPTIONS'],
  credentials: true
}));

// Handle preflight requests
app.options('*', cors());

const BOT_TOKEN = process.env.BOT_TOKEN;
const ADMIN_GROUP_ID = process.env.ADMIN_GROUP_ID;
const MINING_PER_SECOND = 0.231;
const AICOIN_TO_VND_RATE = 10000000;

// Database
const db = new sqlite3.Database('./aicoin.db', (err) => {
  if (err) console.error('DB Error:', err);
  else console.log('✅ Connected to SQLite');
});

// Tạo bảng
db.serialize(() => {
  db.run(`CREATE TABLE IF NOT EXISTS users (
    userId TEXT PRIMARY KEY,
    aicoin REAL DEFAULT 0,
    vnd REAL DEFAULT 0,
    bankName TEXT,
    accNum TEXT,
    accName TEXT,
    lastUpdate INTEGER
  )`);

  db.run(`CREATE TABLE IF NOT EXISTS withdraws (
    orderId TEXT PRIMARY KEY,
    userId TEXT,
    messageId INTEGER,
    status TEXT,
    bankName TEXT,
    accNum TEXT,
    accName TEXT,
    amount REAL,
    fee REAL,
    receivedAmount REAL,
    timestamp INTEGER
  )`);
});

// Lấy dữ liệu user
app.get('/api/getData', (req, res) => {
  const userId = req.query.userId;
  
  db.get('SELECT * FROM users WHERE userId = ?', [userId], (err, row) => {
    if (err) return res.json({ error: err.message });
    
    if (!row) {
      db.run('INSERT INTO users (userId, lastUpdate) VALUES (?, ?)', 
        [userId, Date.now()], 
        () => res.json({ aicoin: 0, vnd: 0, bankName: '', accNum: '', accName: '' })
      );
    } else {
      const offlineTime = (Date.now() - row.lastUpdate) / 1000;
      const earnedOffline = MINING_PER_SECOND * offlineTime;
      const newAicoin = row.aicoin + earnedOffline;

      db.run('UPDATE users SET aicoin = ?, lastUpdate = ? WHERE userId = ?',
        [newAicoin, Date.now(), userId]
      );

      res.json({
        aicoin: newAicoin,
        vnd: row.vnd,
        bankName: row.bankName || '',
        accNum: row.accNum || '',
        accName: row.accName || ''
      });
    }
  });
});

// Lưu dữ liệu user
app.post('/api/saveData', (req, res) => {
  const { userId, aicoin, vnd, bankName, accNum, accName } = req.body;
  
  db.run(
    'UPDATE users SET aicoin = ?, vnd = ?, bankName = ?, accNum = ?, accName = ?, lastUpdate = ? WHERE userId = ?',
    [aicoin, vnd, bankName, accNum, accName, Date.now(), userId],
    (err) => {
      if (err) res.json({ error: err.message });
      else res.json({ success: true });
    }
  );
});

// Kiểm tra trạng thái rút tiền
app.get('/api/checkWithdrawStatus', (req, res) => {
  const userId = req.query.userId;
  
  db.get(
    'SELECT status FROM withdraws WHERE userId = ? ORDER BY timestamp DESC LIMIT 1',
    [userId],
    (err, row) => {
      if (err) return res.json({ status: 'error' });
      res.json({ status: row?.status || 'pending' });
    }
  );
});

// Lưu request rút tiền
app.post('/api/saveWithdraw', (req, res) => {
  const { userId, orderId, messageId, status, bankName, accNum, accName, amount, fee, receivedAmount, timestamp } = req.body;
  
  db.run(
    `INSERT OR REPLACE INTO withdraws 
    (orderId, userId, messageId, status, bankName, accNum, accName, amount, fee, receivedAmount, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [orderId, userId, messageId, status, bankName, accNum, accName, amount, fee, receivedAmount, timestamp],
    (err) => {
      if (err) res.json({ error: err.message });
      else res.json({ success: true });
    }
  );
});

// Webhook từ Telegram
app.post('/api/telegram-webhook', (req, res) => {
  const update = req.body;
  
  if (update.callback_query) {
    const callbackQuery = update.callback_query;
    const callbackData = callbackQuery.data;
    const messageId = callbackQuery.message.message_id;

    const [action, ...orderParts] = callbackData.split('_');
    const orderId = orderParts.join('_');

    console.log(`📨 Admin action: ${action} - ${orderId}`);

    const newStatus = action === 'approve' ? 'approved' : 'rejected';
    
    // Lấy userId từ database
    db.get(
      'SELECT userId FROM withdraws WHERE orderId = ?',
      [orderId],
      (err, row) => {
        if (err) {
          console.error('DB Error:', err);
          res.json({ ok: true });
          return;
        }

        const userId = row?.userId;
        if (!userId) {
          console.error('User ID not found for order:', orderId);
          res.json({ ok: true });
          return;
        }

        // Cập nhật status
        db.run(
          'UPDATE withdraws SET status = ? WHERE orderId = ?',
          [newStatus, orderId],
          (err) => {
            if (err) console.error('DB Error:', err);
          }
        );

        // Thông báo cho admin
        const emoji = action === 'approve' ? '✅' : '❌';
        const text = action === 'approve' 
          ? `${emoji} ĐƠN ${orderId} ĐÃ ĐƯỢC DUYỆT!` 
          : `${emoji} ĐƠN ${orderId} BỊ TỪ CHỐI!`;

        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/answerCallbackQuery`, {
          callback_query_id: callbackQuery.id,
          text: text,
          show_alert: true
        }).catch(err => console.error('Error:', err));

        // Chỉnh sửa message admin
        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/editMessageText`, {
          chat_id: ADMIN_GROUP_ID,
          message_id: messageId,
          text: `${text}\n\n📋 Order: ${orderId}`,
          parse_mode: 'HTML'
        }).catch(err => console.error('Error:', err));

        // ⭐ GỬI DM CHO NGƯỜI DÙNG
        let userMessage = '';
        if (action === 'approve') {
          userMessage = `✅ <b>LỆNH RÚT TIỀN ĐÃ ĐƯỢC DUYỆT!</b>\n\n📋 Đơn hàng: <code>${orderId}</code>\n💰 Số tiền: sẽ được chuyển trong 24 giờ\n\n📞 Liên hệ admin nếu có vấn đề!`;
        } else {
          userMessage = `❌ <b>LỆNH RÚT TIỀN BỊ TỪ CHỐI!</b>\n\n📋 Đơn hàng: <code>${orderId}</code>\n⚠️ Vui lòng kiểm tra lại thông tin tài khoản\n\n📞 Liên hệ admin để biết chi tiết!`;
        }

        axios.post(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
          chat_id: userId,
          text: userMessage,
          parse_mode: 'HTML'
        }).then(response => {
          console.log('✅ DM sent to user:', userId);
        }).catch(err => {
          console.error('❌ Failed to send DM:', err.message);
        });
      }
    );
  }

  res.json({ ok: true });
});

// Thiết lập webhook Telegram
async function setupWebhook() {
  const webhookUrl = `${process.env.WEBHOOK_URL}/api/telegram-webhook`;
  try {
    const response = await axios.post(
      `https://api.telegram.org/bot${BOT_TOKEN}/setWebhook`,
      { url: webhookUrl }
    );
    console.log('✅ Webhook setup:', response.data);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
  }
}

app.get('/', (req, res) => {
  res.json({ status: 'AICOIN Bot Running! 🚀' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
  setupWebhook();
});
