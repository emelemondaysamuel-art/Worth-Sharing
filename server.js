const express = require('express'), multer = require('multer'), mammoth = require('mammoth');
const JSZip = require('jszip'), PDFDocument = require('pdfkit');
const fs = require('fs'), path = require('path'), os = require('os'), crypto = require('crypto');

const app = express();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 25 * 1024 * 1024 } });
const OUT = path.join(os.tmpdir(), 'ready-writer');
fs.mkdirSync(OUT, { recursive: true });
app.use(express.static(path.join(__dirname, 'public')));
app.get('/download/:id/:name', (req, res) => {
  const f = path.join(OUT, path.basename(req.params.id), path.basename(req.params.name));
  fs.existsSync(f) ? res.download(f) : res.status(404).send('Expired - please generate again.');
});
setInterval(() => { // delete jobs older than 1 hour
  for (const d of fs.readdirSync(OUT)) { const p = path.join(OUT, d); try { if (Date.now() - fs.statSync(p).mtimeMs > 36e5) fs.rmSync(p, { recursive: true }); } catch {} }
}, 6e5);

const FONTS = { serif: ['Times-Roman', 'Times-Bold', 'Times-Italic'], sans: ['Helvetica', 'Helvetica-Bold', 'Helvetica-Oblique'], mono: ['Courier', 'Courier-Bold', 'Courier-Oblique'] };
const CSSF = { serif: 'Georgia,"Times New Roman",serif', sans: 'Helvetica,Arial,sans-serif', mono: '"Courier New",monospace' };
const SIZES = { '6x9': [432, 648], '5.5x8.5': [396, 612], '5x8': [360, 576] };
const HEAD = /^(chapter\s+[\w-]+.*|part\s+[\w-]+.*|prologue|epilogue|preface|foreword|introduction|acknowledge?ments|about the author)$/i;
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const imgExt = b => (b[0] === 0x89 && b[1] === 0x50 ? 'png' : 'jpg');
const mime = e => (e === 'png' ? 'image/png' : 'image/jpeg');

// ---------- free AI (Pollinations, no key) ----------
async function ai(prompt, system) {
  try {
    const r = await fetch('https://text.pollinations.ai/', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: 'openai', messages: [{ role: 'system', content: system }, { role: 'user', content: prompt }] }),
      signal: AbortSignal.timeout(60000)
    });
    return r.ok ? (await r.text()).trim() : null;
  } catch { return null; }
}
async function aiImage(prompt, w, h) {
  try {
    const u = `https://image.pollinations.ai/prompt/${encodeURIComponent(prompt)}?width=${w}&height=${h}&nologo=true&seed=${Math.floor(Math.random() * 1e6)}`;
    const r = await fetch(u, { signal: AbortSignal.timeout(90000) });
    if (!r.ok) return null;
    const b = Buffer.from(await r.arrayBuffer());
    return b.length > 2000 ? b : null;
  } catch { return null; }
}

// ---------- manuscript parsing ----------
function parse(text, fallback) {
  text = text.replace(/\r/g, '').replace(/\u00a0/g, ' ');
  const chapters = []; let cur = null;
  for (let blk of text.split(/\n\s*\n/)) {
    blk = blk.trim(); if (!blk) continue;
    const lines = blk.split('\n'), first = lines[0].trim();
    if (first.length < 80 && HEAD.test(first)) {
      cur = { title: first, items: [] }; chapters.push(cur);
      blk = lines.slice(1).join('\n').trim(); if (!blk) continue;
    }
    if (!cur) { cur = { title: fallback, items: [] }; chapters.push(cur); }
    const m = blk.match(/^\[\[image:(\d+)\]\]$/i);
    cur.items.push(m ? { img: +m[1] - 1 } : { p: blk.replace(/\s*\n\s*/g, ' ').replace(/\s+/g, ' ') });
  }
  return chapters;
}

async function aiEdit(chapters) {
  const sys = 'You are a careful book editor. Fix spelling, grammar, punctuation and paragraph breaks only. Keep the author\'s wording, voice and meaning. Return only the edited text, paragraphs separated by blank lines, no comments.';
  for (const ch of chapters) {
    const out = []; let run = [];
    const flush = async () => {
      if (!run.length) return;
      let chunk = '', parts = [];
      const send = async () => {
        if (!chunk) return;
        const r = await ai(chunk, sys), ok = r && r.length > chunk.length * 0.7 && r.length < chunk.length * 1.4;
        (ok ? r : chunk).split(/\n\s*\n/).map(s => s.trim()).filter(Boolean).forEach(p => parts.push({ p }));
        chunk = '';
      };
      for (const it of run) { if (chunk.length + it.p.length > 4500) await send(); chunk += (chunk ? '\n\n' : '') + it.p; }
      await send(); out.push(...parts); run = [];
    };
    for (const it of ch.items) { if (it.p) run.push(it); else { await flush(); out.push(it); } }
    await flush(); ch.items = out;
  }
}

function placeImages(chapters, n) {
  const used = new Set();
  chapters.forEach(c => c.items.forEach(i => i.img !== undefined && used.add(i.img)));
  const free = []; for (let i = 0; i < n; i++) if (!used.has(i)) free.push(i);
  const step = Math.max(1, Math.floor(chapters.length / (free.length || 1)));
  free.forEach((img, k) => { const c = chapters[Math.min(k * step, chapters.length - 1)]; c.items.splice(Math.min(2, c.items.length), 0, { img }); });
}

// ---------- PDF ----------
function buildPdf(b) {
  return new Promise(resolve => {
    const [w, h] = b.size, M = { top: 60, bottom: 60, left: 54, right: 54 };
    const doc = new PDFDocument({ size: [w, h], margins: M, info: { Title: b.title, Author: b.author } });
    const chunks = []; doc.on('data', c => chunks.push(c)); doc.on('end', () => resolve(Buffer.concat(chunks)));
    const [R, B, I] = FONTS[b.font], bg = b.night ? '#121212' : '#ffffff', fg = b.night ? '#e4e4e4' : '#111111';
    const paint = () => { doc.save().rect(0, 0, w, h).fill(bg).restore(); doc.fillColor(fg); };
    paint(); doc.on('pageAdded', paint);
    const fullImage = buf => { doc.image(buf, 0, 0, { width: w, height: h }); doc.save().opacity(0.55).rect(0, 0, w, h).fill('#000').restore(); };
    const centerTitle = (t, size, y) => doc.font(B).fontSize(size).fillColor(fg).text(t, M.left, y ?? doc.y, { width: w - 108, align: 'center' });

    // cover
    if (b.cover) {
      if (b.coverOverlay) { fullImage(b.cover.buf); doc.fillColor('#fff'); doc.font(B).fontSize(30).text(b.title, M.left, h * 0.25, { width: w - 108, align: 'center' }); doc.font(R).fontSize(16).text(b.author, M.left, h * 0.8, { width: w - 108, align: 'center' }); }
      else doc.image(b.cover.buf, 0, 0, { width: w, height: h });
      doc.addPage();
    }
    // title page
    centerTitle(b.title, 28, h * 0.3); doc.moveDown(1.5).font(R).fontSize(16).text(b.author, { width: w - 108, align: 'center' });
    // copyright
    doc.addPage(); doc.font(R).fontSize(9).text(`Copyright © ${b.year} ${b.author}\nAll rights reserved.\n\n${b.date ? 'First published: ' + b.date + '\n' : ''}${b.isbn ? 'ISBN: ' + b.isbn + '\n' : ''}\nNo part of this book may be reproduced without written permission of the author.`, M.left, h * 0.6, { width: w - 108, align: 'center' });
    if (b.dedication) { doc.addPage(); doc.font(I).fontSize(13).text(b.dedication, M.left, h * 0.35, { width: w - 108, align: 'center' }); }
    // contents
    doc.addPage(); centerTitle('Contents', 20, M.top); doc.moveDown(1.5).font(R).fontSize(12);
    b.chapters.forEach(c => { if (doc.y > h - 90) doc.addPage(); doc.text(c.title, { align: 'left', lineGap: 4 }); });
    // chapters
    for (const ch of b.chapters) {
      doc.addPage(); doc.outline.addItem(ch.title);
      centerTitle(ch.title, 22, M.top + 40); doc.moveDown(2);
      let first = true;
      for (const it of ch.items) {
        if (it.p) { doc.font(R).fontSize(b.fontSize).fillColor(fg).text(it.p, M.left, doc.y, { width: w - 108, align: 'justify', indent: first ? 0 : 18, lineGap: 3 }); first = false; }
        else if (b.images[it.img]) {
          try {
            const im = doc.openImage(b.images[it.img].buf), s = Math.min((w - 108) / im.width, (h * 0.5) / im.height, 1), ih = im.height * s;
            if (doc.y + ih > h - M.bottom) doc.addPage();
            doc.image(im, (w - im.width * s) / 2, doc.y + 6, { width: im.width * s }); doc.y += ih + 18;
          } catch {}
        }
      }
    }
    // back cover
    doc.addPage();
    if (b.backImg) fullImage(b.backImg);
    doc.fillColor(b.backImg || b.night ? '#fff' : '#111');
    doc.font(B).fontSize(16).text(b.title, M.left, 70, { width: w - 108, align: 'center' });
    doc.moveDown().font(R).fontSize(11).text(b.blurb, { width: w - 108, align: 'center', lineGap: 4 });
    doc.font(I).fontSize(11).text(`— ${b.author}`, M.left, h - 120, { width: w - 108, align: 'center' });
    if (b.isbn) doc.font(R).fontSize(9).text('ISBN ' + b.isbn, M.left, h - 90, { width: w - 108, align: 'center' });
    doc.end();
  });
}

// ---------- EPUB ----------
async function buildEpub(b) {
  const z = new JSZip(), man = [], spine = [], uid = 'urn:uuid:' + crypto.randomUUID();
  z.file('mimetype', 'application/epub+zip', { compression: 'STORE' });
  z.file('META-INF/container.xml', '<?xml version="1.0"?><container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/></rootfiles></container>');
  const X = (t, body) => `<?xml version="1.0" encoding="UTF-8"?><!DOCTYPE html><html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" lang="en"><head><meta charset="utf-8"/><title>${esc(t)}</title><link rel="stylesheet" href="style.css"/></head><body>${body}</body></html>`;
  const page = (id, t, body) => { z.file(`OEBPS/${id}.xhtml`, X(t, body)); man.push(`<item id="${id}" href="${id}.xhtml" media-type="application/xhtml+xml"/>`); spine.push(`<itemref idref="${id}"/>`); };
  const dark = 'background:#121212;color:#e4e4e4';
  z.file('OEBPS/style.css', `body{font-family:${CSSF[b.font]};line-height:1.55;margin:5%;${b.night ? dark : ''}}
h1{text-align:center;margin:2em 0 1em}p{margin:0;text-indent:1.4em;text-align:justify}p.f,.c p{text-indent:0}.c{text-align:center}
.fig{text-align:center;margin:1em 0}.fig img{max-width:100%;max-height:70vh}.cover{text-align:center}.cover img{max-width:100%;max-height:95vh}
@media(prefers-color-scheme:dark){body{${dark}}}`);
  if (b.cover) {
    const e = b.cover.ext; z.file('OEBPS/images/cover.' + e, b.cover.buf);
    man.push(`<item id="cimg" href="images/cover.${e}" media-type="${mime(e)}" properties="cover-image"/>`);
    page('cover', 'Cover', `<div class="cover"><img src="images/cover.${e}" alt="Cover"/></div>`);
  }
  page('title', b.title, `<div class="c"><h1>${esc(b.title)}</h1><p>${esc(b.author)}</p></div>`);
  page('copyright', 'Copyright', `<div class="c"><p>Copyright © ${b.year} ${esc(b.author)}</p><p>All rights reserved.</p>${b.date ? `<p>First published: ${esc(b.date)}</p>` : ''}${b.isbn ? `<p>ISBN: ${esc(b.isbn)}</p>` : ''}</div>`);
  if (b.dedication) page('dedication', 'Dedication', `<div class="c"><p><i>${esc(b.dedication)}</i></p></div>`);
  b.images.forEach((im, i) => { z.file(`OEBPS/images/img${i}.${im.ext}`, im.buf); man.push(`<item id="img${i}" href="images/img${i}.${im.ext}" media-type="${mime(im.ext)}"/>`); });
  b.chapters.forEach((ch, n) => {
    let first = true;
    const body = `<h1>${esc(ch.title)}</h1>` + ch.items.map(it => it.p ? (first ? (first = false, `<p class="f">`) : '<p>') + esc(it.p) + '</p>' : (b.images[it.img] ? `<div class="fig"><img src="images/img${it.img}.${b.images[it.img].ext}" alt=""/></div>` : '')).join('');
    page('ch' + n, ch.title, body);
  });
  page('back', 'About this book', `<div class="c"><h1>${esc(b.title)}</h1>${b.blurb.split(/\n+/).map(p => `<p>${esc(p)}</p>`).join('')}<p><i>— ${esc(b.author)}</i></p>${b.isbn ? `<p>ISBN ${esc(b.isbn)}</p>` : ''}</div>`);
  if (b.backImg) { z.file('OEBPS/images/back.jpg', b.backImg); man.push('<item id="bimg" href="images/back.jpg" media-type="image/jpeg"/>'); }
  z.file('OEBPS/nav.xhtml', X('Contents', `<nav epub:type="toc"><h1>Contents</h1><ol>${b.chapters.map((c, n) => `<li><a href="ch${n}.xhtml">${esc(c.title)}</a></li>`).join('')}</ol></nav>`));
  man.push('<item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>'); spine.splice(b.cover ? 2 : 1, 0, '<itemref idref="nav"/>');
  const dt = /^\d{4}(-\d\d(-\d\d)?)?$/.test(b.date) ? `<dc:date>${b.date}</dc:date>` : '';
  z.file('OEBPS/content.opf', `<?xml version="1.0" encoding="UTF-8"?><package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="uid">${b.isbn ? 'urn:isbn:' + esc(b.isbn.replace(/[^0-9Xx]/g, '')) : uid}</dc:identifier><dc:title>${esc(b.title)}</dc:title><dc:creator>${esc(b.author)}</dc:creator><dc:language>en</dc:language>${dt}<meta property="dcterms:modified">${new Date().toISOString().replace(/\.\d+/, '')}</meta></metadata><manifest>${man.join('')}</manifest><spine>${spine.join('')}</spine></package>`);
  return z.generateAsync({ type: 'nodebuffer', mimeType: 'application/epub+zip', compression: 'DEFLATE' });
}

// ---------- API ----------
app.post('/api/generate', upload.fields([{ name: 'manuscripts', maxCount: 50 }, { name: 'images', maxCount: 40 }, { name: 'cover', maxCount: 1 }]), async (req, res) => {
  try {
    const f = req.files || {}, q = req.body, notes = [];
    if (!f.manuscripts?.length) return res.status(400).json({ error: 'Upload at least one .txt or .docx file.' });
    let chapters = [];
    for (const m of f.manuscripts) {
      const e = path.extname(m.originalname).toLowerCase(); let text;
      if (e === '.docx') text = (await mammoth.extractRawText({ buffer: m.buffer })).value;
      else if (e === '.txt' || e === '.md') text = m.buffer.toString('utf8');
      else { notes.push(`Skipped ${m.originalname} (only .txt and .docx supported).`); continue; }
      chapters.push(...parse(text, path.basename(m.originalname, e).replace(/[_-]+/g, ' ')));
    }
    if (!chapters.length) return res.status(400).json({ error: 'No readable text found.' });
    const images = (f.images || []).filter(i => /^image\/(jpeg|png)$/.test(i.mimetype)).map(i => ({ buf: i.buffer, ext: imgExt(i.buffer) }));
    if ((f.images || []).length > images.length) notes.push('Only JPG and PNG pictures are supported; others were skipped.');
    if (images.length && q.autoPlace !== 'off') placeImages(chapters, images.length);
    if (q.aiEdit === 'on') { await aiEdit(chapters); }

    const title = (q.title || 'Untitled').trim(), author = (q.author || 'Anonymous').trim();
    const sample = chapters.flatMap(c => c.items.filter(i => i.p).map(i => i.p)).join('\n').slice(0, 3000);
    let blurb = (q.blurb || '').trim();
    if (!blurb) blurb = await ai(`Book title: ${title}\nAuthor: ${author}\nGenre: ${q.genre || 'unspecified'}\nExcerpt:\n${sample}`, 'You write compelling back-cover blurbs for books. Write 90-130 words: a hook, the stakes, and a closing line. No spoilers, no markdown, plain paragraphs only.');
    if (!blurb) { blurb = sample.slice(0, 350) + '…'; notes.push('AI blurb unavailable; used an excerpt instead.'); }

    let cover = null, coverOverlay = false, backImg = null;
    if (f.cover?.[0]) cover = { buf: f.cover[0].buffer, ext: imgExt(f.cover[0].buffer) };
    const style = q.coverStyle || q.genre || title;
    if (q.aiCover === 'on') {
      const [c, bk] = await Promise.all([cover ? null : aiImage(`book cover artwork for "${title}", ${style}, dramatic, professional, no text, no letters`, 768, 1152), aiImage(`abstract moody textured background, ${style}, subtle, no text, no letters`, 768, 1152)]);
      if (c) { cover = { buf: c, ext: 'jpg' }; coverOverlay = true; } else if (!cover) notes.push('AI cover image unavailable.');
      backImg = bk; if (!bk) notes.push('AI back-cover image unavailable; plain back cover used.');
    }
    const b = {
      title, author, blurb, cover, coverOverlay, backImg, images, chapters,
      date: (q.date || '').trim(), isbn: (q.isbn || '').trim(), dedication: (q.dedication || '').trim(),
      year: ((q.date || '').match(/\d{4}/) || [new Date().getFullYear()])[0],
      font: FONTS[q.font] ? q.font : 'serif', fontSize: Math.min(16, Math.max(9, +q.fontSize || 11.5)),
      night: q.theme === 'night', size: SIZES[q.trim] || SIZES['6x9']
    };
    const id = crypto.randomBytes(8).toString('hex'), dir = path.join(OUT, id); fs.mkdirSync(dir);
    const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'book';
    const files = [];
    const save = (name, label, buf) => { fs.writeFileSync(path.join(dir, name), buf); files.push({ label, url: `/download/${id}/${name}` }); };
    save(slug + '.pdf', 'PDF (KDP print / Kindle)', await buildPdf(b));
    save(slug + '.epub', 'EPUB (Kindle / all e-readers)', await buildEpub(b));
    if (cover) save(slug + '-front-cover.' + cover.ext, 'Front cover image', cover.buf);
    if (backImg) save(slug + '-back-cover.jpg', 'Back cover image', backImg);
    res.json({ files, blurb, notes, chapters: chapters.length });
  } catch (e) { console.error(e); res.status(500).json({ error: 'Generation failed: ' + e.message }); }
});

app.listen(process.env.PORT || 3000, () => console.log('Ready-Writer running'));
