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
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }
    );
    if (!geminiRes.ok) {
      const err = await geminiRes.json();
      return res.status(geminiRes.status).json({ error: err.error?.message || 'Gemini hatası' });
    }
    const data = await geminiRes.json();
    let text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/gi, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

app.post('/interactions', async (req, res) => {
  try {
    const { meds } = req.body;
    if (!meds || meds.length < 2) return res.json({ etkilesimler: [] });
    const liste = meds.map(m => `- ${m.ilac_adi} (${m.doz})`).join('\n');
    const prompt = `Aşağıdaki ilaçlar aynı hastada kullanılıyor. Klinik olarak önemli etkileşimleri bul.
SADECE JSON döndür:
{"etkilesimler": [{"ilaclar": "İlaç A + İlaç B", "risk": "yüksek veya orta", "oneri": "2 cümle: ne olur, ne yapmalı (doktorunuza danışın ile bitir)"}]}
Etkileşim yoksa: {"etkilesimler": []}
İlaçlar:\n${liste}`;
    const geminiRes = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent?key=${process.env.GEMINI_API_KEY}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ parts: [{ text: prompt }] }] }) }
    );
    if (!geminiRes.ok) return res.json({ etkilesimler: [] });
    const data = await geminiRes.json();
    let text = data.candidates[0].content.parts[0].text.trim().replace(/```json|```/gi, '').trim();
    res.json(JSON.parse(text));
  } catch (err) {
    res.json({ etkilesimler: [] });
  }
});

app.post('/register', (req, res) => {
  const { name } = req.body;
  if (!name) return res.status(400).json({ error: 'İsim gerekli' });
  const userId = uuidv4();
  const code = generateCode();
  users[userId] = { userId, name, code, meds: [], checked: {}, createdAt: new Date().toISOString() };
  codes[code] = userId;
  res.json({ userId, code, name });
});

app.post('/login', (req, res) => {
  const { userId } = req.body;
  if (!userId || !users[userId]) return res.status(404).json({ error: 'Kullanıcı bulunamadı' });
  const u = users[userId];
  res.json({ userId: u.userId, code: u.code, name: u.name });
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

app.get('/family/:code', (req, res) => {
  const user = getUserByCode(req.params.code.toUpperCase());
  if (!user) return res.status(404).json({ error: 'Kod bulunamadı. Kodu kontrol edin.' });
  const today = new Date().toISOString().split('T')[0];
  const todayChecked = user.checked[today] || {};
  let totalDose = 0, takenDose = 0, missedDoses = [];
  const now = new Date();
  const nowTime = String(now.getHours()).padStart(2,'0') + ':' + String(now.getMinutes()).padStart(2,'0');
  user.meds.forEach(med => {
    (med.saatler || []).forEach(saat => {
      const key = `${med.id}_${saat}`;
      if (saat <= nowTime) {
        totalDose++;
        if (todayChecked[key]) takenDose++;
        else missedDoses.push({ ilac: med.ilac_adi, saat });
      }
    });
  });
  res.json({
    name: user.name, today, totalDose, takenDose, missedDoses,
    uyumPct: totalDose > 0 ? Math.round(takenDose / totalDose * 100) : null,
    meds: user.meds, checked: user.checked
  });
});

app.get('/', (req, res) => res.json({ status: 'ok', message: 'Sağlıklı Kal Backend çalışıyor 💊' }));

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Sağlıklı Kal Backend port ${PORT}'de çalışıyor`));
