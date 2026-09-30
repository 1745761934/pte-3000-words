import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import vm from 'node:vm';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const SCRIPTS = [...HTML.matchAll(/<script\b[^>]*>([\s\S]*?)<\/script>/gi)].map(m => m[1]);
const DATA = Object.fromEntries([1, 2, 3].map(n => [n, JSON.parse(fs.readFileSync(path.join(ROOT, `data/s${n}.json`), 'utf8'))]));
const WORDS = Object.values(DATA).flatMap(d => d.v);
const PHRASES = WORDS.filter(v => /\s/.test(v.w));

// A small DOM is sufficient for the app's actual handlers. It deliberately
// models HTML replacement, disabled buttons, and document-wide selectors,
// so tests do not reuse stale nodes after the application renders a new card.
class Element {
  constructor(tag = 'div', attributes = {}, parent = null) {
    this.tagName = tag.toUpperCase(); this.attributes = attributes; this.parentElement = parent;
    this.children = []; this.style = {}; this.dataset = {}; this.value = attributes.value || '';
    this.className = attributes.class || ''; this.id = attributes.id || ''; this.textContent = '';
    this.disabled = 'disabled' in attributes;
    Object.entries(attributes).filter(([k]) => k.startsWith('data-')).forEach(([k, v]) => this.dataset[k.slice(5)] = v);
    this.classList = {
      contains: c => this.className.split(/\s+/).includes(c),
      add: (...cs) => { this.className = [...new Set([...this.className.split(/\s+/), ...cs])].filter(Boolean).join(' '); },
      remove: (...cs) => { this.className = this.className.split(/\s+/).filter(c => !cs.includes(c)).join(' '); },
      toggle: (c, force) => { const on = force === undefined ? !this.classList.contains(c) : force; on ? this.classList.add(c) : this.classList.remove(c); return on; }
    };
  }
  set innerHTML(html) { this._html = String(html); this.children = parseElements(this._html, this); }
  get innerHTML() { return this._html || ''; }
  querySelectorAll(selector) { return query(this, selector); }
  querySelector(selector) { return this.querySelectorAll(selector)[0] || null; }
  focus() { if (this.ownerDocument) this.ownerDocument.activeElement = this; }
  click() { if (!this.disabled) return this.onclick?.({ target: this }); }
  remove() { if (this.parentElement) this.parentElement.children = this.parentElement.children.filter(x => x !== this); }
  setAttribute(name, value) { this.attributes[name] = String(value); if (name === 'id') this.id = String(value); if (name === 'class') this.className = String(value); if (name === 'disabled') this.disabled = true; }
  removeAttribute(name) { delete this.attributes[name]; if (name === 'disabled') this.disabled = false; }
  closest(selector) { for (let e = this; e; e = e.parentElement) if (matches(e, selector)) return e; return null; }
  getBoundingClientRect() { return { left: 0, bottom: 0, width: 200 }; }
  contains(other) { return other === this || descendants(this).includes(other); }
  play() { return Promise.resolve(); }
}
function parseElements(html, parent) {
  const root = new Element(); root.ownerDocument = parent?.ownerDocument;
  const stack = [root];
  const token = /<!--[\s\S]*?-->|<\/?[A-Za-z][^>]*>/g;
  for (const m of html.matchAll(token)) {
    const t = m[0]; if (t.startsWith('<!--')) continue;
    if (t.startsWith('</')) { if (stack.length > 1) stack.pop(); continue; }
    const tag = /^<([\w-]+)/.exec(t)[1];
    const attrs = {}; for (const a of t.matchAll(/([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g)) {
      if (a.index === 1) continue; attrs[a[1]] = a[2] ?? a[3] ?? a[4] ?? '';
    }
    const el = new Element(tag, attrs, stack.at(-1)); el.ownerDocument = parent?.ownerDocument;
    stack.at(-1).children.push(el);
    if (!/^(input|br|hr|img|meta|link|source)$/i.test(tag) && !t.endsWith('/>')) stack.push(el);
  }
  root.children.forEach(e => e.parentElement = parent); return root.children;
}
function descendants(root) { return root.children.flatMap(e => [e, ...descendants(e)]); }
function matches(el, simple) {
  const tag = /^[\w-]+/.exec(simple)?.[0]; if (tag && el.tagName !== tag.toUpperCase()) return false;
  for (const [, id] of simple.matchAll(/#([\w-]+)/g)) if (el.id !== id) return false;
  for (const [, cls] of simple.matchAll(/\.([\w-]+)/g)) if (!el.classList.contains(cls)) return false;
  for (const [, attr, , value] of simple.matchAll(/\[([\w-]+)(?:=(['"]?)(.*?)\2)?\]/g)) {
    if (!(attr in el.attributes)) return false; if (value !== undefined && el.attributes[attr] !== value) return false;
  }
  return true;
}
function query(root, selector) {
  const parts = selector.trim().split(/\s+(?=(?:[^'"\[]|'[^']*'|"[^"]*"|\[[^\]]*\])*$)/);
  return descendants(root).filter(e => {
    if (!matches(e, parts.at(-1))) return false;
    let p = e.parentElement; for (let i = parts.length - 2; i >= 0; i--) {
      while (p && !matches(p, parts[i])) p = p.parentElement; if (!p) return false; p = p.parentElement;
    } return true;
  });
}

async function harness(options = {}) {
  let now = Date.parse('2026-09-30T04:00:00Z');
  const trace = { requests: [], speech: [], toasts: [], warnings: [], removed: [], stopped: 0, revoked: [], importsReloaded: 0, errors: [] };
  const storage = new Map(); if (options.storage !== undefined) storage.set('vocab3000_v2', options.storage);
  const tasks = new Map(); let taskId = 0;
  const document = { activeElement: null, events: new Map() };
  document.body = new Element('body'); document.body.ownerDocument = document;
  document.documentElement = document.body;
  document.body.innerHTML = HTML.replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '').replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '');
  document.querySelectorAll = s => query(document.body, s);
  document.querySelector = s => document.querySelectorAll(s)[0] || null;
  document.addEventListener = (e, fn) => { const a = document.events.get(e) || []; a.push(fn); document.events.set(e, a); };
  document.createElement = tag => { const e = new Element(tag); e.ownerDocument = document; return e; };
  const schedule = (fn, ms, repeat) => { const id = ++taskId; tasks.set(id, { fn, ms, repeat }); return id; };
  class FakeDate extends Date { constructor(...args) { super(...(args.length ? args : [now])); } static now() { return now; } }
  const englishVoice = { name: 'Microsoft Zira', lang: 'en-US', voiceURI: 'EnglishVoice' };
  let voices = options.voices || [englishVoice];
  const stream = { getTracks: () => [{ stop: () => trace.stopped++ }] };
  let recorder;
  class FakeRecorder {
    constructor(s) { if (options.recorderError) throw Error('fixture recorder failed'); this.stream = s; this.state = 'inactive'; recorder = this; }
    start() { this.state = 'recording'; }
    stop() { this.state = 'inactive'; if (!options.emptyRecording) this.ondataavailable?.({ data: new Blob(['audio'], { type: 'audio/webm' }) }); this.onstop?.(); }
  }
  const context = vm.createContext({
    document, console: { warn: (...a) => trace.warnings.push(a.join(' ')), log() {}, error: (...a) => trace.errors.push(a.join(' ')) },
    Date: FakeDate, Blob, MediaRecorder: FakeRecorder,
    navigator: { mediaDevices: { getUserMedia: async () => { if (options.permissionError) throw Error('permission denied'); return stream; } } },
    localStorage: { getItem: k => storage.get(k) ?? null, setItem: (k, v) => storage.set(k, String(v)), removeItem: k => { trace.removed.push(k); storage.delete(k); } },
    location: { reload: () => trace.importsReloaded++ }, alert: m => trace.errors.push(String(m)), confirm: () => true,
    URL: { createObjectURL: () => 'blob:fixture-' + (++taskId), revokeObjectURL: u => trace.revoked.push(u) },
    SpeechSynthesisUtterance: class { constructor(txt) { this.text = txt; } },
    setTimeout: (fn, ms) => schedule(fn, ms, false), clearTimeout: id => tasks.delete(id),
    setInterval: (fn, ms) => schedule(fn, ms, true), clearInterval: id => tasks.delete(id),
    fetch: async url => {
      trace.requests.push(String(url)); const n = Number(/s(\d)\.json/.exec(url)?.[1]);
      if (options.failStage === n) return { ok: false, status: 503 };
      await Promise.resolve(); return { ok: true, json: async () => structuredClone(DATA[n]) };
    },
    FileReader: class { readAsText(file) { this.result = file.text; this.onload?.(); } }
  });
  context.window = context;
  context.scrollTo = () => {};
  context.speechSynthesis = { getVoices: () => voices, cancel() {}, speak: utterance => trace.speech.push(utterance) };
  for (let i = 0; i < SCRIPTS.length; i++) vm.runInContext(SCRIPTS[i], context, { filename: `index.html:inline-script-${i + 1}` });
  for (let i = 0; i < 12; i++) await Promise.resolve();
  const evaluate = code => vm.runInContext(code, context);
  const clone = code => { const raw = evaluate(`JSON.stringify(${code})`); return raw === undefined ? undefined : JSON.parse(raw); };
  const runTasks = async (predicate = task => !task.repeat) => {
    const selected = [...tasks].filter(([, t]) => predicate(t));
    for (const [id, t] of selected) { if (!tasks.has(id)) continue; if (!t.repeat) tasks.delete(id); t.fn(); for (let i = 0; i < 6; i++) await Promise.resolve(); }
  };
  return {
    evaluate, clone, trace, document, tasks, runTasks, storage,
    element: s => { const el = document.querySelector(s); assert.ok(el, `expected element ${s}`); return el; },
    clock: date => { now = Date.parse(date); },
    voices: v => { voices = v; }, recorder: () => recorder,
    import: o => document.querySelector('#fileIn').onchange({ target: { files: [{ text: typeof o === 'string' ? o : JSON.stringify(o) }] } })
  };
}

const cases = [];
function test(name, fn) { cases.push([name, fn]); }

test('15 real phrases: recall, verification, spell accept exact words and reject wrong words', async () => {
  assert.equal(PHRASES.length, 15, 'test fixtures must be the actual 15 phrase entries');
  for (const word of PHRASES) {
    for (const method of ['recall', 'verify', 'spell']) {
      for (const correct of [true, false]) {
        const h = await harness(); h.evaluate('P={};S.todayNew=0;S.todayRev=0;S.days[todayStr()]=0;');
        const value = correct ? `  ${word.w.toUpperCase().replace(/ /g, '  ')}  ` : word.w + 'x';
        if (method === 'recall') {
          h.evaluate('S.recall=1;renderLearn()'); h.evaluate(`wireRecall(${JSON.stringify(word.w)})`); h.element('#stInput').value = value; h.evaluate(`checkRecall(${JSON.stringify(word.w)},recallToken)`);
          assert.equal(h.clone(`P[${JSON.stringify(word.w)}].lapse`), correct ? 0 : 1, `${method}: ${word.w}`);
        } else if (method === 'verify') {
          h.evaluate(`startVerify(${JSON.stringify(word)},'#learnCard',()=>{window.testOk=(window.testOk||0)+1},()=>{})`);
          h.element('#vfInput').value = value; h.evaluate('checkVerify()'); await h.runTasks(t => t.ms === 560);
          assert.equal(h.evaluate('window.testOk||0'), correct ? 1 : 0, `${method}: ${word.w}`);
        } else {
          h.evaluate(`spellPool=[${JSON.stringify(word)}];nextSpell()`); h.element('#spellInput').value = value; h.evaluate('checkSpell()');
          assert.equal(h.clone(`P[${JSON.stringify(word.w)}].lapse`), correct ? 0 : 1, `${method}: ${word.w}`);
        }
      }
    }
  }
});

test('blank submissions leave state untouched', async () => {
  const h = await harness(); h.evaluate('S.recall=1;renderLearn()'); const w = h.clone('cur.w');
  const before = h.clone('P'); h.element('#stInput').value = '   '; h.evaluate(`checkRecall(${JSON.stringify(w)},recallToken)`); assert.deepEqual(h.clone('P'), before);
  h.evaluate(`startVerify(cur,'#learnCard',()=>{},()=>{})`); h.element('#vfInput').value = ''; h.evaluate('checkVerify()'); assert.equal(h.evaluate('verifyDone'), false);
  h.evaluate('spellPool=[cur];nextSpell()'); h.element('#spellInput').value = ''; h.evaluate('checkSpell()'); assert.equal(h.evaluate('spellAnswered'), false);
});

test('recall repeated wrong submit counts one lapse per rendered card', async () => {
  const h = await harness(); h.evaluate('S.recall=1;P={};renderLearn()'); const w = h.clone('cur.w');
  h.element('#stInput').value = 'wrong-answer'; h.evaluate(`checkRecall(${JSON.stringify(w)},recallToken);checkRecall(${JSON.stringify(w)},recallToken)`);
  assert.equal(h.clone(`P[${JSON.stringify(w)}].lapse`), 1);
  h.evaluate('renderLearn()'); assert.equal(h.element('#stInput').disabled, false, 'new render must allow recall again');
});

test('learn verification repeated correct submit counts and advances once', async () => {
  const h = await harness(); h.evaluate('P={};S.todayNew=0;S.days[todayStr()]=0;renderLearn();grade(2)'); const w = h.clone('vT.w');
  h.element('#vfInput').value = w; h.evaluate('checkVerify();checkVerify()'); await h.runTasks(t => t.ms === 560);
  assert.equal(h.clone('S.todayNew'), 1); assert.equal(h.clone(`P[${JSON.stringify(w)}].reps`), 1); assert.equal(h.clone('S.days[todayStr()]'), 1);
  const next = h.clone('cur.w'); assert.notEqual(next, w); assert.equal(h.clone(`P[${JSON.stringify(next)}].reps`), 0);
});

test('review verification repeated correct submit counts once', async () => {
  const h = await harness(); h.evaluate("P={};S.todayRev=0;S.days[todayStr()]=0;for(const v of VOCAB.slice(0,2))P[v.w]={iv:1,ease:2,due:0,reps:1,lapse:0,seen:1,star:0};renderReview()");
  h.element('#reviewCard .g-good').click(); const w = h.clone('vT.w'); h.element('#vfInput').value = w;
  h.evaluate('checkVerify();checkVerify()'); await h.runTasks(t => t.ms === 560);
  assert.equal(h.clone('S.todayRev'), 1); assert.equal(h.clone(`P[${JSON.stringify(w)}].reps`), 2); assert.equal(h.clone('S.days[todayStr()]'), 1);
});

test('verification repeated wrong submit counts one learning lapse', async () => {
  const h = await harness(); h.evaluate('P={};S.todayNew=0;S.days[todayStr()]=0;renderLearn();grade(2)'); const w = h.clone('vT.w');
  h.element('#vfInput').value = w + 'x'; h.evaluate('checkVerify();checkVerify();verifyWrong()');
  assert.equal(h.clone(`P[${JSON.stringify(w)}].lapse`), 1); assert.equal(h.clone(`S.wrong[${JSON.stringify(w)}].n`), 1); assert.equal(h.clone('S.todayNew'), 1); assert.equal(h.clone('S.days[todayStr()]'), 1);
});

test('review verification wrong answer consumes one review count', async () => {
  const h = await harness(); h.evaluate("P={};S.todayRev=0;for(const v of VOCAB.slice(0,2))P[v.w]={iv:1,ease:2,due:0,reps:1,lapse:0,seen:1,star:0};renderReview()");
  h.element('#reviewCard .g-good').click(); h.element('#vfInput').value = 'wrong-answer'; h.evaluate('checkVerify();checkVerify()');
  assert.equal(h.clone('S.todayRev'), 0, 'an unknown review word remains due, so it is not a completed review');
  assert.equal(h.clone('S.days[todayStr()]'), 1, 'the wrong review attempt is counted once in the daily activity ledger');
});

test('spell repeated right and wrong submissions count once', async () => {
  for (const correct of [true, false]) {
    const h = await harness(); h.evaluate('P={};S.days[todayStr()]=0;spellPool=[VOCAB[0]];nextSpell()'); const w = h.clone('sq.w');
    h.element('#spellInput').value = correct ? w : w + 'x'; h.evaluate('checkSpell();checkSpell();showAns(false)');
    assert.equal(h.clone(`P[${JSON.stringify(w)}].reps`), 1); assert.equal(h.clone(`P[${JSON.stringify(w)}].lapse`), correct ? 0 : 1); assert.equal(h.clone('S.days[todayStr()]'), 1);
  }
});

test('actual completion-stage button loads the next stage before rendering', async () => {
  const h = await harness(); h.evaluate('P={};S.todayNew=0;for(const v of inStage())rec(v.w).seen=1;renderLearn()');
  await h.element('#btnNextStage').click(); assert.equal(h.clone('S.stage'), 2); assert.ok(h.clone('[...LOADED]').includes(2));
  assert.equal(h.clone('inStage().length'), DATA[2].v.length); assert.equal(h.clone('cur.b'), 2); assert.match(h.trace.requests.join('\n'), /s2\.json/);
});

test('stage completion button cannot skip a stage through a double click', async () => {
  const h = await harness(); h.evaluate('P={};S.todayNew=0;for(const v of inStage())rec(v.w).seen=1;renderLearn()');
  const b = h.element('#btnNextStage'); const first = b.click(); const second = b.click(); await Promise.all([first, second]); assert.equal(h.clone('S.stage'), 2);
});

test('concurrent lazy-loading deduplicates actual fetch and vocabulary', async () => {
  const h = await harness(); const before = h.trace.requests.length;
  await h.evaluate('Promise.all([loadStage(2),loadStage(2),loadStage(2)])');
  assert.equal(h.trace.requests.length - before, 1); assert.equal(h.clone('VOCAB.filter(v=>v.b===2).length'), DATA[2].v.length); assert.equal(h.clone('LOADING.size'), 0);
});

test('failed stage fetch is retryable and leaves previous selection usable', async () => {
  const h = await harness({ failStage: 2 }); const selected = h.clone('S.stage');
  await assert.rejects(h.evaluate('loadStage(2)'), /加载失败/); assert.equal(h.clone('LOADING.size'), 0); assert.equal(h.clone('LOADED.has(2)'), false);
  assert.equal(h.clone('S.stage'), selected); assert.equal(h.clone('inStage().length'), DATA[1].v.length);
});

test('corrupt localStorage recovers without preventing application boot', async () => {
  const h = await harness({ storage: '{broken-json' }); assert.equal(h.clone('S.stage'), 1); assert.ok(h.clone('inStage().length') > 0); assert.ok(h.trace.warnings.length > 0);
});

test('valid import preserves learning progress through actual FileReader handler', async () => {
  const h = await harness(); h.import({ stage: 2, today: '2026-09-30', days: { '2026-09-30': 7 }, prog: { cat: { seen: 1, iv: 3, ease: 2, reps: 4, lapse: 1, due: 100, star: 1 } } });
  assert.equal(h.trace.importsReloaded, 1); assert.equal(h.clone('S.stage'), 2); assert.equal(h.clone('P.cat.reps'), 4); assert.equal(JSON.parse(h.storage.get('vocab3000_v2')).prog.cat.star, 1);
});

test('import rejects or sanitizes malformed nested progress and ledger records', async () => {
  const h = await harness(); h.import({ stage: 42, newPerDay: 'bad', rate: Infinity, days: { '2026-09-30': 'bad' }, prog: { cat: 'bad', dog: null, bird: [] }, wrong: { cat: 7 }, unk: [] });
  assert.equal(h.clone('S.stage'), 1); assert.ok(Number.isFinite(h.clone('S.newPerDay'))); assert.ok(h.clone('S.newPerDay') >= 5);
  assert.equal(h.clone('P.cat'), undefined); assert.equal(h.clone('S.wrong.cat'), undefined);
  h.evaluate("const r=rec('cat');r.seen=1;markWrong('cat');bumpToday(1);save()");
  assert.equal(h.clone('P.cat.seen'), 1); assert.ok(Number.isFinite(h.clone("S.days[todayStr()]"))); assert.ok(Number.isFinite(h.clone('S.wrong.cat.n')));
});

test('first open does not count a learning streak until actual activity', async () => {
  const h = await harness(); assert.equal(h.clone('S.streak'), 0); assert.equal(h.clone('S.days[todayStr()]'), 0); h.evaluate('grade(1)'); assert.equal(h.clone('S.streak'), 1);
});

test('midnight first grade resets old quotas and still counts the new activity', async () => {
  const h = await harness(); h.evaluate("S.today='2026-09-30';S.todayNew=14;S.todayRev=20;S.lastActive='2026-09-30';S.streak=4;S.days['2026-09-30']=14;");
  h.clock('2026-10-01T04:00:00Z'); h.evaluate('grade(1)'); assert.equal(h.clone('S.today'), '2026-10-01'); assert.equal(h.clone('S.todayNew'), 1); assert.equal(h.clone('S.todayRev'), 0); assert.equal(h.clone('S.streak'), 5);
});

test('periodic rollover clears quotas while retaining streak until activity', async () => {
  const h = await harness(); h.evaluate("S.todayNew=14;S.todayRev=20;S.lastActive='2026-09-30';S.streak=4;"); h.clock('2026-10-01T04:00:00Z');
  await h.runTasks(t => t.repeat && t.ms === 60000); assert.equal(h.clone('S.todayNew'), 0); assert.equal(h.clone('S.todayRev'), 0); assert.equal(h.clone('S.streak'), 4);
});

test('no English voices disables selector and never selects a foreign voice', async () => {
  const h = await harness({ voices: [{ lang: 'zh-CN', name: 'ChineseVoice', voiceURI: 'ChineseVoice' }] });
  assert.equal(h.clone('VOICES.length'), 0); assert.equal(h.element('#setVoice').disabled, true);
  h.evaluate("speak('hello')"); assert.ok(h.trace.speech.every(u => !u.voice || /^en/i.test(u.voice.lang)));
});

test('English voices re-enable selection after delayed browser availability', async () => {
  const h = await harness({ voices: [] }); assert.equal(h.element('#setVoice').disabled, true);
  h.voices([{ lang: 'en-GB', name: 'BritishVoice', voiceURI: 'BritishVoice' }]); h.evaluate('loadVoices()'); assert.equal(h.element('#setVoice').disabled, false); assert.equal(h.clone('S.voiceURI'), 'BritishVoice');
});

test('normal recording stop releases microphone tracks', async () => {
  const h = await harness(); await h.evaluate('spkRec()'); assert.equal(h.recorder().state, 'recording'); await h.evaluate('spkRec()'); assert.equal(h.clone('recStream'), null); assert.equal(h.trace.stopped, 1);
});

test('empty recording stop still releases microphone and timer', async () => {
  const h = await harness({ emptyRecording: true }); await h.evaluate('spkRec()'); await h.evaluate('spkRec()'); assert.equal(h.clone('recStream'), null); assert.equal(h.trace.stopped, 1);
  assert.equal([...h.tasks.values()].filter(t => t.repeat && t.ms === 1000).length, 0);
});

test('recorder constructor failure releases granted microphone', async () => {
  const h = await harness({ recorderError: true }); await h.evaluate('spkRec()'); assert.equal(h.clone('recStream'), null); assert.equal(h.trace.stopped, 1);
});

test('leaving speaking tab cancels recording and releases microphone', async () => {
  const h = await harness(); await h.evaluate('spkRec()'); h.evaluate("showTab('learn')"); assert.equal(h.clone('recStream'), null); assert.equal(h.trace.stopped, 1); assert.equal(h.recorder().state, 'inactive');
});

let passed = 0;
for (const [name, fn] of cases) {
  try { await fn(); passed++; console.log(`PASS ${name}`); }
  catch (e) { console.error(`FAIL ${name}\n  ${e.message}`); if (process.env.DEBUG_TESTS) console.error(e.stack); }
}
console.log(`\n${passed}/${cases.length} regression groups passed (actual index.html inline scripts; ${PHRASES.length} real phrase fixtures).`);
process.exitCode = passed === cases.length ? 0 : 1;
