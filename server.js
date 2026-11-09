require('dotenv').config();
const express = require('express');
const helmet = require('helmet');
const rateLimit = require('express-rate-limit');
const multer = require('multer');
const mammoth = require('mammoth');
const pdfParse = require('pdf-parse');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const PORT = Number(process.env.PORT || 3000);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'references.json');
fs.mkdirSync(DATA_DIR, { recursive: true });
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(helmet({ contentSecurityPolicy: false }));
app.use(express.json({ limit: '2mb' }));
app.use('/api/', rateLimit({ windowMs: 60_000, limit: 40, standardHeaders: 'draft-7', legacyHeaders: false }));
app.use(express.static(path.join(__dirname, 'public')));

const scanLimiter = rateLimit({ windowMs: 10 * 60_000, limit: 5, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'تجاوزت عدد الفحوصات المسموح بها مؤقتاً. حاول بعد عدة دقائق.' } });
const aiLimiter = rateLimit({ windowMs: 60 * 60_000, limit: 3, standardHeaders: 'draft-7', legacyHeaders: false, message: { error: 'تم بلوغ الحد المؤقت لتحليلات الذكاء الاصطناعي. حاول لاحقاً.' } });
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 20 * 1024 * 1024, files: 1 }, fileFilter: (_req, file, cb) => {
  const ext = path.extname(file.originalname).toLowerCase();
  cb(ext === '.txt' || ext === '.docx' || ext === '.pdf' ? null : new Error('الملفات المدعومة TXT وDOCX وPDF فقط.'), ext === '.txt' || ext === '.docx' || ext === '.pdf');
} });
function loadDb() { try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); } catch { return []; } }
function saveDb(items) { fs.writeFileSync(DB_FILE, JSON.stringify(items, null, 2), 'utf8'); }
function normalize(text) {
  return String(text || '').toLocaleLowerCase('ar').normalize('NFKC')
    .replace(/[ًٌٍَُِّْـ]/g, '').replace(/[إأآٱ]/g, 'ا').replace(/ى/g, 'ي').replace(/ؤ/g, 'و').replace(/ئ/g, 'ي')
    .replace(/[^\p{L}\p{N}\s]/gu, ' ').replace(/\s+/g, ' ').trim();
}
function words(text) { return normalize(text).split(' ').filter(Boolean); }
function ngramMap(tokens, n) {
  const map = new Map();
  for (let i = 0; i <= tokens.length - n; i++) { const gram = tokens.slice(i, i + n).join(' '); if (!map.has(gram)) map.set(gram, []); map.get(gram).push(i); }
  return map;
}
async function extractText(file) {
  const ext = path.extname(file.originalname).toLowerCase();
  if (ext === '.txt') return file.buffer.toString('utf8').replace(/^\uFEFF/, '');
  if (ext === '.docx') return (await mammoth.extractRawText({ buffer: file.buffer })).value || '';
  if (ext === '.pdf') return (await pdfParse(file.buffer)).text || '';
  throw new Error('صيغة الملف غير مدعومة.');
}
function requireAdmin(req, res, next) {
  const secret = process.env.ADMIN_TOKEN;
  if (!secret || secret.length < 24) return res.status(503).json({ error: 'إدارة قاعدة المصادر غير مهيأة بعد.' });
  if (req.get('x-admin-token') !== secret) return res.status(401).json({ error: 'رمز إدارة المصادر غير صحيح.' });
  next();
}
app.get('/api/health', (_req, res) => res.json({ ok: true, service: 'Sanad Academic Personal', version: '5.0.0', corpusCount: loadDb().length }));
app.get('/api/references', (_req, res) => {
  const refs = loadDb().map(({ id, name, words: count, createdAt }) => ({ id, name, words: count, createdAt }));
  res.json({ count: refs.length, references: refs });
});
app.post('/api/references', requireAdmin, upload.single('file'), async (req, res, next) => {
  try {
    if (!req.file) return res.status(400).json({ error: 'اختر ملفاً لإضافته إلى قاعدة المصادر.' });
    const text = await extractText(req.file); const tokens = words(text);
    if (tokens.length < 10) return res.status(422).json({ error: 'المستند لا يحتوي على 10 كلمات قابلة للاستخراج على الأقل.' });
    const refs = loadDb(); const item = { id: crypto.randomUUID(), name: path.basename(req.file.originalname).slice(0,180), text, words: tokens.length, createdAt: new Date().toISOString() };
    refs.push(item); saveDb(refs);
    res.status(201).json({ message: 'تمت إضافة المصدر إلى قاعدة المقارنة.', reference: { id: item.id, name: item.name, words: item.words, createdAt: item.createdAt } });
  } catch (e) { next(e); }
});
app.delete('/api/references/:id', requireAdmin, (req, res) => {
  const refs = loadDb(); const next = refs.filter(x => x.id !== req.params.id);
  if (next.length === refs.length) return res.status(404).json({ error: 'المصدر غير موجود.' });
  saveDb(next); res.json({ message: 'تم حذف المصدر.' });
});
app.post('/api/scan', scanLimiter, async (req, res, next) => {
  try {
    const { text, ngram = 6, excludeQuotes = true, excludeBibliography = true } = req.body || {};
    if (typeof text !== 'string' || text.trim().length < 40) return res.status(400).json({ error: 'أدخل نصاً لا يقل عن 40 حرفاً.' });
    if (text.length > 500000) return res.status(413).json({ error: 'الحد الأقصى للنص 500 ألف حرف.' });
    const n = Math.max(3, Math.min(15, Number(ngram) || 6)); let candidate = text;
    if (excludeQuotes) candidate = candidate.replace(/"[^\"]*"|“[^”]*”|«[^»]*»/g, ' ');
    if (excludeBibliography) { const match = /^\s*(?:قائمة المراجع|المراجع|المصادر|references|bibliography)\s*[:：]?\s*$/im.exec(candidate); if (match) candidate = candidate.slice(0, match.index); }
    const target = words(candidate); if (target.length < n) return res.status(400).json({ error: `النص أقصر من ${n} كلمات.` });
    const targetNgrams = ngramMap(target, n); const references = loadDb(); const matchedPositions = new Set(); const results = [];
    for (const ref of references) {
      const sourceTokens = words(ref.text); const sourceGrams = ngramMap(sourceTokens, n); const positions = new Set(); const snippets = [];
      for (const [gram, targetPositions] of targetNgrams) if (sourceGrams.has(gram)) for (const pos of targetPositions) {
        for (let k = 0; k < n; k++) { positions.add(pos + k); matchedPositions.add(pos + k); }
        if (snippets.length < 5) snippets.push({ excerpt: target.slice(pos, pos + n).join(' '), targetWord: pos + 1 });
      }
      if (positions.size) results.push({ id: ref.id, name: ref.name, matchedWords: positions.size, similarity: Math.round(positions.size / target.length * 1000) / 10, snippets });
    }
    results.sort((a,b) => b.similarity - a.similarity); const matched = matchedPositions.size; const similarity = Math.round(matched / target.length * 1000) / 10;
    res.json({ id: crypto.randomUUID(), status: 'completed', method: 'local-reference-corpus-ngram', ngram: n, totalWords: target.length, matchedWords: matched, similarity, sourceCount: results.length, corpusCount: references.length, sources: results,
      disclaimer: references.length ? 'مقارنة فعلية مع مستندات قاعدة سَنَد فقط؛ لا تشمل كامل الإنترنت أو قواعد Turnitin.' : 'قاعدة المصادر فارغة؛ لم يتم اختلاق نسبة تشابه.' });
  } catch (e) { next(e); }
});
app.post('/api/ai-detection', aiLimiter, async (req, res, next) => {
  try {
    const text = String(req.body?.text || ''); if (text.trim().length < 500) return res.status(400).json({ error: 'لتحليل أكثر استقراراً، أدخل 500 حرف على الأقل.' });
    if (text.length > 150000) return res.status(413).json({ error: 'الحد الأقصى 150 ألف حرف.' });
    if (!process.env.AI_DETECTOR_URL) return res.status(503).json({ error: 'محرك كشف الذكاء الاصطناعي غير مربوط بعد. لن نعرض نسبة تخمينية أو مضللة.' });
    const response = await fetch(process.env.AI_DETECTOR_URL, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(process.env.AI_DETECTOR_API_KEY ? { Authorization: 'Bearer ' + process.env.AI_DETECTOR_API_KEY } : {}) }, body: JSON.stringify({ text, language: 'ar', task: 'ai_generated_text_detection' }), signal: AbortSignal.timeout(60000) });
    const d = await response.json(); if (!response.ok) throw new Error('خدمة تحليل الذكاء الاصطناعي غير متاحة حالياً.');
    const probability = Number(d.ai_probability); if (!Number.isFinite(probability) || probability < 0 || probability > 1) throw new Error('استجابة محرك الكشف غير مطابقة للمواصفات.');
    res.json({ status: 'completed', aiLikelihood: Math.round(probability * 1000) / 10, model: String(d.model || 'Arabic AI detector').slice(0,120), wordCount: words(text).length, warning: 'هذه احتمالية تصنيف للنص وليست قياساً مؤكداً لنسبة الكلمات التي كتبها الذكاء الاصطناعي. قد يخطئ الكاشف، ولا تستخدم النتيجة وحدها لإدانة الباحث.' });
  } catch (e) { next(e); }
});
app.get('/api/discover', async (req, res) => {
  const q = String(req.query.q || '').trim().slice(0,300); if (q.length < 12) return res.status(400).json({ error: 'أدخل عبارة بحث أطول.' });
  try {
    const url = new URL('https://api.openalex.org/works'); url.searchParams.set('search', q); url.searchParams.set('per-page', '5');
    if (process.env.OPENALEX_MAILTO) url.searchParams.set('mailto', process.env.OPENALEX_MAILTO);
    const response = await fetch(url, { headers: { 'User-Agent': 'SanadAcademic/5.0' }, signal: AbortSignal.timeout(12000) }); if (!response.ok) throw new Error('OpenAlex unavailable');
    const data = await response.json(); res.json({ results: (data.results || []).map(w => ({ title: w.title, year: w.publication_year, doi: w.doi, url: w.primary_location?.landing_page_url || w.doi, authors: (w.authorships || []).slice(0,3).map(a => a.author?.display_name).filter(Boolean) })) });
  } catch { res.status(502).json({ error: 'تعذر الوصول إلى فهرس OpenAlex حالياً.' }); }
});
app.use((err, _req, res, _next) => {
  console.error(err);
  if (err instanceof multer.MulterError) return res.status(400).json({ error: err.code === 'LIMIT_FILE_SIZE' ? 'الحد الأقصى لحجم الملف 20 ميغابايت.' : 'تعذر رفع الملف.' });
  res.status(400).json({ error: err.message || 'حدث خطأ غير متوقع.' });
});
app.listen(PORT, '0.0.0.0', () => console.log(`Sanad Academic Personal running on port ${PORT}`));
