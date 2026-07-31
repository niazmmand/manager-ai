// ============================================================
// سرور دستیار تحلیلی مدیران
// این فایل هسته‌ی برنامه است: صفحات را نمایش می‌دهد،
// سؤال مدیر را می‌گیرد، مرتبط‌ترین محتوای کتابخانه را پیدا می‌کند
// و از کلود می‌خواهد بر اساس آن‌ها تحلیل تولید کند.
// ============================================================

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const mammoth = require('mammoth');
const multer = require('multer');
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024 } });

const GEMINI_MODEL = 'gemini-2.5-flash';
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

const app = express();
const PORT = process.env.PORT || 3000;
const CONTENT_FILE = path.join(__dirname, 'data', 'content.json');
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-me';

app.use(express.json({ limit: '2mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---------- کمکی: خواندن و نوشتن کتابخانه محتوا ----------
function readLibrary() {
  if (!fs.existsSync(CONTENT_FILE)) return [];
  return JSON.parse(fs.readFileSync(CONTENT_FILE, 'utf8'));
}
function writeLibrary(items) {
  fs.mkdirSync(path.dirname(CONTENT_FILE), { recursive: true });
  fs.writeFileSync(CONTENT_FILE, JSON.stringify(items, null, 2), 'utf8');
}

// ---------- جست‌وجوی ساده کلیدواژه‌ای ----------
function findRelevant(query, library, topN = 4) {
  const q = query.toLowerCase();
  const scored = library.map(item => {
    let score = 0;
    (item.keywords || []).forEach(k => {
      if (q.includes(k.toLowerCase())) score += 3;
    });
    const words = q.split(/\s+/).filter(w => w.length > 2);
    words.forEach(w => {
      if ((item.title || '').toLowerCase().includes(w)) score += 1;
      if ((item.content || '').toLowerCase().includes(w)) score += 1;
    });
    return { item, score };
  }).filter(s => s.score > 0).sort((a, b) => b.score - a.score);

  if (scored.length === 0) return library.slice(0, 3);
  return scored.slice(0, topN).map(s => s.item);
}

// ---------- مسیر چت اصلی ----------
app.post('/api/chat', async (req, res) => {
  try {
    const { message } = req.body;
    if (!message || !message.trim()) {
      return res.status(400).json({ error: 'پیام خالی است.' });
    }
    if (!process.env.GEMINI_API_KEY) {
      return res.status(500).json({ error: 'کلید API تنظیم نشده است. در تنظیمات هاست، GEMINI_API_KEY را وارد کنید.' });
    }

    const library = readLibrary();
    const relevant = findRelevant(message, library);

    const contextBlock = relevant.map((r, i) =>
      `منبع ${i + 1} — «${r.title}»:\n${r.content}`
    ).join('\n\n');

    const systemPrompt = `تو دستیار تحلیلی فارسی‌زبان برای مدیران هستی. فقط بر اساس منابعی که در ادامه داده می‌شود، تحلیلی مشخص، عملی و مرتبط با سؤال مدیر ارائه بده. پاسخ باید:
- کاملاً به فارسی و در ۳ تا ۵ پاراگراف کوتاه باشد
- مستقیماً به چالش خاص مدیر پاسخ بدهد، نه یک خلاصه‌ی کلی از منابع
- در پایان، ۲ تا ۳ اقدام عملی و مشخص پیشنهاد بدهد
- لحن حرفه‌ای، مستقیم و بدون تعارف باشد

منابع:
${contextBlock || 'در حال حاضر کتابخانه خالی است — بر اساس دانش عمومی مدیریتی پاسخ بده و این را ذکر کن.'}`;

    const geminiRes = await fetch(`${GEMINI_URL}?key=${process.env.GEMINI_API_KEY}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        system_instruction: { parts: [{ text: systemPrompt }] },
        contents: [{ role: 'user', parts: [{ text: message }] }],
        generationConfig: { maxOutputTokens: 1000 },
      }),
    });

    const data = await geminiRes.json();

    if (!geminiRes.ok) {
      const msg = (data && data.error && data.error.message) ? data.error.message : ('خطای سرویس Gemini (کد ' + geminiRes.status + ')');
      throw new Error(msg);
    }

    const textBlocks = (data.candidates && data.candidates[0] && data.candidates[0].content && data.candidates[0].content.parts)
      ? data.candidates[0].content.parts.map(p => p.text || '').join('\n')
      : '';

    res.json({
      answer: textBlocks || 'پاسخی تولید نشد.',
      sources: relevant.map(r => ({ title: r.title, category: r.category || '' })),
    });
  } catch (err) {
    console.error('خطا در /api/chat:', err);
    res.status(500).json({ error: 'خطا در ارتباط با سرویس تحلیل: ' + (err.message || 'نامشخص') });
  }
});

// ---------- مسیرهای مدیریت محتوا (پنل ساده) ----------
app.get('/api/library', (req, res) => {
  res.json(readLibrary());
});

app.post('/api/library/add', (req, res) => {
  const { password, title, category, content, keywords } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'رمز عبور اشتباه است.' });
  }
  if (!title || !content) {
    return res.status(400).json({ error: 'عنوان و متن الزامی است.' });
  }
  const library = readLibrary();
  library.push({
    id: Date.now(),
    title,
    category: category || 'عمومی',
    content,
    keywords: (keywords || '').split(',').map(k => k.trim()).filter(Boolean),
    addedAt: new Date().toISOString(),
  });
  writeLibrary(library);
  res.json({ ok: true, count: library.length });
});

app.post('/api/library/delete', (req, res) => {
  const { password, id } = req.body;
  if (password !== ADMIN_PASSWORD) {
    return res.status(401).json({ error: 'رمز عبور اشتباه است.' });
  }
  const library = readLibrary().filter(item => item.id !== id);
  writeLibrary(library);
  res.json({ ok: true, count: library.length });
});

// ---------- آپلود مستقیم فایل ورد (.docx) ----------
// فایل را به متن تبدیل می‌کند و آن را بر اساس پاراگراف‌ها
// به چند مطلب جداگانه در کتابخانه تقسیم می‌کند.
app.post('/api/library/add-docx', upload.single('file'), async (req, res) => {
  try {
    const { password, category } = req.body;
    if (password !== ADMIN_PASSWORD) {
      return res.status(401).json({ error: 'رمز عبور اشتباه است.' });
    }
    if (!req.file) {
      return res.status(400).json({ error: 'فایلی دریافت نشد.' });
    }

    const result = await mammoth.extractRawText({ buffer: req.file.buffer });
    const fullText = result.value || '';

    // تقسیم متن به پاراگراف‌های معنادار (پاراگراف‌های خیلی کوتاه نادیده گرفته می‌شوند)
    const paragraphs = fullText
      .split(/\n+/)
      .map(p => p.trim())
      .filter(p => p.length > 60);

    if (paragraphs.length === 0) {
      return res.status(400).json({ error: 'متنی در فایل پیدا نشد یا خیلی کوتاه بود.' });
    }

    const library = readLibrary();
    const baseTime = Date.now();
    paragraphs.forEach((p, idx) => {
      const title = p.split(/[\.\!\?؛،]/)[0].slice(0, 60) + (p.length > 60 ? '…' : '');
      library.push({
        id: baseTime + idx,
        title,
        category: category || 'عمومی',
        content: p,
        keywords: [],
        addedAt: new Date().toISOString(),
      });
    });
    writeLibrary(library);

    res.json({ ok: true, added: paragraphs.length, count: library.length });
  } catch (err) {
    console.error('خطا در /api/library/add-docx:', err);
    res.status(500).json({ error: 'خطا در پردازش فایل ورد: ' + (err.message || 'نامشخص') });
  }
});

app.listen(PORT, () => {
  console.log(`سرور روی پورت ${PORT} اجرا شد.`);
});
