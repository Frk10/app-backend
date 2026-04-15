require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { v4: uuidv4 } = require('uuid');

const app = express();
app.use(cors());
app.use(express.json({ limit: '10mb' }));

let users = {};
let codes = {};

function generateCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function getUserByCode(code) {
  const userId = codes[code];
  return userId ? users[userId] : null;
}

app.post('/analyze', async (req, res) => {
  try {
    const { imageBase64, mimeType } = req.body;
    if (!imageBase64) return res.status(400).json({ error: 'Görüntü gerekli' });
    const prompt = `Bu bir ilaç kutusu veya prospektüs görüntüsüdür. Kullanım talimatlarını analiz et. SADECE şu JSON formatında yanıt ver, başka hiçbir şey yazma, markdown backtick kullanma:
{"ilac_adi":"İlaç adı ve dozu","etken_madde":"etken madde","doz":"1 tablet","gunluk_kullanim":2,"saatler":["08:00","20:00"],"yemek_durumu":"aç karnına veya yemekle veya tok karnına veya önemli değil","sure":"süresiz","ozel_uyarilar":"varsa uyarı"}
yemek_durumu için SADECE şu değerlerden birini kullan: "aç karnına", "yemekle", "tok karnına", "önemli değil"`;
    const payload = { contents: [{ parts: [{ text: prompt }, { inlineData: { mimeType: mimeType || 'image/jpeg', data: imageBase64 } }] }] };
    const geminiRes = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    if (!geminiRes.ok) { const err = await geminiRes.json(); return res.status(geminiRes.status).json({ error: err.error?.message || 'Gemini hatası' }); }
    const data = await geminiRes.json();
    let text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/gi, '').trim();
    res.json(JSON.parse(text));
  } catch (err) { res.status(500).json({ error: err.message }); }
});

app.post('/interactions', async (req, res) => {
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
  } catch (err) { res.json({ etkilesimler: [] }); }
});

app.post('/register', (req, res) => {
  const { name, pin } = req.body;
  if (!name) return res.status(400).json({ error: 'İsim gerekli' });
  if (!pin || pin.length !== 4 || !/^\d{4}$/.test(pin)) return res.status(400).json({ error: 'PIN 4 haneli rakam olmalı' });
  const userId = uuidv4();
  const code = generateCode();
  users[userId] = { userId, name, pin, code, meds: [], checked: {}, followers: [], followRequests: [], blocked: [], following: [], createdAt: new Date().toISOString() };
  codes[code] = userId;
  res.json({ userId, code, name });
});

// PIN ile giriş (başka cihazdan)
app.post('/login', (req, res) => {
  const { userId, pin, code } = req.body;
  // userId ile giriş (aynı cihaz)
  if (userId) {
    if (!users[userId]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
    const u = users[userId];
    if (pin && u.pin !== pin) return res.status(401).json({ error: 'PIN hatalı' });
    return res.json({ userId: u.userId, code: u.code, name: u.name });
  }
  // Kod + PIN ile giriş (başka cihaz)
  if (code && pin) {
    const u = getUserByCode(code.toUpperCase());
    if (!u) return res.status(404).json({ error: 'Kod bulunamadı' });
    if (u.pin !== pin) return res.status(401).json({ error: 'PIN hatalı' });
    return res.json({ userId: u.userId, code: u.code, name: u.name });
  }
  return res.status(400).json({ error: 'Kod ve PIN gerekli' });
});

// PIN güncelle
app.post('/update-pin', (req, res) => {
  const { userId, oldPin, newPin } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (user.pin !== oldPin) return res.status(401).json({ error: 'Mevcut PIN hatalı' });
  if (!/^\d{4}$/.test(newPin)) return res.status(400).json({ error: 'Yeni PIN 4 haneli rakam olmalı' });
  user.pin = newPin;
  res.json({ ok: true });
});

app.get('/meds/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(user.meds);
});

app.post('/meds/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user.meds = req.body.meds;
  res.json({ ok: true });
});

app.get('/checked/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(user.checked);
});

app.post('/checked/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user.checked = req.body.checked;
  res.json({ ok: true });
});

// TAKİP SİSTEMİ

app.post('/follow/request', (req, res) => {
  const { fromUserId, toCode } = req.body;
  const fromUser = users[fromUserId];
  const toUser = getUserByCode(toCode.toUpperCase());
  if (!fromUser) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  if (!toUser) return res.status(404).json({ error: 'Kod bulunamadı, kontrol edin' });
  if (toUser.userId === fromUserId) return res.status(400).json({ error: 'Kendinizi takip edemezsiniz' });
  if ((toUser.blocked || []).includes(fromUserId)) return res.status(403).json({ error: 'Bu kullanıcıya istek gönderemezsiniz' });
  if ((toUser.followers || []).some(f => f.userId === fromUserId)) return res.status(400).json({ error: 'Zaten takip ediyorsunuz' });
  if ((toUser.followRequests || []).some(r => r.userId === fromUserId)) return res.status(400).json({ error: 'İstek zaten gönderildi, onay bekleniyor' });
  if (!toUser.followRequests) toUser.followRequests = [];
  toUser.followRequests.push({ userId: fromUserId, name: fromUser.name, requestedAt: new Date().toISOString() });
  res.json({ ok: true, toName: toUser.name });
});

app.get('/follow/requests/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(user.followRequests || []);
});

app.post('/follow/approve', (req, res) => {
  const { userId, requesterUserId } = req.body;
  const user = users[userId];
  const requester = users[requesterUserId];
  if (!user || !requester) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  const reqIdx = (user.followRequests || []).findIndex(r => r.userId === requesterUserId);
  if (reqIdx === -1) return res.status(404).json({ error: 'İstek bulunamadı' });
  user.followRequests.splice(reqIdx, 1);
  if (!user.followers) user.followers = [];
  user.followers.push({ userId: requesterUserId, name: requester.name, approvedAt: new Date().toISOString() });
  if (!requester.following) requester.following = [];
  requester.following.push({ userId: user.userId, name: user.name, code: user.code });
  res.json({ ok: true });
});

app.post('/follow/reject', (req, res) => {
  const { userId, requesterUserId } = req.body;
  const user = users[userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user.followRequests = (user.followRequests || []).filter(r => r.userId !== requesterUserId);
  res.json({ ok: true });
});

app.post('/follow/remove', (req, res) => {
  const { userId, followerUserId, block } = req.body;
  const user = users[userId];
  const follower = users[followerUserId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  user.followers = (user.followers || []).filter(f => f.userId !== followerUserId);
  if (block) { if (!user.blocked) user.blocked = []; if (!user.blocked.includes(followerUserId)) user.blocked.push(followerUserId); }
  if (follower) follower.following = (follower.following || []).filter(f => f.userId !== userId);
  res.json({ ok: true });
});

app.get('/follow/following/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(user.following || []);
});

app.get('/follow/followers/:userId', (req, res) => {
  const user = users[req.params.userId];
  if (!user) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  res.json(user.followers || []);
});

app.get('/family/user/:targetUserId', (req, res) => {
  const { viewerUserId } = req.query;
  const target = users[req.params.targetUserId];
  if (!target) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  const isFollower = (target.followers || []).some(f => f.userId === viewerUserId);
  if (!isFollower) return res.status(403).json({ error: 'Takip izniniz yok' });
  const today = new Date().toISOString().split('T')[0];
  const todayChecked = target.checked[today] || {};
  let totalDose = 0, takenDose = 0, missedDoses = [];
  const now = new Date();
  const nowTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  target.meds.forEach(med => {
    (med.saatler || []).forEach(saat => {
      const key = `${med.id}_${saat}`;
      if (saat <= nowTime) { totalDose++; if (todayChecked[key]) takenDose++; else missedDoses.push({ ilac: med.ilac_adi, saat }); }
    });
  });
  res.json({ name: target.name, today, totalDose, takenDose, missedDoses, uyumPct: totalDose > 0 ? Math.round(takenDose / totalDose * 100) : null, meds: target.meds, checked: target.checked });
});

app.get('/family/:code', (req, res) => {
  const user = getUserByCode(req.params.code.toUpperCase());
  if (!user) return res.status(404).json({ error: 'Kod bulunamadı' });
  const today = new Date().toISOString().split('T')[0];
  const todayChecked = user.checked[today] || {};
  let totalDose = 0, takenDose = 0, missedDoses = [];
  const now = new Date();
  const nowTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  user.meds.forEach(med => {
    (med.saatler || []).forEach(saat => {
      const key = `${med.id}_${saat}`;
      if (saat <= nowTime) { totalDose++; if (todayChecked[key]) takenDose++; else missedDoses.push({ ilac: med.ilac_adi, saat }); }
    });
  });
  res.json({ name: user.name, today, totalDose, takenDose, missedDoses, uyumPct: totalDose > 0 ? Math.round(takenDose / totalDose * 100) : null, meds: user.meds, checked: user.checked });
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Sağlıklı Kal Backend çalışıyor 💊' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sağlıklı Kal Backend port ${PORT}'de çalışıyor`));
