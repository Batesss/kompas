// Поисковик работ — сервер без внешних библиотек (Node 20+)
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ENV = process.env;
const PORT = Number(ENV.PORT || 3000);
const DATA_DIR = ENV.DATA_DIR || path.join(__dirname, 'data');
const PRICE_CZK = Number(ENV.PRICE_CZK || 149);
const MODEL = ENV.MODEL || 'claude-sonnet-5-5';
const FREE_MODE = ENV.FREE_MODE === '1';     // без оплаты — только для проверки
const MOCK_SEARCH = ENV.MOCK_SEARCH === '1'; // поддельный поиск — только для проверки
const MAX_ATTEMPTS = 5;

fs.mkdirSync(path.join(DATA_DIR, 'orders'), { recursive: true });
const INDEX_PATH = [path.join(__dirname, 'public', 'index.html'), path.join(__dirname, 'index.html')].find((f) => fs.existsSync(f));
const INDEX_HTML = fs.readFileSync(INDEX_PATH);

// ---------- хранение заказов ----------
const orderFile = (id) => path.join(DATA_DIR, 'orders', id + '.json');
const validId = (id) => /^[A-Za-z0-9_-]{16,40}$/.test(id || '');
function loadOrder(id) {
  if (!validId(id)) return null;
  try { return JSON.parse(fs.readFileSync(orderFile(id), 'utf8')); } catch { return null; }
}
function saveOrder(o) {
  o.updatedAt = new Date().toISOString();
  const tmp = orderFile(o.id) + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(o, null, 2));
  fs.renameSync(tmp, orderFile(o.id));
}

// ---------- помощники ----------
function send(res, code, body, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Cache-Control': 'no-store' });
  res.end(typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body));
}
function readBody(req, limit = 30000) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', (c) => { size += c.length; if (size > limit) { reject(new Error('too big')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}
function baseUrl(req) {
  if (ENV.PUBLIC_URL) return ENV.PUBLIC_URL.replace(/\/$/, '');
  const proto = (req.headers['x-forwarded-proto'] || 'http').split(',')[0];
  return `${proto}://${req.headers.host}`;
}
const clip = (v, n) => String(v ?? '').trim().slice(0, n);
const log = (...a) => console.log(new Date().toISOString(), ...a);

// простое ограничение: не больше 20 заказов в час с одного адреса
const hits = new Map();
function limited(req) {
  const ip = (req.headers['x-forwarded-for'] || req.socket.remoteAddress || '').split(',')[0].trim();
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 3600e3);
  arr.push(now); hits.set(ip, arr);
  return arr.length > 20;
}

// ---------- Stripe (через REST) ----------
async function stripe(method, p, params) {
  const r = await fetch('https://api.stripe.com/v1' + p, {
    method,
    headers: { Authorization: 'Bearer ' + ENV.STRIPE_SECRET_KEY, 'Content-Type': 'application/x-www-form-urlencoded' },
    body: params ? new URLSearchParams(params).toString() : undefined,
  });
  const j = await r.json();
  if (!r.ok) throw new Error('Stripe: ' + (j.error && j.error.message || r.status));
  return j;
}
function verifyStripeSignature(raw, header, secret) {
  if (!header || !secret) return false;
  const parts = Object.fromEntries(header.split(',').map((kv) => { const i = kv.indexOf('='); return [kv.slice(0, i), kv.slice(i + 1)]; }));
  const sigs = header.split(',').filter((kv) => kv.startsWith('v1=')).map((kv) => kv.slice(3));
  const t = Number(parts.t);
  if (!t || Math.abs(Date.now() / 1000 - t) > 300) return false;
  const expected = crypto.createHmac('sha256', secret).update(`${t}.${raw}`).digest('hex');
  return sigs.some((s) => s.length === expected.length && crypto.timingSafeEqual(Buffer.from(s), Buffer.from(expected)));
}
async function checkPaid(o) {
  if (o.status !== 'awaiting_payment' || !o.stripeSessionId || !ENV.STRIPE_SECRET_KEY) return;
  try {
    const s = await stripe('GET', '/checkout/sessions/' + encodeURIComponent(o.stripeSessionId));
    if (s.payment_status === 'paid') markPaid(o.id);
  } catch (e) { log('checkPaid', o.id, e.message); }
}
function markPaid(id) {
  const o = loadOrder(id);
  if (!o || o.status !== 'awaiting_payment') return;
  o.status = 'paid'; o.paidAt = new Date().toISOString();
  saveOrder(o); log('paid', id);
  runSearch(id);
}

// ---------- поиск через Claude ----------
const DOCS = {
  protection: 'тимчасовий захист (dočasná ochrana)',
  visa: 'віза або дозвіл на проживання (ВНЖ)',
  eu: 'паспорт країни ЄС',
  biometric: 'тільки біометричний паспорт (безвіз)',
  other: 'інше (див. побажання)',
};
const WHO = { man: 'чоловік', woman: 'жінка', couple: 'пара (чоловік і жінка разом)' };
const HOUSING = { yes: 'потрібне житло від роботодавця', no: 'житло не потрібне' };
const CZECH = { none: 'чеської не знає', basic: 'базова чеська', good: 'добра чеська' };

function buildPrompt(o) {
  const f = o.form;
  const lang = o.lang === 'ru' ? 'русском' : 'украинском';
  const today = new Date().toISOString().slice(0, 10);
  return `Сегодня ${today}. Ты помогаешь человеку из Украины найти работу в Чехии и не нарваться на обман.

ЗАПРОС КЛИЕНТА
- Где: ${f.place}
- Какая работа: ${f.job}
- Документы: ${DOCS[f.docs] || f.docs}
- Кто ищет: ${WHO[f.who] || f.who}
- Жильё: ${HOUSING[f.housing] || f.housing}
- Чешский язык: ${CZECH[f.czech] || f.czech}
- Пожелания: ${f.notes || 'нет'}

ЗАДАЧА
1. Найди в интернете актуальные вакансии под этот запрос, опубликованные или обновлённые не раньше чем 14 дней назад. Ищи на чешских сайтах (jobs.cz, prace.cz, profesia.cz, uradprace.cz, careerjet.cz, sites агентур) и на украиноязычных/русскоязычных сайтах о работе в Чехии. Учитывай документы клиента: например, с тимчасовим захистом можно работать без отдельного разрешения.
2. По каждой фирме или агентуре: проверь, есть ли у неё разрешение на посредничество (povolení ke zprostředkování zaměstnání) в официальном списке агентур práce МПСВ / Úřad práce. Можно искать по названию и IČO (ARES). Если это прямой работодатель, а не агентура, — так и напиши.
3. Найди 2–3 отзыва о фирме/агентуре (Google Maps, atmoskop.cz, firmy.cz, форумы, группы). Перескажи их коротко своими словами.
4. Дай итог: "ok" — выглядит надёжно; "caution" — есть сомнения; "bad" — признаки обмана (нет лицензии, просят деньги за трудоустройство, много жалоб).

ПРАВИЛА
- Только реальные вакансии с реальными ссылками, которые ты нашёл. Ничего не выдумывай. Нет данных — пиши "невідомо"/"неизвестно".
- Лучше 3 проверенные вакансии, чем 10 сомнительных. Максимум 10.
- Сначала самые подходящие и надёжные.
- Все тексты пиши на ${lang} языке.

ОТВЕТ — только JSON, без пояснений вокруг:
{
  "summary": "2-3 предложения: что нашлось и общий совет",
  "vacancies": [
    {
      "title": "должность",
      "company": "фирма или агентура",
      "is_agency": true,
      "city": "город",
      "salary": "зарплата как в объявлении",
      "housing": "есть ли жильё и цена",
      "documents": "какие документы нужны и подходит ли клиенту",
      "posted": "дата публикации, если видна",
      "link": "https://...",
      "contact": "телефон / email / имя, если есть в объявлении",
      "license": "yes | no | unknown | not_needed",
      "license_note": "коротко: где проверял, номер разрешения если нашёл",
      "reviews": [ { "text": "коротко", "source": "откуда", "link": "https://..." } ],
      "verdict": "ok | caution | bad",
      "verdict_note": "почему"
    }
  ]
}`;
}

async function callClaude(prompt) {
  if (!ENV.ANTHROPIC_API_KEY) throw new Error('Нет ANTHROPIC_API_KEY');
  const messages = [{ role: 'user', content: prompt }];
  for (let turn = 0; turn < 6; turn++) {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': ENV.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 12000,
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: Number(ENV.MAX_SEARCHES || 15) }],
        messages,
      }),
      signal: AbortSignal.timeout(6 * 60e3),
    });
    const j = await r.json();
    if (!r.ok) throw new Error('Claude: ' + (j.error && j.error.message || r.status));
    if (j.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: j.content }); continue; }
    const text = j.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
    return text;
  }
  throw new Error('Claude: слишком долгий поиск');
}

function parseResult(text) {
  const a = text.indexOf('{'), b = text.lastIndexOf('}');
  if (a < 0 || b <= a) throw new Error('Ответ без JSON');
  const j = JSON.parse(text.slice(a, b + 1));
  const s = (v, n = 600) => clip(v, n);
  const url = (v) => { const u = s(v, 1000); return /^https?:\/\//i.test(u) ? u : ''; };
  const pick = (v, list, d) => (list.includes(v) ? v : d);
  return {
    summary: s(j.summary, 1500),
    vacancies: (Array.isArray(j.vacancies) ? j.vacancies : []).slice(0, 10).map((v) => ({
      title: s(v.title, 200), company: s(v.company, 200), is_agency: !!v.is_agency, city: s(v.city, 200),
      salary: s(v.salary, 300), housing: s(v.housing, 300), documents: s(v.documents), posted: s(v.posted, 100),
      link: url(v.link), contact: s(v.contact, 300),
      license: pick(v.license, ['yes', 'no', 'unknown', 'not_needed'], 'unknown'), license_note: s(v.license_note),
      reviews: (Array.isArray(v.reviews) ? v.reviews : []).slice(0, 4).map((r) => ({ text: s(r.text), source: s(r.source, 200), link: url(r.link) })),
      verdict: pick(v.verdict, ['ok', 'caution', 'bad'], 'caution'), verdict_note: s(v.verdict_note),
    })),
  };
}

function mockResult(o) {
  const ua = o.lang !== 'ru';
  return {
    summary: ua ? 'ТЕСТ: знайдено 2 вакансії. Це тестові дані, не справжні.' : 'ТЕСТ: найдено 2 вакансии. Это тестовые данные, не настоящие.',
    vacancies: [
      { title: ua ? 'Комплектувальник на складі' : 'Комплектовщик на складе', company: 'Test Agentura s.r.o.', is_agency: true, city: 'Praha 9',
        salary: '170 Kč/год', housing: ua ? 'Так, 4000 Kč/міс' : 'Да, 4000 Kč/мес', documents: ua ? 'Тимчасовий захист — підходить' : 'Временная защита — подходит',
        posted: '2026-11-08', link: 'https://example.com/vacancy/1', contact: '+420 000 000 000', license: 'yes', license_note: 'MPSV, č. 00000/00',
        reviews: [{ text: ua ? 'Зарплату платять вчасно.' : 'Зарплату платят вовремя.', source: 'Google Maps', link: 'https://example.com/r1' }],
        verdict: 'ok', verdict_note: ua ? 'Ліцензія є, відгуки добрі.' : 'Лицензия есть, отзывы хорошие.' },
      { title: ua ? 'Різноробочий на будові' : 'Разнорабочий на стройке', company: 'Neznámá firma', is_agency: true, city: 'Kladno',
        salary: '200 Kč/год', housing: ua ? 'Невідомо' : 'Неизвестно', documents: ua ? 'Невідомо' : 'Неизвестно', posted: '2026-11-05',
        link: 'https://example.com/vacancy/2', contact: '', license: 'no', license_note: ua ? 'Немає в реєстрі' : 'Нет в реестре',
        reviews: [], verdict: 'bad', verdict_note: ua ? 'Немає ліцензії, просять оплату наперед.' : 'Нет лицензии, просят оплату вперёд.' },
    ],
  };
}

const running = new Set();
async function runSearch(id) {
  if (running.has(id)) return;
  running.add(id);
  let o = loadOrder(id);
  try {
    if (!o || !['paid', 'error'].includes(o.status)) return;
    o.status = 'searching'; o.attempts = (o.attempts || 0) + 1; o.error = null; saveOrder(o);
    log('search start', id, 'attempt', o.attempts);
    let result;
    if (MOCK_SEARCH) { await new Promise((r) => setTimeout(r, 3000)); result = mockResult(o); }
    else {
      let lastErr;
      for (let i = 0; i < 2 && !result; i++) {
        try { result = parseResult(await callClaude(buildPrompt(o))); } catch (e) { lastErr = e; log('search fail', id, e.message); }
      }
      if (!result) throw lastErr;
    }
    o = loadOrder(id); o.status = 'done'; o.result = result; o.doneAt = new Date().toISOString(); saveOrder(o);
    log('search done', id, result.vacancies.length);
    sendEmail(o).catch((e) => log('email fail', id, e.message));
  } catch (e) {
    o = loadOrder(id) || o; o.status = 'error'; o.error = String(e.message || e).slice(0, 300); saveOrder(o);
  } finally { running.delete(id); }
}

// ---------- email (Resend) ----------
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
async function sendEmail(o) {
  if (!ENV.RESEND_API_KEY || !ENV.EMAIL_FROM || !o.email || o.emailSent) return;
  const ua = o.lang !== 'ru';
  const link = `${o.baseUrl}/r/${o.id}`;
  const V = { ok: '✅', caution: '⚠️', bad: '⛔' };
  const items = o.result.vacancies.map((v) => `<li style="margin-bottom:14px"><b>${V[v.verdict]} ${esc(v.title)}</b> — ${esc(v.company)}, ${esc(v.city)}<br>${esc(v.salary)}<br>${v.link ? `<a href="${esc(v.link)}">${esc(v.link)}</a>` : ''}</li>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px">
<h2>${ua ? 'Ваша добірка вакансій' : 'Ваша подборка вакансий'}</h2>
<p>${esc(o.result.summary)}</p><ol>${items}</ol>
<p><a href="${esc(link)}" style="background:#1d4ed8;color:#fff;padding:12px 18px;border-radius:8px;text-decoration:none;display:inline-block">${ua ? 'Відкрити повну добірку з перевіркою агентур' : 'Открыть полную подборку с проверкой агентур'}</a></p></div>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + ENV.RESEND_API_KEY, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: ENV.EMAIL_FROM, to: [o.email], subject: ua ? 'Компас: ваша добірка вакансій у Чехії' : 'Компас: ваша подборка вакансий в Чехии', html }),
  });
  if (!r.ok) throw new Error('Resend ' + r.status + ' ' + (await r.text()).slice(0, 200));
  const fresh = loadOrder(o.id); fresh.emailSent = true; saveOrder(fresh); log('email sent', o.id);
}

// ---------- маршруты ----------
const publicView = (o) => ({ id: o.id, lang: o.lang, form: o.form, status: o.status, result: o.result || null, attempts: o.attempts || 0, canRetry: o.status === 'error' && (o.attempts || 0) < MAX_ATTEMPTS, createdAt: o.createdAt });

async function handle(req, res) {
  const u = new URL(req.url, 'http://x');
  const p = u.pathname;

  if (req.method === 'GET' && (p === '/' || p.startsWith('/r/'))) return send(res, 200, INDEX_HTML, 'text/html; charset=utf-8');
  if (req.method === 'GET' && p === '/health') return send(res, 200, { ok: true });
  if (req.method === 'GET' && p === '/api/config') return send(res, 200, { price: PRICE_CZK, currency: 'Kč', free: FREE_MODE });

  if (req.method === 'POST' && p === '/api/order') {
    if (limited(req)) return send(res, 429, { error: 'too_many' });
    let b; try { b = JSON.parse((await readBody(req)).toString()); } catch { return send(res, 400, { error: 'bad_json' }); }
    const form = {
      place: clip(b.place, 200), job: clip(b.job, 1000), docs: clip(b.docs, 30), who: clip(b.who, 30),
      housing: clip(b.housing, 10), czech: clip(b.czech, 10), notes: clip(b.notes, 1000),
    };
    const email = clip(b.email, 200);
    if (!form.place || !form.job || !DOCS[form.docs] || !WHO[form.who] || !HOUSING[form.housing] || !CZECH[form.czech]) return send(res, 400, { error: 'fields' });
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return send(res, 400, { error: 'email' });
    const o = { id: crypto.randomBytes(16).toString('base64url'), lang: b.lang === 'ru' ? 'ru' : 'uk', form, email,
      status: 'awaiting_payment', createdAt: new Date().toISOString(), baseUrl: baseUrl(req) };
    if (FREE_MODE) { saveOrder(o); markPaid(o.id); return send(res, 200, { url: `/r/${o.id}` }); }
    if (!ENV.STRIPE_SECRET_KEY) return send(res, 500, { error: 'no_payments' });
    try {
      const s = await stripe('POST', '/checkout/sessions', {
        mode: 'payment',
        'line_items[0][price_data][currency]': 'czk',
        'line_items[0][price_data][unit_amount]': String(Math.round(PRICE_CZK * 100)),
        'line_items[0][price_data][product_data][name]': o.lang === 'ru' ? 'Подборка проверенных вакансий' : 'Добірка перевірених вакансій',
        'line_items[0][quantity]': '1',
        customer_email: email,
        client_reference_id: o.id,
        'metadata[order_id]': o.id,
        success_url: `${o.baseUrl}/r/${o.id}`,
        cancel_url: `${o.baseUrl}/`,
        locale: 'auto',
      });
      o.stripeSessionId = s.id; saveOrder(o);
      return send(res, 200, { url: s.url });
    } catch (e) { log('stripe create', e.message); return send(res, 502, { error: 'payment' }); }
  }

  if (req.method === 'POST' && p === '/webhook/stripe') {
    const raw = (await readBody(req, 1e6)).toString();
    if (!verifyStripeSignature(raw, req.headers['stripe-signature'], ENV.STRIPE_WEBHOOK_SECRET)) return send(res, 400, { error: 'signature' });
    const ev = JSON.parse(raw);
    if (ev.type === 'checkout.session.completed' || ev.type === 'checkout.session.async_payment_succeeded') {
      const s = ev.data.object; const id = s.metadata && s.metadata.order_id;
      if (id && s.payment_status === 'paid') markPaid(id);
    }
    return send(res, 200, { received: true });
  }

  let m;
  if (req.method === 'GET' && (m = p.match(/^\/api\/order\/([A-Za-z0-9_-]+)$/))) {
    const o = loadOrder(m[1]); if (!o) return send(res, 404, { error: 'not_found' });
    if (o.status === 'awaiting_payment') { await checkPaid(o); }
    return send(res, 200, publicView(loadOrder(m[1])));
  }
  if (req.method === 'POST' && (m = p.match(/^\/api\/order\/([A-Za-z0-9_-]+)\/retry$/))) {
    const o = loadOrder(m[1]); if (!o) return send(res, 404, { error: 'not_found' });
    if (o.status !== 'error' || (o.attempts || 0) >= MAX_ATTEMPTS) return send(res, 400, { error: 'cannot_retry' });
    runSearch(o.id);
    return send(res, 200, { ok: true });
  }
  send(res, 404, { error: 'not_found' });
}

http.createServer((req, res) => handle(req, res).catch((e) => { log('err', e.message); if (!res.headersSent) send(res, 500, { error: 'server' }); }))
  .listen(PORT, () => {
    log(`Сайт работает на порту ${PORT}${FREE_MODE ? ' [БЕЗ ОПЛАТЫ]' : ''}${MOCK_SEARCH ? ' [ТЕСТОВЫЙ ПОИСК]' : ''}`);
    // если сервер перезапустился во время поиска — продолжить оплаченные заказы
    for (const f of fs.readdirSync(path.join(DATA_DIR, 'orders'))) {
      if (!f.endsWith('.json')) continue;
      const o = loadOrder(f.slice(0, -5));
      if (o && (o.status === 'searching' || o.status === 'paid')) { o.status = 'paid'; saveOrder(o); runSearch(o.id); }
    }
  });
