// ウォークモンスター 自動テスト
// 実行: npm test (または node tests/run.js)
// 結果は「OK/NG と理由」の一覧で表示し、NG があれば終了コード 1 を返す。
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFileSync } = require('child_process');

let chromium;
try { ({ chromium } = require('playwright')); } catch (e) {
  console.error('playwright が見つかりません。先に npm install を実行してください。');
  process.exit(2);
}

const ROOT = path.resolve(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'output');
const WIDTHS = [{ w: 375, h: 667 }, { w: 390, h: 844 }];
// 古い4段階の頃の言葉(画面に出ていたら NG)
// 「最終形態」が画面に無いことも、ここで確認する
const OLD_WORDS = ['最終形態', '幼年期', '成長期', '成熟期', '最終進化'];

const results = [];
const add = (name, ok, msg) => {
  results.push({ name, ok, msg });
  console.log(`${ok ? 'OK' : 'NG'}  ${name} … ${msg}`);
};
const screenTexts = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));

// ---------- 1. 構文チェック ----------
function syntaxCheck() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'wm-'));
  const errs = [];
  const check = (file, label) => {
    try { execFileSync(process.execPath, ['--check', file], { stdio: 'pipe' }); }
    catch (e) { errs.push(label + ': ' + String(e.stderr).split('\n').slice(0, 4).join(' ')); }
  };
  check(path.join(ROOT, 'sprites.js'), 'sprites.js');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const re = /<script(?![^>]*\bsrc=)[^>]*>([\s\S]*?)<\/script>/g;
  let m, i = 0;
  while ((m = re.exec(html))) {
    const f = path.join(tmp, `inline-${++i}.js`);
    fs.writeFileSync(f, m[1]);
    check(f, `index.html の script ${i}`);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
  add('構文チェック', !errs.length, errs.length ? errs.join(' / ') : `sprites.js と index.html 内の script ${i}個 すべてOK`);
}

// ---------- ブラウザ準備 ----------
async function newPage(browser, size, opt = {}) {
  const ctx = await browser.newContext({
    viewport: { width: size.w, height: size.h }, deviceScaleFactor: 2, isMobile: true, hasTouch: true,
    reducedMotion: opt.reduce ? 'reduce' : 'no-preference', colorScheme: opt.dark ? 'dark' : 'light', locale: 'ja-JP',
  });
  const errors = [];
  await ctx.addInitScript(({ speed }) => {
    // 音: オシレーターが鳴らされた回数を数える
    // ダンジョンの選択肢はテストでは自動で選ぶ: イベントはランダム、進むか帰るかは「進む」
    window.DAUTO = (o, kind) => kind == 'path' ? o[0].k : o[Math.floor(Math.random() * o.length)].k;
    window.__osc = 0;
    if (window.OscillatorNode) {
      const st = OscillatorNode.prototype.start;
      OscillatorNode.prototype.start = function (...a) { window.__osc++; return st.apply(this, a); };
    }
    // バトル・ダンジョンを早回しするため、タイマーを speed 倍速にする
    if (speed > 1) {
      const sT = window.setTimeout, sI = window.setInterval;
      window.setTimeout = (f, ms, ...a) => sT(f, (ms || 0) / speed, ...a);
      window.setInterval = (f, ms, ...a) => sI(f, (ms || 0) / speed, ...a);
    }
  }, { speed: opt.speed || 1 });
  const page = await ctx.newPage();
  page.on('pageerror', e => errors.push('pageerror: ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  await page.goto(URL);
  await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
  // テスト用ヘルパー(ゲームの状態を指定キャラ・指定時刻にする)
  await page.evaluate(() => {
    window.__T = {
      all: () => Object.values(SPR).flat(),
      setup(k, hour, stageDay) {
        const c = __T.all().find(x => x.k == k);
        S = fresh(); S.attr = ATR(k); S.chr = k; S.type = 'dra'; S.stage = c.g; setTypeFor(k);
        const now = Date.now(), g = new Date(now);
        let skip = ((hour * 60 + 1) - (g.getHours() * 60 + g.getMinutes())) / 1440;
        if (skip < 0) skip += 1;
        const day = stageDay != null ? stageDay : TH[c.g] + 0.5;
        S.skip = skip; S.born = now + skip * 864e5 - day * 864e5;
        care(dNow()); Object.assign(S.cr, { hu: 4, hz: null, po: 0, p0: null });
        tab = null; CB = 0; document.getElementById('ov').hidden = true;
        document.querySelectorAll('.cine').forEach(e => e.remove());
        save(); render();
      },
    };
  });
  return { ctx, page, errors };
}

// 画像の読み込み・左右のはみ出しを調べる(アニメーションの途中も数か所見る)
const measureFn = async sel => {
  const img = document.querySelector(sel);
  if (!img) return { err: '画像の要素がない' };
  try { await img.decode(); } catch (e) { return { err: '画像が読み込めない' }; }
  if (!img.complete || !img.naturalWidth) return { err: '画像が読み込めない' };
  await new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
  const VW = document.documentElement.clientWidth;
  const anims = document.getAnimations().filter(a => a.effect && a.effect.target &&
    (a.effect.target.contains(img) || a.effect.target === img));
  const samples = anims.length ? [0, .15, .3, .45, .6, .75, .9] : [0];
  let minL = 1e9, maxR = -1e9;
  for (const f of samples) {
    for (const a of anims) {
      const d = a.effect.getComputedTiming().duration;
      if (isFinite(d) && d > 0) { a.pause(); a.currentTime = d * f; }
    }
    const r = img.getBoundingClientRect();
    minL = Math.min(minL, r.left); maxR = Math.max(maxR, r.right);
  }
  anims.forEach(a => a.play());
  const r = img.getBoundingClientRect();
  return { VW, minL, maxR, w: r.width, h: r.height, scrollW: document.documentElement.scrollWidth };
};

// ---------- 2. 読み込み時のコンソールエラー・音 ----------
async function loadAndSound(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0]);
  await sleep(1500);
  add('読み込み時のコンソールエラー', !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  screenTexts.push(['たまご選び', await page.evaluate(() => document.body.innerText)]);
  // 音: タップで音が始まり、効果音で音が鳴らされるか
  await page.mouse.click(5, 300);
  await sleep(800);
  const s = await page.evaluate(async () => {
    const a = window.__osc; AU.sfx('coin'); AU.jingle('win');
    await new Promise(r => setTimeout(r, 300));
    return { bgm: a, after: window.__osc };
  });
  add('音(動作確認のみ・聞こえ方は未確認)', s.bgm > 0 && s.after > s.bgm,
    s.bgm > 0 && s.after > s.bgm ? `BGMと効果音の発音を確認(${s.after}音)。聞こえ方は自動テストでは確認できません` : `音が鳴らされていない(BGM ${s.bgm}, 効果音後 ${s.after})`);
  await ctx.close();
}

// ---------- 3. 全105体(昼)・寝姿98体(夜) ----------
async function charaCheck(browser, size) {
  const { ctx, page, errors } = await newPage(browser, size, { reduce: false });
  const list = await page.evaluate(() => __T.all().map(c => ({ k: c.k, n: c.n, g: c.g, z: !!c.z })));
  const bad = [], badBt = [], badZ = [], scroll = [];
  let nZ = 0;
  for (const c of list) {
    await page.evaluate(([k]) => __T.setup(k, 12), [c.k]);
    const r = await page.evaluate(measureFn, '.stage .petw img.pm');
    if (r.err) bad.push(`${c.n}(${r.err})`);
    else if (r.minL < -0.5 || r.maxR > r.VW + 0.5) bad.push(`${c.n}(左${r.minL.toFixed(0)} 右${r.maxR.toFixed(0)} / 画面${r.VW})`);
    if (!r.err && r.scrollW > r.VW) scroll.push(c.n);
    // バトル画面の自分のキャラ
    const rb = await page.evaluate(async () => {
      document.getElementById('psp').innerHTML = pet(S.stage); view('ob');
      return null;
    }).then(() => page.evaluate(measureFn, '#psp img.pm'));
    if (rb.err) badBt.push(`${c.n}(${rb.err})`);
    else if (rb.minL < -0.5 || rb.maxR > rb.VW + 0.5) badBt.push(`${c.n}(左${rb.minL.toFixed(0)} 右${rb.maxR.toFixed(0)})`);
    await page.evaluate(() => { document.getElementById('ov').hidden = true; });
    // 夜の寝姿
    if (c.z) {
      nZ++;
      await page.evaluate(([k]) => __T.setup(k, 23), [c.k]);
      const rz = await page.evaluate(measureFn, '.stage .petw.sleep img.pm.zs');
      if (rz.err) badZ.push(`${c.n}(${rz.err})`);
      else if (rz.minL < -0.5 || rz.maxR > rz.VW + 0.5) badZ.push(`${c.n}(左${rz.minL.toFixed(0)} 右${rz.maxR.toFixed(0)})`);
      if (rz.err && badZ.length <= 3) await page.screenshot({ path: path.join(OUT, `sleep-${size.w}-${c.k}.png`) });
    }
    if ((r.err || bad.length) && bad.length <= 3 && bad[bad.length - 1] && bad[bad.length - 1].startsWith(c.n))
      await page.screenshot({ path: path.join(OUT, `home-${size.w}-${c.k}.png`) });
  }
  const W = `[${size.w}px]`;
  add(`${W} 全${list.length}体 ホーム表示`, list.length === 105 && !bad.length,
    list.length !== 105 ? `キャラ数が${list.length}体(105体のはず)` : bad.length ? `${bad.length}体NG: ${bad.slice(0, 6).join('、')}` : '画像読み込み・左右はみ出しなし');
  add(`${W} 全${list.length}体 バトル画面表示`, !badBt.length, badBt.length ? `${badBt.length}体NG: ${badBt.slice(0, 6).join('、')}` : '画像読み込み・左右はみ出しなし');
  add(`${W} 夜の寝姿${nZ}体`, nZ === 98 && !badZ.length,
    nZ !== 98 ? `寝姿が${nZ}体(98体のはず)` : badZ.length ? `${badZ.length}体NG: ${badZ.slice(0, 6).join('、')}` : '全員 寝姿で表示・はみ出しなし');
  add(`${W} 横スクロールが出ない`, !scroll.length, scroll.length ? `横にはみ出す: ${scroll.slice(0, 6).join('、')}` : 'なし');
  // 各タブの画面(言葉チェック・はみ出し用)
  await page.evaluate(() => __T.setup('fire5', 12));
  const tabBad = [];
  for (const t of [null, 'st', 'tr', 'wk', 'ts']) {
    const o = await page.evaluate(async t => {
      tab = t; render(); await new Promise(r => setTimeout(r, 400));
      const VW = document.documentElement.clientWidth;
      return { txt: document.body.innerText, sw: document.documentElement.scrollWidth, VW };
    }, t);
    screenTexts.push([`タブ ${t || 'ホーム'} ${size.w}px`, o.txt]);
    if (o.sw > o.VW) tabBad.push(`${t || 'ホーム'}(幅${o.sw})`);
  }
  add(`${W} 各タブの横はみ出し`, !tabBad.length, tabBad.length ? tabBad.join('、') : 'ホーム/ステータス/トレーニング/あるく/テスト すべてOK');
  add(`${W} キャラ表示中のコンソールエラー`, !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  await ctx.close();
}

// 進化の選択画面が出ていたら1つ目を選ぶ
const handleChoice = page => page.evaluate(async () => {
  const o = document.querySelector('.cine.cho');
  if (!o) return false;
  o.querySelector('.chc').click(); o.querySelector('.chok').click();
  await new Promise(r => setTimeout(r, 700));
  return true;
});

// ---------- 4. 一生を通しで(たまご選び→孵化→進化→寿命→選び直し) ----------
async function lifeCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true });
  async function oneLife(attr, strong) {
    const shown = await page.isVisible('#eg');
    if (!shown) return { err: 'たまご選びが表示されない' };
    await page.click(`.egc[data-a="${attr}"]`);
    await page.click('#egok');
    const gen = await page.evaluate(() => S.gen || 1);
    const stages = [], names = [], nts = [];
    let endAge = null, ended = false;
    for (let i = 0; i < 40; i++) {
      await page.evaluate(() => advance(24));
      await sleep(80);
      while (await handleChoice(page)) {}
      // 育成ミスの「がっかり」の動き中は画面の描き直しが止まるので、終わるまで待つ
      await page.waitForFunction(() => !CB, null, { timeout: 10000 }).catch(() => {});
      const st = await page.evaluate(() => ({ nt: (document.querySelector('.info .chip') || {}).textContent, stage: S.stage, end: S.end, chr: S.chr, gen: S.gen || 1, d: dNow(), eg: !document.getElementById('eg').hidden && !document.getElementById('ov').hidden, n: petName() }));
      screenTexts.push([`一生 ${attr} ${i + 1}日目`, await page.evaluate(() => document.body.innerText)]);
      if (st.gen !== gen) { ended = true; endAge = i + 1; if (!st.eg) return { err: '寿命後にたまご選びが出ない', stages, names }; break; }
      if (!stages.includes(st.stage)) { stages.push(st.stage); names.push(st.n); }
      if (st.stage >= 1) nts.push({ stage: st.stage, nt: st.nt });
      if (strong && st.stage === 4) await page.evaluate(() => { for (let j = 0; j < 5; j++) ['atk', 'def', 'spd', 'matk', 'mdef'].forEach(testStat); });
    }
    return { stages, names, ended, endAge, nts };
  }
  const a = await oneLife('fire', true);
  const okA = !a.err && a.ended && [1, 2, 3, 4, 5].every(s => a.stages.includes(s)) && a.endAge >= 20 && a.endAge <= 24;
  add('一生(究極体まで育てる)', okA, a.err ? a.err : `段階 ${a.stages.join('→')}(${a.names.join('→')})、${a.ended ? a.endAge + '日目に寿命→たまご選び直し' : '40日たっても寿命が来ない'}`);
  // 進化までの欄: 究極体は「究極体」、それ以外は「進化まで あと○」
  if (!a.err) {
    const ult = a.nts.filter(x => x.stage === 5), mid = a.nts.filter(x => x.stage < 5);
    const badU = ult.filter(x => x.nt !== '究極体'), badM = mid.filter(x => !/^進化まで あと\d+(日|時間)$/.test(x.nt || ''));
    add('進化までの欄の表示', ult.length > 0 && !badU.length && !badM.length,
      !ult.length ? '究極体まで進まず確認できない' : badU.length ? `究極体で「${badU[0].nt}」と表示` : badM.length ? `段階${badM[0].stage}で「${badM[0].nt}」と表示` : `究極体は「究極体」、それ以外は「進化まで あと○」(${a.nts.length}日分を確認)`);
  }
  const b = await oneLife('water', false);
  const okB = !b.err && b.ended && b.endAge >= 15 && b.endAge <= 16;
  add('一生(究極体の条件不足)', okB, b.err ? b.err : `段階 ${b.stages.join('→')}、${b.ended ? b.endAge + '日目に終了→たまご選び直し' : '終わらない'}`);
  const again = await page.isVisible('#eg');
  add('寿命後のたまご選び直し', again, again ? '2回とも たまご選び画面に戻った' : 'たまご選び画面が出ていない');
  add('一生テスト中のコンソールエラー', !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  await ctx.close();
}

// ---------- 5. ごはん・そうじ・放置 ----------
async function careCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 2).k);
  await page.evaluate(k => { __T.setup(k, 9); advance(6); }, k);
  const waitCB = () => page.waitForFunction(() => !CB, null, { timeout: 15000 });
  // ごはん
  const hu0 = await page.evaluate(() => S.cr.hu);
  await page.evaluate(() => feed());
  await waitCB();
  const hu1 = await page.evaluate(() => S.cr.hu);
  add('ごはん', hu0 < 4 && hu1 === hu0 + 1, `おなか ${hu0}→${hu1}`);
  // そうじ
  await page.evaluate(() => { S.cr.po = Math.max(1, S.cr.po); S.cr.p0 = S.cr.p0 ?? S.cr.pt; save(); render(); });
  const po0 = await page.evaluate(() => S.cr.po);
  const pooShown = await page.evaluate(() => document.querySelectorAll('.stage .poo').length);
  await page.evaluate(() => clean());
  await waitCB();
  const po1 = await page.evaluate(() => S.cr.po);
  add('そうじ', po0 > 0 && po1 === 0 && pooShown > 0, `うんち ${po0}→${po1}(画面に${pooShown}個表示されていた)`);
  // 放置
  const m0 = await page.evaluate(() => S.cr.mis);
  for (let i = 0; i < 4; i++) { await page.evaluate(() => advance(12)); await sleep(50); while (await handleChoice(page)) {} }
  const m1 = await page.evaluate(() => S.cr.mis);
  add('放置で育成ミスが増える', m1 > m0, `2日放置で 育成ミス ${m0}→${m1}`);
  add('お世話テスト中のコンソールエラー', !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  await ctx.close();
}

// ---------- 5c. テストタブの「キャラ表示」で段階・年齢も合う ----------
async function chrPickCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true });
  await page.click('.egc[data-a="fire"]'); await page.click('#egok');
  await page.evaluate(() => advance(24 * 13)); await sleep(200);
  while (await handleChoice(page)) {}
  const ng = [];
  const now = () => page.waitForFunction(() => !CB, null, { timeout: 10000 }).catch(() => {}).then(() => page.evaluate(() => {
    tick(); return { g: S.stage, st: ST[S.stage], age: Math.floor(dNow()), n: petName(), nt: (document.querySelector('.info .chip') || {}).textContent, mis: S.cr ? S.cr.mis : 0 };
  }));
  const pick = async k => { await page.evaluate(() => { tab = 'ts'; render(); }); await page.selectOption('.csel', k); await page.evaluate(() => { tab = null; render(); }); return now(); };
  const b0 = await now();
  // 完全体・13才 → 究極体を選ぶ / 成熟体を選ぶ / 同じ段階の範囲内なら年齢そのまま
  const cases = await page.evaluate(() => ({ u: SPR.fire.find(c => c.g == 5), m: SPR.fire.find(c => c.g == 3), m2: SPR.fire.filter(c => c.g == 3)[1] }));
  const a = await pick(cases.u.k);
  if (a.g !== 5 || a.age !== 15 || a.nt !== '究極体' || a.n !== cases.u.n) ng.push(`究極体を選んで ${a.st}・${a.age}才・「${a.nt}」`);
  if (a.mis !== b0.mis) ng.push(`年齢を動かしたら育成ミスが ${b0.mis}→${a.mis}`);
  const b = await pick(cases.m.k);
  if (b.g !== 3 || b.age !== 6 || !/^進化まで あと/.test(b.nt || '')) ng.push(`成熟体を選んで ${b.st}・${b.age}才・「${b.nt}」`);
  await page.evaluate(() => advance(24)); 
  const c = await pick(cases.m2.k);
  if (c.g !== 3 || c.age !== 7 || c.n !== cases.m2.n) ng.push(`同じ段階のキャラを選んで ${c.st}・${c.age}才(7才のままのはず)`);
  add('テストタブのキャラ表示で段階・年齢が合う', !ng.length, ng.length ? ng.join('、') :
    `完全体${b0.age}才→${cases.u.n}で究極体15才「究極体」/${cases.m.n}で成熟体6才/同じ段階なら年齢そのまま、育成ミスも増えない`);
  if (errors.length) add('キャラ表示テスト中のコンソールエラー', false, errors.slice(0, 3).join(' / '));
  await ctx.close();
}

// ---------- 5e. 寿命をむかえた子の記録(歴代の子) ----------
async function histCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true });
  const ng = [];
  // 1人目: 火の究極体・育成ミス2回・1500歩 / 2人目: 水の成熟体
  const pick = await page.evaluate(() => ({ u: SPR.fire.find(c => c.g == 5), m: SPR.water.find(c => c.g == 3) }));
  const exp = [];
  for (const [c, mis, steps] of [[pick.u, 2, 1500], [pick.m, 0, 300]]) {
    const want = await page.evaluate(([k, mis, steps]) => {
      const h = S.hist, g = S.gen; __T.setup(k, 12); S.hist = h; S.gen = g; S.cr.mis = mis; addSteps(steps); S.st.atk = 123; checkLearn(); save();
      return { gen: S.gen || 1, attr: S.attr, key: S.chr, name: petName(), stage: S.stage, type: S.type, st: Object.assign({}, S.st), sk: (S.kn || []).slice(), age: Math.floor(dNow()), mis: S.cr.mis, steps: S.steps, ult: S.stage >= 5 ? 1 : 0 };
    }, [c.k, mis, steps]);
    exp.push(want);
    await page.evaluate(() => { tab = 'ts'; render(); });
    await page.click('button:has-text("今の子を寿命にする")');
    await page.waitForFunction(g => (S.gen || 1) === g + 1 && !document.getElementById('eg').hidden, want.gen, { timeout: 10000 });
    await page.click('.egc[data-a="fire"]'); await page.click('#egok');
  }
  const same = (h, w, i) => {
    const keys = ['gen', 'attr', 'key', 'name', 'stage', 'type', 'age', 'mis', 'steps', 'ult'];
    keys.forEach(k => { if (h[k] !== w[k]) ng.push(`${i + 1}件目の${k}が ${h[k]}(正しくは ${w[k]})`); });
    if (JSON.stringify(h.st) !== JSON.stringify(w.st)) ng.push(`${i + 1}件目の能力が違う`);
    if (JSON.stringify(h.sk.map(x => x.id)) !== JSON.stringify(w.sk) || h.sk.some(x => !x.n)) ng.push(`${i + 1}件目の技が違う`);
  };
  const h1 = await page.evaluate(() => S.hist);
  if (h1.length !== 2) ng.push(`記録が ${h1.length}件`); else h1.forEach((h, i) => same(h, exp[i], i));
  add('寿命を2回むかえると記録が2件・内容が正しい', !ng.length, ng.length ? ng.join('、') :
    `${h1.map(h => `${h.gen}代目 ${h.name}(${["たまご","幼体","成長体","成熟体","完全体","究極体"][h.stage]}・${h.age}才・ミス${h.mis}・${h.steps}歩・技${h.sk.length}つ)`).join(' / ')}`);
  // 再読み込みしても残る・一覧に出る
  await page.reload(); await sleep(300);
  const r = await page.evaluate(() => { tab = 'ts'; render(); return { n: S.hist.length, same: JSON.stringify(S.hist), li: document.querySelectorAll('.hist li').length }; });
  add('再読み込みしても記録が残る', r.n === 2 && r.same === JSON.stringify(h1) && r.li === 2, `記録 ${r.n}件、テストメニューの一覧 ${r.li}行`);
  // 古いセーブ(記録なし)でも壊れない / 「最初から」で消える
  const o = await page.evaluate(() => { const x = JSON.parse(localStorage.getItem('walkmon-v1')); delete x.hist; localStorage.setItem('walkmon-v1', JSON.stringify(x)); return Array.isArray(load().hist) && load().hist.length === 0; });
  await page.evaluate(() => { reset(); reset(); });
  const z = await page.evaluate(() => S.hist.length);
  add('古いセーブ・「最初から」で記録', o && z === 0, `記録なしのセーブ→${o ? '空の一覧' : 'NG'}、最初から→${z}件`);
  if (errors.length) add('記録テスト中のコンソールエラー', false, errors.slice(0, 3).join(' / '));
  await ctx.close();
}

// ---------- 5d. 端末のダークモードでも、昼は明るい空 ----------
async function darkCheck(browser) {
  const look = async (dark, hour) => {
    const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { dark });
    await page.evaluate(h => __T.setup('fire5', h), hour);
    const r = await page.evaluate(() => {
      const st = document.querySelector('.stage'), cs = getComputedStyle(document.documentElement);
      return { night: st.classList.contains('night'), bg: getComputedStyle(st).backgroundImage, dark: matchMedia('(prefers-color-scheme: dark)').matches,
        vars: ['--sky1', '--sky2', '--c1', '--c2', '--gr', '--ink', '--card'].map(v => cs.getPropertyValue(v).trim()).join(' ') };
    });
    await ctx.close();
    return Object.assign(r, { errors });
  };
  const ld = await look(false, 12), dd = await look(true, 12), ln = await look(false, 23), dn = await look(true, 23);
  const ng = [];
  if (!dd.dark) ng.push('ダークモードの設定がテストで効いていない');
  if (dd.night || ld.night) ng.push('昼なのに夜の見た目');
  if (dd.bg !== ld.bg) ng.push('ダークモードだと昼の空の色が変わる');
  if (dd.vars !== ld.vars) ng.push(`ダークモードだと色の設定が変わる(${dd.vars})`);
  if (!dn.night || !ln.night) ng.push('夜(23時)に夜の見た目にならない');
  if (dn.bg !== ln.bg) ng.push('ダークモードだと夜の空の色が変わる');
  const errs = [...ld.errors, ...dd.errors, ...ln.errors, ...dn.errors];
  if (errs.length) ng.push('コンソールエラー: ' + errs[0]);
  add('ダークモード(prefers-color-scheme: dark)でも、昼は明るい空', !ng.length,
    ng.length ? ng.join('、') : '昼も夜も、ダークモードとライトモードで空・色が同じ(昼と夜はゲーム内の時刻で切り替え)');
}

// ---------- 5e. 空は時刻だけで決まり、寝るかどうかは段階ごとの時間 ----------
async function skyCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0]);
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);  // 成熟体
  const at = h => page.evaluate(([k, h]) => {
    __T.setup(k, h);
    const st = document.querySelector('.stage'), w = document.querySelector('.stage .petw');
    return { sky: st.classList.contains('night') ? '夜空' : st.classList.contains('eve') ? '夕方' : '昼', star: (st.querySelector('.hbg') || {}).dataset?.t === 'night' && st.querySelector('.hbg').height > 0,
      sleep: w.classList.contains('sleep'), zs: !!w.querySelector('img.zs'), zzz: !!st.querySelector('.zzz') };
  }, [k, h]);
  const ng = [], R = {};
  for (const h of [12, 16, 17, 18, 19, 21, 22, 23, 2, 5, 6]) R[h] = await at(h);
  for (const h of [12, 16, 6]) if (R[h].sky !== '昼') ng.push(`${h}時が${R[h].sky}`);
  for (const h of [17, 18]) if (R[h].sky !== '夕方' || R[h].star) ng.push(`${h}時が夕方の空でない(${R[h].sky})`);
  for (const h of [19, 21, 22, 23, 2, 5]) if (R[h].sky !== '夜空' || !R[h].star) ng.push(`${h}時が夜空でない(${R[h].sky})`);
  for (const h of [19, 21]) if (R[h].sleep || R[h].zs) ng.push(`${h}時に成熟体が寝ている`);
  for (const h of [22, 23, 2, 5]) if (!R[h].sleep || !R[h].zs || !R[h].zzz) ng.push(`${h}時に成熟体が寝ていない`);
  if (errors.length) ng.push('コンソールエラー: ' + errors[0]);
  add('19時は夜空で成熟体は起きている', ![19, 21].some(h => ng.some(x => x.startsWith(h + '時'))), `19時: ${R[19].sky}・${R[19].sleep ? '寝ている' : '起きている'}`);
  add('22時以降は夜空で寝ている', ![22, 23, 2, 5].some(h => ng.some(x => x.startsWith(h + '時'))), [22, 23, 2, 5].map(h => `${h}時: ${R[h].sky}・${R[h].sleep ? '寝姿' : '起きている'}`).join('、'));
  add('17時台は夕方の空', ![17, 18].some(h => ng.some(x => x.startsWith(h + '時'))), `17時: ${R[17].sky}、18時: ${R[18].sky}`);
  add('空の切り替え(昼6〜17時・夕方17〜19時・夜19〜6時)', !ng.length, ng.length ? ng.join('、') : '6・12・16時は昼、17・18時は夕方、19〜5時は夜空');
  await ctx.close();
}

// ---------- 5b. ホームのメッセージ(約2秒でフェードアウト) ----------
async function msgCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0]);
  const st = () => page.evaluate(() => { const c = document.querySelector('.info .chip.lg'); return c ? { t: c.textContent, o: +getComputedStyle(c).opacity } : null; });
  const ng = [];
  await page.click('.egc[data-a="fire"]'); await page.click('#egok'); await sleep(300);
  let r = await st(); if (!r || !r.t.includes('とどいた') || r.o < 0.9) ng.push('たまごが届いたメッセージが出ない');
  await sleep(1500); r = await st(); if (!r || r.o < 0.9) ng.push('約2秒より前に消えた');
  await sleep(1500); r = await st(); if (r && r.o > 0.05) ng.push(`3秒後も消えていない(濃さ${r.o.toFixed(2)})`);
  await page.evaluate(() => { say('テスト1'); render(); }); await sleep(2200);
  await page.evaluate(() => { say('テスト2'); render(); }); await sleep(1000);
  r = await st(); if (!r || r.t !== 'テスト2' || r.o < 0.9) ng.push('消えている途中の新しいメッセージで数え直さない');
  await page.evaluate(() => render()); r = await st(); if (!r || r.o < 0.9) ng.push('画面の描き直しで表示が変わる');
  await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined'); await sleep(500);
  r = await st(); if (r && r.o > 0.05) ng.push(`再読み込みで古いメッセージ「${r.t}」が出る`);
  add('ホームのメッセージのフェード', !ng.length, ng.length ? ng.join('、') : '表示→約2秒で消える・途中で来た新しいメッセージで数え直し・再読み込みで出ない');
  if (errors.length) add('メッセージテスト中のコンソールエラー', false, errors.slice(0, 3).join(' / '));
  await ctx.close();
}

// ---------- 6b. バトル画面の配置・「にげる」 ----------
let BATTLE_BASE = null;
async function battleLayoutCheck(browser, size) {
  const { ctx, page, errors } = await newPage(browser, size, { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 4).k);
  // サイズごとに見比べるので、敵は毎回同じ(EN[0]の強さ・見た目はオルガロウ)にする
  await page.evaluate(k => { __T.setup(k, 12); bfight(mkEnemy(Object.assign({}, EN[0], { sp: 'water7' }), 1, 0), S.st.hp, null, false); }, k);
  await sleep(400);
  const L = await page.evaluate(() => {
    const r = e => (typeof e == 'string' ? document.querySelector(e) : e).getBoundingClientRect();
    const sw = document.documentElement.scrollWidth;
    const bs = ['c0', 'c2', 'c3', 'c4'].map(id => { const b = r('#' + id); return { id, t: document.getElementById(id).firstChild.textContent, w: b.width, h: b.height, top: b.top, bot: b.bottom, l: b.left, rt: b.right }; });
    const en = r('#en'), pl = r('#pl'), es = r('#esp'), ps = r('#psp'), eh = r('#en .hpb'), ph = r('#pl .hpb'), cmd = r('#cmd');
    return { W: innerWidth, H: innerHeight, sw, bs, en: { l: en.left, r: en.right, t: en.top, b: en.bottom }, pl: { l: pl.left, r: pl.right, t: pl.top, b: pl.bottom },
      gap: pl.top - en.bottom, es: { l: es.left, t: es.top, cx: es.left + es.width / 2, cy: es.top + es.height / 2 }, ps: { r: ps.right, b: ps.bottom, cx: ps.left + ps.width / 2, cy: ps.top + ps.height / 2 }, eg: { r: r('#en .gg').right, t: r('#en .gg').top }, pg: { l: r('#pl .gg').left, b: r('#pl .gg').bottom }, dt: Math.min(...[...document.querySelectorAll('#esp svg *, #esp img')].map(e => e.getBoundingClientRect()).filter(q => q.width || q.height).map(q => q.top)),
      arH: r('#ar').height, blogH: r('#blog').height, blogGap: r('#blog').top - r('#ar').bottom,
      geo: { '味方の大きさ': ps.width, '敵の大きさ': es.width, '味方の足の高さ': r('#ar').bottom - ps.bottom, '敵の頭の高さ': r('#ar').bottom - Math.min(...[...document.querySelectorAll('#esp svg *, #esp img')].map(e => e.getBoundingClientRect()).filter(q => q.width || q.height).map(q => q.top)), '敵と味方の横の距離': (es.left + es.width / 2) - (ps.left + ps.width / 2), 'ボタンの高さ': r('#c0').height, 'メッセージ欄の高さ': r('#blog').height }, top: Math.min(...[...document.querySelectorAll('#esp svg *, #esp img')].map(e => e.getBoundingClientRect()).filter(q => q.width || q.height).map(q => q.top), r('#en .gg').top) - r('#ar').top,
      flip: /matrix\(-1/.test(getComputedStyle(document.querySelector('#psp .pm')).transform), feet: (ps.bottom - r('.flr').top) / r('.flr').height, cmdBot: cmd.bottom };
  });
  const ng = [];
  const names = L.bs.map(b => b.t).join('・');
  if (names !== 'こうげき・ぼうぎょ・必殺技・にげる') ng.push(`ボタンが ${names}`);
  L.bs.forEach(b => { if (b.h < 44 || b.w < 44) ng.push(`${b.t}が小さい(${Math.round(b.w)}×${Math.round(b.h)})`); if (b.bot > L.H || b.rt > L.W || b.l < 0) ng.push(`${b.t}が画面からはみ出す`); });
  if (L.sw > L.W) ng.push('横スクロールが出る');
  if (!(L.es.cx > L.ps.cx && L.es.cy < L.ps.cy)) ng.push('敵が右上・味方が左下になっていない');
  if (L.gap > 0) ng.push(`敵と味方の間が ${Math.round(L.gap)}px あいている`);
  if (Math.abs(L.eg.t - L.dt) > 4 || Math.abs(L.pg.b - L.ps.b) > 4) ng.push('ゲージが 敵=頭・味方=足元 の高さにない');
  // 空が伸びる方式: 床からボタンまでの見た目は 375×667 と同じで、違うのは空の高さだけ
  if (L.blogGap > 8) ng.push(`枠とメッセージ欄の間が ${Math.round(L.blogGap)}px あいている`);
  if (size.w === 375) BATTLE_BASE = L.geo;
  else if (BATTLE_BASE) Object.keys(L.geo).forEach(k => { if (Math.abs(L.geo[k] - BATTLE_BASE[k]) > 6) ng.push(`${k} が 375px と ${Math.round(L.geo[k] - BATTLE_BASE[k])}px ちがう`); });
  if (L.blogH > 60) ng.push(`メッセージ欄が高い(${Math.round(L.blogH)}px)`);
  if (!L.flip) ng.push('味方が敵の方を向いていない');
  if (L.feet < 0.6) ng.push('味方の足が床の下の方にない');
  if (!(L.eg.r <= L.es.l + 1) || !(L.pg.l >= L.ps.r - 1)) ng.push('ゲージがキャラの横にない(敵は左・味方は右)');
  if (L.H - L.cmdBot > 30) ng.push(`画面の下に ${Math.round(L.H - L.cmdBot)}px の余白`);
  await page.screenshot({ path: path.join(OUT, `battle-${size.w}.png`) });
  // 全105体で、キャラとゲージが重ならない・味方は枠内に比率を保って収まる・ドット絵のまま
  const O = await page.evaluate(async () => {
    const hit = (a, b) => a.left < b.right - 0.5 && b.left < a.right - 0.5 && a.top < b.bottom - 0.5 && b.top < a.bottom - 0.5;
    const R = q => document.querySelector(q).getBoundingClientRect(), bad = [];
    let minG = 1e9, cut = 0;
    for (const c of Object.values(SPR).flat()) {
      __T.setup(c.k, 12); bfight(mkEnemy(eLook(EN[0], c.g), 1, 0), S.st.hp, null, false);
      await Promise.all(document.querySelector('#ov .box').getAnimations().map(a => a.finished.catch(() => 0)));
      const img = document.querySelector('#psp img.pm'); try { await img.decode(); } catch (e) {}
      const pi = img.getBoundingClientRect(), box = R('#psp'), pg = R('#pl .gg'), eg = R('#en .gg'), snd = R('#snd');
      const why = [];
      // 味方の絵の見えている部分(左右反転して表示している)
      const cv = document.createElement('canvas'); cv.width = img.naturalWidth; cv.height = img.naturalHeight;
      const cx = cv.getContext('2d'); cx.drawImage(img, 0, 0); const D = cx.getImageData(0, 0, cv.width, cv.height).data;
      let x0 = 1e9, y0 = 1e9, x1 = -1, y1 = -1;
      for (let y = 0; y < cv.height; y++) for (let x = 0; x < cv.width; x++) if (D[(y * cv.width + x) * 4 + 3] > 20) { x0 = Math.min(x0, x); x1 = Math.max(x1, x); y0 = Math.min(y0, y); y1 = Math.max(y1, y); }
      const k = pi.width / cv.width, po = { left: pi.right - (x1 + 1) * k, right: pi.right - x0 * k, top: pi.top + y0 * k, bottom: pi.top + (y1 + 1) * k };
      if (hit(po, pg)) why.push('味方とゲージ'); if (hit(po, eg)) why.push('味方と敵ゲージ');
      if (hit(pg, snd) || hit(eg, snd)) why.push('ゲージと音ボタン');
      // 敵: 同じ段階の全キャラ+ボス(ひとつ上の段階)。強さは EN の5種を順に
      const foes = [...ePool(c.g), ...ePool(Math.min(5, c.g + 1))];
      for (let j = 0; j < foes.length; j++) {
        const fe = Object.assign({}, EN[j % EN.length], { sp: foes[j].k, n: foes[j].n });
        BT.en = mkEnemy(fe, 1, 0); document.getElementById('esp').innerHTML = esv(fe); fitPx(); eCap(); eAlign(); __T.ek = Math.min(__T.ek || 9, parseFloat(document.querySelector('#esp img').style[document.querySelector('#esp img').dataset.d == 'w' ? 'width' : 'height']) / document.querySelector('#esp img').dataset.p);
        const ei = document.querySelector('#esp img');
        if (ei.getBoundingClientRect().right > R('#esp').right + 1 || ei.getBoundingClientRect().top < R('#ar').top + 2) { if (!why.includes('敵が枠からはみ出す')) why.push('敵が枠からはみ出す'); }
        if (getComputedStyle(ei).imageRendering !== 'pixelated' && !why.includes('敵がぼやける')) why.push('敵がぼやける');
        if (R('#en .gg').top - ei.getBoundingClientRect().top > 4 && !why.includes('敵ゲージが頭の高さにない')) why.push('敵ゲージが頭の高さにない');
        const es = [...document.querySelectorAll('#esp svg *, #esp img')].map(e => e.getBoundingClientRect()).filter(q => q.width || q.height)
          .reduce((a, q) => ({ left: Math.min(a.left, q.left), top: Math.min(a.top, q.top), right: Math.max(a.right, q.right), bottom: Math.max(a.bottom, q.bottom) }), { left: 1e9, top: 1e9, right: -1e9, bottom: -1e9 });
        const eg = R('#en .gg'); if (hit(eg, snd) && !why.includes('ゲージと音ボタン')) why.push('ゲージと音ボタン');
        if (hit(eg, po) && !why.includes('味方と敵ゲージ')) why.push('味方と敵ゲージ:' + foes[j].n);
        if (hit(es, eg) && !why.includes('敵とゲージ')) why.push('敵とゲージ'); if (hit(es, pg) && !why.includes('敵と味方ゲージ')) why.push('敵と味方ゲージ');
        if (hit(es, po) && !why.includes('味方と敵')) why.push('味方と敵:' + foes[j].n);
      }
      if (pi.left < box.left - 1 || pi.right > box.right + 1 || pi.top < box.top - 1 || pi.bottom > box.bottom + 1) why.push('味方が枠からはみ出す');
      if (Math.abs(pi.width / pi.height - img.naturalWidth / img.naturalHeight) > 0.05 * img.naturalWidth / img.naturalHeight) why.push('比率がくずれた');
      if (getComputedStyle(img).imageRendering !== 'pixelated') why.push('ドット絵がぼやける');
      if (why.length) bad.push(c.n + '(' + why.join('・') + ')');
      minG = Math.min(minG, pg.width, eg.width);
      document.querySelectorAll('#ob .nm span').forEach(e => { if (e.scrollWidth > e.clientWidth + 1 || e.getBoundingClientRect().right > e.closest('.gg').getBoundingClientRect().right + 1) cut++; });
    }
    BT.busy = 1; document.getElementById('ov').hidden = true;
    return { n: Object.values(SPR).flat().length, bad, minG, cut, ek: __T.ek };
  });
  add(`[${size.w}px] 全${O.n}体で、バトル画面のキャラとゲージが重ならない`, !O.bad.length && O.minG >= 100 && !O.cut,
    O.bad.length ? `${O.bad.length}体: ${O.bad.slice(0, 4).join('、')}` : O.minG < 100 ? `ゲージの幅が ${Math.round(O.minG)}px しかない` : O.cut ? '名前か数字がゲージからはみ出す' :
    `重なりなし(同じ段階の敵全員・ボスとも・音ボタンとも、敵の縮小は最小 ${Math.round(O.ek * 100)}%)・味方は枠内で比率そのまま・ドット絵のまま、ゲージの幅 ${Math.round(O.minG)}px 以上`);
  add(`[${size.w}px] バトル画面の配置とボタン`, !ng.length, ng.length ? ng.join('、') :
    `${names}(${L.bs.map(b => Math.round(b.w) + '×' + Math.round(b.h)).join(', ')})、敵と味方の重なり ${Math.round(-L.gap)}px、上の空き ${Math.round(L.top)}px、下の余白 ${Math.round(L.H - L.cmdBot)}px`);
  // こうげき→技の一覧→もどる で、バトルの枠・背景・キャラ・ゲージの位置と大きさが変わらない(技が多いときは一覧の中でスクロール)
  {
    await page.evaluate(() => { const k = SPR.fire.find(c => c.g == 5).k; __T.setup(k, 12); for (const q in S.st) S.st[q] *= 12; bfight(mkEnemy(EN[0], 1, 0), S.st.hp, null, false); });
    await sleep(400);
    const snap = () => page.evaluate(() => {
      const r = s => { const q = document.querySelector(s).getBoundingClientRect(); return [q.left, q.top, q.width, q.height].map(v => Math.round(v * 10) / 10).join(','); };
      const ar = document.getElementById('ar'), cv = document.getElementById('abg');
      return { box: ['#ar', '#abg', '#esp', '#psp', '#en .hpb', '#pl .hpb'].map(r).join(' / '), sky: cv.getBoundingClientRect().top <= ar.getBoundingClientRect().top + ar.clientTop + .5, sy: scrollY };
    });
    const s0 = await snap();
    await page.click('#c0'); await sleep(300);
    const s1 = await snap();
    const sk = await page.evaluate(() => { const m = document.getElementById('skm').getBoundingClientRect(), c = document.getElementById('cmd').getBoundingClientRect(), l = document.getElementById('skl');
      return { same: Math.abs(m.bottom - c.bottom) < 1 && m.top >= document.getElementById('ar').getBoundingClientRect().bottom - .5, n: l.children.length, scroll: l.scrollHeight > l.clientHeight + 1 ? getComputedStyle(l).overflowY : 'fit' }; });
    await page.click('#skm .big'); await sleep(300);
    const s2 = await snap();
    const ok = s0.box === s1.box && s0.box === s2.box && s0.sky && s1.sky && s0.sy === s1.sy && sk.same && (sk.scroll === 'fit' || sk.scroll === 'auto');
    add(`[${size.w}px] こうげき→技の一覧→もどる で枠と背景が動かない`, ok, ok ? `位置・大きさ同じ、技の一覧はメッセージ欄〜ボタンの場所(技${sk.n}個・${sk.scroll === 'fit' ? '全部入る' : '中でスクロール'})、空は枠の上まで`
      : `変化: ${s0.box !== s1.box ? '一覧で動いた ' : ''}${s0.box !== s2.box ? 'もどるで動いた ' : ''}${sk.same ? '' : '一覧がボタンの場所とずれる・枠にかかる '}${s0.sky && s1.sky ? '' : '空が上まで届かない '}${sk.scroll}`);
  }
  // 技が1〜6個: 技のボタン同士・「← もどる」が重ならず、全部押せる。全タイプの技の名前・数字がボタンに収まる
  {
    const res = await page.evaluate(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms)), R = e => e.getBoundingClientRect(), ng = [];
      const hit = e => { const q = R(e), t = document.elementFromPoint(q.left + q.width / 2, q.top + q.height / 2); return !!t && e.contains(t); };
      const ov = (a, b) => a.left < b.right - .5 && b.left < a.right - .5 && a.top < b.bottom - .5 && b.top < a.bottom - .5;
      const ty = S.type, org = TY[ty].sk;
      for (let n = 1; n <= 6; n++) {
        TY[ty].sk = org.slice(0, n).map(a => { const b = a.slice(); b[5] = 0; b[6] = 0; return b; });
        BT.busy = 0; BT.mp = 999; bmenu(0); bmenu(1); await wait(50);
        const l = document.getElementById('skl'), bk = document.querySelector('#skm .big'), bs = [...l.querySelectorAll('.sk2')];
        if (bs.length != n) { ng.push(`${n}個: ボタンが${bs.length}個`); continue; }
        const rs = bs.map(R), rb = R(bk), rl = R(l);
        for (let i = 0; i < n; i++) { if (ov(rs[i], rb)) ng.push(`${n}個: 技${i + 1}ともどるが重なる`); for (let j = i + 1; j < n; j++) if (ov(rs[i], rs[j])) ng.push(`${n}個: 技${i + 1}と技${j + 1}が重なる`); }
        if (n <= 4 && l.scrollHeight > l.clientHeight + 1) ng.push(`${n}個: スクロールしないと見えない`);
        for (const b of bs) { b.scrollIntoView({ block: 'nearest' }); await wait(20); if (!hit(b)) ng.push(`${n}個: 「${b.querySelector('b').textContent}」が押せない`); if (!hit(bk)) ng.push(`${n}個: スクロール中にもどるが押せない`); }
        if (n == 4 && Math.abs(rs[2].left - rs[0].left) > 1) ng.push('4個: 2×2 に並ばない');
      }
      TY[ty].sk = org;
      // 全タイプの技の文字がボタンからはみ出さない
      for (const t of Object.keys(TY)) {
        S.type = t; const o = TY[t].sk; TY[t].sk = o.map(a => { const b = a.slice(); b[5] = 0; b[6] = 0; return b; });
        BT.mp = 999; bmenu(0); bmenu(1); await wait(30);
        document.querySelectorAll('#skl .sk2 b,#skl .sk2 small').forEach(e => { if (e.scrollWidth > e.clientWidth + 1) ng.push(`${t}: 「${e.textContent}」が切れる`); });
        TY[t].sk = o;
      }
      S.type = ty; bmenu(0);
      return ng;
    });
    add(`[${size.w}px] 技が1〜6個でボタンともどるが重ならず全部押せる`, !res.length, res.length ? res.slice(0, 4).join(' / ') : '1〜6個とも重ならず全部押せる・4個は2×2・全タイプの技の文字が収まる');
  }
  // コマンドと技のボタン: 高さ56px以上・すき間10px以上(技は4つで確認)
  {
    const res = await page.evaluate(async () => {
      const wait = ms => new Promise(r => setTimeout(r, ms)), ng = [];
      const chk = (bs, nm) => { const rs = bs.map(b => b.getBoundingClientRect()); rs.forEach((r, i) => { if (r.height < 56) ng.push(`${nm}${i + 1}の高さ ${r.height.toFixed(1)}px`); });
        for (let i = 0; i < rs.length; i++) for (let j = i + 1; j < rs.length; j++) { const p = rs[i], q = rs[j], gx = Math.max(q.left - p.right, p.left - q.right), gy = Math.max(q.top - p.bottom, p.top - q.bottom);
          if (Math.max(gx, gy) < 9.5) ng.push(`${nm}${i + 1}と${j + 1}のすき間 ${Math.max(gx, gy).toFixed(1)}px`); } return rs; };
      bmenu(0); await wait(30);
      const rc = chk([...document.querySelectorAll('#cmd button')], 'コマンド');
      const ty = S.type, org = TY[ty].sk; TY[ty].sk = org.slice(0, 4).map(a => { const b = a.slice(); b[5] = 0; b[6] = 0; return b; });
      BT.busy = 0; BT.mp = 999; bmenu(1); await wait(50);
      const rk = chk([...document.querySelectorAll('#skl .sk2')], '技');
      rk.forEach((r, i) => { if (Math.abs(r.height - rc[i].height) > 1) ng.push(`技${i + 1}の高さがコマンドと違う(${r.height.toFixed(1)}/${rc[i].height.toFixed(1)})`); });
      TY[ty].sk = org; bmenu(0);
      return { ng, h: rc[0].height, hk: rk[0] && rk[0].height };
    });
    add(`[${size.w}px] コマンドと技のボタンが高さ56px以上・すき間10px以上`, !res.ng.length, res.ng.length ? res.ng.slice(0, 4).join(' / ') : `コマンド ${res.h}px・技 ${res.hk}px、すき間10px以上`);
  }
  if (errors.length) add(`[${size.w}px] バトル配置テスト中のコンソールエラー`, false, errors.slice(0, 3).join(' / '));
  await ctx.close();
}
// ---------- 6c. 敵はドット絵キャラ(全段階)・ボスの見た目・写真 ----------
async function enemyLookCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true });
  const R = await page.evaluate(async () => {
    const bad = [], seen = {};
    const typ = (c, en) => { const t = EVT[ATR(c.k)].t[+c.k.replace(/\D/g, '')]; return TYC[t] || en.ty; };
    const chk = (e, g, boss, where) => {
      const c = e.sp && Object.values(SPR).flat().find(x => x.k == e.sp);
      if (!c) { bad.push(`${where}: ドット絵キャラでない(${e.n})`); return; }
      const hid = SPR[ATR(c.k)].indexOf(c) == EVT[ATR(c.k)].h;
      const base = EN.find(x => x.t == e.t) || BOSS;
      if (c.g != g) bad.push(`${where}: ${c.n} の段階が ${ST6[c.g]}(${ST6[g]}のはず)`);
      if (hid) bad.push(`${where}: 隠し進化の ${c.n} が出た`);
      if (e.n != (boss ? '👑 ' : '') + c.n) bad.push(`${where}: 名前が「${e.n}」(${c.n})`);
      if (e.ty != typ(c, base)) bad.push(`${where}: ${c.n} のタイプが ${e.ty}(${typ(c, base)}のはず)`);
      (seen[g] = seen[g] || new Set()).add(ATR(c.k));
    };
    for (let g = 1; g <= 5; g++) {
      const me = SPR.fire.find(c => c.g == g);
      __T.setup(me.k, 12);
      for (let n = 0; n < 40; n++) {
        S.stam = 10; S.wins = n % 5 == 0 ? 4 : 0; openBattle();
        BT.cands.forEach((e, k) => {
          chk(e, e.boss ? Math.min(5, g + 1) : g, e.boss, `${ST6[g]}の修行${e.boss ? 'ボス' : ''}`);
          // 強さは元の敵のまま
          const base = e.boss ? BOSS : EN.find(x => x.t == e.t), a = mkEnemy(e, e.f, e.boss), b = mkEnemy(base, e.f, e.boss);
          if (['hp', 'atk', 'def', 'spd', 'matk', 'mdef'].some(x => a[x] != b[x])) bad.push(`${ST6[g]}: ${e.n} の強さが変わった`);
          const im = document.querySelectorAll('#oel .esp img')[k], sp = Object.values(SPR).flat().find(x => x.k == e.sp);
          if (!im || !sp || im.src != sp.u) bad.push(`${ST6[g]}: 敵選び画面の絵がドット絵でない`);
          else if (getComputedStyle(im).imageRendering != 'pixelated') bad.push('敵選び画面の絵がぼやける');
        });
        if (n == 0) { const e = BT.cands[0]; bfight(mkEnemy(e, e.f, e.boss), S.st.hp, null, false);
          const im = document.querySelector('#esp img'), sp = Object.values(SPR).flat().find(x => x.k == e.sp);
          if (!im || im.src != sp.u || document.getElementById('enm').textContent != e.n) bad.push(`${ST6[g]}: バトル画面の敵の絵・名前がちがう`);
          BT.busy = 1; }
      }
      // ダンジョンの道中の敵(出てきた敵を横取りして調べる。バトルには入らない)
      const oL = eLook, oF = bfight; let got = null;
      eLook = (...a) => (got = oL(...a)); bfight = () => {};
      for (let n = 0; n < 10; n++) {
        S.dun = -99; openDungeon(); dstop(); devent('foe');
        chk(got, g, 0, `${ST6[g]}のダンジョン`);
        const im = document.querySelector('#dev img');
        if (!im || im.src != Object.values(SPR).flat().find(x => x.k == got.sp).u) bad.push(`${ST6[g]}のダンジョン: 道中の絵がドット絵でない`);
        clearInterval(DG.iv); DG.run = 0;
      }
      await new Promise(r => setTimeout(r, 1200)); eLook = oL; bfight = oF;
    }
    return { bad, seen: Object.keys(seen).map(g => ST6[g] + seen[g].size + '属性').join('・') };
  });
  add('全段階で、敵がドット絵キャラになり、名前とタイプが設定と合う', !R.bad.length,
    R.bad.length ? R.bad.slice(0, 4).join('、') : `幼体〜究極体で修行(ボスは1つ上・👑つき)・ダンジョンとも、隠し進化なし・強さは元のまま(出た属性: ${R.seen})`);
  // ボスの見た目: 魔王の影 = マオウドラゴの影
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 4).k);
  await page.evaluate(k => { __T.setup(k, 12); S.dun = -99; openDungeon(); dstop(); DG.fl = 4; dnext(); }, k);
  await page.waitForFunction(() => !document.getElementById('ob').hidden && BT && BT.en.boss, null, { timeout: 15000 });
  const B = await page.evaluate(() => {
    const im = document.querySelector('#esp img'), f = im ? getComputedStyle(im).filter : '';
    return { n: document.getElementById('enm').textContent, src: im && im.src == SPR.dark[11].u, ch: SPR.dark[11].n, f, pr: im && getComputedStyle(im).imageRendering };
  });
  const okB = B.n == '魔王の影' && B.src && /brightness\(0\.2/.test(B.f) && /drop-shadow/.test(B.f) && /rgb\(1[0-9]{2}, \d+, 255\)/.test(B.f) && B.pr == 'pixelated';
  add('ボスの見た目(魔王の影)', okB, okB ? `名前「魔王の影」・${B.ch}の絵を暗くして紫の光のふち・ドット絵のまま` : `名前「${B.n}」・絵${B.src ? 'OK' : 'がちがう'}・filter ${B.f}`);
  await page.evaluate(() => { clearInterval(DG.iv); DG.run = 0; BT.busy = 1; });
  if (errors.length) add('敵の見た目テスト中のコンソールエラー', false, errors.slice(0, 3).join(' / '));
  await ctx.close();
  // 写真: 成長体・究極体のバトル(ふつう・ボス)、ダンジョンのボス
  const files = []; const maoR = [];
  for (const size of WIDTHS) {
    const { ctx, page } = await newPage(browser, size, { reduce: true });
    for (const g of [2, 5]) {
      const k = await page.evaluate(g => SPR.fire.find(c => c.g == g).k, g);
      for (const boss of [0, 1]) {
        await page.evaluate(([k, boss]) => { __T.setup(k, 12); S.stam = 10; S.wins = boss ? 4 : 0; openBattle(); const i = BT.cands.findIndex(e => !!e.boss == !!boss); bstart(i); }, [k, boss]);
        await sleep(400);
        const f = `enemy-${size.w}-${g == 2 ? 'seichou' : 'kyukyoku'}${boss ? '-boss' : ''}.png`;
        await page.screenshot({ path: path.join(OUT, f) }); files.push(f);
        await page.evaluate(() => { BT.busy = 1; });
      }
    }
    await page.evaluate(k => { __T.setup(k, 12); S.dun = -99; openDungeon(); dstop(); DG.fl = 4; dnext(); }, k);
    await page.waitForFunction(() => !document.getElementById('ob').hidden && BT && BT.en.boss, null, { timeout: 15000 });
    await sleep(400);
    const f = `enemy-${size.w}-dungeon-boss.png`; await page.screenshot({ path: path.join(OUT, f) }); files.push(f);
    // 魔王戦の専用画面: 味方は映らない・魔王のゲージは魔王のすぐ上・味方のゲージは枠の下でボタンと重ならない
    const M = await page.evaluate(() => {
      const R = e => e.getBoundingClientRect(), ar = R(document.getElementById('ar')), im = document.querySelector('#esp img'), r = im ? R(im) : null,
        eg = R(document.querySelector('#en .gg')), pl = R(document.getElementById('pl')), lg = R(document.getElementById('blog')), cm = R(document.getElementById('cmd')),
        pet = [...document.querySelectorAll('#psp img, #psp svg')].some(e => { const q = R(e); return q.width > 0 && q.height > 0; });
      return { mao: document.getElementById('ar').classList.contains('mao'), pet, w: r ? r.width / ar.width : 0, h: r ? r.height / ar.height : 0,
        gap: r ? r.top - eg.bottom : -99, gx: r ? (eg.left < r.left + r.width / 2 && eg.right > r.left + r.width / 2) : false,
        pIn: pl.left >= ar.left && pl.right <= ar.right && pl.bottom <= ar.bottom + .5 && pl.bottom > ar.bottom - 30, pOv: pl.bottom > lg.top || pl.bottom > cm.top, wide: pl.width / ar.width,
        bossOv: r ? r.bottom > pl.top + 2 : true };
    });
    maoR.push([size.w, M]);
    await page.evaluate(() => { clearInterval(DG.iv); DG.run = 0; BT.busy = 1; });
    await ctx.close();
  }
  const mt = M => `${M[0]}px`;
  const m1 = maoR.filter(([, M]) => !M.mao || M.pet);
  add('魔王戦の画面に味方キャラが映らない', !m1.length, m1.length ? `映っている: ${m1.map(mt).join('、')}` : maoR.map(([w, M]) => `${w}px: 魔王 幅${Math.round(M.w * 100)}%・高さ${Math.round(M.h * 100)}%`).join(' / '));
  const m2 = maoR.filter(([, M]) => !(M.gap >= -40 && M.gap <= 24 && M.gx) || M.w > .81 || M.h > .66);
  add('魔王のゲージが魔王の上にある(魔王は幅80%・高さ65%まで)', !m2.length, maoR.map(([w, M]) => `${w}px: すき間${Math.round(M.gap)}px${M.gx ? '' : '・中央からずれ'}・幅${Math.round(M.w * 100)}%・高さ${Math.round(M.h * 100)}%`).join(' / '));
  const m3 = maoR.filter(([, M]) => !M.pIn || M.pOv || M.wide < .8 || M.bossOv);
  add('魔王戦: 味方のゲージが枠の一番下に横長で、ボタン・メッセージと重ならない', !m3.length, maoR.map(([w, M]) => `${w}px: 枠内${M.pIn ? 'OK' : 'NG'}・重なり${M.pOv ? 'あり' : 'なし'}・幅${Math.round(M.wide * 100)}%${M.bossOv ? '・魔王と重なる' : ''}`).join(' / '));
  add('敵の写真', true, `tests/output/ に ${files.length}枚(${files.join(', ')})`);
}
// ---------- 🔊ボタンが何にも重ならない(ホーム・バトル・ダンジョン・トレーニング) ----------
async function sndCheck(browser, size) {
  const { ctx, page, errors } = await newPage(browser, size, { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);
  const probe = () => page.evaluate(() => {
    const sb = document.getElementById('snd').getBoundingClientRect(), hit = [];
    const ov = (q, nm) => { if (q.width && q.height && q.left < sb.right - .5 && sb.left < q.right - .5 && q.top < sb.bottom - .5 && sb.top < q.bottom - .5) hit.push(nm); };
    // 全画面の画面が開いているときは、その中だけを見る(下のホームは隠れている)
    const o = document.getElementById('ov'), shown = e => e.getClientRects().length && getComputedStyle(e).visibility != 'hidden' && !e.closest('[hidden]') && (o.hidden || o.contains(e));
    // 枠・ボタン・ゲージなどは箱で、見出しや文字は文字の範囲で調べる
    document.querySelectorAll('button:not(#snd),.arena,.dsc,.hpb,.dpr,.chip,.pill,.emb,.sbar,.sheet,.hud,.blog,.ts,.mach').forEach(e => { if (shown(e)) ov(e.getBoundingClientRect(), e.id || e.className || e.tagName); });
    document.querySelectorAll('h2,.bh b,.bh span,small,p').forEach(e => { if (!shown(e)) return; const r = document.createRange(); r.selectNodeContents(e); [...r.getClientRects()].forEach(q => ov(q, (e.textContent || '').trim().slice(0, 10))); });
    // 🔊が押せる(上に何もかぶっていない)
    const t = document.elementFromPoint(sb.left + sb.width / 2, sb.top + sb.height / 2);
    if (!t || t.id != 'snd') hit.push('🔊の上に別の要素');
    return [...new Set(hit)];
  });
  const R = {};
  const step = async (nm, f, ms = 400) => { await page.evaluate(f, k); await sleep(ms); R[nm] = await probe(); };
  await step('ホーム', k => { __T.setup(k, 12); });
  await step('ホーム(夜)', k => { __T.setup(k, 23); });
  await step('トレーニングのタブ', () => setTab('tr'), 600);
  await step('トレーニングのえらぶ画面', k => { __T.setup(k, 12); S.stam = 10; train(0); });
  await step('トレーニング中', () => document.getElementById('mtap').click());
  await step('対戦相手えらび', k => { __T.setup(k, 12); S.stam = 10; openBattle(); });
  await step('修行バトル', () => bstart(BT.cands.findIndex(c => !c.boss)));
  await step('技の一覧', () => bmenu(1));
  await step('ダンジョン', k => { __T.setup(k, 12); S.dun = -99; openDungeon(); dstop(); });
  const ng = Object.entries(R).filter(([, v]) => v.length).map(([n, v]) => `${n}: ${v.slice(0, 3).join('・')}`);
  if (errors.length) ng.push('コンソールエラー: ' + errors[0]);
  add(`[${size.w}px] 🔊ボタンが何にも重ならない`, !ng.length, ng.length ? ng.join(' / ') : Object.keys(R).join('・') + ' で重ならない');
  await ctx.close();
}
async function fleeCheck(browser) {
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true, speed: 4 });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);
  const vis = id => page.evaluate(id => !document.getElementById('ov').hidden && !document.getElementById(id).hidden, id);
  // 修行バトル: ごほうびなしでホームへ
  const a0 = await page.evaluate(k => { __T.setup(k, 12); S.stam = 10; openBattle(); bstart(BT.cands.findIndex(c => !c.boss)); return { wins: S.wins, st: JSON.stringify(S.st), stam: S.stam }; }, k);
  await sleep(300);
  await page.click('#c4'); await sleep(300);
  const a1 = await page.evaluate(() => ({ wins: S.wins, st: JSON.stringify(S.st), stam: S.stam, ov: document.getElementById('ov').hidden, home: !!document.querySelector('.stage .petw') }));
  const okA = a1.ov && a1.home && a1.wins === a0.wins && a1.st === a0.st && Math.abs(a1.stam - a0.stam) < 0.1;
  add('修行バトルで にげる', okA, okA ? 'ホームに戻った・勝利数も能力も変わらない(ごほうびなし)' : `ホーム${a1.ov ? 'に戻った' : 'に戻らない'}・勝利数 ${a0.wins}→${a1.wins}・能力${a1.st === a0.st ? '同じ' : 'が変わった'}`);
  // 修行バトルのボス: グレーで押せない
  await page.evaluate(() => { bfight(mkEnemy(BOSS, BOSSF2, 1), S.st.hp, null, false); }); await sleep(300);
  const b = await page.evaluate(() => { const d = document.getElementById('c4').disabled; brun(); return { d, ob: !document.getElementById('ob').hidden && !document.getElementById('ov').hidden, g: getComputedStyle(document.getElementById('c4')).filter }; });
  add('ボス戦では にげられない(修行)', b.d && b.ob && /grayscale/.test(b.g), b.d ? 'にげるがグレーで、押してもバトルが続く' : 'にげるが押せる');
  await page.evaluate(() => { BT.busy = 1; document.getElementById('ov').hidden = true; });
  // ダンジョンの通常の敵: 脱出して、それまでの獲得はもらえる
  await page.evaluate(k => { __T.setup(k, 12); S.dun = -99; openDungeon(); dstop(); DG.inc = { atk: 4, def: 3 }; devent('foe'); }, k);
  await page.waitForFunction(() => !document.getElementById('ob').hidden && BT && BT.dun && !document.getElementById('c4').disabled, null, { timeout: 10000 });
  const st0 = await page.evaluate(() => ({ atk: S.st.atk, def: S.st.def }));
  await page.click('#c4');
  let okD = true, msgD = '';
  try { await page.waitForSelector('#or:not([hidden])', { timeout: 15000 }); } catch (e) { okD = false; msgD = '結果画面が出ない'; }
  if (okD) {
    const d = await page.evaluate(() => ({ t: document.querySelector('#or .rt').textContent, atk: S.st.atk, def: S.st.def, run: DG.run, dun: S.dun === dayNow(), fl: DG.fl }));
    okD = d.t === '帰還' && d.atk >= st0.atk + 4 && d.def >= st0.def + 3 && !d.run && d.dun;
    msgD = `「${d.t}」・攻撃 ${st0.atk}→${d.atk}・防御 ${st0.def}→${d.def}${d.run ? '・ダンジョンが止まっていない' : ''}`;
    await page.click('#or button.ok');
  }
  add('ダンジョンの敵から にげる(脱出・獲得あり)', okD, msgD);
  // ダンジョンのボス: グレーで押せない
  await page.evaluate(k => { __T.setup(k, 12); S.dun = -99; openDungeon(); dstop(); DG.fl = 4; dnext(); }, k);
  await page.waitForFunction(() => !document.getElementById('ob').hidden && BT && BT.en.boss, null, { timeout: 15000 });
  const c = await page.evaluate(() => { const d = document.getElementById('c4').disabled; brun(); return { d, ob: !document.getElementById('ob').hidden, run: DG.run }; });
  add('ボス戦では にげられない(ダンジョン)', c.d && c.ob && c.run, c.d ? 'にげるがグレーで、押してもバトルが続く' : 'にげるが押せる');
  await page.evaluate(() => { clearInterval(DG.iv); DG.run = 0; BT.busy = 1; });
  if (errors.length) add('にげるテスト中のコンソールエラー', false, errors.slice(0, 3).join(' / '));
  await ctx.close();
}

// ---------- 6. 修行バトル・ダンジョンを自動で回す ----------
async function battleCheck(browser) {
  const SPEED = 8;
  const { ctx, page, errors } = await newPage(browser, WIDTHS[0], { reduce: true, speed: SPEED });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);
  await page.evaluate(k => __T.setup(k, 12), k);
  // ボス戦(手動操作の戦い)はテスト側で自動でコマンドを選ぶ
  await page.evaluate(() => setInterval(() => {
    const $ = id => document.getElementById(id);
    if (!window.__noClick && !$('ov').hidden && !$('ob').hidden && BT && BT.en && !BT.auto && !BT.busy && !$('c0').disabled) bturn(autoPick());
  }, 40));
  const N = 15, stuck = [];
  let win = 0, bossN = 0, bossWin = 0;
  for (let i = 0; i < N; i++) {
    const r0 = await page.evaluate(() => {
      S.stam = 10; openBattle();
      const k = Math.max(0, BT.cands.findIndex(c => c.boss)), e = BT.cands[k];
      S.stam -= 3; bfight(mkEnemy(e, e.f, e.boss), S.st.hp, null, true);
      return { boss: !!e.boss, wins: S.wins };
    });
    try {
      await page.waitForSelector('#or:not([hidden])', { timeout: 60000 });
    } catch (e) { stuck.push(`${i + 1}戦目`); await page.evaluate(() => { document.getElementById('ov').hidden = true; }); continue; }
    const w = await page.evaluate(w0 => S.wins > w0, r0.wins);
    screenTexts.push(['バトル結果', await page.evaluate(() => document.body.innerText)]);
    if (w) win++;
    if (r0.boss) { bossN++; if (w) bossWin++; }
    await page.click('#or button.ok');
  }
  await page.evaluate(() => { window.__noClick = true; });
  add('修行バトル 自動' + N + '戦', !stuck.length,
    (stuck.length ? `止まった: ${stuck.join('、')}。` : '全戦 最後まで終了。') + `勝ち ${win}/${N}、ボス勝率 ${bossN ? bossWin + '/' + bossN : '(ボス戦なし)'}`);
  // ダンジョンの一人称視点: 層ごとの色・奥に見える敵・なめらかさ
  const V = await page.evaluate(async () => {
    const fr = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r)));
    S.dun = -99; openDungeon(); dstop();
    const avg = () => { const c = document.getElementById('dcv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; return [r / n, g / n, b / n].map(Math.round); };
    const cols = [];
    for (let fl = 1; fl <= 5; fl++) { DG.fl = fl; DG.pg = 20; DG.evs = [{ at: 99, k: 'box', done: 1 }]; await fr(); cols.push(avg()); }
    DG.fl = 2; DG.evs = [{ at: 60, k: 'foe', done: 0 }];
    const ws = [];
    for (const pg of [20, 40, 55, 59.8]) { DG.pg = pg; await fr(); const im = document.querySelector('#dob img'); ws.push(im ? im.getBoundingClientRect().width : 0); }
    const en = DG.evs[0].en, sp = en && Object.values(SPR).flat().find(x => x.k == en.sp), im0 = document.querySelector('#dob img');
    const okSrc = !!(im0 && sp && im0.src == sp.u), pet = !!document.querySelector('#od .dpet, #od .pet');
    // そのまま進めてイベントを起こす: 目の前に同じ敵が同じ大きさで出る(バトルには入らない)
    const oF = bfight; bfight = () => {}; dgo();
    await new Promise(r => { const t = setInterval(() => { if (DG.evs[0].done) { clearInterval(t); r(); } }, 5); });
    const dv = document.querySelector('#dev img'), same = !!(dv && sp && dv.src == sp.u), dw = dv ? dv.getBoundingClientRect().width : 0;
    clearInterval(DG.iv); await new Promise(r => setTimeout(r, 1500)); bfight = oF;
    // 一歩ずつ進む: 1歩=DSTEP.pg 進んで止まり、イベントの位置でちょうど止まる
    const oD = devent; let at = null; devent = () => { at = DG.pg; };
    DG.run = 1; DG.pause = 0; DG.fl = 1; DG.pg = 0; DG.sk = null; DG.evs = [{ at: 30, k: 'box', done: 0 }];
    const lands = [], iv = setInterval(() => { dtick(); if (DG.sk == DSN() && lands[lands.length - 1] !== +DG.pg.toFixed(2)) lands.push(+DG.pg.toFixed(2)); }, 50);
    await new Promise(r => { const t = setInterval(() => { if (at != null) { clearInterval(t); r(); } }, 10); setTimeout(r, 8000); });
    clearInterval(iv); devent = oD; DG.run = 0;
    // 歩いているときの描画回数
    DG.run = 1; DG.pause = 0; DG.fl = 1; DG.pg = 0; DG.evs = [{ at: 99, k: 'box', done: 0 }]; dview();
    const tk = setInterval(() => { DG.pg = Math.min(98, DG.pg + .75); }, 50);
    await new Promise(r => setTimeout(r, 300)); const n0 = DGV.n, t0 = performance.now();
    await new Promise(r => setTimeout(r, 1500)); const fps = (DGV.n - n0) / ((performance.now() - t0) / 1000);
    clearInterval(tk); DG.run = 0;
    return { cols, ws, okSrc, pet, same, dw, fps, lands, at, step: DSTEP.pg };
  });
  // イベントの絵: 絵文字ではなくドット絵(コードで描いた画像)。近づくとき・目の前に来たとき・階段・たき火
  const EV = await page.evaluate(async () => {
    const fr = () => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))), bad = [], seen = [];
    const emo = el => /\p{Extended_Pictographic}/u.test(el.textContent);
    const ok = (el, where) => { const d = el && el.querySelector('.dpx'); if (!d) { bad.push(where + ': ドット絵がない'); return; }
      const cs = getComputedStyle(d), r = d.getBoundingClientRect();
      if (!/^url\("data:image\/png/.test(cs.backgroundImage)) bad.push(where + ': 画像でない');
      if (cs.imageRendering != 'pixelated') bad.push(where + ': ぼやける');
      if (!r.width || !r.height) bad.push(where + ': 大きさ0');
      if (emo(el)) bad.push(where + ': 絵文字がある');
      el.querySelectorAll('.dpx').forEach(x => seen.push(x.dataset.k)); };
    const oA = window.DAUTO; window.DAUTO = o => o[0].k;
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); await fr();
    for (const k of ['box', 'spr', 'trp', 'shr']) { DG.fl = 1; DG.pg = 20; DG.evs = [{ at: 30, k, done: 0, gold: false }]; await fr(); ok(document.querySelector('#dob .dobj'), k + 'が近づく') }
    DG.evs = []; DG.pg = 90; await fr(); ok(document.querySelector('#dob .dstr'), '階段');
    const oR = Math.random;
    for (const [k, m] of [['spr'], ['trp'], ['shr'], ['box', .9], ['box', .05]]) {
      if (m != null) Math.random = () => m;
      const pr = devent(k, { gold: false }); ok(document.getElementById('dev'), k + 'が目の前');
      if (m != null) { for (let i = 0; i < 200 && !document.querySelector('#dev .dpx[data-k="open"],#dev .dpx[data-k="mimic"]'); i++) await new Promise(r => setTimeout(r, 20)); Math.random = oR; ok(document.getElementById('dev'), m < .2 ? 'ミミック' : '開いた宝箱'); }
      await pr; dstop();
    }
    const oF = bfight; let bc = 0; bfight = () => { bc = 1; }; DG.run = 1; DG.fl = 4; dnext(); ok(document.getElementById('dev'), 'ボス前のたき火');
    for (let i = 0; i < 300 && !bc; i++) await new Promise(r => setTimeout(r, 40)); bfight = oF; DG.run = 0; window.DAUTO = oA;
    return { bad, seen: [...new Set(seen)] };
  });
  add('ダンジョン: イベントの絵が絵文字でなくドット絵', !EV.bad.length && ['box', 'open', 'fx', 'mimic', 'spr', 'trp', 'shr', 'stair', 'fire'].every(k => EV.seen.includes(k)),
    EV.bad.length ? EV.bad.slice(0, 4).join('、') : `出てきた絵: ${EV.seen.join('・')}`);
  const cd = (a, b) => Math.abs(a[0] - b[0]) + Math.abs(a[1] - b[1]) + Math.abs(a[2] - b[2]);
  const dup = []; V.cols.forEach((a, i) => V.cols.forEach((b, j) => { if (i < j && cd(a, b) < 15) dup.push(`${i + 1}層と${j + 1}層`); }));
  add('ダンジョン: 層ごとに色が違う(1〜4層・ボス部屋)', !dup.length, dup.length ? `似ている: ${dup.join('、')}` : V.cols.map((c, i) => `${i + 1}層 rgb(${c})`).join(' / '));
  const grow = V.ws.every((w, i) => w > 0 && (i == 0 || w > V.ws[i - 1]));
  add('ダンジョン: 敵イベントの前に、奥に敵が見えて近づくほど大きくなる', grow && V.okSrc && V.same && !V.pet && Math.abs(V.dw / V.ws[3] - 1) < .15,
    `幅 ${V.ws.map(Math.round).join('→')}px、止まった時 ${Math.round(V.dw)}px、ドット絵${V.okSrc ? '一致' : '不一致'}、出てきた敵${V.same ? '同じ' : 'ちがう'}${V.pet ? '、自分のキャラが映っている' : ''}`);
  add('ダンジョン: 一歩ずつ進み、イベントの位置でちょうど止まる', V.at === 30 && V.lands.join() == [V.step, V.step * 2, V.step * 3, 30].join(), `止まった位置 ${V.lands.join('→')}、イベント ${V.at}`);
  add('ダンジョン: 描画が30fps以上', V.fps >= 30, `${Math.round(V.fps)}fps`);
  // ダンジョンの音: 入るとダンジョンBGM・出るとホーム。ふつうの敵はバトルBGMで終わると戻る。魔王戦は たき火 → 魔王戦の曲 → 結果
  const AUR = await page.evaluate(async () => {
    AU.init(); const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 300 && !f(); i++) await w(40); return f(); };
    const r = {}; S.dun = -99; openDungeon(); r.in = AU.cur(); const o0 = window.__osc; await w(1600); r.osc = window.__osc - o0;
    dstop(); clearInterval(DG.iv); window.__b0 = BT; devent('foe'); await until(() => BT !== window.__b0 && BT.en && !BT.en.boss && !document.getElementById('ob').hidden); r.foe = AU.cur();
    BT.busy = 1; BT.dun(1, {}, BT.php); r.back = AU.cur(); dstop(); dend(3); r.out = AU.cur();
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); window.__b0 = BT; DG.fl = 4; dnext(); r.fire = AU.cur();
    await until(() => BT !== window.__b0 && BT.en && BT.en.boss && !document.getElementById('ob').hidden); r.boss = AU.cur(); const o1 = window.__osc; await w(1600); r.bosc = window.__osc - o1;
    BT.busy = 1; bend(1); r.end = AU.cur(); document.getElementById('ov').hidden = true; return r;
  });
  add('ダンジョンに入るとダンジョンBGMになり、出るとホームに戻る(動作確認のみ・聞こえ方は未確認)', AUR.in == 'dun' && AUR.osc > 0 && AUR.foe == 'train' && AUR.back == 'dun' && AUR.out == 'home',
    `入る ${AUR.in}(${AUR.osc}音)→ 敵とのバトル ${AUR.foe} → 戻る ${AUR.back} → 出る ${AUR.out}`);
  add('魔王戦でBGMが切り替わる(動作確認のみ・聞こえ方は未確認)', AUR.fire == 'fire' && AUR.boss == 'boss' && AUR.bosc > 0 && AUR.end == 'home',
    `たき火 ${AUR.fire} → 魔王戦 ${AUR.boss}(${AUR.bosc}音)→ 結果 ${AUR.end}`);
  // ダンジョンのMP: HPと同じく持ち越す。階段・泉で回復、たき火で全回復。修行バトルは毎戦最大
  const MP = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 300 && !f(); i++) await w(40); return f(); },
      ob = () => !document.getElementById('ob').hidden, r = {};
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); r.mx = S.st.mp; r.start = DG.mp; r.top = document.getElementById('odhv').textContent;
    window.__b0 = BT; devent('foe'); await until(() => BT !== window.__b0 && BT.en && ob()); r.b1 = BT.mp;
    // 1戦目: 一番MPを使う技を1回使ってから勝ったことにする
    const s = known().filter(x => x.mp > 0 && x.mp <= BT.mp).sort((a, b) => b.mp - a.mp)[0] || Object.assign({}, known()[0], { mp: 3 });
    BT.en.hp = 99999; BT.php = 9999; await bturn({ k: 'sk', s }); r.e1 = BT.mp;
    BT.busy = 1; bend(1); r.d1 = DG.mp; DG.hp = DG.mx; dstop();
    window.__b0 = BT; devent('foe'); await until(() => BT !== window.__b0 && BT.en && ob()); r.b2 = BT.mp;
    // MPが足りない技はグレー
    BT.mp = 0; bmenu(1); const sk = [...document.querySelectorAll('#skl .sk2')]; r.gray = known().every((x, i) => sk[i] && !!sk[i].disabled == (x.mp > 0)); bmenu(0);
    BT.busy = 1; BT.dun(1, {}, DG.mx); dstop();
    // 階段・泉
    r.mmx = DG.mmx; DG.mp = 1; DG.fl = 1; const pn = dnext(); await until(() => DG.fl == 2); r.st = DG.mp; await pn; dstop();
    DG.mp = 1; devent('spr'); r.sp = DG.mp; await w(1700); dstop();
    // ボス前のたき火
    // ボス前のたき火: HP・MPを最大の50%分だけ回復(最大値は超えない)。回復量を表示
    const oF = bfight, oA = window.DAUTO; r.fire = [];
    for (const [h, m] of [[1, 0], [DG.mx - 1, DG.mmx - 1], [DG.mx, DG.mmx]]) {
      let arg = null, gn = ''; bfight = (...a) => { arg = a; }; window.DAUTO = (o, kind) => { gn = document.getElementById('dgn').textContent; return 'go'; };
      DG.run = 1; DG.hp = h; DG.mp = m; DG.fl = 4; dnext(); const now = [DG.hp, DG.mp];
      await until(() => arg); r.fire.push({ h, m, hp: now[0], mp: now[1], mx: DG.mx, mmx: DG.mmx, boss: [arg[1], arg[5]], gn: /たき火で回復 HP \+\d+ \/ MP \+\d+/.test(gn) });
    }
    bfight = oF; window.DAUTO = oA; DG.run = 0;
    // 修行バトル: 毎戦最大で始まる
    S.stam = 10; S.wins = 0; openBattle(); bstart(0); r.t1 = BT.mp; BT.mp = 1; BT.busy = 1; S.stam = 10; openBattle(); bstart(0); r.t2 = BT.mp; BT.busy = 1;
    document.getElementById('ov').hidden = true; return r;
  });
  add('ダンジョン: 1戦目の終了MPが2戦目の開始MPと同じ(足りない技はグレー)', MP.start == MP.mx && MP.b1 == MP.mx && MP.e1 < MP.mx && MP.d1 == MP.e1 && MP.b2 == MP.e1 && MP.gray && /MP/.test(MP.top),
    `開始 ${MP.b1}/${MP.mx} → 1戦目終了 ${MP.e1} → 2戦目開始 ${MP.b2}、グレー${MP.gray ? 'OK' : 'NG'}、上の表示「${MP.top}」`);
  const eSt = Math.min(MP.mmx, 1 + Math.round(MP.mmx * .12)), eSp = Math.min(MP.mmx, 1 + Math.round(MP.mmx * .35));
  add('ダンジョン: 階段・泉でMPが回復する', MP.st == eSt && MP.sp == eSp, `MP1から 階段 ${MP.st}(期待${eSt})・泉 ${MP.sp}(期待${eSp})`);
  { const [a, b, c] = MP.fire, half = (v, x) => Math.min(x, v + Math.round(x * .5));
    add('ダンジョン: たき火でHP・MPが最大の50%分だけ回復する(回復量を表示)', a.hp == half(a.h, a.mx) && a.mp == half(a.m, a.mmx) && a.boss[0] == a.hp && a.boss[1] == a.mp && a.gn,
      `HP ${a.h}→${a.hp}/${a.mx}・MP ${a.m}→${a.mp}/${a.mmx}、魔王戦の開始 HP${a.boss[0]}・MP${a.boss[1]}、表示${a.gn ? 'あり' : 'なし'}`);
    add('ダンジョン: たき火の回復は最大値を超えない・満タンでも壊れない', b.hp == b.mx && b.mp == b.mmx && c.hp == c.mx && c.mp == c.mmx && c.gn && c.boss[0] == c.mx,
      `満タン-1 → HP ${b.hp}/${b.mx}・MP ${b.mp}/${b.mmx}、満タン → HP ${c.hp}/${c.mx}・MP ${c.mp}/${c.mmx}(+0の表示${c.gn ? 'あり' : 'なし'})`); }
  add('修行バトルは毎戦MPが最大で始まる', MP.t1 == MP.mx && MP.t2 == MP.mx, `1戦目 ${MP.t1}・2戦目 ${MP.t2}(最大 ${MP.mx})`);
  // 選べるイベント: 乱数を固定して、各選択肢の成功・失敗が説明どおりか
  const CH = await page.evaluate(async () => {
    const bad = [], log = [], oR = Math.random, oA = window.DAUTO, sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv);
    // k: イベント, ev, c: 選ぶキー, r: 乱数, want(前, 後): 期待どおりなら空、ちがえば理由
    const run = async (name, k, ev, c, r, want) => {
      DG.hp = DG.mx; DG.mp = Math.floor(DG.mmx / 2); const b = { hp: DG.hp, mp: DG.mp, inc: Object.assign({}, DG.inc) };
      let shown = null; window.DAUTO = o => { shown = o; return c; }; Math.random = () => r;
      try { await devent(k, ev); } finally { Math.random = oR; }
      const a = { hp: DG.hp, mp: DG.mp, inc: Object.assign({}, DG.inc) }, d = {}; for (const x in a.inc) if (a.inc[x] != (b.inc[x] || 0)) d[x] = a.inc[x] - (b.inc[x] || 0);
      const why = want({ dhp: a.hp - b.hp, dmp: a.mp - b.mp, d, shown });
      if (why) bad.push(name + ': ' + why); else log.push(name); dstop();
    };
    const mx = () => DG.mx, mm = () => DG.mmx;
    // 宝箱(ふつう: ミミック10% HP-12% / 能力+2、豪華: ミミック35% HP-18% / 能力+3、やめる: 何もなし)
    for (const [g, mi, hp, up] of [[false, .1, .12, 2], [true, .35, .18, 3]]) {
      const nm = g ? '豪華な宝箱' : '宝箱';
      await run(nm + '・開ける→ミミック', 'box', { gold: g }, 'open', mi - .01, x => x.dhp == -Math.round(mx() * hp) && !Object.keys(x.d).length ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
      await run(nm + '・開ける→能力アップ', 'box', { gold: g }, 'open', mi + .01, x => x.dhp == 0 && sum(x.d) == GR(Object.keys(x.d)[0], up) && Object.keys(x.d).length == 1 ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
      await run(nm + '・やめる', 'box', { gold: g }, 'no', .01, x => x.dhp == 0 && !Object.keys(x.d).length ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
    }
    // 罠(避ける=素早さ・解除する=魔攻 の成功率は 能力/(能力+定数)、20〜90%。耐える=必ずダメージ+防御・魔防)
    const P = S.st, l = Math.max(1, Math.round(DG.mx * .15 * (1 - Math.min(.6, (P.def + P.mdef) / 80)))), pa = dtrp(P.spd), pb = dtrp(P.matk);
    const rate = (x, i, p) => { const m = x.shown && x.shown[i].s.match(/(\d+)%/); if (!m || +m[1] != Math.round(p * 100)) return `表示${m ? m[1] : '?'}%・計算${Math.round(p * 100)}%`; return ''; };
    // 表示の%のすぐ下・すぐ上の乱数で、成功・失敗が分かれる(=表示が実際と一致)
    await run('罠・避ける→成功', 'trp', null, 'dodge', Math.round(pa * 100) / 100 - .006, x => rate(x, 0, pa) || (x.dhp == 0 && sum(x.d) == GR('spd', 1) && x.d.spd ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`));
    await run('罠・避ける→失敗', 'trp', null, 'dodge', Math.round(pa * 100) / 100 + .006, x => x.dhp == -l && !Object.keys(x.d).length ? '' : `HP${x.dhp}(期待-${l})・能力${JSON.stringify(x.d)}`);
    await run('罠・解除する→成功', 'trp', null, 'undo', Math.round(pb * 100) / 100 - .006, x => rate(x, 1, pb) || (x.dhp == 0 && x.dmp == Math.min(mm() - Math.floor(mm() / 2), Math.round(mm() * .1)) && x.d.matk && Object.keys(x.d).length == 1 ? '' : `HP${x.dhp}・MP${x.dmp}・能力${JSON.stringify(x.d)}`));
    await run('罠・解除する→失敗', 'trp', null, 'undo', Math.round(pb * 100) / 100 + .006, x => x.dhp == -Math.round(l * 1.3) && !Object.keys(x.d).length ? '' : `HP${x.dhp}(期待-${Math.round(l * 1.3)})・能力${JSON.stringify(x.d)}`);
    await run('罠・耐える', 'trp', null, 'bear', .01, x => x.dhp == -l && x.d.def && x.d.mdef && Object.keys(x.d).length == 2 ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
    // 祠(修行する=HP-6%・能力+2、祈る=HP・MP+15%、通り過ぎる=何もなし)
    await run('祠・修行する', 'shr', null, 'train', .5, x => x.dhp == -Math.round(mx() * .06) && Object.keys(x.d).length == 1 && sum(x.d) == GR(Object.keys(x.d)[0], 2) ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
    DG.hp = 1; await run('祠・祈る', 'shr', null, 'pray', .5, x => x.dhp == 0 && x.dmp == Math.min(mm() - Math.floor(mm() / 2), Math.round(mm() * .15)) && !Object.keys(x.d).length ? '' : `MP${x.dmp}・能力${JSON.stringify(x.d)}`);
    { const hp0 = Math.max(1, DG.mx - Math.round(DG.mx * .15) - 3); DG.hp = hp0; window.DAUTO = () => 'pray'; await devent('shr'); if (DG.hp != hp0 + Math.round(DG.mx * .15)) bad.push(`祠・祈る: HP ${hp0}→${DG.hp}`); dstop(); }
    await run('祠・通り過ぎる', 'shr', null, 'pass', .5, x => x.dhp == 0 && x.dmp == 0 && !Object.keys(x.d).length ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
    // 成功率は20〜90%におさまる
    const st0 = Object.assign({}, S.st); S.st.spd = 1; S.st.matk = 9999; const lo = dtrp(S.st.spd), hi = dtrp(S.st.matk); S.st = st0;
    if (lo != .2 || hi != .9) bad.push(`成功率の範囲 ${lo}〜${hi}`); else log.push('成功率は20〜90%');
    window.DAUTO = oA; DG.run = 0; document.getElementById('ov').hidden = true;
    return { bad, log, pa: Math.round(pa * 100), pb: Math.round(pb * 100), K: DTK[S.stage], stg: S.stage };
  });
  add('ダンジョン: 乱数を固定して、宝箱・罠・祠の各選択肢の成功と失敗が説明どおり', !CH.bad.length, CH.bad.length ? CH.bad.slice(0, 4).join('、') : `${CH.log.length}通りOK(${CH.log.join('、')})`);
  add('ダンジョン: 罠の成功率の表示が実際の計算と一致', ['罠・避ける→成功', '罠・避ける→失敗', '罠・解除する→成功', '罠・解除する→失敗'].every(n => CH.log.includes(n)),
    `段階${CH.stg}(定数${CH.K}): 避ける ${CH.pa}%・解除する ${CH.pb}%。表示の%のすぐ下の乱数で成功、すぐ上で失敗`);
  // 進むか帰るか: 帰ると獲得がそのままもらえる(階段の前・たき火のあと)
  const BK = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 300 && !f(); i++) await w(40); return f(); }, oA = window.DAUTO, out = [];
    for (const fl of [1, 4]) {
      S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); DG.inc = { atk: 3, def: 2, hp: 5 }; const st0 = Object.assign({}, S.st); let seen = null;
      window.DAUTO = (o, kind) => { const g = document.getElementById('dgn'); seen = { kind, t: o.map(x => x.t).join('/'), gn: g.hidden ? '' : g.textContent, h: Math.min(...[...document.querySelectorAll('#dcb button')].map(b => b.offsetHeight)) }; return 'back'; };
      DG.fl = fl; dnext(); await until(() => !document.getElementById('or').hidden);
      const em = {}; document.querySelectorAll('#or .gr').forEach(g => { em[g.querySelector('span').textContent.replace(/^\S+\s/, '')] = +g.querySelector('em').textContent.replace('+', ''); });
      const ds = {}; for (const k in S.st) if (S.st[k] != st0[k]) ds[k] = S.st[k] - st0[k];
      out.push({ fl, seen, ds, em, title: document.querySelector('#or .rt').textContent });
      document.getElementById('ov').hidden = true;
    }
    window.DAUTO = oA; return out;
  });
  const bkOk = BK.every(b => b.seen && b.seen.kind == 'path' && /ここまでの獲得/.test(b.seen.gn) && /半分/.test(b.seen.gn) && b.seen.h >= 56 && JSON.stringify(b.ds) == JSON.stringify({ hp: 5, atk: 3, def: 2 }) && b.title == '帰還');
  add('ダンジョン: 進むか帰るかで帰ると、獲得がそのままもらえる', bkOk, BK.map(b => `${b.fl == 1 ? '1層の階段前' : 'たき火のあと'}: 「${b.seen ? b.seen.t : '選択肢なし'}」→ ${b.title}、増えた能力 ${JSON.stringify(b.ds)}${b.seen && /ここまでの獲得/.test(b.seen.gn) ? '' : '・獲得の表示なし'}`).join(' / '));
  // オート: 無難な選択・進むか帰るかは待つ・バトルの自動/手動・にげる・バトル中の切り替え
  const AT = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 300) => { for (let i = 0; i < n && !f(); i++) await w(40); return f(); },
      $ = id => document.getElementById(id), oA = window.DAUTO, r = { bad: [] }, setAuto = on => { if (DAU != on) dauto(); };
    window.DAUTO = null; r.init = DAU;
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); setAuto(true);
    // A: 無難ルール。選んだボタンが強調されるまでの時間も見る
    const pick = async (name, k, ev, prep, want) => {
      DG.hp = DG.mx; DG.mp = DG.mmx; const st0 = Object.assign({}, S.st); prep(); const t0 = performance.now(); const pr = devent(k, ev);
      await until(() => document.querySelector('#dcb .pick')); const e = document.querySelector('#dcb .pick'), got = e && e.dataset.k, ms = performance.now() - t0;
      await pr; dstop(); S.st = st0; (got == want && ms >= 100 ? r.ok = (r.ok || []) : r.bad).push(`${name}→${got}${got == want ? '' : '(期待' + want + ')'}`);
    };
    await pick('ふつうの宝箱', 'box', { gold: false }, () => { DG.hp = Math.round(DG.mx * .3); }, 'open');
    await pick('豪華な宝箱・HP60%以上', 'box', { gold: true }, () => { DG.hp = Math.ceil(DG.mx * .6); }, 'open');
    await pick('豪華な宝箱・HP60%未満', 'box', { gold: true }, () => { DG.hp = Math.floor(DG.mx * .6) - 1; }, 'no');
    await pick('罠・素早さが高い', 'trp', null, () => { S.st.spd = 300; S.st.matk = 5; }, 'dodge');
    await pick('罠・魔攻が高い', 'trp', null, () => { S.st.spd = 5; S.st.matk = 300; }, 'undo');
    await pick('罠・同じ', 'trp', null, () => { S.st.spd = 40; S.st.matk = 40; }, 'bear');
    await pick('祠・元気', 'shr', null, () => {}, 'train');
    await pick('祠・HP60%未満', 'shr', null, () => { DG.hp = Math.floor(DG.mx * .6) - 1; }, 'pray');
    await pick('祠・MP60%未満', 'shr', null, () => { DG.mp = Math.floor(DG.mmx * .6) - 1; }, 'pray');
    // B: 進むか帰るかは、オートONでも止まって待つ
    DG.fl = 1; const pn = dnext(); await w(3000); r.wait1 = !$('dch').hidden && DG.fl == 1 && $('dcb').textContent.includes('進む');
    $('dcb').querySelector('[data-k="go"]').click(); await until(() => DG.fl == 2); await pn; dstop();
    DG.fl = 4; const oF = bfight; let bc = 0; bfight = () => { bc = 1; }; const pb = dnext(); await w(4000); r.wait2 = !$('dch').hidden && !bc && $('dcb').textContent.includes('魔王に挑む');
    $('dcb').querySelector('[data-k="go"]').click(); await until(() => bc); bfight = oF; await pb; DG.run = 0;
    // C: オートONで通常の敵・魔王戦が自動で進む(押さなくてもターンが進む)
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); DG.hp = DG.mx = 99999; window.__b0 = BT; devent('foe');
    await until(() => BT !== window.__b0 && !$('ob').hidden); r.foeAuto = BT.auto; await until(() => $('ob').hidden, 4000); r.foeDone = $('ob').hidden && !$('od').hidden;
    DG.fl = 4; window.DAUTO = (o, kind) => 'go'; window.__b0 = BT; dnext(); await until(() => BT !== window.__b0 && BT.en.boss && !$('ob').hidden);
    r.bossAuto = BT.auto; await until(() => BT.turn >= 2, 3000); r.bossTurn = BT.turn; BT.busy = 1; BT.auto = false; DG.run = 0; window.DAUTO = null;
    // D・E: オートOFFでは通常の敵でもコマンドが出る。にげるで脱出して獲得はそのまま
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); setAuto(false); DG.inc = { atk: 2 }; window.__b0 = BT; devent('foe');
    await until(() => BT !== window.__b0 && !$('ob').hidden); await w(2500);
    r.manual = { turn: BT.turn, c0: !$('c0').disabled, cmd: $('cmd').style.visibility != 'hidden', bau: !$('bau').hidden && $('bau').textContent.includes('OFF'), c4: !$('c4').disabled };
    const atk0 = S.st.atk; $('c4').click(); await until(() => !$('or').hidden); r.flee = { t: document.querySelector('#or .rt').textContent, d: S.st.atk - atk0 }; $('ov').hidden = true;
    // F: バトル中に切り替えても壊れない(ON→進む、OFF→そのターンで止まる、ON→また進む)
    S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv); DG.hp = DG.mx = 99999; window.__b0 = BT; devent('foe');
    await until(() => BT !== window.__b0 && !$('ob').hidden); const b = BT; b.en.hp = b.en.max = 99999; await w(1500); const t0 = b.turn;
    dauto(); await until(() => b.turn >= t0 + 2, 3000); dauto(); await until(() => !b.busy); const t1 = b.turn; await w(2500); const t2 = b.turn, en = !$('c0').disabled;
    dauto(); await until(() => b.turn >= t2 + 1, 3000); const t3 = b.turn; b.busy = 1; b.auto = false; DG.run = 0; setAuto(true);
    r.sw = { t0, t1, t2, t3, en, ok: t0 == 0 && t1 >= 2 && t2 == t1 && en && t3 >= t2 + 1 };
    $('ov').hidden = true; window.DAUTO = oA; return r;
  });
  add('オートONで、宝箱・罠・祠の選択が無難ルールどおり(約1秒見せて強調)', !AT.bad.length, AT.bad.length ? AT.bad.join('、') : AT.ok.join('、'));
  add('オートONでも、進むか帰るか・魔王に挑むかは止まって待つ', AT.wait1 && AT.wait2, `階段の前 ${AT.wait1 ? '待つ' : '待たない'}・たき火のあと ${AT.wait2 ? '待つ' : '待たない'}`);
  add('オートONで通常の敵・魔王戦が自動で進む', AT.foeAuto && AT.foeDone && AT.bossAuto && AT.bossTurn >= 2, `通常の敵 ${AT.foeDone ? '自動で決着' : '止まった'}・魔王戦 ${AT.bossTurn}ターン自動で進行`);
  add('オートOFFで通常の敵でもコマンドが出る', AT.manual.turn == 0 && AT.manual.c0 && AT.manual.cmd && AT.manual.bau, `待ってもターン ${AT.manual.turn}・こうげき${AT.manual.c0 ? '押せる' : '押せない'}・オート表示${AT.manual.bau ? 'OFF' : '?'}`);
  add('ダンジョン中のバトルで にげるが使える(獲得はそのまま)', AT.manual.c4 && AT.flee.t == '帰還' && AT.flee.d == 2, `にげる${AT.manual.c4 ? '押せる' : 'グレー'} → ${AT.flee.t}・攻撃力+${AT.flee.d}`);
  add('バトル中にオートを切り替えても壊れない', AT.sw.ok, `ON→${AT.sw.t1}ターン目で OFF→待っても${AT.sw.t2}ターン(こうげき${AT.sw.en ? '押せる' : '押せない'})→ON→${AT.sw.t3}ターン`);
  // 分かれ道
  const FK = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 300) => { for (let i = 0; i < n && !f(); i++) await w(40); return f(); },
      $ = id => document.getElementById(id), oA = window.DAUTO, oR = Math.random, r = { bad: [] };
    if (DAU) dauto(); S.dun = -99; openDungeon(); dstop(); clearInterval(DG.iv);
    // 1. 配置: 1層は1回、2〜4層は1〜2回。ほかのイベントは今までどおり2〜3個、離れた位置。4層はたき火の手前(70より先)に出ない
    const cnt = {};
    for (let fl = 1; fl <= 4; fl++) for (let n = 0; n < 60; n++) {
      DG.fl = fl; dfloor(); const f = DG.evs.filter(e => e.k == 'frk'), o = DG.evs.filter(e => e.k != 'frk');
      (cnt[fl] = cnt[fl] || {})[f.length] = (cnt[fl][f.length] || 0) + 1;
      if (fl == 1 ? f.length != 1 : f.length < 1 || f.length > 2) r.bad.push(`${fl}層: 分かれ道${f.length}回`);
      if (o.length < 2 || o.length > 3 || o.some(e => !['foe', 'box', 'spr', 'trp', 'shr'].includes(e.k))) r.bad.push(`${fl}層: ほかのイベント ${o.map(e => e.k)}`);
      if (f.some(x => DG.evs.some(e => e !== x && Math.abs(e.at - x.at) <= 9) || !x.p.includes('m') || x.at < 15 || x.at > (fl >= 4 ? 70 : 80))) r.bad.push(`${fl}層: 位置・道 ${f.map(x => Math.round(x.at) + x.p.join(''))}`);
      if (DG.evs.some((e, i) => i && e.at < DG.evs[i - 1].at)) r.bad.push(`${fl}層: 順番`);
    }
    r.cnt = cnt;
    // 2. 画面: 道のボタン(高さ・画面内)と、通路の分かれ(左の道があると左の壁が暗い)
    DG.fl = 2; DG.pg = 50; DG.evs = [{ at: 50, k: 'frk', done: 1, p: ['l', 'm', 'r'] }]; let shown = null; window.DAUTO = null;
    const pr = devent('frk', DG.evs[0]); await until(() => !$('dch').hidden); await w(200);
    const bs = [...document.querySelectorAll('#dcb button')]; r.btn = { t: bs.map(b => b.firstChild.textContent).join('/'), h: Math.min(...bs.map(b => b.offsetHeight)), bottom: Math.max(...bs.map(b => b.getBoundingClientRect().bottom)) <= innerHeight };
    const lum = () => { const c = $('dcv'), x = c.getContext('2d'), y = Math.round(c.height * .45), d = x.getImageData(0, y, Math.round(c.width / 8), Math.round(c.height * .08)).data; let s = 0; for (let i = 0; i < d.length; i += 4) s += d[i] + d[i + 1] + d[i + 2]; return s / (d.length / 4); };
    const l3 = lum(); DG.fkCur.p = ['m', 'r']; await w(200); const l2 = lum(); DG.fkCur.p = ['l', 'm', 'r']; r.dark = { l3: Math.round(l3), l2: Math.round(l2) };
    // オートOFFは止まって待つ
    await w(2500); r.wait = !$('dch').hidden; window.DAUTO = o => o[0].k; const oP0 = dfkPick; dfkPick = () => 'heal'; bs[1].click(); await pr; dfkPick = oP0; dstop();
    // 3. 重み(4000回)と、強めの敵・罠のすぐあとは出ない
    DG.fkL = null; const fq = {}; for (let n = 0; n < 4000; n++) { const o = dfkPick(); fq[o] = (fq[o] || 0) + 1; }
    const tot = Object.values(DFW).reduce((a, b) => a + b, 0); r.fq = Object.keys(DFW).map(k => `${k} ${Math.round((fq[k] || 0) / 40)}%(${Math.round(DFW[k] / tot * 100)}%)`).join('・');
    if (Object.keys(DFW).some(k => Math.abs((fq[k] || 0) / 4000 - DFW[k] / tot) > .035)) r.bad.push('重みとちがう: ' + r.fq);
    for (const L of ['foe', 'trp']) { DG.fkL = L; for (let n = 0; n < 500; n++) { const o = dfkPick(); if (o == 'foe' || o == 'trp') { r.bad.push(`${L}のあとに${o}`); break; } } }
    // 4. 選んだ先: 回復・宝箱・罠はそのイベント、強めの敵は強さと報酬が倍率どおり、近道は1〜2個飛ばす
    const oP = dfkPick, oF = bfight, oM = mkEnemy; window.DAUTO = o => o[0].k; DG.hp = DG.mx = 9999;
    for (const [o, want] of [['heal', /spr|shr/], ['box', /box/], ['trp', /trp/]]) {
      dfkPick = () => o; let seen = ''; const pe = devent('frk', { p: ['l', 'm'] }); await until(() => { const d = document.querySelector('#dev .dpx'); if (d) seen = d.dataset.k; return d; }); await pe; dstop();
      if (!want.test(seen)) r.bad.push(`${o}→${seen || '何も出ない'}`);
    }
    let fArg = null, cb = null; dfkPick = () => 'foe'; mkEnemy = (en, f, b) => { fArg = f; return oM(en, f, b); }; bfight = (e, php, dun) => { cb = dun; };
    DG.fl = 3; await devent('frk', { p: ['m', 'r'] }); await until(() => cb); mkEnemy = oM; bfight = oF;
    const atk0 = DG.inc.atk || 0; if (cb) { if (!BT) BT = { mp: DG.mp }; cb(1, { atk: 10 }, DG.hp); } dstop();
    r.foe = { f: fArg, want: (.45 + 3 * .07) * DFS.str, rew: (DG.inc.atk || 0) - atk0, wrew: Math.round(10 * DFS.rew) };
    if (!cb || Math.abs(r.foe.f - r.foe.want) > 1e-9 || r.foe.rew != r.foe.wrew) r.bad.push(`強めの敵: 倍率${r.foe.f}(期待${r.foe.want})・報酬+${r.foe.rew}(期待+${r.foe.wrew})`);
    dfkPick = () => 'short'; r.short = [];
    for (const m of [.7, .3]) {
      DG.pg = 30; DG.evs = [{ at: 30, k: 'frk', done: 1, p: ['l', 'm'] }, { at: 40, k: 'box', done: 0 }, { at: 55, k: 'spr', done: 0 }, { at: 70, k: 'trp', done: 0 }];
      const pe = devent('frk', DG.evs[0]); await until(() => !$('dch').hidden || DG.pg > 30); Math.random = () => m; await pe; Math.random = oR; dstop();
      r.short.push(DG.evs.filter(e => e.done && e.k != 'frk').length + '個飛ばし・進行' + Math.round(DG.pg));
    }
    if (r.short.join() != '1個飛ばし・進行47,2個飛ばし・進行62') r.bad.push('近道: ' + r.short.join('、'));
    dfkPick = oP;
    // 5. オートONは「まっすぐ」を強調して選ぶ
    window.DAUTO = null; dauto(); DG.pg = 50; const t0 = performance.now(), pa = devent('frk', { p: ['l', 'm', 'r'] }); await until(() => document.querySelector('#dcb .pick'));
    const pk = document.querySelector('#dcb .pick'); r.auto = { k: pk && pk.dataset.k, ms: Math.round(performance.now() - t0) }; dfkPick = () => 'short'; await pa; dfkPick = oP; dauto(); dstop();
    // 6. 効果音
    AU.init(); const o0 = window.__osc; AU.sfx('fork'); await w(100); r.snd = window.__osc - o0;
    window.DAUTO = oA; DG.run = 0; document.getElementById('ov').hidden = true; return r;
  });
  add('分かれ道が各層に出る(1層は1回・2〜4層は1〜2回、ほかのイベントは今までどおり)', !FK.bad.some(x => /層/.test(x)), Object.entries(FK.cnt).map(([fl, c]) => `${fl}層 ${Object.entries(c).map(([n, k]) => n + '回×' + k).join(' ')}`).join(' / ') + (FK.bad.length ? ' / ' + FK.bad.filter(x => /層/.test(x)).slice(0, 2).join('、') : ''));
  add('分かれ道の画面: 通路が分かれて見え、道のボタンが375×667でも収まる', FK.btn.t == '左の道/まっすぐ/右の道' && FK.btn.h >= 44 && FK.btn.bottom && FK.dark.l3 < FK.dark.l2 * .7, `ボタン「${FK.btn.t}」高さ${FK.btn.h}px${FK.btn.bottom ? '' : '・はみ出し'}、左の壁の明るさ 左の道あり${FK.dark.l3}/なし${FK.dark.l2}`);
  add('分かれ道の先: 重みどおりで、強めの敵・罠は続かない', !FK.bad.some(x => /重み|のあとに/.test(x)), FK.fq);
  add('分かれ道の先: 回復・宝箱・罠・強めの敵(倍率)・近道が説明どおり', !FK.bad.some(x => /→|強めの敵|近道/.test(x)), `強めの敵 強さ×${FK.foe.f && (FK.foe.f / (.45 + 3 * .07)).toFixed(2)}・報酬 10→${FK.foe.rew}、近道 ${FK.short.join('、')}` + (FK.bad.length ? ' / ' + FK.bad.join('、') : ''));
  add('分かれ道: オートONは「まっすぐ」を約1秒見せて選ぶ・オートOFFは止まって待つ', FK.auto.k == 'm' && FK.auto.ms >= 100 && FK.wait, `オートON→${FK.auto.k}(${FK.auto.ms}ms・8倍速)、オートOFF→${FK.wait ? '待つ' : '待たない'}`);
  add('分かれ道の効果音(動作確認のみ・聞こえ方は未確認)', FK.snd > 0, `${FK.snd}音`);
  // ダンジョン: オートONで5回、オートOFF(選択はランダム・コマンドはテストが自動で押す)で2回。進むか帰るかはテストの仕組みで「進む」
  await page.evaluate(() => { window.__fw = { n: 0, w: 0 }; const oB = bfight;
    bfight = (en, php, dun, ...a) => oB(en, php, dun && !en.boss ? (win, ...b) => { __fw.n++; if (win) __fw.w++; return dun(win, ...b); } : dun, ...a); });
  const runD = async (on, D) => {
    await page.evaluate(on => { if (DAU != on) dauto(); __fw.n = __fw.w = 0; }, on);
    const dstuck = [], floors = []; let clear = 0, reach5 = 0;
    for (let i = 0; i < D; i++) {
      await page.evaluate(() => { S.dun = -99; openDungeon(); });
      try {
        await page.waitForSelector('#or:not([hidden])', { timeout: 120000 });
      } catch (e) {
        dstuck.push(`${i + 1}回目(${await page.evaluate(() => '第' + DG.fl + '層 ' + document.getElementById('odm').textContent)})`);
        await page.evaluate(() => { clearInterval(DG.iv); DG.run = 0; document.getElementById('ov').hidden = true; });
        continue;
      }
      const r = await page.evaluate(() => ({ fl: Math.min(DG.fl, 5), t: document.querySelector('#or .rt').textContent }));
      screenTexts.push(['ダンジョン結果', await page.evaluate(() => document.body.innerText)]);
      floors.push(r.fl);
      if (r.fl >= 5) reach5++;
      if (r.t.includes('攻略')) clear++;
      await page.click('#or button.ok');
    }
    const fw = await page.evaluate(() => __fw);
    return { dstuck, floors, clear, reach5, fw, txt: (dstuck.length ? `止まった: ${dstuck.join('、')}。` : '全回 最後まで終了。') + `到達層 ${floors.join(',')}、ボス勝率 ${reach5 ? clear + '/' + reach5 : '(ボスまで行けず)'}、通常の敵 ${fw.w}/${fw.n}勝` };
  };
  const D = 5, on5 = await runD(true, D);
  add('ダンジョン 自動' + D + '回(オートON)', !on5.dstuck.length, on5.txt);
  await page.evaluate(() => { window.__noClick = false; });
  const off2 = await runD(false, 2);
  add('ダンジョン 2回(オートOFF・選択とコマンドはテストが自動操作)', !off2.dstuck.length, off2.txt);
  // 設定が再読み込みで残る
  const RL = [];
  for (const on of [true, false]) {
    await page.evaluate(on => { if (DAU != on) dauto(); }, on);
    await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
    RL.push(await page.evaluate(() => ({ dau: DAU, cls: document.getElementById('dau').className })));
  }
  add('オートの設定が再読み込みで残る(最初はオフ)', AT.init === false && RL[0].dau === true && /on/.test(RL[0].cls) && RL[1].dau === false && /off/.test(RL[1].cls), `最初 ${AT.init ? 'ON' : 'OFF'}、ON→再読み込み ${RL[0].dau ? 'ON' : 'OFF'}、OFF→再読み込み ${RL[1].dau ? 'ON' : 'OFF'}`);
  add('バトル・ダンジョン中のコンソールエラー', !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  await ctx.close();
}

// ---------- 7. 古い4段階の言葉 ----------
function oldWordCheck() {
  const found = [];
  for (const [where, txt] of screenTexts)
    for (const w of OLD_WORDS)
      if (txt.includes(w) && !found.some(f => f.w === w)) found.push({ w, where });
  add('古い4段階の言葉が画面にない', !found.length,
    found.length ? found.map(f => `「${f.w}」(${f.where})`).join('、') : `${screenTexts.length}画面を確認、見つからず(${OLD_WORDS.join('/')})`);
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  console.log('ウォークモンスター 自動テスト開始\n');
  syntaxCheck();
  const browser = await chromium.launch();
  const steps = [
    ['読み込み・音', () => loadAndSound(browser)],
    ...WIDTHS.map(s => [`キャラ表示 ${s.w}px`, () => charaCheck(browser, s)]),
    ['一生', () => lifeCheck(browser)],
    ['お世話', () => careCheck(browser)],
    ['メッセージ', () => msgCheck(browser)],
    ['キャラ表示で段階', () => chrPickCheck(browser)],
    ['歴代の子', () => histCheck(browser)],
    ['ダークモード', () => darkCheck(browser)],
    ['空と寝る時間', () => skyCheck(browser)],
    ...[...WIDTHS, { w: 430, h: 932 }].map(s => [`バトル配置 ${s.w}px`, () => battleLayoutCheck(browser, s)]),
    ['敵の見た目', () => enemyLookCheck(browser)],
    ...WIDTHS.map(s => [`🔊の位置 ${s.w}px`, () => sndCheck(browser, s)]),
    ['にげる', () => fleeCheck(browser)],
    ['バトル・ダンジョン', () => battleCheck(browser)],
  ];
  for (const [name, fn] of steps) {
    try { await fn(); } catch (e) { add(name, false, 'テストが途中で止まった: ' + e.message.split('\n')[0]); }
  }
  oldWordCheck();
  await browser.close();
  const ng = results.filter(r => !r.ok);
  console.log(`\n==== 結果: OK ${results.length - ng.length} / NG ${ng.length}(${Math.round((Date.now() - t0) / 1000)}秒) ====`);
  results.forEach(r => console.log(`${r.ok ? 'OK' : 'NG'}  ${r.name}`));
  if (ng.length) console.log('\nNG の理由:\n' + ng.map(r => `- ${r.name}: ${r.msg}`).join('\n'));
  console.log('\n※音は「鳴らされているか」だけ確認。聞こえ方は確認できません。');
  process.exit(ng.length ? 1 : 0);
})();
