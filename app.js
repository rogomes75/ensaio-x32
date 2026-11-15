'use strict';
/* Ensaio X32: abre uma cena (.scn) da Behringer X32 / Midas M32, permite editar,
   medir o espectro pelo microfone e salvar uma revisão da cena. Nada sai do aparelho. */

// ---------- Tempo (sempre America/Los_Angeles para exibir; guardado em UTC) ----------
const TZ = 'America/Los_Angeles';
const formatLA = (d, opts = {}) => new Intl.DateTimeFormat('pt-BR', { timeZone: TZ, ...opts }).format(new Date(d));
const stampLA = d => formatLA(d, { day: '2-digit', month: '2-digit', year: 'numeric', hour: '2-digit', minute: '2-digit' });

const $ = id => document.getElementById(id);
const el = (tag, attrs = {}, ...kids) => {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (k === 'class') e.className = v; else if (k === 'text') e.textContent = v;
    else if (k.startsWith('on')) e.addEventListener(k.slice(2), v); else if (v !== false && v != null) e.setAttribute(k, v);
  }
  for (const k of kids) if (k != null) e.append(k);
  return e;
};
function say(text, kind = '') {
  const m = $('msg'); m.textContent = text; m.className = 'msg ' + kind; m.hidden = !text;
  if (text) { clearTimeout(say.t); say.t = setTimeout(() => { m.hidden = true; }, 9000); }
}

// ---------- Leitura e escrita do arquivo de cena ----------
function parseScene(text) {
  const eol = text.includes('\r\n') ? '\r\n' : '\n';
  const lines = text.replace(/\r/g, '').split('\n');
  const idx = {};
  lines.forEach((l, i) => { if (l[0] === '/') { const sp = l.indexOf(' '); idx[sp < 0 ? l : l.slice(0, sp)] = i; } });
  return { lines, idx, eol };
}
const sceneText = sc => sc.lines.join(sc.eol);
function tokens(line) {
  const out = []; const re = /"[^"]*"|\S+/g; let m;
  while ((m = re.exec(line))) out.push({ t: m[0], s: m.index, e: m.index + m[0].length });
  return out;
}
function getTok(sc, path, n) {
  const i = sc && sc.idx[path]; if (i == null) return null;
  const tk = tokens(sc.lines[i]); return tk[n] ? tk[n].t : null;
}
// Troca um valor mantendo o alinhamento de colunas do arquivo original.
function setTok(sc, path, n, val) {
  const i = sc.idx[path]; if (i == null) return false;
  const line = sc.lines[i]; const tk = tokens(line); const k = tk[n]; if (!k) return false;
  const start = tk[n - 1].e + 1; const width = k.e - start;
  const txt = val.length >= width ? val : ' '.repeat(width - val.length) + val;
  sc.lines[i] = line.slice(0, start) + txt + line.slice(k.e);
  return true;
}
function isScene(text) { return /^#\d+\.\d+#/.test(text) && /\n\/ch\/01\//.test(text); }
function sceneName(sc) { const m = /^#[\d.]+#\s+"([^"]*)"/.exec(sc.lines[0] || ''); return m ? m[1] : ''; }
function setSceneName(sc, name) {
  const l = sc.lines[0]; const m = /^(#[\d.]+#\s+)"[^"]*"/.exec(l); if (!m) return;
  let out = m[1] + '"' + name + '"' + l.slice(m[0].length);
  if (out.length > l.length) out = out.replace(/\s+$/, m2 => m2.slice(0, Math.max(0, m2.length - (out.length - l.length))));
  else out = out + ' '.repeat(l.length - out.length);
  sc.lines[0] = out;
}

// ---------- Formatos de número da X32 ----------
const parseFreq = t => { const m = /^(\d+)k(\d+)$/.exec(t); return m ? Number(m[1]) * 1000 + Number(m[2]) * (1000 / 10 ** m[2].length) : Number(t); };
const fmtFreq = f => { if (f < 1000) return f.toFixed(1); const v = Math.round(f / 10); return Math.floor(v / 100) + 'k' + String(v % 100).padStart(2, '0'); };
const sign = (v, s) => (v >= 0 ? '+' : '') + s;
const T = {
  onoff: { opts: ['ON', 'OFF'] },
  int:   { parse: Number, fmt: v => String(Math.round(v)) },
  db1:   { parse: Number, fmt: v => v.toFixed(1) },
  gain:  { parse: Number, fmt: v => sign(v, Math.abs(v) < 10 ? v.toFixed(2) : v.toFixed(1)) },
  mg:    { parse: Number, fmt: v => (v < 10 ? v.toFixed(2) : v.toFixed(1)) },
  q:     { parse: Number, fmt: v => v.toFixed(1) },
  freq:  { parse: parseFreq, fmt: fmtFreq },
  fader: { parse: t => (t === '-oo' ? -90 : Number(t)), fmt: v => (v <= -90 ? '-oo' : sign(v, v.toFixed(1))) },
};
const RATIOS = ['1.1', '1.3', '1.5', '2.0', '2.5', '3.0', '4.0', '5.0', '7.0', '10', '20', '100'];
const EQTYPES = ['LCut', 'LShv', 'PEQ', 'VEQ', 'HShv', 'HCut'];
const EQNAMES = { LCut: 'Corta graves', LShv: 'Prateleira grave', PEQ: 'Sino', VEQ: 'Sino vintage', HShv: 'Prateleira aguda', HCut: 'Corta agudos' };
function human(type, tok) {
  if (tok == null) return '';
  if (type === 'freq') { const f = parseFreq(tok); return f >= 1000 ? (f / 1000).toFixed(2).replace('.', ',') + ' kHz' : String(f).replace('.', ',') + ' Hz'; }
  if (type === 'onoff') return tok === 'ON' ? 'ligado' : 'desligado';
  if (type === 'fader' && tok === '-oo') return '−∞';
  if (type === 'eqtype') return EQNAMES[tok] || tok;
  return tok.replace('.', ',');
}

// ---------- Canais e campos ----------
const GROUPS = [['ch', 32, 'Canais'], ['auxin', 8, 'Aux'], ['fxrtn', 8, 'Retornos de efeito'], ['bus', 16, 'Buses'], ['mtx', 6, 'Matrizes']];
function listStrips(sc) {
  const out = [];
  for (const [kind, n, group] of GROUPS) for (let i = 1; i <= n; i++) {
    const base = `/${kind}/${String(i).padStart(2, '0')}`;
    if (!((base + '/config') in sc.idx)) continue;
    const name = (getTok(sc, base + '/config', 1) || '').replace(/"/g, '');
    out.push({ base, kind, group, num: String(i), name });
  }
  if ('/main/st/mix' in sc.idx) out.push({ base: '/main/st', kind: 'main', group: 'Saídas principais', num: 'LR', name: 'Main LR' });
  if ('/main/m/mix' in sc.idx) out.push({ base: '/main/m', kind: 'main', group: 'Saídas principais', num: 'M', name: 'Mono' });
  return out;
}
const F = (path, n, label, type, x = {}) => ({ path, n, label, type, ...x });
function sectionsFor(sc, st) {
  const b = st.base, has = p => p in sc.idx, secs = [];
  if (st.kind === 'ch' && has(b + '/preamp')) secs.push({ t: 'Filtro de graves (HPF)', f: [
    F(b + '/preamp', 3, 'Filtro', 'onoff'), F(b + '/preamp', 5, 'Frequência (Hz)', 'int', { min: 20, max: 400, step: 1 })] });
  if (has(b + '/eq')) {
    const bands = [];
    for (let k = 1; k <= 6; k++) { const p = `${b}/eq/${k}`; if (!has(p)) break;
      bands.push({ t: 'Banda ' + k, f: [
        F(p, 1, 'Tipo', 'eqtype'), F(p, 2, 'Frequência (Hz)', 'freq', { min: 20, max: 20000, step: 'any' }),
        F(p, 3, 'Ganho (dB)', 'gain', { min: -15, max: 15, step: 0.25 }), F(p, 4, 'Largura (Q)', 'q', { min: 0.3, max: 10, step: 0.1 })] }); }
    secs.push({ t: 'Equalizador', f: [F(b + '/eq', 1, 'Equalizador', 'onoff')], bands });
  }
  if (has(b + '/gate')) secs.push({ t: 'Gate', f: [
    F(b + '/gate', 1, 'Gate', 'onoff'), F(b + '/gate', 3, 'Limiar (dB)', 'db1', { min: -80, max: 0, step: 0.5 }),
    F(b + '/gate', 4, 'Redução (dB)', 'db1', { min: 3, max: 60, step: 1 })] });
  if (has(b + '/dyn')) secs.push({ t: 'Compressor', f: [
    F(b + '/dyn', 1, 'Compressor', 'onoff'), F(b + '/dyn', 5, 'Limiar (dB)', 'db1', { min: -60, max: 0, step: 0.5 }),
    F(b + '/dyn', 6, 'Taxa', 'ratio'), F(b + '/dyn', 8, 'Ganho de saída (dB)', 'mg', { min: 0, max: 24, step: 0.5 }),
    F(b + '/dyn', 9, 'Ataque (ms)', 'int', { min: 0, max: 120, step: 1 }), F(b + '/dyn', 11, 'Soltura (ms)', 'int', { min: 5, max: 4000, step: 1 })] });
  if (has(b + '/mix')) {
    const f = [F(b + '/mix', 1, 'Canal (ON = sem mute)', 'onoff'), F(b + '/mix', 2, 'Fader (dB)', 'fader', { min: -90, max: 10, step: 0.1, hint: '−90 = −∞' })];
    if (tokens(sc.lines[sc.idx[b + '/mix']]).length >= 7) f.push(F(b + '/mix', 5, 'Envio ao Mono', 'onoff'), F(b + '/mix', 6, 'Nível no Mono (dB)', 'fader', { min: -90, max: 10, step: 0.1, hint: '−90 = −∞' }));
    secs.push({ t: 'Volume', f });
  }
  return secs;
}
const allFields = secs => secs.flatMap(s => [...s.f, ...(s.bands || []).flatMap(b => b.f)]);
function optsFor(type) { return type === 'onoff' ? T.onoff.opts : type === 'ratio' ? RATIOS : type === 'eqtype' ? EQTYPES : null; }

// ---------- Estado ----------
const KEY = 'ensaio-x32/v1';
const S = { baseText: '', baseFile: '', refText: '', refFile: '', edits: {}, revs: [], snaps: [], cur: '', a: null, b: null };
let BASE = null, WORK = null, REF = null, STRIPS = [];
function persist() {
  try { localStorage.setItem(KEY, JSON.stringify(S)); }
  catch (e) { say('Não consegui guardar o estado neste aparelho. O trabalho continua na tela, mas se perde ao fechar.', 'bad'); }
}
function restore() {
  try { const j = JSON.parse(localStorage.getItem(KEY) || 'null'); if (j) Object.assign(S, j); } catch (e) { /* começa vazio */ }
}
function rebuild() {
  BASE = S.baseText ? parseScene(S.baseText) : null;
  REF = S.refText ? parseScene(S.refText) : null;
  WORK = BASE ? parseScene(S.baseText) : null;
  if (WORK) for (const [p, line] of Object.entries(S.edits)) if (p in WORK.idx) WORK.lines[WORK.idx[p]] = line;
  STRIPS = WORK ? listStrips(WORK) : [];
  if (!STRIPS.some(s => s.base === S.cur)) S.cur = STRIPS[0] ? STRIPS[0].base : '';
}
function setField(fd, tokText) {
  if (!setTok(WORK, fd.path, fd.n, tokText)) return;
  const i = WORK.idx[fd.path];
  if (WORK.lines[i] === BASE.lines[i]) delete S.edits[fd.path]; else S.edits[fd.path] = WORK.lines[i];
  persist();
}
const nEdits = () => Object.keys(S.edits).length;

// ---------- Aba Cena ----------
function renderCena() {
  const has = !!WORK;
  $('empty').hidden = has; $('cena').hidden = !has;
  $('btn-save').disabled = !has || nEdits() === 0;
  $('btn-ref').disabled = !has;
  $('scene-info').textContent = has
    ? `Cena: ${sceneName(BASE) || S.baseFile}` + (REF ? ` · Referência: ${sceneName(REF) || S.refFile}` : '') + ` · ${nEdits()} linha(s) alterada(s)`
    : '';
  if (!has) return;
  const box = $('strips'); box.textContent = ''; let g = '';
  for (const st of STRIPS) {
    if (st.group !== g) { g = st.group; box.append(el('h3', { text: g })); }
    const dirty = Object.keys(S.edits).some(p => p.startsWith(st.base + '/'));
    box.append(el('button', { 'aria-current': st.base === S.cur ? 'true' : 'false', onclick: () => { S.cur = st.base; persist(); renderCena(); } },
      el('span', { class: 'n', text: st.num }), el('span', { class: 'nm', text: st.name || '(sem nome)' }), dirty ? el('span', { class: 'dot', title: 'alterado' }) : null));
  }
  const cur = box.querySelector('[aria-current="true"]'); if (cur && cur.scrollIntoView) cur.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  renderEditor();
}
function fieldEl(fd) {
  const id = 'f' + fd.path.replace(/\W/g, '_') + '_' + fd.n;
  const wrap = el('div', { class: 'fld' }); const note = el('div', { class: 'note' });
  const opts = optsFor(fd.type); let inp;
  const cur = getTok(WORK, fd.path, fd.n);
  if (opts) {
    inp = el('select', { id });
    for (const o of (opts.includes(cur) ? opts : [cur, ...opts])) inp.append(el('option', { value: o, text: fd.type === 'onoff' ? (o === 'ON' ? 'Ligado' : 'Desligado') : fd.type === 'eqtype' ? (EQNAMES[o] || o) : o + (fd.type === 'ratio' ? ' : 1' : '') }));
    inp.value = cur;
  } else {
    inp = el('input', { id, type: 'number', inputmode: 'decimal', min: fd.min, max: fd.max, step: fd.step });
    inp.value = String(T[fd.type].parse(cur));
  }
  const paint = () => {
    const now = getTok(WORK, fd.path, fd.n), was = getTok(BASE, fd.path, fd.n), ref = REF ? getTok(REF, fd.path, fd.n) : null;
    wrap.classList.toggle('chg', now !== was); note.textContent = '';
    if (now !== was) note.append(el('span', { class: 'was', text: 'antes: ' + human(fd.type, was) + '  ' }));
    if (ref != null && ref !== now) note.append(el('span', { class: 'ref', text: 'ref.: ' + human(fd.type, ref) }));
    if (!note.textContent && fd.hint) note.append(el('span', { class: 'mut', text: fd.hint }));
  };
  inp.addEventListener('change', () => {
    let tok;
    if (opts) tok = inp.value;
    else {
      let v = Number(String(inp.value).replace(',', '.'));
      if (!isFinite(v)) { inp.value = String(T[fd.type].parse(getTok(WORK, fd.path, fd.n))); return; }
      v = Math.min(fd.max, Math.max(fd.min, v)); tok = T[fd.type].fmt(v); inp.value = String(T[fd.type].parse(tok));
    }
    setField(fd, tok); paint(); renderCenaStatus();
  });
  wrap.append(el('label', { for: id, text: fd.label }), inp, note); paint();
  return wrap;
}
function renderCenaStatus() {
  $('btn-save').disabled = nEdits() === 0;
  $('scene-info').textContent = `Cena: ${sceneName(BASE) || S.baseFile}` + (REF ? ` · Referência: ${sceneName(REF) || S.refFile}` : '') + ` · ${nEdits()} linha(s) alterada(s)`;
  const cur = STRIPS.find(s => s.base === S.cur); const btn = $('strips').querySelector('[aria-current="true"]');
  if (cur && btn) { const dirty = Object.keys(S.edits).some(p => p.startsWith(cur.base + '/')); const dot = btn.querySelector('.dot');
    if (dirty && !dot) btn.append(el('span', { class: 'dot' })); if (!dirty && dot) dot.remove(); }
}
function renderEditor() {
  const box = $('editor'); box.textContent = '';
  const st = STRIPS.find(s => s.base === S.cur); if (!st) return;
  box.append(el('h2', { class: 'title', text: `${st.num} · ${st.name || '(sem nome)'}` }));
  for (const sec of sectionsFor(WORK, st)) {
    const card = el('div', { class: 'card sec' }, el('h2', { text: sec.t }));
    const grid = el('div', { class: 'grid' }); sec.f.forEach(fd => grid.append(fieldEl(fd))); card.append(grid);
    for (const bd of sec.bands || []) { const g2 = el('div', { class: 'grid' }); bd.f.forEach(fd => g2.append(fieldEl(fd)));
      card.append(el('div', { class: 'band' }, el('b', { text: bd.t }), g2)); }
    box.append(card);
  }
}
function readFile(input, cb) {
  const f = input.files && input.files[0]; if (!f) return;
  const r = new FileReader();
  r.onload = () => { input.value = ''; const text = String(r.result);
    if (!isScene(text)) { say('Esse arquivo não parece uma cena da X32/M32 (.scn).', 'bad'); return; } cb(text, f.name); };
  r.onerror = () => say('Não consegui ler o arquivo.', 'bad');
  r.readAsText(f, 'latin1');
}
$('btn-open').onclick = () => {
  if (WORK && (nEdits() || S.revs.length) && !confirm('Abrir outra cena apaga as alterações e as revisões guardadas aqui. Continuar?')) return;
  $('file-open').click();
};
$('file-open').onchange = e => readFile(e.target, (text, name) => {
  Object.assign(S, { baseText: text, baseFile: name, edits: {}, revs: [], cur: '' }); rebuild(); persist(); renderAll();
  say(`Cena "${sceneName(BASE) || name}" aberta, com ${STRIPS.length} canais e saídas.`, 'ok');
});
$('btn-ref').onclick = () => $('file-ref').click();
$('file-ref').onchange = e => readFile(e.target, (text, name) => { S.refText = text; S.refFile = name; rebuild(); persist(); renderAll(); say('Referência carregada. Os valores diferentes aparecem em azul.', 'ok'); });

// ---------- Salvar revisão ----------
async function saveFile(name, text) {
  const bytes = new Uint8Array(text.length); for (let i = 0; i < text.length; i++) bytes[i] = text.charCodeAt(i) & 255;
  const blob = new Blob([bytes], { type: 'application/octet-stream' });
  if (window.showSaveFilePicker) {
    try { const h = await window.showSaveFilePicker({ suggestedName: name });
      const w = await h.createWritable(); await w.write(blob); await w.close(); return 'picker'; }
    catch (e) { if (e && e.name === 'AbortError') return 'cancel'; }
  }
  const a = el('a', { href: URL.createObjectURL(blob), download: name }); document.body.append(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 4000); return 'download';
}
function revisionScene(n) {
  const sc = parseScene(sceneText(WORK));
  const base = (sceneName(BASE) || 'Cena').replace(/ r\d+$/, '');
  const tag = ' r' + n; const name = base.slice(0, 16 - tag.length) + tag;
  setSceneName(sc, name); return { sc, name };
}
$('btn-save').onclick = async () => {
  if (!WORK || !nEdits()) return;
  const n = (S.revs.length ? Math.max(...S.revs.map(r => r.n)) : 0) + 1;
  const { sc, name } = revisionScene(n);
  const how = await saveFile(name + '.scn', sceneText(sc));
  if (how === 'cancel') { say('Salvamento cancelado. Nada foi gravado.'); return; }
  S.revs.push({ n, utc: new Date().toISOString(), name, edits: { ...S.edits } }); persist(); renderAll();
  say(how === 'download' ? `"${name}.scn" foi para a pasta Downloads. Copie para o pendrive e carregue na mesa.` : `"${name}.scn" gravado. Carregue na mesa pelo pendrive.`, 'ok');
};

// ---------- Aba Revisões ----------
function changedFields() {
  const out = [];
  for (const st of STRIPS) { const secs = sectionsFor(WORK, st);
    for (const sec of secs) { for (const fd of sec.f) push(fd, sec.t); for (const bd of sec.bands || []) for (const fd of bd.f) push(fd, sec.t + ' · ' + bd.t); }
    function push(fd, where) { const now = getTok(WORK, fd.path, fd.n), was = getTok(BASE, fd.path, fd.n);
      if (now !== was) out.push({ st, fd, where, now, was }); } }
  return out;
}
function renderRev() {
  const ch = $('changes'); ch.textContent = '';
  if (!WORK) { ch.append(el('p', { class: 'mut', text: 'Abra uma cena na aba Cena.' })); $('revs').textContent = ''; return; }
  const list = changedFields();
  if (!list.length) ch.append(el('p', { class: 'mut', text: 'Nenhuma alteração em relação à cena aberta.' }));
  else {
    const tb = el('table', {}, el('tr', {}, el('th', { text: 'Canal' }), el('th', { text: 'Ajuste' }), el('th', { text: 'Antes' }), el('th', { text: 'Agora' }), el('th', {})));
    for (const c of list) tb.append(el('tr', {}, el('td', { text: `${c.st.num} ${c.st.name}` }), el('td', { text: `${c.where} · ${c.fd.label}` }),
      el('td', { text: human(c.fd.type, c.was) }), el('td', { text: human(c.fd.type, c.now) }),
      el('td', {}, el('button', { text: 'Desfazer', onclick: () => { setField(c.fd, c.was); renderAll(); } }))));
    ch.append(el('div', { style: 'overflow-x:auto' }, tb));
    ch.append(el('div', { class: 'bar', style: 'margin-top:12px' }, el('button', { text: 'Desfazer tudo', onclick: () => { if (confirm('Voltar todos os valores para a cena aberta?')) { S.edits = {}; rebuild(); persist(); renderAll(); } } })));
  }
  const rv = $('revs'); rv.textContent = '';
  if (!S.revs.length) { rv.append(el('p', { class: 'mut', text: 'Nenhuma revisão salva ainda.' })); return; }
  const ul = el('ul', { class: 'clean' });
  for (const r of [...S.revs].reverse()) ul.append(el('li', {}, el('div', { class: 'bar', style: 'margin:0' },
    el('div', { class: 'grow' }, el('b', { text: r.name }), el('div', { class: 'small mut', text: `${stampLA(r.utc)} (Los Angeles) · ${Object.keys(r.edits).length} linha(s) alterada(s)` })),
    el('button', { text: 'Voltar a esta', onclick: () => { S.edits = { ...r.edits }; rebuild(); persist(); renderAll(); say(`Valores da revisão "${r.name}" carregados na tela.`, 'ok'); } }),
    el('button', { text: 'Baixar de novo', onclick: async () => { const keep = S.edits; S.edits = { ...r.edits }; rebuild(); const { sc } = revisionScene(r.n); const t = sceneText(sc); S.edits = keep; rebuild(); await saveFile(r.name + '.scn', t); } }))));
  rv.append(ul);
}

// ---------- Aba Medir: espectro em terços de oitava ----------
const NB = 31;
const NOM = ['20', '25', '31', '40', '50', '63', '80', '100', '125', '160', '200', '250', '315', '400', '500', '630', '800', '1k', '1k25', '1k6', '2k', '2k5', '3k15', '4k', '5k', '6k3', '8k', '10k', '12k5', '16k', '20k'];
const CEN = Array.from({ length: NB }, (_, b) => 1000 * 2 ** ((b - 17) / 3));
const NOMHZ = [20, 25, 31.5, 40, 50, 63, 80, 100, 125, 160, 200, 250, 315, 400, 500, 630, 800, 1000, 1250, 1600, 2000, 2500, 3150, 4000, 5000, 6300, 8000, 10000, 12500, 16000, 20000];
const hzLabel = b => (NOMHZ[b] >= 1000 ? String(NOMHZ[b] / 1000).replace('.', ',') + ' kHz' : String(NOMHZ[b]).replace('.', ',') + ' Hz');
const M = { ac: null, an: null, buf: null, stream: null, live: new Float64Array(NB), acc: null, accN: 0, until: 0, raf: 0, demo: null };
function bandPower() {
  M.an.getFloatFrequencyData(M.buf); const hz = M.ac.sampleRate / M.an.fftSize; const p = new Float64Array(NB);
  for (let b = 0; b < NB; b++) {
    const i0 = Math.max(1, Math.ceil(CEN[b] / 2 ** (1 / 6) / hz)), i1 = Math.min(M.buf.length - 1, Math.max(i0, Math.ceil(CEN[b] * 2 ** (1 / 6) / hz) - 1));
    let s = 0; for (let i = i0; i <= i1; i++) s += 10 ** (M.buf[i] / 10); p[b] = s;
  }
  return p;
}
const toDb = p => Array.from(p, v => (v > 1e-14 ? 10 * Math.log10(v) : -140));
// Roda por relógio (e não por quadro de tela), para a medição terminar mesmo se o navegador reduzir a animação.
function tick() {
  if (!M.an) return;
  const p = bandPower();
  for (let b = 0; b < NB; b++) M.live[b] = M.live[b] * 0.8 + p[b] * 0.2;
  if (M.acc) {
    for (let b = 0; b < NB; b++) M.acc[b] += p[b]; M.accN++;
    const left = Math.ceil((M.until - performance.now()) / 1000);
    $('btn-cap').textContent = left > 0 ? `Medindo… ${left} s` : 'Medir 10 s';
    if (left <= 0) finishCapture();
  }
  draw();
}
async function startAudio(source) {
  stopAudio();
  M.ac = new (window.AudioContext || window.webkitAudioContext)();
  M.an = M.ac.createAnalyser(); M.an.fftSize = 16384; M.an.smoothingTimeConstant = 0;
  M.buf = new Float32Array(M.an.frequencyBinCount); M.live.fill(0);
  if (source === 'mic') {
    M.stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: false, noiseSuppression: false, autoGainControl: false, channelCount: 1 } });
    M.ac.createMediaStreamSource(M.stream).connect(M.an);
  } else {
    // Sinal sintético: ruído com queda natural e uma sobra perto de 250 Hz, só para mostrar como a análise funciona.
    const len = M.ac.sampleRate * 4, bufN = M.ac.createBuffer(1, len, M.ac.sampleRate), d = bufN.getChannelData(0);
    let b0 = 0, b1 = 0, b2 = 0;
    for (let i = 0; i < len; i++) { const w = Math.random() * 2 - 1; b0 = 0.99765 * b0 + w * 0.0990460; b1 = 0.96300 * b1 + w * 0.2965164; b2 = 0.57000 * b2 + w * 1.0526913; d[i] = (b0 + b1 + b2 + w * 0.1848) * 0.08; }
    const src = M.ac.createBufferSource(); src.buffer = bufN; src.loop = true;
    const pk = M.ac.createBiquadFilter(); pk.type = 'peaking'; pk.frequency.value = 250; pk.Q.value = 4; pk.gain.value = 16;
    src.connect(pk).connect(M.an); src.start(); M.demo = src;
  }
  if (M.ac.state === 'suspended') await M.ac.resume();
  M.raf = setInterval(tick, 50);
}
function stopAudio() {
  clearInterval(M.raf); M.raf = 0;
  if (M.stream) M.stream.getTracks().forEach(t => t.stop());
  if (M.demo) { try { M.demo.stop(); } catch (e) { /* já parado */ } }
  if (M.ac) M.ac.close();
  Object.assign(M, { ac: null, an: null, stream: null, demo: null, acc: null });
}
function micUI(mode) {
  $('btn-mic').textContent = mode === 'mic' ? 'Desligar microfone' : 'Ligar microfone';
  $('btn-demo').textContent = mode === 'demo' ? 'Parar demonstração' : 'Demonstração';
  $('btn-cap').textContent = 'Medir 10 s';
  $('mic-info').textContent = mode === 'mic' ? 'Microfone ligado. Nada é gravado nem enviado.' : mode === 'demo' ? 'Sinal de exemplo, com uma sobra proposital perto de 250 Hz.' : 'O microfone só é usado nesta aba, e nada é gravado nem enviado.';
  M.mode = mode;
}
async function micOn() {
  if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) { say('Este navegador não libera o microfone para esta página. Abra pelo Chrome, no endereço https.', 'bad'); return false; }
  try {
    await startAudio('mic'); micUI('mic');
    M.stream.getTracks().forEach(t => { t.onended = () => { if (M.mode === 'mic') { stopAudio(); micUI(''); draw(); say('O microfone foi interrompido pelo aparelho. Toque em Medir 10 s para ligar de novo.', 'bad'); } }; });
    return true;
  } catch (e) { stopAudio(); micUI(''); say(e && e.name === 'NotAllowedError' ? 'Permissão do microfone negada. Libere nas configurações do site e tente de novo.' : 'Não consegui abrir o microfone: ' + (e && e.message || e), 'bad'); return false; }
}
$('btn-mic').onclick = async () => {
  if (M.mode === 'mic') { stopAudio(); micUI(''); draw(); return; }
  await micOn();
};
// Ao sair da página (tela apagada, outro aplicativo), o Android corta o áudio: desliga de forma limpa.
document.addEventListener('visibilitychange', () => { if (document.hidden && M.mode) { stopAudio(); micUI(''); } });
$('btn-demo').onclick = async () => {
  if (M.mode === 'demo') { stopAudio(); micUI(''); draw(); return; }
  try { await startAudio('demo'); micUI('demo'); } catch (e) { stopAudio(); micUI(''); say('Não consegui iniciar o áudio: ' + (e && e.message || e), 'bad'); }
};
$('btn-cap').onclick = async () => {
  if (M.acc) return;
  if (!M.an && !(await micOn())) return;   // liga o microfone sozinho, se estiver desligado
  try { if (M.ac.state !== 'running') await M.ac.resume(); } catch (e) { /* segue; a medição acusa se vier vazia */ }
  M.acc = new Float64Array(NB); M.accN = 0; M.until = performance.now() + 10000;
  $('btn-cap').textContent = 'Medindo… 10 s';
};
function finishCapture() {
  const db = toDb(M.acc.map(v => v / Math.max(1, M.accN))).map(v => Math.round(v * 10) / 10); M.acc = null;
  $('btn-cap').textContent = 'Medir 10 s';
  if (Math.max(...db) < -110) { stopAudio(); micUI(''); draw(); say('Não chegou som nenhum nessa medição. Desliguei o microfone; toque em Medir 10 s para ligar e tentar de novo.', 'bad'); return; }
  const id = Date.now(); const name = $('snap-name').value.trim() || 'Medição ' + (S.snaps.length + 1);
  S.snaps.push({ id, name, utc: new Date().toISOString(), db, demo: M.mode === 'demo' }); $('snap-name').value = '';
  if (S.a == null) S.a = id; else if (S.b == null) S.b = id;
  persist(); renderMedir();
}
function draw() {
  const cv = $('cv'), g = cv.getContext('2d'), W = cv.width, H = cv.height, L = 44, R = 10, Tp = 12, B = 34;
  g.clearRect(0, 0, W, H);
  const live = M.an ? toDb(M.live) : null, A = S.snaps.find(s => s.id === S.a), Bs = S.snaps.find(s => s.id === S.b);
  const all = [live, A && A.db, Bs && Bs.db].filter(Boolean).flat().filter(v => v > -139);
  const top = all.length ? Math.ceil((Math.max(...all) + 4) / 10) * 10 : 0, bot = top - 60;
  const x = b => L + (b + 0.5) * (W - L - R) / NB, y = v => Tp + (top - Math.max(bot, Math.min(top, v))) / 60 * (H - Tp - B);
  g.font = '13px system-ui,sans-serif'; g.textBaseline = 'middle';
  for (let d = top; d >= bot; d -= 10) { g.strokeStyle = '#263247'; g.beginPath(); g.moveTo(L, y(d)); g.lineTo(W - R, y(d)); g.stroke(); g.fillStyle = '#7f8da6'; g.textAlign = 'right'; g.fillText(String(d - top), L - 6, y(d)); }
  g.textAlign = 'center'; g.textBaseline = 'top';
  for (let b = 0; b < NB; b += 3) { g.fillStyle = '#7f8da6'; g.fillText(NOM[b], x(b), H - B + 8); }
  if (live) { const bw = (W - L - R) / NB * 0.7; g.fillStyle = '#3d4d6b'; for (let b = 0; b < NB; b++) { const yy = y(live[b]); g.fillRect(x(b) - bw / 2, yy, bw, H - B - yy); } }
  const line = (db, col) => { g.strokeStyle = col; g.lineWidth = 3; g.beginPath(); db.forEach((v, b) => (b ? g.lineTo(x(b), y(v)) : g.moveTo(x(b), y(v)))); g.stroke(); g.lineWidth = 1; };
  if (Bs) line(Bs.db, '#58c7e0'); if (A) line(A.db, '#f2b04a');
  if (!all.length) { g.fillStyle = '#7f8da6'; g.textBaseline = 'middle'; g.fillText('Ligue o microfone para ver o espectro', W / 2, H / 2); }
}
// Faixas que sobram em relação às vizinhas (40 Hz a 10 kHz).
function peaksOf(db) {
  // Começa em 80 Hz (o microfone do aparelho não é confiável abaixo disso) e ignora faixas
  // mais de 25 dB abaixo da mais forte, que não chegam a ser ouvidas.
  const out = [], top = Math.max(...db);
  for (let b = 6; b <= 27; b++) {
    const nb = [db[b - 2], db[b - 1], db[b + 1], db[b + 2]]; const ex = db[b] - nb.reduce((a, v) => a + v, 0) / 4;
    if (ex >= 5 && db[b] >= top - 25 && db[b] >= db[b - 1] && db[b] >= db[b + 1]) out.push({ b, ex });
  }
  return out.sort((p, q) => q.ex - p.ex).slice(0, 4);
}
function eqBands(st) {
  const out = [];
  for (let k = 1; k <= 6; k++) { const p = `${st.base}/eq/${k}`; if (!(p in WORK.idx)) break;
    out.push({ k, p, type: getTok(WORK, p, 1), freq: parseFreq(getTok(WORK, p, 2)), gain: Number(getTok(WORK, p, 3)) }); }
  return out;
}
function planCut(st, f, cut) {
  const bells = eqBands(st).filter(b => b.type === 'PEQ' || b.type === 'VEQ'); if (!bells.length) return null;
  const dist = b => Math.abs(Math.log2(b.freq / f));
  const near = bells.filter(b => dist(b) <= 1 / 3).sort((a, b) => dist(a) - dist(b))[0];
  if (near && near.gain <= -4) return { text: `A banda ${near.k} já corta ${String(Math.abs(near.gain)).replace('.', ',')} dB perto dessa frequência. Cortar mais neste canal dificilmente resolve: a sobra deve vir da sala, das caixas, de outro canal, ou é o som natural do que está tocando.`, set: null };
  // Pico ao lado de um corte fundo (até uma oitava): o pico é o que sobrou de pé; alivia-se o corte em vez de cortar mais.
  const deep = !near && bells.filter(b => b.gain < -6 && dist(b) <= 1).sort((a, b) => dist(a) - dist(b))[0];
  if (deep) { const ng = Math.min(deep.gain + 3, -6); const g = v => T.gain.fmt(v).replace('.', ',');
    return { ease: deep, text: `Em vez de cortar aqui, aliviar o corte vizinho: banda ${deep.k}, em ${human('freq', fmtFreq(deep.freq))}, de ${g(deep.gain)} para ${g(ng)} dB.`, set: [[deep.p, 3, T.gain.fmt(ng)]] }; }
  if (near) { const ng = Math.max(-15, near.gain - cut);
    return { text: `Banda ${near.k}, que já está em ${human('freq', fmtFreq(near.freq))}: ganho de ${T.gain.fmt(near.gain).replace('.', ',')} para ${T.gain.fmt(ng).replace('.', ',')} dB.`, set: [[near.p, 3, T.gain.fmt(ng)]] }; }
  const free = bells.find(b => b.gain === 0);
  if (free) return { text: `Banda ${free.k}, que está livre: ${human('freq', fmtFreq(f))}, ganho ${T.gain.fmt(-cut).replace('.', ',')} dB, Q 3,0.`, set: [[free.p, 2, fmtFreq(f)], [free.p, 3, T.gain.fmt(-cut)], [free.p, 4, '3.0']] };
  return { text: 'As bandas deste canal já estão em uso em outras frequências. Ajuste à mão na aba Cena.', set: null };
}
function renderMedir() {
  const sel = $('sug-strip'); const keep = sel.value || S.cur; sel.textContent = '';
  if (!WORK) sel.append(el('option', { value: '', text: 'Abra uma cena para aplicar sugestões' }));
  for (const st of STRIPS) if ((st.base + '/eq/1') in WORK.idx) sel.append(el('option', { value: st.base, text: `${st.num} · ${st.name || '(sem nome)'}` }));
  if ([...sel.options].some(o => o.value === keep)) sel.value = keep;
  const box = $('snaps'); box.textContent = '';
  for (const s of S.snaps) box.append(el('div', { class: 'snap' },
    el('div', { class: 'nm' }, el('div', { text: s.name + (s.demo ? ' (exemplo)' : '') }), el('div', { class: 'small mut', text: stampLA(s.utc) })),
    el('button', { class: S.a === s.id ? 'on' : '', text: 'A', 'aria-pressed': String(S.a === s.id), onclick: () => { S.a = S.a === s.id ? null : s.id; if (S.b === S.a) S.b = null; persist(); renderMedir(); } }),
    el('button', { class: S.b === s.id ? 'onb' : '', text: 'B', 'aria-pressed': String(S.b === s.id), onclick: () => { S.b = S.b === s.id ? null : s.id; if (S.a === S.b) S.a = null; persist(); renderMedir(); } }),
    el('button', { text: 'Apagar', onclick: () => { S.snaps = S.snaps.filter(x => x.id !== s.id); if (S.a === s.id) S.a = null; if (S.b === s.id) S.b = null; persist(); renderMedir(); } })));
  renderAnalysis(); draw();
}
// Regiões do espectro: [até Hz, nome, como soa em excesso, resultado do corte, risco de cortar demais]
const REG = [
  [125, 'peso do grave', 'ronco ou estrondo que cobre o resto', 'grave mais firme e definido', 'o som fica magro, sem peso'],
  [315, 'corpo', 'som embolado ou abafado', 'mais clareza; voz e instrumentos se separam', 'o som fica fino, sem corpo'],
  [630, 'médio-grave', 'som de caixa de papelão, voz que parece dentro de um tubo', 'som mais aberto e natural', 'o som fica oco'],
  [1600, 'médios', 'som anasalado, de telefone', 'timbre mais suave', 'a voz fica distante e some na mistura'],
  [4000, 'presença', 'som ardido, que cansa o ouvido; é a região mais comum de microfonia', 'som menos agressivo', 'perde-se a clareza das palavras'],
  [8000, 'sibilância', '"s" e "ch" chiando, pratos estridentes', 'agudos mais suaves', 'o som fica opaco, sem definição'],
  [1e9, 'brilho', 'chiado ou agudo fino demais', 'menos chiado', 'o som fica abafado, sem ar'],
];
const regionOf = f => REG.find(r => f <= r[0]);
function renderAnalysis() {
  const box = $('analysis'); box.textContent = ''; box.className = '';
  const A = S.snaps.find(s => s.id === S.a), B = S.snaps.find(s => s.id === S.b);
  if (!A) { box.className = 'small mut'; box.textContent = 'Faça uma medição e marque como A. Marque outra como B para comparar.'; return; }
  const st = STRIPS.find(s => s.base === $('sug-strip').value);
  box.append(el('h3', { style: 'margin:0 0 6px;color:var(--acc)', text: 'A: ' + A.name }));
  const pk = peaksOf(A.db);
  box.append(el('p', { class: 'how', text: 'A linha amarela do gráfico é esta medição. "Sobra" quer dizer que a faixa está acima da média das duas vizinhas de cada lado. Nem toda sobra é defeito: voz e instrumentos têm picos naturais. Corte só se você ouvir o problema descrito.' }));
  if (!pk.length) box.append(el('p', { class: 'mut', text: 'Nenhuma faixa sobra mais de 5 dB em relação às vizinhas.' }));
  for (const p of pk) {
    const cut = Math.min(6, Math.max(2, Math.round(p.ex / 2 * 2) / 2)); const f = NOMHZ[p.b]; const rg = regionOf(f);
    const cutTxt = String(cut).replace('.', ','); const exTxt = p.ex.toFixed(1).replace('.', ','); let what, apply = null;
    let why = `Na medição, essa faixa está ${exTxt} dB acima das vizinhas. O corte sugerido é cerca de metade disso, para corrigir sem exagerar.`;
    let result = `${rg[3][0].toUpperCase() + rg[3].slice(1)}. Se cortar demais, ${rg[4]}.`;
    if (st) { const plan = planCut(st, f, cut);
      if (!plan) what = `${st.num} · ${st.name} não tem banda do tipo sino no equalizador. Escolha outro canal acima.`;
      else if (plan.ease) { what = `Em ${st.num} · ${st.name}: ${plan.text}`; apply = plan.set;
        why = `Essa faixa fica ao lado de um corte fundo (banda ${plan.ease.k}, ${String(Math.abs(plan.ease.gain)).replace('.', ',')} dB a menos em ${human('freq', fmtFreq(plan.ease.freq))}). O pico de ${exTxt} dB é o que sobrou de pé ao lado do buraco; cortar aqui também só deixaria tudo mais baixo.`;
        result = 'A curva fica mais plana e o som mais natural; o pico diminui sem perder volume. Risco: se esse corte estava segurando microfonia, ela pode voltar. Teste falando no microfone no volume do culto e desfaça se apitar.'; }
      else if (plan.set) { what = `Em ${st.num} · ${st.name}, cortar ${cutTxt} dB. ${plan.text}`; apply = plan.set; }
      else { const used = eqBands(st).map(b => `banda ${b.k} em ${human('freq', fmtFreq(b.freq))} (${T.gain.fmt(b.gain).replace('.', ',')} dB)`).join('; ');
        what = `${st.num} · ${st.name}: ${plan.text} Hoje: ${used}.`; }
    } else what = `Cortar cerca de ${cutTxt} dB nessa frequência, no canal que está tocando. Abra uma cena para a página indicar a banda.`;
    if (st && !apply) why = `Na medição, essa faixa está ${exTxt} dB acima das vizinhas.`;
    const row = (k, v) => [el('dt', { text: k }), el('dd', { text: v })];
    const sug = el('div', { class: 'sug' },
      el('p', {}, el('b', { text: hzLabel(p.b) }), ` sobra ${p.ex.toFixed(1).replace('.', ',')} dB em relação às faixas vizinhas.`),
      el('dl', {},
        ...row('Região', `${rg[1][0].toUpperCase() + rg[1].slice(1)}. Em excesso: ${rg[2]}.`),
        ...row('O que mudar', what),
        ...row('Por quê', why),
        ...row('Resultado esperado', result)));
    if (apply) sug.append(el('button', { class: 'pri', text: 'Aplicar na cena', onclick: () => {
      for (const [path, n, tok] of apply) setField({ path, n }, tok);
      S.cur = st.base; persist(); renderAll(); say(`Ajuste aplicado em ${st.num} · ${st.name}. Salve uma revisão para levar à mesa, e meça de novo depois.`, 'ok'); } }));
    box.append(sug);
  }
  if (!B) return;
  box.append(el('h3', { style: 'margin:16px 0 6px;color:var(--cy)', text: 'B comparado com A: ' + B.name }));
  const diff = []; for (let b = 3; b <= 28; b++) { const d = B.db[b] - A.db[b]; if (Math.abs(d) >= 3) diff.push({ b, d }); }
  if (!diff.length) box.append(el('p', { class: 'mut', text: 'As duas medições ficam a menos de 3 dB uma da outra em todas as faixas.' }));
  else { const ul = el('ul', { class: 'clean' });
    for (const x of diff.sort((p, q) => Math.abs(q.d) - Math.abs(p.d)).slice(0, 8)) ul.append(el('li', { text: `${hzLabel(x.b)}: B tem ${x.d > 0 ? '+' : '−'}${Math.abs(x.d).toFixed(1).replace('.', ',')} dB` }));
    box.append(ul); }
  const ma = Math.max(...A.db.slice(3, 14)), mb = Math.max(...B.db.slice(3, 14)); const both = [];
  for (let b = 3; b <= 13; b++) if (A.db[b] >= ma - 6 && B.db[b] >= mb - 6) both.push(hzLabel(b));
  if (both.length) box.append(el('p', { class: 'small', style: 'margin-top:10px', text: `Graves em que os dois são fortes ao mesmo tempo: ${both.join(', ')}. Se forem dois instrumentos (bumbo e baixo, por exemplo), é aí que disputam espaço.` }));
}
$('sug-strip').onchange = renderAnalysis;

// ---------- Abas ----------
function showTab(t) {
  for (const k of ['cena', 'medir', 'rev']) { $('p-' + k).hidden = k !== t; $('tab-' + k).setAttribute('aria-selected', String(k === t)); }
  if (t !== 'medir' && M.mode) { stopAudio(); micUI(''); }
  if (t === 'medir') renderMedir(); if (t === 'rev') renderRev(); if (t === 'cena') renderCena();
}
document.querySelectorAll('nav button').forEach(b => b.addEventListener('click', () => showTab(b.dataset.tab)));
function renderAll() { renderCena(); renderRev(); renderMedir(); }

restore(); rebuild(); renderAll(); micUI('');
if ('serviceWorker' in navigator && (location.protocol === 'https:' || location.hostname === 'localhost')) navigator.serviceWorker.register('sw.js').catch(() => {});
