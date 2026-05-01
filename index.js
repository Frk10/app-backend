require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');
const mongoose = require('mongoose');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const rateLimit = require('express-rate-limit');

const app = express();
app.set('trust proxy', 1);
app.use(cors());
app.use(express.json({ limit: '10mb' }));

// MongoDB
mongoose.connect(process.env.MONGODB_URI)
  .then(() => console.log('MongoDB bağlandı'))
  .catch(err => { console.error('MongoDB hatası:', err); process.exit(1); });

const userSchema = new mongoose.Schema({
  userId: { type: String, default: () => uuidv4(), unique: true },
  name: String,
  pin: String,
  code: { type: String, unique: true },
  banned: { type: Boolean, default: false },
  meds: { type: mongoose.Schema.Types.Mixed, default: [] },
  meds_archive: { type: mongoose.Schema.Types.Mixed, default: [] },
  checked: { type: mongoose.Schema.Types.Mixed, default: {} },
  messages: { type: mongoose.Schema.Types.Mixed, default: [] },
  followers: { type: mongoose.Schema.Types.Mixed, default: [] },
  followRequests: { type: mongoose.Schema.Types.Mixed, default: [] },
  blocked: { type: mongoose.Schema.Types.Mixed, default: [] },
  following: { type: mongoose.Schema.Types.Mixed, default: [] },
}, { timestamps: true, minimize: false });

const User = mongoose.model('User', userSchema);

const JWT_SECRET = process.env.JWT_SECRET || 'sagliklikal_dev_secret_change_in_prod';
const SALT_ROUNDS = 10;

// Rate limiters
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 200,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Çok fazla istek, lütfen bekleyin' }
});
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, max: 10,
  standardHeaders: true, legacyHeaders: false,
  message: { error: 'Çok fazla giriş denemesi, 15 dakika bekleyin' }
});
app.use(generalLimiter);

async function generateUniqueCode() {
  let code;
  do { code = Math.random().toString(36).substring(2, 8).toUpperCase(); }
  while (await User.findOne({ code }));
  return code;
}

function signToken(userId) {
  return jwt.sign({ userId }, JWT_SECRET, { expiresIn: '30d' });
}

async function auth(req, res, next) {
  const header = req.headers.authorization;
  if (!header?.startsWith('Bearer ')) return res.status(401).json({ error: 'Token gerekli' });
  try {
    const { userId } = jwt.verify(header.slice(7), JWT_SECRET);
    const u = await User.findOne({ userId }, { banned: 1 }).lean();
    if (!u) return res.status(401).json({ error: 'Hesap bulunamadı' });
    if (u.banned) return res.status(403).json({ error: 'Hesap askıya alınmış' });
    req.userId = userId;
    next();
  } catch { res.status(401).json({ error: 'Geçersiz veya süresi dolmuş token' }); }
}

function adminAuth(req, res, next) {
  const key = req.headers['x-admin-key'];
  if (!process.env.ADMIN_KEY || key !== process.env.ADMIN_KEY) return res.status(403).json({ error: 'Yetkisiz' });
  next();
}

// Gemini: ilaç analizi
app.post('/analyze', auth, async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Görüntü gerekli' });
    const prompt = `Bu bir ilaç kutusu veya prospektüs görüntüsüdür. Kullanım talimatlarını analiz et. SADECE şu JSON formatında yanıt ver, başka hiçbir şey yazma, markdown backtick kullanma:
{"ilac_adi":"İlaç adı ve dozu","etken_madde":"etken madde","doz":"1 tablet","gunluk_kullanim":2,"saatler":["08:00","20:00"],"yemek_durumu":"aç karnına veya yemekle veya tok karnına veya önemli değil","sure":"süresiz","bitis_tarihi":null,"ozel_uyarilar":"varsa uyarı"}
yemek_durumu için SADECE şu değerlerden birini kullan: "aç karnına", "yemekle", "tok karnına", "önemli değil"
bitis_tarihi için: kutuda son kullanma tarihi / SKT / EXP tarihi varsa YYYY-MM-DD formatında yaz, yoksa null yaz. Tedavi bitiş süresini bitis_tarihi olarak yazma, sadece gerçek son kullanma tarihini yaz.`;
    const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }] }] };
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!geminiRes.ok) { const err = await geminiRes.json(); return res.status(geminiRes.status).json({ error: err.error?.message || 'Gemini hatası' }); }
    const data = await geminiRes.json();
    let text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/gi, '').trim();
    res.json(JSON.parse(text));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Gemini: ilaç etkileşimleri
app.post('/interactions', auth, async (req, res) => {
  try {
    const { meds } = req.body;
    if (!meds || meds.length < 2) return res.json({ etkilesimler: [] });
    const liste = meds.map(m => `- ${m.ilac_adi} (${m.doz})`).join('\n');
    const prompt = `Aşağıdaki ilaçlar aynı hastada kullanılıyor. Klinik olarak önemli etkileşimleri bul. SADECE JSON döndür:\n{"etkilesimler": [{"ilaclar": "İlaç A + İlaç B", "risk": "yüksek veya orta", "oneri": "2 cümle: ne olur, ne yapmalı (doktorunuza danışın ile bitir)"}]}\nEtkileşim yoksa: {"etkilesimler": []}\nİlaçlar:\n${liste}`;
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) });
    if (!geminiRes.ok) return res.json({ etkilesimler: [] });
    const data = await geminiRes.json();
    let text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/gi, '').trim();
    res.json(JSON.parse(text));
  } catch { res.json({ etkilesimler: [] }); }
});

// Kayıt
app.post('/register', authLimiter, async (req, res) => {
  try {
    const { name, pin } = req.body;
    if (!name) return res.status(400).json({ error: 'İsim gerekli' });
    if (!pin || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN 4 haneli rakam olmalı' });
    const hashedPin = await bcrypt.hash(pin, SALT_ROUNDS);
    const code = await generateUniqueCode();
    const userId = uuidv4();
    await User.create({ userId, name, pin: hashedPin, code });
    res.json({ userId, code, name, token: signToken(userId) });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Giriş
app.post('/login', authLimiter, async (req, res) => {
  try {
    const { userId, pin, code } = req.body;
    if (userId) {
      const u = await User.findOne({ userId });
      if (!u) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
      if (u.banned) return res.status(403).json({ error: 'Bu hesap askıya alınmış' });
      if (pin) {
        const ok = await bcrypt.compare(String(pin), u.pin);
        if (!ok) return res.status(401).json({ error: 'PIN hatalı' });
      }
      return res.json({ userId: u.userId, code: u.code, name: u.name, token: signToken(u.userId) });
    }
    if (code && pin) {
      const u = await User.findOne({ code: code.toUpperCase() });
      if (!u) return res.status(404).json({ error: 'Kod bulunamadı' });
      if (u.banned) return res.status(403).json({ error: 'Bu hesap askıya alınmış' });
      const ok = await bcrypt.compare(String(pin), u.pin);
      if (!ok) return res.status(401).json({ error: 'PIN hatalı' });
      return res.json({ userId: u.userId, code: u.code, name: u.name, token: signToken(u.userId) });
    }
    res.status(400).json({ error: 'Kod ve PIN gerekli' });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// PIN güncelle
app.post('/update-pin', auth, async (req, res) => {
  try {
    const { oldPin, newPin } = req.body;
    const user = await User.findOne({ userId: req.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const ok = await bcrypt.compare(String(oldPin), user.pin);
    if (!ok) return res.status(401).json({ error: 'Mevcut PIN hatalı' });
    if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Yeni PIN 4 haneli rakam olmalı' });
    user.pin = await bcrypt.hash(String(newPin), SALT_ROUNDS);
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// İlaçlar
app.get('/meds/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.meds || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/meds/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    user.meds = req.body.meds;
    user.markModified('meds');
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Alım takibi
app.get('/checked/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.checked || {});
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/checked/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    user.checked = req.body.checked;
    user.markModified('checked');
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Takip sistemi
app.post('/follow/request', auth, async (req, res) => {
  try {
    const { toCode } = req.body;
    const fromUser = await User.findOne({ userId: req.userId });
    const toUser = await User.findOne({ code: toCode.toUpperCase() });
    if (!fromUser) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    if (!toUser) return res.status(404).json({ error: 'Kod bulunamadı, kontrol edin' });
    if (toUser.userId === req.userId) return res.status(400).json({ error: 'Kendinizi takip edemezsiniz' });
    if ((toUser.blocked || []).includes(req.userId)) return res.status(403).json({ error: 'Bu kullanıcıya istek gönderemezsiniz' });
    if ((toUser.followers || []).some(f => f.userId === req.userId)) return res.status(400).json({ error: 'Zaten takip ediyorsunuz' });
    if ((toUser.followRequests || []).some(r => r.userId === req.userId)) return res.status(400).json({ error: 'İstek zaten gönderildi, onay bekleniyor' });
    if (!toUser.followRequests) toUser.followRequests = [];
    toUser.followRequests.push({ userId: req.userId, name: fromUser.name, requestedAt: new Date().toISOString() });
    toUser.markModified('followRequests');
    await toUser.save();
    res.json({ ok: true, toName: toUser.name });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/follow/requests/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.followRequests || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/follow/approve', auth, async (req, res) => {
  try {
    const { requesterUserId } = req.body;
    const user = await User.findOne({ userId: req.userId });
    const requester = await User.findOne({ userId: requesterUserId });
    if (!user || !requester) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const reqIdx = (user.followRequests || []).findIndex(r => r.userId === requesterUserId);
    if (reqIdx === -1) return res.status(404).json({ error: 'İstek bulunamadı' });
    user.followRequests.splice(reqIdx, 1);
    if (!user.followers) user.followers = [];
    user.followers.push({ userId: requesterUserId, name: requester.name, approvedAt: new Date().toISOString() });
    if (!requester.following) requester.following = [];
    requester.following.push({ userId: user.userId, name: user.name, code: user.code });
    user.markModified('followRequests');
    user.markModified('followers');
    requester.markModified('following');
    await user.save();
    await requester.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/follow/reject', auth, async (req, res) => {
  try {
    const { requesterUserId } = req.body;
    const user = await User.findOne({ userId: req.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    user.followRequests = (user.followRequests || []).filter(r => r.userId !== requesterUserId);
    user.markModified('followRequests');
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/follow/remove', auth, async (req, res) => {
  try {
    const { followerUserId, block } = req.body;
    const user = await User.findOne({ userId: req.userId });
    const follower = await User.findOne({ userId: followerUserId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    user.followers = (user.followers || []).filter(f => f.userId !== followerUserId);
    if (block) {
      if (!user.blocked) user.blocked = [];
      if (!user.blocked.includes(followerUserId)) user.blocked.push(followerUserId);
    }
    user.markModified('followers');
    user.markModified('blocked');
    if (follower) {
      follower.following = (follower.following || []).filter(f => f.userId !== req.userId);
      follower.markModified('following');
      await follower.save();
    }
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/follow/following/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.following || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/follow/followers/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.followers || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Aile görünümü (token ile)
app.get('/family/user/:targetUserId', auth, async (req, res) => {
  try {
    const target = await User.findOne({ userId: req.params.targetUserId });
    if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const isFollower = (target.followers || []).some(f => f.userId === req.userId);
    if (!isFollower) return res.status(403).json({ error: 'Takip izniniz yok' });
    const today = new Date().toISOString().split('T')[0];
    const todayChecked = (target.checked || {})[today] || {};
    let totalDose = 0, takenDose = 0, missedDoses = [];
    const now = new Date();
    const nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    (target.meds || []).forEach(med => {
      (med.saatler || []).forEach(saat => {
        const key = `${med.id}_${saat}`;
        if (saat <= nowTime) { totalDose++; if (todayChecked[key]) takenDose++; else missedDoses.push({ ilac: med.ilac_adi, saat }); }
      });
    });
    res.json({ name: target.name, today, totalDose, takenDose, missedDoses, uyumPct: totalDose > 0 ? Math.round(takenDose / totalDose * 100) : null, meds: target.meds, checked: target.checked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Aile görünümü (kod ile, auth yok — eski uyumluluk)
app.get('/family/:code', async (req, res) => {
  try {
    const user = await User.findOne({ code: req.params.code.toUpperCase() });
    if (!user) return res.status(404).json({ error: 'Kod bulunamadı' });
    const today = new Date().toISOString().split('T')[0];
    const todayChecked = (user.checked || {})[today] || {};
    let totalDose = 0, takenDose = 0, missedDoses = [];
    const now = new Date();
    const nowTime = String(now.getHours()).padStart(2, '0') + ':' + String(now.getMinutes()).padStart(2, '0');
    (user.meds || []).forEach(med => {
      (med.saatler || []).forEach(saat => {
        const key = `${med.id}_${saat}`;
        if (saat <= nowTime) { totalDose++; if (todayChecked[key]) takenDose++; else missedDoses.push({ ilac: med.ilac_adi, saat }); }
      });
    });
    res.json({ name: user.name, today, totalDose, takenDose, missedDoses, uyumPct: totalDose > 0 ? Math.round(takenDose / totalDose * 100) : null, meds: user.meds, checked: user.checked });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// İlaç arşivi
app.get('/meds-archive/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.meds_archive || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/meds-archive/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    user.meds_archive = req.body.meds_archive;
    user.markModified('meds_archive');
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Mesajlaşma
app.post('/message/send', auth, async (req, res) => {
  try {
    const { toUserId, text, medName, saat } = req.body;
    if (!toUserId || !text) return res.status(400).json({ error: 'Eksik alan' });
    const fromUser = await User.findOne({ userId: req.userId });
    const toUser = await User.findOne({ userId: toUserId });
    if (!fromUser || !toUser) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const isFollower = (toUser.followers || []).some(f => f.userId === req.userId);
    if (!isFollower) return res.status(403).json({ error: 'Sadece takip ettiğiniz kişilere mesaj gönderebilirsiniz' });
    const msg = { from: req.userId, fromName: fromUser.name, text, sentAt: new Date().toISOString(), read: false };
    if (medName) msg.medName = medName;
    if (saat) msg.saat = saat;
    if (!toUser.messages) toUser.messages = [];
    toUser.messages.push(msg);
    toUser.markModified('messages');
    await toUser.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/message/inbox/:userId', auth, async (req, res) => {
  try {
    if (req.userId !== req.params.userId) return res.status(403).json({ error: 'Yetkisiz' });
    const user = await User.findOne({ userId: req.params.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    res.json(user.messages || []);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/message/read', auth, async (req, res) => {
  try {
    const user = await User.findOne({ userId: req.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    (user.messages || []).forEach(m => { m.read = true; });
    user.markModified('messages');
    await user.save();
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/message/delete', auth, async (req, res) => {
  try {
    const { sentAt } = req.body;
    const user = await User.findOne({ userId: req.userId });
    if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    user.messages = (user.messages || []).filter(m => m.sentAt !== sentAt);
    user.markModified('messages');
    await user.save();
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Takip - ilaç alındı bildirimi
app.post('/family/notify-taken', auth, async (req, res) => {
  try {
    const { medName, saat } = req.body;
    const user = await User.findOne({ userId: req.userId });
    if (!user || !(user.followers || []).length) return res.json({ ok: true });
    const text = `✅ ${user.name} — ${medName}${saat ? ' (' + saat + ')' : ''} ilacını aldı!`;
    const msg = { from: req.userId, fromName: user.name, text, sentAt: new Date().toISOString(), read: false, type: 'taken' };
    await Promise.all((user.followers).map(async f => {
      const follower = await User.findOne({ userId: f.userId });
      if (!follower) return;
      if (!follower.messages) follower.messages = [];
      follower.messages.push(msg);
      follower.markModified('messages');
      return follower.save();
    }));
    res.json({ ok: true });
  } catch(err) { res.status(500).json({ error: err.message }); }
});

// Admin API
app.get('/admin/users', adminAuth, async (req, res) => {
  try {
    const users = await User.find({ banned: { $ne: true } }, { pin: 0 }).lean();
    res.json(users.map(u => ({
      userId: u.userId, name: u.name, code: u.code,
      medCount: (u.meds || []).length,
      followerCount: (u.followers || []).length,
      followingCount: (u.following || []).length,
      createdAt: u.createdAt
    })));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.delete('/admin/users/:userId', adminAuth, async (req, res) => {
  try {
    await User.findOneAndUpdate({ userId: req.params.userId }, { banned: true, pin: '', meds: [], checked: {}, followers: [], followRequests: [], following: [] });
    res.json({ ok: true });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.get('/admin/photos', adminAuth, async (req, res) => {
  try {
    const users = await User.find({}, { pin: 0 }).lean();
    const photos = [];
    users.forEach(u => {
      (u.meds || []).forEach(med => {
        if (med.thumbnail) {
          photos.push({
            userName: u.name, userCode: u.code,
            ilac_adi: med.ilac_adi, doz: med.doz,
            thumbnail: med.thumbnail,
            addedAt: med.id ? new Date(parseInt(med.id.replace('med_', ''))).toISOString() : null
          });
        }
      });
    });
    res.json(photos);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// Admin paneli (tarayıcıdan açılır, anahtar HTML içinde istenir)
app.get('/admin', (req, res) => {
  res.send(`<!DOCTYPE html>
<html lang="tr">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>Sağlıklı Kal — Admin</title>
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: system-ui, sans-serif; background: #0f172a; color: #e2e8f0; min-height: 100vh; padding: 24px; }
  h1 { font-size: 1.5rem; margin-bottom: 20px; color: #38bdf8; }
  .login-box { max-width: 360px; background: #1e293b; border-radius: 12px; padding: 24px; margin: 80px auto; }
  .login-box h2 { margin-bottom: 16px; font-size: 1.1rem; }
  input { width: 100%; padding: 10px 12px; background: #0f172a; border: 1px solid #334155; border-radius: 8px; color: #e2e8f0; font-size: 1rem; margin-bottom: 12px; }
  button { width: 100%; padding: 10px; background: #38bdf8; color: #0f172a; border: none; border-radius: 8px; font-size: 1rem; font-weight: 600; cursor: pointer; }
  button:hover { background: #7dd3fc; }
  .stats { display: flex; gap: 16px; margin-bottom: 24px; flex-wrap: wrap; }
  .stat-card { background: #1e293b; border-radius: 10px; padding: 16px 24px; flex: 1; min-width: 140px; }
  .stat-card .num { font-size: 2rem; font-weight: 700; color: #38bdf8; }
  .stat-card .label { font-size: 0.8rem; color: #94a3b8; margin-top: 4px; }
  table { width: 100%; border-collapse: collapse; background: #1e293b; border-radius: 12px; overflow: hidden; }
  th { background: #0f172a; padding: 12px 16px; text-align: left; font-size: 0.75rem; color: #94a3b8; text-transform: uppercase; letter-spacing: .05em; }
  td { padding: 12px 16px; border-top: 1px solid #334155; font-size: 0.875rem; }
  tr:hover td { background: #263045; }
  .badge { display: inline-block; padding: 2px 8px; border-radius: 999px; font-size: 0.75rem; font-weight: 600; background: #164e63; color: #38bdf8; }
  .del-btn { background: #7f1d1d; color: #fca5a5; border: none; border-radius: 6px; padding: 4px 10px; cursor: pointer; font-size: 0.75rem; }
  .del-btn:hover { background: #991b1b; }
  #error { color: #f87171; margin-top: 8px; font-size: 0.875rem; }
  #content { display: none; }
  .tabs { display: flex; gap: 8px; margin-bottom: 20px; }
  .tab-btn { padding: 8px 20px; border-radius: 8px; border: none; background: #1e293b; color: #94a3b8; font-size: 0.9rem; font-weight: 600; cursor: pointer; }
  .tab-btn.active { background: #38bdf8; color: #0f172a; }
  .photo-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(240px, 1fr)); gap: 16px; }
  .photo-card { background: #1e293b; border-radius: 10px; overflow: hidden; }
  .photo-card img { width: 100%; aspect-ratio: 1; object-fit: contain; display: block; background: #0f172a; }
  .photo-info { padding: 8px 10px; }
  .photo-name { font-size: 0.8rem; font-weight: 700; color: #e2e8f0; }
  .photo-meta { font-size: 0.7rem; color: #64748b; margin-top: 2px; }
  #photos-panel { display: none; }
</style>
</head>
<body>
<div id="loginBox" class="login-box">
  <h2>🔐 Admin Girişi</h2>
  <input id="keyInput" type="password" placeholder="Admin anahtarı" />
  <button onclick="login()">Giriş</button>
  <div id="error"></div>
</div>
<div id="content">
  <h1>💊 Sağlıklı Kal — Admin Paneli</h1>
  <div class="stats" id="stats"></div>
  <div class="tabs">
    <button class="tab-btn active" onclick="showTab('users')">👥 Kullanıcılar</button>
    <button class="tab-btn" onclick="showTab('photos')">📷 Taranan Fotoğraflar</button>
  </div>
  <div id="users-panel">
    <table>
      <thead><tr><th>İsim</th><th>Kod</th><th>İlaç</th><th>Takipçi</th><th>Takip</th><th>Kayıt</th><th></th></tr></thead>
      <tbody id="tbody"></tbody>
    </table>
  </div>
  <div id="photos-panel">
    <div class="photo-grid" id="photo-grid"></div>
  </div>
</div>
<script>
let adminKey = '';
async function login() {
  adminKey = document.getElementById('keyInput').value;
  const res = await fetch('/admin/users', { headers: { 'x-admin-key': adminKey } });
  if (!res.ok) { document.getElementById('error').textContent = 'Hatalı anahtar'; return; }
  document.getElementById('loginBox').style.display = 'none';
  document.getElementById('content').style.display = 'block';
  renderUsers(await res.json());
}
document.getElementById('keyInput').addEventListener('keydown', e => { if (e.key === 'Enter') login(); });
function showTab(tab) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
  event.target.classList.add('active');
  document.getElementById('users-panel').style.display = tab === 'users' ? 'block' : 'none';
  document.getElementById('photos-panel').style.display = tab === 'photos' ? 'block' : 'none';
  if (tab === 'photos') loadPhotos();
}
async function loadPhotos() {
  const grid = document.getElementById('photo-grid');
  grid.innerHTML = '<div style="color:#94a3b8;padding:20px;">Yükleniyor...</div>';
  const res = await fetch('/admin/photos', { headers: { 'x-admin-key': adminKey } });
  const photos = await res.json();
  if (photos.length === 0) { grid.innerHTML = '<div style="color:#94a3b8;padding:20px;">Henüz taranan fotoğraf yok.</div>'; return; }
  grid.innerHTML = photos.map(p => \`
    <div class="photo-card">
      <img src="data:image/jpeg;base64,\${p.thumbnail}" alt="\${p.ilac_adi}" />
      <div class="photo-info">
        <div class="photo-name">\${p.ilac_adi}</div>
        <div class="photo-meta">\${p.userName} · \${p.doz}</div>
        <div class="photo-meta">\${p.addedAt ? new Date(p.addedAt).toLocaleDateString('tr-TR') : ''}</div>
      </div>
    </div>
  \`).join('');
}
function renderUsers(users) {
  const totalMeds = users.reduce((s, u) => s + u.medCount, 0);
  document.getElementById('stats').innerHTML = \`
    <div class="stat-card"><div class="num">\${users.length}</div><div class="label">Toplam Kullanıcı</div></div>
    <div class="stat-card"><div class="num">\${totalMeds}</div><div class="label">Toplam İlaç Kaydı</div></div>
  \`;
  const tbody = document.getElementById('tbody');
  tbody.innerHTML = users.map(u => \`
    <tr>
      <td>\${u.name}</td>
      <td><span class="badge">\${u.code}</span></td>
      <td>\${u.medCount}</td>
      <td>\${u.followerCount}</td>
      <td>\${u.followingCount}</td>
      <td>\${u.createdAt ? new Date(u.createdAt).toLocaleDateString('tr-TR') : '-'}</td>
      <td><button class="del-btn" onclick="deleteUser('\${u.userId}', '\${u.name}')">Sil</button></td>
    </tr>
  \`).join('');
}
async function deleteUser(userId, name) {
  if (!confirm(\`"\${name}" kullanıcısını silmek istiyor musunuz?\`)) return;
  await fetch(\`/admin/users/\${userId}\`, { method: 'DELETE', headers: { 'x-admin-key': adminKey } });
  const res = await fetch('/admin/users', { headers: { 'x-admin-key': adminKey } });
  renderUsers(await res.json());
}
</script>
</body>
</html>`);
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Sağlıklı Kal Backend çalışıyor 💊', nosyapi: !!process.env.NOSYAPI_KEY }));

app.get('/debug/nosyapi', async (req, res) => {
  const key = process.env.NOSYAPI_KEY;
  if (!key) return res.json({ error: 'key yok' });
  try {
    const r = await fetch(`https://www.nosyapi.com/apiv2/service/pharmacies-on-duty?cityId=28&apikey=${key}`);
    const data = await r.json();
    res.json({
      result: data,
      keyLength: key.length,
      keyStart: key.slice(0, 5),
      keyEnd: key.slice(-5),
      keyHasNewline: key.includes('\n') || key.includes('\r')
    });
  } catch(e) { res.json({ error: e.message }); }
});

// ── ECZANE API ──
function calcDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLng = (lng2 - lng1) * Math.PI / 180;
  const a = Math.sin(dLat/2)**2 + Math.cos(lat1*Math.PI/180) * Math.cos(lat2*Math.PI/180) * Math.sin(dLng/2)**2;
  return Math.round(R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a)));
}

// Yakın eczaneler — birden fazla Overpass mirror dene
app.get('/api/nearby-pharmacies', async (req, res) => {
  const { lat, lng, radius = 3000 } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat ve lng gerekli' });
  const query = `[out:json][timeout:15];node["amenity"="pharmacy"](around:${radius},${lat},${lng});out body;`;
  const mirrors = [
    `https://overpass-api.de/api/interpreter?data=${encodeURIComponent(query)}`,
    `https://maps.mail.ru/osm/tools/overpass/api/interpreter?data=${encodeURIComponent(query)}`,
    `https://overpass.kumi.systems/api/interpreter?data=${encodeURIComponent(query)}`,
  ];
  for (const url of mirrors) {
    try {
      const r = await fetch(url, { signal: AbortSignal.timeout(10000) });
      if (!r.ok) continue;
      const data = await r.json();
      if (!data.elements) continue;
      const pharmacies = data.elements.map(el => ({
        id: el.id,
        name: el.tags.name || el.tags['name:tr'] || 'Eczane',
        lat: el.lat, lng: el.lon,
        phone: el.tags.phone || el.tags['contact:phone'] || null,
        address: [el.tags['addr:street'], el.tags['addr:housenumber']].filter(Boolean).join(' ') || null,
        distance: calcDistance(parseFloat(lat), parseFloat(lng), el.lat, el.lon)
      })).sort((a, b) => a.distance - b.distance).slice(0, 25);
      return res.json({ pharmacies });
    } catch(e) { continue; }
  }
  res.json({ pharmacies: [], error: 'Eczane verisi alınamadı' });
});

// Nöbetçi eczane — eczaneler.net scraping (API key yok, tamamen ücretsiz)
const cheerio = require('cheerio');

const CITY_SLUGS = {
  'İstanbul':'istanbul','Ankara':'ankara','İzmir':'izmir','Bursa':'bursa','Antalya':'antalya',
  'Adana':'adana','Konya':'konya','Gaziantep':'gaziantep','Mersin':'mersin','Kocaeli':'kocaeli',
  'Diyarbakır':'diyarbakir','Eskişehir':'eskisehir','Samsun':'samsun','Kayseri':'kayseri',
  'Balıkesir':'balikesir','Sakarya':'sakarya','Trabzon':'trabzon','Malatya':'malatya',
  'Kahramanmaraş':'kahramanmaras','Erzurum':'erzurum','Van':'van','Aydın':'aydin',
  'Muğla':'mugla','Manisa':'manisa','Tekirdağ':'tekirdag','Hatay':'hatay','Denizli':'denizli',
  'Şanlıurfa':'sanliurfa','Afyonkarahisar':'afyonkarahisar','Ordu':'ordu','Sivas':'sivas',
  'Rize':'rize','Giresun':'giresun','Tokat':'tokat','Çorum':'corum','Elazığ':'elazig',
  'Edirne':'edirne','Bolu':'bolu','Isparta':'isparta','Burdur':'burdur','Kastamonu':'kastamonu',
  'Kırıkkale':'kirikkale','Zonguldak':'zonguldak','Karabük':'karabuk','Düzce':'duzce',
  'Yalova':'yalova','Kırklareli':'kirklareli','Sinop':'sinop','Bartın':'bartin',
  'Çanakkale':'canakkale','Nevşehir':'nevsehir','Aksaray':'aksaray','Niğde':'nigde',
  'Karaman':'karaman','Kırşehir':'kirsehir','Yozgat':'yozgat','Amasya':'amasya',
  'Tunceli':'tunceli','Erzincan':'erzincan','Ardahan':'ardahan','Kars':'kars',
  'Ağrı':'agri','Iğdır':'igdir','Muş':'mus','Bitlis':'bitlis','Siirt':'siirt',
  'Batman':'batman','Şırnak':'sirnak','Mardin':'mardin','Hakkari':'hakkari',
  'Adıyaman':'adiyaman','Osmaniye':'osmaniye','Kilis':'kilis','Gümüşhane':'gumushane',
  'Bayburt':'bayburt','Artvin':'artvin','Çankırı':'cankiri','Bilecik':'bilecik',
  'Uşak':'usak','Kütahya':'kutahya'
};

// Nöbetçi eczane cache (her gün güncellenir)
const _dutyCache = {};

app.get('/api/duty-pharmacies', async (req, res) => {
  const { lat, lng } = req.query;
  if (!lat || !lng) return res.status(400).json({ error: 'lat ve lng gerekli' });
  try {
    // Şehri bul
    const geoUrl = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&accept-language=tr`;
    const geoRes = await fetch(geoUrl, { headers: { 'User-Agent': 'SaglikliKal/1.0' } });
    const geoData = await geoRes.json();
    const cityRaw = geoData.address?.province || geoData.address?.city || geoData.address?.state || 'İstanbul';
    const city = Object.keys(CITY_SLUGS).find(k => cityRaw.toLowerCase().includes(k.toLowerCase().replace('İ','i'))) || 'İstanbul';
    const slug = CITY_SLUGS[city] || 'istanbul';

    // Cache kontrolü (gün bazlı)
    const today = new Date().toISOString().split('T')[0];
    const cacheKey = `${slug}_${today}`;
    if (_dutyCache[cacheKey]) {
      const cached = _dutyCache[cacheKey];
      const pharmacies = cached.map(p => ({
        ...p,
        distance: (p.lat && p.lng) ? calcDistance(parseFloat(lat), parseFloat(lng), p.lat, p.lng) : null
      })).sort((a, b) => (a.distance ?? 999999) - (b.distance ?? 999999));
      return res.json({ pharmacies, city });
    }

    // nosyapi.com — günde 100 istek ücretsiz, cache ile yeterli
    const NOSYAPI_KEY = process.env.NOSYAPI_KEY;
    if (!NOSYAPI_KEY) return res.json({ pharmacies: [], city, error: 'NOSYAPI_KEY gerekli' });

    const CITY_IDS = {
      'Adana':1,'Adıyaman':2,'Afyonkarahisar':3,'Ağrı':4,'Amasya':5,'Ankara':6,'Antalya':7,
      'Artvin':8,'Aydın':9,'Balıkesir':10,'Bilecik':11,'Bingöl':12,'Bitlis':13,'Bolu':14,
      'Burdur':15,'Bursa':16,'Çanakkale':17,'Çankırı':18,'Çorum':19,'Denizli':20,
      'Diyarbakır':21,'Edirne':22,'Elazığ':23,'Erzincan':24,'Erzurum':25,'Eskişehir':26,
      'Gaziantep':27,'Giresun':28,'Gümüşhane':29,'Hakkari':30,'Hatay':31,'Isparta':32,
      'Mersin':33,'İstanbul':34,'İzmir':35,'Kars':36,'Kastamonu':37,'Kayseri':38,
      'Kırklareli':39,'Kırşehir':40,'Kocaeli':41,'Konya':42,'Kütahya':43,'Malatya':44,
      'Manisa':45,'Kahramanmaraş':46,'Mardin':47,'Muğla':48,'Muş':49,'Nevşehir':50,
      'Niğde':51,'Ordu':52,'Rize':53,'Sakarya':54,'Samsun':55,'Siirt':56,'Sinop':57,
      'Sivas':58,'Tekirdağ':59,'Tokat':60,'Trabzon':61,'Tunceli':62,'Şanlıurfa':63,
      'Uşak':64,'Van':65,'Yozgat':66,'Zonguldak':67,'Aksaray':68,'Bayburt':69,
      'Karaman':70,'Kırıkkale':71,'Batman':72,'Şırnak':73,'Bartın':74,'Ardahan':75,
      'Iğdır':76,'Yalova':77,'Karabük':78,'Kilis':79,'Osmaniye':80,'Düzce':81
    };
    const cityId = CITY_IDS[city] || 34;
    const r = await fetch(`https://www.nosyapi.com/apiv2/service/pharmacies-on-duty?cityId=${cityId}&apikey=${NOSYAPI_KEY}`);
    const data = await r.json();
    console.log('nosyapi response:', JSON.stringify(data).slice(0, 500));
    const pharmacies = (data.data || data.result || data.pharmacies || []).map(p => ({
      name: p.eczane_adi || p.name || '',
      address: p.adres || p.address || null,
      phone: p.telefon || p.phone || null,
      district: p.ilce || null,
      lat: parseFloat(p.lat) || null,
      lng: parseFloat(p.lng) || null,
    })).filter(p => p.name)
      .map(p => ({
        ...p,
        distance: (p.lat && p.lng) ? calcDistance(parseFloat(lat), parseFloat(lng), p.lat, p.lng) : null
      }))
      .sort((a, b) => (a.distance ?? 999999) - (b.distance ?? 999999));

    // Cache'e kaydet
    if (pharmacies.length > 0) _dutyCache[cacheKey] = pharmacies;

    res.json({ pharmacies, city });
  } catch(e) {
    res.status(500).json({ error: 'Nöbetçi eczane verisi alınamadı', pharmacies: [], detail: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sağlıklı Kal Backend port ${PORT}'de çalışıyor`));
