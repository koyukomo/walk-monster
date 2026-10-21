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
    return { sky: st.classList.contains('night') ? '夜空' : st.classList.contains('eve') ? '夕方' : '昼', star: !!st.querySelector('.sky'),
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
async function battleLayoutCheck(browser, size) {
  const { ctx, page, errors } = await newPage(browser, size, { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 4).k);
  await page.evaluate(k => { __T.setup(k, 12); S.stam = 10; openBattle(); bstart(BT.cands.findIndex(c => !c.boss)); }, k);
  await sleep(400);
  const L = await page.evaluate(() => {
    const r = e => (typeof e == 'string' ? document.querySelector(e) : e).getBoundingClientRect();
    const sw = document.documentElement.scrollWidth;
    const bs = ['c0', 'c2', 'c3', 'c4'].map(id => { const b = r('#' + id); return { id, t: document.getElementById(id).firstChild.textContent, w: b.width, h: b.height, top: b.top, bot: b.bottom, l: b.left, rt: b.right }; });
    const en = r('#en'), pl = r('#pl'), es = r('#esp'), ps = r('#psp'), eh = r('#en .hpb'), ph = r('#pl .hpb'), cmd = r('#cmd');
    return { W: innerWidth, H: innerHeight, sw, bs, en: { l: en.left, r: en.right, t: en.top, b: en.bottom }, pl: { l: pl.left, r: pl.right, t: pl.top, b: pl.bottom },
      gap: pl.top - en.bottom, eHp: es.top - eh.bottom, pHp: ps.top - ph.bottom, cmdBot: cmd.bottom };
  });
  const ng = [];
  const names = L.bs.map(b => b.t).join('・');
  if (names !== 'こうげき・ぼうぎょ・必殺技・にげる') ng.push(`ボタンが ${names}`);
  L.bs.forEach(b => { if (b.h < 44 || b.w < 44) ng.push(`${b.t}が小さい(${Math.round(b.w)}×${Math.round(b.h)})`); if (b.bot > L.H || b.rt > L.W || b.l < 0) ng.push(`${b.t}が画面からはみ出す`); });
  if (L.sw > L.W) ng.push('横スクロールが出る');
  if (!(L.en.r > L.pl.r && L.en.t < L.pl.t)) ng.push('敵が右上・味方が左下になっていない');
  if (L.gap > 10) ng.push(`敵と味方が ${Math.round(L.gap)}px 離れている`);
  if (L.eHp > 20 || L.pHp > 40) ng.push(`HPバーがキャラから遠い(敵${Math.round(L.eHp)}px・味方${Math.round(L.pHp)}px)`);
  if (L.H - L.cmdBot > 30) ng.push(`画面の下に ${Math.round(L.H - L.cmdBot)}px の余白`);
  await page.screenshot({ path: path.join(OUT, `battle-${size.w}.png`) });
  add(`[${size.w}px] バトル画面の配置とボタン`, !ng.length, ng.length ? ng.join('、') :
    `${names}(${L.bs.map(b => Math.round(b.w) + '×' + Math.round(b.h)).join(', ')})、敵と味方の間 ${Math.round(L.gap)}px、下の余白 ${Math.round(L.H - L.cmdBot)}px`);
  if (errors.length) add(`[${size.w}px] バトル配置テスト中のコンソールエラー`, false, errors.slice(0, 3).join(' / '));
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
  await page.waitForFunction(() => !document.getElementById('ob').hidden && BT && BT.auto, null, { timeout: 10000 });
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
    if (!$('ov').hidden && !$('ob').hidden && BT && BT.en && !BT.auto && !BT.busy && !$('c0').disabled) bturn(autoPick());
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
  add('修行バトル 自動' + N + '戦', !stuck.length,
    (stuck.length ? `止まった: ${stuck.join('、')}。` : '全戦 最後まで終了。') + `勝ち ${win}/${N}、ボス勝率 ${bossN ? bossWin + '/' + bossN : '(ボス戦なし)'}`);
  // ダンジョン
  const D = 5, dstuck = [];
  let clear = 0, reach5 = 0;
  const floors = [];
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
  add('ダンジョン 自動' + D + '回', !dstuck.length,
    (dstuck.length ? `止まった: ${dstuck.join('、')}。` : '全回 最後まで終了。') + `到達層 ${floors.join(',')}、ボス勝率 ${reach5 ? clear + '/' + reach5 : '(ボスまで行けず)'}`);
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
    ...WIDTHS.map(s => [`バトル配置 ${s.w}px`, () => battleLayoutCheck(browser, s)]),
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
