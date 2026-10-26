// ウォークモンスター 自動テスト
// 実行: npm test(ふだん用・重いテストなし) / npm run test:full(全部) / npm test -- --only dungeon(グループを指定。カンマで複数)
// グループ: home(ホーム・お世話・一生) / battle(バトル) / dungeon(ダンジョン) / sound(音) / other(その他)
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
// --full: 重いテスト(ダンジョンの通し・修行バトル15戦)も動かす。--only: グループ(またはテスト名の一部)を指定
const argv = process.argv.slice(2), FULL = argv.includes('--full'), optOnly = argv.includes('--only') ? argv[argv.indexOf('--only') + 1] : null;
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
    // ダンジョンの選択肢はテストでは自動で選ぶ: イベントはランダム、進むか帰るかは「進む」、ひきかえすの確認は「はい」
    window.DAUTO = (o, kind) => kind == 'path' || kind == 'back' ? o[0].k : o[Math.floor(Math.random() * o.length)].k;
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
        S.dgSteps = 1e7; // ダンジョン用の歩数(テストでは十分に持たせる。歩数切れのテストでは個別に減らす)
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
      const rc = chk([...document.querySelectorAll('#cmd button:not([hidden])')], 'コマンド');
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
        S.dg = null; openDungeon(); dstop(); devent('foe');
        chk(got, g, 0, `${ST6[g]}のダンジョン`);
        const tmp = document.createElement('div'); tmp.innerHTML = esv(got); const im = tmp.querySelector('img'); // バトル画面に出る絵(演出のあとバトルで出る)
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
  await page.evaluate(k => { __T.setup(k, 12); S.dg = null; openDungeon(); dstop(); DG.fl = 4; dnext(); }, k);
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
    await page.evaluate(k => { __T.setup(k, 12); S.dg = null; openDungeon(); dstop(); DG.fl = 4; dnext(); }, k);
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
// ---------- ダンジョン: オートボタンが切れない・長いメッセージでも動かない・使わない選択パネルは見えない ----------
async function autoLayoutCheck(browser, size) {
  const { ctx, page, errors } = await newPage(browser, size, { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);
  const L = await page.evaluate(async k => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 300) => { for (let i = 0; i < n && !f(); i++) await w(40); return f(); },
      $ = id => document.getElementById(id), R = e => { const r = e.getBoundingClientRect(); return { l: r.left, r: r.right, t: r.top, b: r.bottom, w: r.width, h: r.height }; },
      VW = document.documentElement.clientWidth, bad = [], LONG = '魔王の影のぜつぼうのいかずち!なかまに123のダメージ。からだがしびれて動けない…';
    // 画面内に完全に収まるか
    const inside = (id, where) => { const b = $(id), r = R(b); if (!(r.w > 0 && r.l >= 0 && r.r <= VW + .5 && r.b <= innerHeight + .5)) bad.push(`${where}: オートボタンが切れる(左${Math.round(r.l)}・右${Math.round(r.r)}/${VW})`); return r; };
    const same = (a, b) => ['l', 't', 'w', 'h'].every(x => Math.abs(a[x] - b[x]) < .6);
    // 中身がメッセージ欄に収まるか(高さは固定)
    const fits = (id, where) => { const b = $(id), cs = getComputedStyle(b), av = b.clientHeight - parseFloat(cs.paddingTop) - parseFloat(cs.paddingBottom) + 1, sum = [...b.children].reduce((a, c) => a + c.offsetHeight, 0); if (sum > av) bad.push(`${where}: メッセージがはみ出す(${sum}/${Math.round(av)}px)`); };
    const panel = where => { const c = $('dch'), r = R(c), vis = getComputedStyle(c).display != 'none' || r.h > 0 || [...document.querySelectorAll('#dcb button, #dgn')].some(e => R(e).h > 0); if (vis) bad.push(`${where}: 選択パネルが見える`); };
    __T.setup(k, 12); window.DAUTO = null; if (DAU) dauto();
    // 歩く画面
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); await w(400); panel('歩く画面');
    const a0 = inside('dau', '歩く画面'), m0 = R($('odm')), k0 = R($('dbk'));
    dm(LONG); await w(50); const a1 = inside('dau', '歩く画面・長いメッセージ'); fits('odm', '歩く画面');
    if (!same(a0, a1) || !same(m0, R($('odm'))) || !same(k0, R($('dbk')))) bad.push('歩く画面: 長いメッセージでボタンの位置・大きさが変わる');
    // 選択の画面と、選び終わったあと
    const pr = devent('shr'); await until(() => !$('dch').hidden); await w(200); inside('dau', '祠の選択'); $('dcb').querySelector('button').click(); await pr; dstop(); await w(100); panel('選択のあと');
    dauto(); inside('dau', '歩く画面・オートON'); dauto();
    // 通常の敵とのバトル・魔王戦(長いメッセージ)
    const bat = async (where, boss) => {
      window.__b0 = BT; if (boss) { window.DAUTO = () => 'go'; DG.fl = 4; dnext(); } else devent('foe');
      await until(() => BT !== window.__b0 && !$('ob').hidden && !!BT.en.boss == boss); await w(1200); BT.busy = 1; window.DAUTO = null;
      const b0 = inside('bau', where), l0 = R($('blog')), c0 = [...document.querySelectorAll('#cmd button')].map(R);
      blg(LONG); blg(LONG + 'もう一度!'); await w(50); const b1 = inside('bau', where + '・長いメッセージ'); fits('blog', where);
      if (!same(b0, b1) || !same(l0, R($('blog'))) || [...document.querySelectorAll('#cmd button')].map(R).some((r, i) => !same(r, c0[i]))) bad.push(where + ': 長いメッセージでボタンの位置・大きさが変わる');
      return { w: Math.round(b1.w), h: Math.round(b1.h), r: Math.round(b1.r) };
    };
    const foe = await bat('通常の敵', false); BT.auto = false; clearInterval(DG.iv); DG.run = 0;
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); const boss = await bat('魔王戦', true);
    DG.run = 0; return { bad, foe, boss, dau: { w: Math.round(a0.w), h: Math.round(a0.h) }, VW };
  }, k);
  add(`[${size.w}px] どの画面でもオートボタンが画面内に完全に収まる`, !L.bad.some(x => /切れる/.test(x)), `歩く画面 ${L.dau.w}×${L.dau.h}px・バトル ${L.foe.w}×${L.foe.h}px(右端 ${L.boss.r}/${L.VW}px)` + (L.bad.length ? ' / ' + L.bad.filter(x => /切れる/.test(x)).slice(0, 3).join('、') : ''));
  add(`[${size.w}px] 長いメッセージ(40文字ほど)でもオートボタンの位置と大きさが変わらない`, !L.bad.some(x => /変わる|はみ出す/.test(x)), L.bad.filter(x => /変わる|はみ出す/.test(x)).join('、') || '歩く画面・通常の敵・魔王戦とも変わらず、メッセージは欄の中に収まる');
  add(`[${size.w}px] 選択がないときに、選択パネルの枠が見えない`, !L.bad.some(x => /パネル/.test(x)), L.bad.filter(x => /パネル/.test(x)).join('、') || '歩く画面・選び終わったあと とも非表示(display:none)');
  if (errors.length) add(`[${size.w}px] オートボタンのテスト中のコンソールエラー`, false, errors.slice(0, 3).join(' / '));
  await ctx.close();
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
  await step('ダンジョン', k => { __T.setup(k, 12); S.dg = null; openDungeon(); dstop(); });
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
  // ダンジョンの通常の敵: にげる(成功率は素早さで決まる)。成功 → 歩く画面に戻る(報酬なし)/失敗 → そのターンは敵の攻撃を受ける
  const FL = await page.evaluate(async k => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 400 && !f(); i++) await w(25); return f(); }, $ = id => document.getElementById(id), oR = Math.random, r = {}, oA = window.DAUTO, oL = blg, logs = [];
    blg = t => { logs.push(t); return oL(t); };
    const start = async () => { __T.setup(k, 12); DENC.foe = DENC.trp = 0; window.DAUTO = null; if (DAU) dauto(); S.dg = null; S.dgSteps = 1e6; openDungeon(); dstop(); DG.inc = { atk: 4 }; devent('foe'); await until(() => !$('ob').hidden && BT && BT.dun && !BT.busy && !$('c4').disabled); };
    await start(); r.label = $('c4').textContent; const one = v => { let n = 0; Math.random = () => n++ ? oR() : v; };
    one(0); $('c4').click(); await until(() => !$('od').hidden); Math.random = oR; await w(300);
    r.ok = { od: !$('od').hidden, or: !$('or').hidden, m: $('odm').textContent, inc: DG.inc.atk, walk: DG.run && !DG.pause }; dstop(); clearInterval(DG.iv); DG.run = 0;
    await start(); const hp0 = BT.php; one(.999); $('c4').click(); await until(() => !BT.busy); Math.random = oR;
    r.ng = { log: $('blog').textContent, all: logs.join(' / '), ob: !$('ob').hidden, turn: BT.turn, hp: hp0 - BT.php, en: BT.en.n }; BT.busy = 1; clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true; window.DAUTO = oA; blg = oL; return r;
  }, k);
  add('ダンジョン: にげるに成功すると、歩く画面に戻って歩きつづける(報酬なし)', FL.ok.od && !FL.ok.or && /うまく逃げきった/.test(FL.ok.m) && FL.ok.inc == 4 && FL.ok.walk && /成功 \d+%/.test(FL.label),
    `ボタン「${FL.label}」→ ${FL.ok.od ? '歩く画面' : '戻らない'}「${FL.ok.m}」・獲得 攻撃+${FL.ok.inc}のまま・${FL.ok.walk ? '歩きだした' : '止まったまま'}`);
  add('ダンジョン: にげるに失敗すると、そのターンは敵の攻撃を受ける', FL.ng.ob && FL.ng.turn == 1 && /にげられなかった/.test(FL.ng.all) && new RegExp(FL.ng.en + '(の|は)').test(FL.ng.all.split('にげられなかった')[1] || ''),
    `「${FL.ng.all.slice(-60)}」・HP-${FL.ng.hp}・バトル${FL.ng.ob ? 'つづく' : '終わった'}`);
  // ダンジョンのボス: グレーで押せない
  await page.evaluate(k => { __T.setup(k, 12); S.dg = null; openDungeon(); dstop(); DG.fl = 4; dnext(); }, k);
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
  // 突然のイベント(ランダムエンカウント)は、決まった動きを見るテストでは止める(ダンジョンの通しの前に戻す)
  await page.evaluate(() => { window.__E0 = Object.assign({}, DENC); DENC.foe = DENC.trp = 0; });
  // ボス戦(手動操作の戦い)はテスト側で自動でコマンドを選ぶ
  await page.evaluate(() => setInterval(() => {
    const $ = id => document.getElementById(id);
    if (!window.__noClick && !$('ov').hidden && !$('ob').hidden && BT && BT.en && !BT.auto && !BT.busy && !$('c0').disabled) bturn(autoPick());
  }, 40));
  const N = FULL ? 15 : 3, stuck = [];
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
    S.dg = null; openDungeon(); dstop();
    const avg = () => { const c = document.getElementById('dcv'), d = c.getContext('2d').getImageData(0, 0, c.width, c.height).data; let r = 0, g = 0, b = 0;
      for (let i = 0; i < d.length; i += 4) { r += d[i]; g += d[i + 1]; b += d[i + 2]; } const n = d.length / 4; return [r / n, g / n, b / n].map(Math.round); };
    const cols = [];
    DG.fl = 1; DG.pg = 20; DG.evs = [{ at: 99, k: 'box', done: 1 }]; for (let i = 0; i < 5; i++) await fr(); // 入った直後の画面が落ち着くまで待つ
    for (const fl of [1, 6, 11, 16, 21, 3, 26]) { DG.fl = fl; DG.pg = 20; DG.evs = [{ at: 99, k: 'box', done: 1 }]; await fr(); cols.push(avg()); }
    DG.fl = 1; window.__pal = [1, 3, 5, 6, 26, 50].map(n => floorParams(n).pal).join(',');
    DG.fl = 2; DG.evs = [{ at: 60, k: 'foe', done: 0 }];
    const ws = [];
    for (const pg of [20, 40, 55, 59.8]) { DG.pg = pg; await fr(); const im = document.querySelector('#dob img'); ws.push(im ? im.getBoundingClientRect().width : 0); }
    const en = DG.evs[0].en, sp = en && Object.values(SPR).flat().find(x => x.k == en.sp), im0 = document.querySelector('#dob img');
    const okSrc = !!(im0 && sp && im0.src == sp.u), pet = !!document.querySelector('#od .dpet, #od .pet');
    // そのまま進めてイベントを起こす: 出現の演出のあと、見えていたのと同じ敵とバトルになる(バトルには入らない)
    const oF = bfight; let fe = null; bfight = e => { fe = e; }; dgo();
    await new Promise(r => { const t = setInterval(() => { if (fe) { clearInterval(t); r(); } }, 5); setTimeout(r, 40000); });
    const same = !!(fe && sp && fe.sp == sp.k), dw = 0;
    clearInterval(DG.iv); await new Promise(r => setTimeout(r, 300)); bfight = oF;
    // 一歩ずつ進む: 1歩=DSTEP.pg(1)進んで止まり、イベントの位置でちょうど止まる
    const oD = devent; let at = null; devent = () => { at = DG.pg; };
    DG.run = 1; DG.pause = 0; DG.fl = 1; DG.pg = 0; DG.sk = null; DG.evs = [{ at: 5, k: 'box', done: 0 }];
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
      if (!/^(pixelated|crisp-edges)$/.test(cs.imageRendering)) bad.push(where + ': ぼやける');
      if (!r.width || !r.height) bad.push(where + ': 大きさ0');
      if (emo(el)) bad.push(where + ': 絵文字がある');
      el.querySelectorAll('.dpx').forEach(x => seen.push(x.dataset.k)); };
    const oA = window.DAUTO; window.DAUTO = o => o[0].k;
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); await fr();
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
  const AFL = [1, 6, 11, 16, 21], dup = []; V.cols.slice(0, 5).forEach((a, i) => V.cols.slice(0, 5).forEach((b, j) => { if (i < j && cd(a, b) < 15) dup.push(`${AFL[i]}階層と${AFL[j]}階層`); }));
  const pal = await page.evaluate(() => window.__pal), same = pal == '1,1,1,2,1,5' && cd(V.cols[0], V.cols[5]) < 45 && cd(V.cols[0], V.cols[6]) < 45;
  add('ダンジョン: 5階層ごとのエリアで色が変わる(同じエリアは同じ色・6エリア目から使い回し)', !dup.length && same, (dup.length ? `似ている: ${dup.join('、')} / ` : '') + AFL.map((f, i) => `${f}階層 rgb(${V.cols[i]})`).join(' / ') + `、色の番号(1,3,5,6,26,50階層) ${pal}、3階層 rgb(${V.cols[5]})・26階層 rgb(${V.cols[6]})`);
  const grow = V.ws.every((w, i) => w > 0 && (i == 0 || w > V.ws[i - 1]));
  add('ダンジョン: 敵イベントの前に、奥に敵が見えて近づくほど大きくなる(同じ敵とバトル)', grow && V.okSrc && V.same && !V.pet,
    `幅 ${V.ws.map(Math.round).join('→')}px、ドット絵${V.okSrc ? '一致' : '不一致'}、出てきた敵${V.same ? '同じ' : 'ちがう'}${V.pet ? '、自分のキャラが映っている' : ''}`);
  add('ダンジョン: 一歩ずつ進み、イベントの位置でちょうど止まる', V.at === 5 && V.step == 1 && V.lands.join() == '1,2,3,4,5', `止まった位置 ${V.lands.join('→')}、イベント ${V.at}`);
  add('ダンジョン: 描画が30fps以上', V.fps >= 30, `${Math.round(V.fps)}fps`);
  // ダンジョンの音: 入るとダンジョンBGM・出るとホーム。ふつうの敵はバトルBGMで終わると戻る。魔王戦は たき火 → 魔王戦の曲 → 結果
  const AUR = await page.evaluate(async () => {
    AU.init(); const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 300 && !f(); i++) await w(40); return f(); };
    const r = {}; S.dg = null; openDungeon(); r.in = AU.cur(); const o0 = window.__osc; await w(1600); r.osc = window.__osc - o0;
    dstop(); clearInterval(DG.iv); window.__b0 = BT; devent('foe'); await until(() => BT !== window.__b0 && BT.en && !BT.en.boss && !document.getElementById('ob').hidden); r.foe = AU.cur();
    BT.busy = 1; await BT.dun(1, {}, BT.php); r.back = AU.cur(); dstop(); dend(3); r.out = AU.cur();
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); window.__b0 = BT; DG.fl = 4; dnext(); r.fire = AU.cur();
    await until(() => BT !== window.__b0 && BT.en && BT.en.boss && !document.getElementById('ob').hidden); r.boss = AU.cur(); const o1 = window.__osc; await w(1600); r.bosc = window.__osc - o1;
    const oA = window.DAUTO; BT.busy = 1; window.DAUTO = (o, kind) => kind == 'back' ? 'yes' : 'back'; bend(1); await until(() => !document.getElementById('od').hidden && document.getElementById('brs').hidden); r.end = AU.cur(); await until(() => !document.getElementById('or').hidden); r.out2 = AU.cur(); window.DAUTO = oA; document.getElementById('ov').hidden = true; return r;
  });
  add('ダンジョンに入るとダンジョンBGMになり、出るとホームに戻る(動作確認のみ・聞こえ方は未確認)', AUR.in == 'dun' && AUR.osc > 0 && AUR.foe == 'train' && AUR.back == 'dun' && AUR.out == 'home',
    `入る ${AUR.in}(${AUR.osc}音)→ 敵とのバトル ${AUR.foe} → 戻る ${AUR.back} → 出る ${AUR.out}`);
  add('魔王戦でBGMが切り替わる(動作確認のみ・聞こえ方は未確認)', AUR.fire == 'fire' && AUR.boss == 'boss' && AUR.bosc > 0 && AUR.end == 'dun' && AUR.out2 == 'home',
    `たき火 ${AUR.fire} → 魔王戦 ${AUR.boss}(${AUR.bosc}音)→ 勝って次の階層 ${AUR.end} → 帰る ${AUR.out2}`);
  // ダンジョンのMP: HPと同じく持ち越す。階段・泉で回復、たき火で全回復。修行バトルは毎戦最大
  const MP = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 300 && !f(); i++) await w(40); return f(); },
      ob = () => !document.getElementById('ob').hidden, r = {};
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); r.mx = S.st.mp; r.start = DG.mp; r.top = document.getElementById('odhv').textContent;
    window.__b0 = BT; devent('foe'); await until(() => BT !== window.__b0 && BT.en && ob() && !BT.busy); r.b1 = BT.mp;
    // 1戦目: 一番MPを使う技を1回使ってから勝ったことにする
    const s = known().filter(x => x.mp > 0 && x.mp <= BT.mp).sort((a, b) => b.mp - a.mp)[0] || Object.assign({}, known()[0], { mp: 3 });
    BT.en.hp = 99999; BT.php = 9999; await bturn({ k: 'sk', s }); r.e1 = BT.mp;
    BT.busy = 1; bend(1); r.d1 = DG.mp; DG.hp = DG.mx; dstop();
    window.__b0 = BT; devent('foe'); await until(() => BT !== window.__b0 && BT.en && ob() && !BT.busy); r.b2 = BT.mp;
    // MPが足りない技はグレー
    BT.mp = 0; bmenu(1); const sk = [...document.querySelectorAll('#skl .sk2')]; r.gray = known().every((x, i) => sk[i] && !!sk[i].disabled == (x.mp > 0)); bmenu(0);
    BT.busy = 1; BT.dun(1, {}, DG.mx); dstop();
    // 階段・泉
    r.mmx = DG.mmx; DG.mp = 1; DG.fl = 1; await dclear(); r.st = DG.mp; dstop();
    DG.mp = 1; devent('spr'); r.sp = DG.mp; await w(1700); dstop();
    // ボス前のたき火
    // ボス前のたき火: HP・MPを最大の50%分だけ回復(最大値は超えない)。回復量を表示
    const oF = bfight, oA = window.DAUTO; r.fire = [];
    for (const [h, m] of [[1, 0], [DG.mx - 1, DG.mmx - 1], [DG.mx, DG.mmx]]) {
      let arg = null, gn = ''; bfight = (...a) => { arg = a; }; window.DAUTO = (o, kind) => { gn = document.getElementById('dgn').textContent; return 'go'; };
      DG.run = 1; DG.hp = h; DG.mp = m; DG.fl = 4; DG.fire = null; dnext(); const now = [DG.hp, DG.mp];
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
  add('ダンジョン: ボスを倒して次の階層へ・泉でMPが回復する', MP.st == eSt && MP.sp == eSp, `MP1から 次の階層 ${MP.st}(期待${eSt})・泉 ${MP.sp}(期待${eSp})`);
  { const [a, b, c] = MP.fire, half = (v, x) => Math.min(x, v + Math.round(x * .5));
    add('ダンジョン: たき火でHP・MPが最大の50%分だけ回復する(回復量を表示)', a.hp == half(a.h, a.mx) && a.mp == half(a.m, a.mmx) && a.boss[0] == a.hp && a.boss[1] == a.mp && a.gn,
      `HP ${a.h}→${a.hp}/${a.mx}・MP ${a.m}→${a.mp}/${a.mmx}、魔王戦の開始 HP${a.boss[0]}・MP${a.boss[1]}、表示${a.gn ? 'あり' : 'なし'}`);
    add('ダンジョン: たき火の回復は最大値を超えない・満タンでも壊れない', b.hp == b.mx && b.mp == b.mmx && c.hp == c.mx && c.mp == c.mmx && c.gn && c.boss[0] == c.mx,
      `満タン-1 → HP ${b.hp}/${b.mx}・MP ${b.mp}/${b.mmx}、満タン → HP ${c.hp}/${c.mx}・MP ${c.mp}/${c.mmx}(+0の表示${c.gn ? 'あり' : 'なし'})`); }
  add('修行バトルは毎戦MPが最大で始まる', MP.t1 == MP.mx && MP.t2 == MP.mx, `1戦目 ${MP.t1}・2戦目 ${MP.t2}(最大 ${MP.mx})`);
  // 選べるイベント: 乱数を固定して、各選択肢の成功・失敗が説明どおりか
  const CH = await page.evaluate(async () => {
    const bad = [], log = [], oR = Math.random, oA = window.DAUTO, sum = o => Object.values(o).reduce((a, b) => a + b, 0);
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv);
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
    // 宝箱(ふつう: ミミック10% HP-16% / アイテム、豪華: ミミック35% HP-24% / アイテム、やめる: 何もなし)
    S.items = {};
    for (const [g, mi, hp] of DBOX.map((b, i) => [!!i, b.mi, b.hp])) {
      const nm = g ? '豪華な宝箱' : '宝箱';
      await run(nm + '・開ける→ミミック', 'box', { gold: g }, 'open', mi - .01, x => x.dhp == -Math.round(mx() * hp) && !Object.keys(x.d).length ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
      const n0 = sum(S.items);
      await run(nm + '・開ける→アイテム', 'box', { gold: g }, 'open', mi + .01, x => x.dhp == 0 && !Object.keys(x.d).length && sum(S.items) == n0 + 1 ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}・持ち物${JSON.stringify(S.items)}`);
      await run(nm + '・やめる', 'box', { gold: g }, 'no', .01, x => x.dhp == 0 && !Object.keys(x.d).length ? '' : `HP${x.dhp}・能力${JSON.stringify(x.d)}`);
    }
    // 罠(避ける=素早さ・解除する=魔攻 の成功率は 能力/(能力+定数)、20〜90%。耐える=必ずダメージ+防御・魔防)
    const P = S.st, l = Math.max(1, Math.round(DG.mx * DTRAP * (1 - Math.min(.6, (P.def + P.mdef) / 80)))), pa = dtrp(P.spd), pb = dtrp(P.matk);
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
  // 持ち物: 宝箱でアイテムが手に入り、9個で止まる / 歩く画面の「持ち物」で使うとHPが回復して1個減る
  const IT2 = await page.evaluate(async () => {
    const $ = id => document.getElementById(id), w = ms => new Promise(r => setTimeout(r, ms)), oR = Math.random, oA = window.DAUTO, r = {};
    S.dg = null; S.dgSteps = 1e6; openDungeon(); dstop(); clearInterval(DG.iv);
    // ふつうの宝箱・乱数0.5 → ミミックでなく、薬草40%のあとの魔力の欠片
    S.items = { shard: 8 }; window.DAUTO = () => 'open'; Math.random = () => .5;
    try { await devent('box', { gold: false }); r.a = S.items.shard; r.m1 = $('odm').textContent; await devent('box', { gold: false }); r.b = S.items.shard; r.m2 = $('odm').textContent; } finally { Math.random = oR; window.DAUTO = oA; }
    dstop(); S.items = { herb: 2 }; DG.hp = 5; DG.pause = 0; $('dbk').hidden = false; await w(50);
    r.vis = getComputedStyle($('dib')).display != 'none'; $('dib').click(); await w(100);
    r.open = !$('dit').hidden; r.stop = !!DG.pause; const it = document.querySelector('#dit .itr[data-k="herb"]'); r.txt = it && it.textContent;
    r.h0 = DG.hp; it.click(); await w(50); r.h1 = DG.hp; r.n = S.items.herb; r.want = 5 + Math.max(1, Math.round(DG.mx * .1));
    DG.hp = DG.mx; itList(); r.gray = document.querySelector('#dit .itr[data-k="herb"]').disabled;
    $('itc').click(); await w(100); r.closed = $('dit').hidden; r.walk = !DG.pause;
    DG.run = 0; clearInterval(DG.iv); $('ov').hidden = true; return r;
  });
  add('ダンジョン: 宝箱でアイテムが手に入り、9個で止まる', IT2.a == 9 && IT2.b == 9 && /魔力の欠片を手に入れた/.test(IT2.m1) && /持ちきれない/.test(IT2.m2), `8個→${IT2.a}個「${IT2.m1}」→${IT2.b}個「${IT2.m2}」`);
  add('ダンジョン: 持ち物で薬草を使うとHPが回復して1個減る(満タンはグレー・閉じると歩く)', IT2.vis && IT2.open && IT2.stop && IT2.h1 == IT2.want && IT2.n == 1 && IT2.gray && IT2.closed && IT2.walk,
    `ボタン${IT2.vis ? 'あり' : 'なし'}・開くと${IT2.stop ? '止まる' : '止まらない'}、HP ${IT2.h0}→${IT2.h1}(期待${IT2.want})・薬草 2→${IT2.n}、満タンで${IT2.gray ? 'グレー' : '押せる'}、閉じると${IT2.walk ? '歩く' : '止まったまま'}`);
  // 進むか帰るか: 帰ると獲得がそのままもらえる(階段の前・たき火のあと)
  const BK = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async f => { for (let i = 0; i < 300 && !f(); i++) await w(40); return f(); }, oA = window.DAUTO, out = [];
    for (const fl of [1, 4]) {
      S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); DG.inc = { atk: 3, def: 2, hp: 5 }; const st0 = Object.assign({}, S.st); let seen = null;
      window.DAUTO = (o, kind) => { if (kind == 'back') return 'yes'; const g = document.getElementById('dgn'); seen = { kind, t: o.map(x => x.t).join('/'), gn: g.hidden ? '' : g.textContent, h: Math.min(...[...document.querySelectorAll('#dcb button')].map(b => b.offsetHeight)) }; return 'back'; };
      DG.fl = fl; dnext(); await until(() => !document.getElementById('or').hidden);
      const em = {}; document.querySelectorAll('#or .gr').forEach(g => { em[g.querySelector('span').textContent.replace(/^\S+\s/, '')] = +g.querySelector('em').textContent.replace('+', ''); });
      const ds = {}; for (const k in S.st) if (S.st[k] != st0[k]) ds[k] = S.st[k] - st0[k];
      out.push({ fl, seen, ds, em, title: document.querySelector('#or .rt').textContent });
      document.getElementById('ov').hidden = true;
    }
    window.DAUTO = oA; return out;
  });
  const bkOk = BK.every(b => b.seen && b.seen.kind == 'path' && /ここまでの獲得/.test(b.seen.gn) && /半分/.test(b.seen.gn) && b.seen.h >= 56 && JSON.stringify(b.ds) == JSON.stringify({ hp: 5, atk: 3, def: 2 }) && b.title == '帰還');
  add('ダンジョン: 進むか帰るかで帰ると、獲得がそのままもらえる', bkOk, BK.map(b => `第${b.fl}階層のたき火のあと: 「${b.seen ? b.seen.t : '選択肢なし'}」→ ${b.title}、増えた能力 ${JSON.stringify(b.ds)}${b.seen && /ここまでの獲得/.test(b.seen.gn) ? '' : '・獲得の表示なし'}`).join(' / '));
  // オート: 無難な選択・進むか帰るかは待つ・バトルの自動/手動・にげる・バトル中の切り替え
  const AT = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 300) => { for (let i = 0; i < n && !f(); i++) await w(40); return f(); },
      $ = id => document.getElementById(id), oA = window.DAUTO, r = { bad: [] }, setAuto = on => { if (DAU != on) dauto(); };
    window.DAUTO = null; r.init = DAU;
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); setAuto(true);
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
    DG.fl = 1; const pn = dclear(); await w(3000); r.wait1 = !$('dch').hidden && DG.fl == 2 && $('dcb').textContent.includes('進む');
    $('dcb').querySelector('[data-k="go"]').click(); await pn; dstop();
    DG.fl = 4; const oF = bfight; let bc = 0; bfight = () => { bc = 1; }; const pb = dnext(); await w(4000); r.wait2 = !$('dch').hidden && !bc && $('dcb').textContent.includes('魔王に挑む');
    $('dcb').querySelector('[data-k="go"]').click(); await until(() => bc); bfight = oF; await pb; DG.run = 0;
    // C: オートONで通常の敵・魔王戦が自動で進む(押さなくてもターンが進む)
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); DG.hp = DG.mx = 99999; window.__b0 = BT; devent('foe');
    await until(() => BT !== window.__b0 && !$('ob').hidden); r.foeAuto = BT.auto; await until(() => $('ob').hidden, 4000); r.foeDone = $('ob').hidden && !$('od').hidden;
    DG.fl = 4; window.DAUTO = (o, kind) => 'go'; window.__b0 = BT; dnext(); await until(() => BT !== window.__b0 && BT.en.boss && !$('ob').hidden);
    r.bossAuto = BT.auto; await until(() => BT.turn >= 2, 3000); r.bossTurn = BT.turn; BT.busy = 1; BT.auto = false; DG.run = 0; window.DAUTO = null;
    // D・E: オートOFFでは通常の敵でもコマンドが出る。にげるで脱出して獲得はそのまま
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); setAuto(false); DG.inc = { atk: 2 }; window.__b0 = BT; devent('foe');
    await until(() => BT !== window.__b0 && !$('ob').hidden); await w(2500);
    r.manual = { turn: BT.turn, c0: !$('c0').disabled, cmd: $('cmd').style.visibility != 'hidden', bau: !$('bau').hidden && $('bau').textContent.includes('OFF'), c4: !$('c4').disabled };
    const oR = Math.random; let n0 = 0; Math.random = () => n0++ ? oR() : 0; $('c4').click(); await until(() => !$('od').hidden); Math.random = oR; r.flee = { od: !$('od').hidden, d: DG.inc.atk || 0 }; dstop(); clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true;
    // F: バトル中に切り替えても壊れない(ON→進む、OFF→そのターンで止まる、ON→また進む)
    S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv); DG.hp = DG.mx = 99999; window.__b0 = BT; devent('foe');
    await until(() => BT !== window.__b0 && !$('ob').hidden); const b = BT; b.en.hp = b.en.max = 99999; await w(1500); const t0 = b.turn;
    dauto(); await until(() => b.turn >= t0 + 2, 3000); dauto(); await until(() => !b.busy); const t1 = b.turn; await w(2500); const t2 = b.turn, en = !$('c0').disabled;
    dauto(); await until(() => b.turn >= t2 + 1, 3000); const t3 = b.turn; b.busy = 1; b.auto = false; DG.run = 0; setAuto(true);
    r.sw = { t0, t1, t2, t3, en, ok: t0 == 0 && t1 >= 2 && t2 == t1 && en && t3 >= t2 + 1 };
    $('ov').hidden = true; window.DAUTO = oA; return r;
  });
  add('オートONで、宝箱・罠・祠の選択が無難ルールどおり(約1秒見せて強調)', !AT.bad.length, AT.bad.length ? AT.bad.join('、') : AT.ok.join('、'));
  add('オートONでも、進むか帰るか・魔王に挑むかは止まって待つ', AT.wait1 && AT.wait2, `ボスを倒したあと ${AT.wait1 ? '待つ' : '待たない'}・たき火のあと ${AT.wait2 ? '待つ' : '待たない'}`);
  add('オートONで通常の敵・魔王戦が自動で進む', AT.foeAuto && AT.foeDone && AT.bossAuto && AT.bossTurn >= 2, `通常の敵 ${AT.foeDone ? '自動で決着' : '止まった'}・魔王戦 ${AT.bossTurn}ターン自動で進行`);
  add('オートOFFで通常の敵でもコマンドが出る', AT.manual.turn == 0 && AT.manual.c0 && AT.manual.cmd && AT.manual.bau, `待ってもターン ${AT.manual.turn}・こうげき${AT.manual.c0 ? '押せる' : '押せない'}・オート表示${AT.manual.bau ? 'OFF' : '?'}`);
  add('ダンジョン中のバトルで にげるが使える(獲得はそのまま)', AT.manual.c4 && AT.flee.od && AT.flee.d == 2, `にげる${AT.manual.c4 ? '押せる' : 'グレー'} → ${AT.flee.od ? '歩く画面' : '戻らない'}・獲得 攻撃+${AT.flee.d}`);
  add('バトル中にオートを切り替えても壊れない', AT.sw.ok, `ON→${AT.sw.t1}ターン目で OFF→待っても${AT.sw.t2}ターン(こうげき${AT.sw.en ? '押せる' : '押せない'})→ON→${AT.sw.t3}ターン`);
  // 分かれ道
  const FK = await page.evaluate(async () => {
    const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 300) => { for (let i = 0; i < n && !f(); i++) await w(40); return f(); },
      $ = id => document.getElementById(id), oA = window.DAUTO, oR = Math.random, r = { bad: [] };
    if (DAU) dauto(); S.dg = null; openDungeon(); dstop(); clearInterval(DG.iv);
    // 1. 配置: 分かれ道は20歩ごと(20・40・60・80歩目の前後 DFK.jit 歩)に4回。ほかのイベント(宝箱・泉・祠)は3〜4個、分かれ道の間(区間に1個まで)
    const cnt = {};
    for (let fl = 1; fl <= 4; fl++) for (let n = 0; n < 60; n++) {
      DG.fl = fl; dfloor(); const f = DG.evs.filter(e => e.k == 'frk'), o = DG.evs.filter(e => e.k != 'frk');
      (cnt[fl] = cnt[fl] || {})[f.length] = (cnt[fl][f.length] || 0) + 1;
      if (f.length != 4) r.bad.push(`${fl}層: 分かれ道${f.length}回`);
      if (o.length < 3 || o.length > 4 || o.some(e => !['box', 'spr', 'shr'].includes(e.k))) r.bad.push(`${fl}層: ほかのイベント ${o.map(e => e.k)}`);
      const seg = o.map(e => f.filter(x => x.at < e.at).length);
      if (o.some(e => f.some(x => Math.abs(x.at - e.at) < 4) || e.at < 4 || e.at > 96) || new Set(seg).size != seg.length) r.bad.push(`${fl}層: ほかのイベントの位置 ${o.map(e => e.at)}`);
      if (f.some((x, i) => !x.p.includes('m') || Math.abs(x.at - 20 * (i + 1)) > DFK.jit)) r.bad.push(`${fl}層: 位置・道 ${f.map(x => Math.round(x.at) + x.p.join(''))}`);
      if (DG.evs.some((e, i) => i && e.at < DG.evs[i - 1].at)) r.bad.push(`${fl}層: 順番`);
    }
    r.cnt = cnt;
    // 何も起きない区間: 1歩ずつ進めて(本物の乱数・配置)、イベントとイベントの間が DENC.quiet 歩をこえないか(200階層ぶん)
    { const E = window.__E0 || DENC, oE = Object.assign({}, DENC); Object.assign(DENC, E, { quiet: oE.quiet }); let mx = 0, forced = 0;
      for (let n = 0; n < 200; n++) { DG.fl = 1 + n % 4; dfloor(); let last = 0;
        for (let pg = 1; pg <= 100; pg++) { DG.pg = pg; const v = DG.evs.find(e => e.at == pg); let hit = pg == 100 || !!v;
          if (!hit) { const q = pg - DG.le > DENC.quiet, k = denc(); if (k) { hit = true; if (q) forced++; if (k == 'foe') DG.lb = pg; } }
          if (hit) { mx = Math.max(mx, pg - last - 1); last = pg; DG.le = pg; } } }
      Object.assign(DENC, oE); r.quiet = { mx, forced }; if (mx > DENC.quiet) r.bad.push(`何も起きない区間 ${mx}歩`); }
    // 層のイベントの出やすさ(DEVW)どおりか。泉・祠は1層あたり約0.3(分かれ道の先のぶんを足して約0.5)
    { const q = {}; let tot = 0; for (let n = 0; n < 3000; n++) { DG.fl = 2; dfloor(); for (const e of DG.evs) if (e.k != 'frk') { q[e.k] = (q[e.k] || 0) + 1; tot++; } }
      r.evw = DEVW.map(([k, w]) => `${k} ${Math.round((q[k] || 0) / tot * 100)}%(${Math.round(w * 100)}%)`).join('・'); r.heal1 = ((q.spr || 0) + (q.shr || 0)) / 3000;
      if (DEVW.some(([k, w]) => Math.abs((q[k] || 0) / tot - w) > .03) || Math.abs(DEVW.reduce((a, [, w]) => a + w, 0) - 1) > 1e-9) r.bad.push('層のイベントの割合: ' + r.evw); }
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
    r.foe = { f: fArg, want: floorParams(3).lv * DFS.str, rew: (DG.inc.atk || 0) - atk0, wrew: Math.max(1, Math.round(10 * derew(3) * DFS.rew)) };
    if (!cb || Math.abs(r.foe.f - r.foe.want) > 1e-9 || r.foe.rew != r.foe.wrew) r.bad.push(`強めの敵: 倍率${r.foe.f}(期待${r.foe.want})・報酬+${r.foe.rew}(期待+${r.foe.wrew})`);
    // 通常の敵のHPは層ごとの倍率(DEHP)で増え、攻撃力は変わらない。報酬は倍率の半分だけ増える
    r.hpm = [];
    for (const fl of [1, 2, 3, 4]) {
      let base = null, got = null, cb2 = null; mkEnemy = (en, f, b) => { const o = oM(en, f, b); base = Object.assign({}, o); return o; }; bfight = (e, php, dun) => { got = e; cb2 = dun; };
      DG.fl = fl; DG.inc = {}; await devent('foe', {}); await until(() => cb2); mkEnemy = oM; bfight = oF;
      if (!BT) BT = { mp: DG.mp }; cb2(1, { atk: 10 }, DG.hp); dstop();
      const wr = Math.max(1, Math.round(10 * derew(fl)));
      r.hpm.push(`${fl}層 HP×${(got.max / base.hp).toFixed(2)}・報酬10→${DG.inc.atk}`);
      if (got.max != Math.round(base.hp * DEHP[fl]) || got.hp != got.max || got.atk != base.atk || got.def != base.def || DG.inc.atk != wr) r.bad.push(`敵HP: ${fl}層 HP${got.max}(期待${Math.round(base.hp * DEHP[fl])})・攻撃${got.atk}/${base.atk}・報酬${DG.inc.atk}(期待${wr})`);
    }
    dfkPick = () => 'short'; r.short = [];
    for (const m of [.7, .3]) {
      DG.pg = 30; DG.evs = [{ at: 30, k: 'frk', done: 1, p: ['l', 'm'] }, { at: 40, k: 'box', done: 0 }, { at: 55, k: 'spr', done: 0 }, { at: 70, k: 'trp', done: 0 }];
      const pe = devent('frk', DG.evs[0]); await until(() => !$('dch').hidden || DG.pg > 30); Math.random = () => m; await pe; Math.random = oR; dstop();
      r.short.push(DG.evs.filter(e => e.done && e.k != 'frk').length + '個飛ばし・進行' + Math.round(DG.pg));
    }
    if (r.short.join() != '1個飛ばし・進行54,2個飛ばし・進行69') r.bad.push('近道: ' + r.short.join('、'));
    dfkPick = oP;
    // 5. オートONは「まっすぐ」を強調して選ぶ
    window.DAUTO = null; dauto(); DG.pg = 50; const t0 = performance.now(), pa = devent('frk', { p: ['l', 'm', 'r'] }); await until(() => document.querySelector('#dcb .pick'));
    const pk = document.querySelector('#dcb .pick'); r.auto = { k: pk && pk.dataset.k, ms: Math.round(performance.now() - t0) }; dfkPick = () => 'short'; await pa; dfkPick = oP; dauto(); dstop();
    // 6. 効果音
    AU.init(); const o0 = window.__osc; AU.sfx('fork'); await w(100); r.snd = window.__osc - o0;
    window.DAUTO = oA; DG.run = 0; document.getElementById('ov').hidden = true; return r;
  });
  add('分かれ道が各層に20歩ごと4回出る(ほかの配置イベントは3〜4個、分かれ道の間)', !FK.bad.some(x => /層/.test(x)), Object.entries(FK.cnt).map(([fl, c]) => `${fl}層 ${Object.entries(c).map(([n, k]) => n + '回×' + k).join(' ')}`).join(' / ') + (FK.bad.length ? ' / ' + FK.bad.filter(x => /層/.test(x)).slice(0, 2).join('、') : ''));
  add('分かれ道の画面: 通路が分かれて見え、道のボタンが375×667でも収まる', FK.btn.t == '左の道/まっすぐ/右の道' && FK.btn.h >= 44 && FK.btn.bottom && FK.dark.l3 < FK.dark.l2 * .7, `ボタン「${FK.btn.t}」高さ${FK.btn.h}px${FK.btn.bottom ? '' : '・はみ出し'}、左の壁の明るさ 左の道あり${FK.dark.l3}/なし${FK.dark.l2}`);
  add('ダンジョン: 配置イベント(宝箱・泉・祠)の割合が設定どおり', !FK.bad.some(x => /層のイベント/.test(x)), `${FK.evw}、泉・祠 1階層あたり ${FK.heal1.toFixed(2)}`);
  add('ダンジョン: 何も起きない区間が7歩をこえない', FK.quiet && FK.quiet.mx <= 7 && !FK.bad.some(x => /区間/.test(x)), FK.quiet ? `いちばん長い区間 ${FK.quiet.mx}歩(200階層・7歩で必ず出たモンスター ${FK.quiet.forced}回)` : '測れない');
  add('分かれ道の先: 重みどおりで、強めの敵・罠は続かない', !FK.bad.some(x => /重み|のあとに/.test(x)), FK.fq);
  add('分かれ道の先: 回復・宝箱・罠・強めの敵(倍率)・近道が説明どおり', !FK.bad.some(x => /→|強めの敵|近道/.test(x)), `強めの敵 強さ×${FK.foe.f && (FK.foe.f / FK.foe.want * 1.2).toFixed(2)}・報酬 10→${FK.foe.rew}、近道 ${FK.short.join('、')}` + (FK.bad.length ? ' / ' + FK.bad.join('、') : ''));
  add('ダンジョン: 通常の敵のHPが層ごとの倍率で増え、攻撃力は同じ・報酬は半分だけ増える', !FK.bad.some(x => /敵HP/.test(x)), FK.hpm.join('、') + (FK.bad.some(x => /敵HP/.test(x)) ? ' / ' + FK.bad.filter(x => /敵HP/.test(x)).join('、') : ''));
  add('分かれ道: オートONは「まっすぐ」を約1秒見せて選ぶ・オートOFFは止まって待つ', FK.auto.k == 'm' && FK.auto.ms >= 100 && FK.wait, `オートON→${FK.auto.k}(${FK.auto.ms}ms・8倍速)、オートOFF→${FK.wait ? '待つ' : '待たない'}`);
  add('分かれ道の効果音(動作確認のみ・聞こえ方は未確認)', FK.snd > 0, `${FK.snd}音`);
  // ダンジョン: オートONで5回、オートOFF(選択はランダム・コマンドはテストが自動で押す)で2回。毎回1階層から。進むか帰るかは「進む」で、5階層のボスを倒したら帰る
  await page.evaluate(() => { window.__fw = { n: 0, w: 0 }; const oB = bfight;
    bfight = (en, php, dun, ...a) => oB(en, php, dun && !en.boss ? (win, ...b) => { __fw.n++; if (win) __fw.w++; return dun(win, ...b); } : dun, ...a); });
  await page.evaluate(() => Object.assign(DENC, window.__E0));
  const runD = async (on, D) => {
    await page.evaluate(on => { if (DAU != on) dauto(); __fw.n = __fw.w = 0; }, on);
    const dstuck = [], floors = [], secs = []; let clear = 0, reach5 = 0;
    for (let i = 0; i < D; i++) {
      const t0 = Date.now();
      await page.evaluate(() => { const oA = window.DAUTO; window.__oA = window.__oA || oA; window.DAUTO = (o, kind) => kind == 'path' && DG.fl > 5 ? 'back' : window.__oA(o, kind); S.dg = null; openDungeon(); });
      try {
        await page.waitForSelector('#or:not([hidden])', { timeout: 300000 });
      } catch (e) {
        dstuck.push(`${i + 1}回目(${await page.evaluate(() => '第' + DG.fl + '層 ' + document.getElementById('odm').textContent)})`);
        await page.evaluate(() => { clearInterval(DG.iv); DG.run = 0; document.getElementById('ov').hidden = true; });
        continue;
      }
      const r = await page.evaluate(() => ({ fl: DG.fl, t: document.querySelector('#or .rt').textContent }));
      screenTexts.push(['ダンジョン結果', await page.evaluate(() => document.body.innerText)]);
      floors.push(r.fl); secs.push(Math.round((Date.now() - t0) / 1000));
      if (r.fl >= 5) reach5++;
      if (r.fl > 5) clear++;
      await page.click('#or button.ok');
    }
    const fw = await page.evaluate(() => __fw);
    return { dstuck, floors, clear, reach5, fw, txt: (dstuck.length ? `止まった: ${dstuck.join('、')}。` : '全回 最後まで終了。') + `到達階層 ${floors.join(',')}(${secs.join('・')}秒)、5階層の強ボスに勝った ${reach5 ? clear + '/' + reach5 : '(5階層まで行けず)'}、通常の敵 ${fw.w}/${fw.n}勝` };
  };
  // 重いテスト(1回1〜2分): --full のときだけ
  if (FULL) {
    const D = 5, on5 = await runD(true, D);
    add('ダンジョン 自動' + D + '回(オートON)', !on5.dstuck.length, on5.txt);
    await page.evaluate(() => { window.__noClick = false; });
    const off2 = await runD(false, 2);
    add('ダンジョン 2回(オートOFF・選択とコマンドはテストが自動操作)', !off2.dstuck.length, off2.txt);
  }
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

// ---------- 冒険ダンジョン: 歩数ストック・階層・途中セーブ ----------
async function dgCheck(browser) {
  const size = WIDTHS[0];
  const { ctx, page, errors } = await newPage(browser, size, { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);
  const W = `const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 300) => { for (let i = 0; i < n && !f(); i++) await w(40); return f(); }, $ = id => document.getElementById(id);
    window.__E0 = window.__E0 || Object.assign({}, DENC); if (!window.__enc) { DENC.foe = DENC.trp = 0; }`;
  const ev = (src, arg) => page.evaluate(new Function('arg', `return (async () => { ${W} ${src} })()`), arg);
  await page.evaluate(k => __T.setup(k, 12), k);
  // 歩数がSPとダンジョン用に同時に入る(ダンジョン用だけのボタンはSPを増やさない)
  const A = await ev(`const d0 = S.dgSteps = 0, p0 = S.pts; addSteps(1000); const a = { dg: S.dgSteps, sp: S.pts - p0 };
    addDgSteps(500); a.dg2 = S.dgSteps; a.sp2 = S.pts - p0; setTab('ts'); a.btn = [...document.querySelectorAll('button')].some(b => b.textContent == 'ダンジョン歩数+1000'); setTab(null); return a;`);
  add('ダンジョン: 歩数がSPとダンジョン用に同時に入る', A.dg == 1000 && A.sp == 10 && A.dg2 == 1500 && A.sp2 == 10 && A.btn,
    `1000歩 → ダンジョン用 ${A.dg}・SP+${A.sp}、ダンジョン用だけ+500 → ${A.dg2}(SP+${A.sp2})、テストメニューのボタン${A.btn ? 'あり' : 'なし'}`);
  // 入り口(はじめから)
  const E0 = await ev(`S.dg = null; S.dgSteps = 0; save(); dgEntry(); await w(300); return { t: $('odn').innerText, b: [...$('odn').querySelectorAll('button')].map(b => b.textContent) };`);
  await page.screenshot({ path: path.join(OUT, `dungeon-entry-new-${size.w}.png`) });
  // 歩数がないと進まない → 歩数が入ると進む(進んだぶんだけ減る)
  const B = await ev(`openDungeon(); DG.evs = [{ at: 60, k: 'box', done: 0 }]; await w(1500);
    const r = { pg: DG.pg, dns: !$('dns').hidden && $('dns').textContent, bk: !$('dbk').hidden };
    S.dgSteps = 250; await until(() => DG.pg > 0); await w(1500); r.pg2 = DG.pg; r.left = S.dgSteps; r.dns2 = !$('dns').hidden && $('dns').textContent;
    r.top = $('odt').textContent; return r;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-nosteps-${size.w}.png`) });
  add('ダンジョン: 歩数がないと進まない(あと何歩かを表示・帰れる)', B.pg == 0 && /歩数がたまったら進めるよ/.test(B.dns) && /あと100歩/.test(B.dns) && B.bk,
    `進み ${B.pg}、表示「${B.dns || 'なし'}」、ひきかえす${B.bk ? 'あり' : 'なし'}`);
  add('ダンジョン: 歩数が入ると進み、進んだぶん減る', B.pg2 == 2 && B.left == 50 && /あと50歩/.test(B.dns2 || ''),
    `250歩 → 進み ${+B.pg2.toFixed(2)}(画面の2歩)・残り ${B.left}歩・また止まる「${B.dns2 || 'なし'}」・上の表示「${B.top}」`);
  // 1歩で減る歩数はいつも100(イベントの手前でも)。1階層を最後まで歩くとちょうど1万歩(イベントは中身を飛ばして通過)
  const P = await ev(`clearInterval(DG.iv); dstop(); const oE = devent, oN = dnext; let end = 0; devent = () => { dgo(); }; dnext = () => { end = 1; };
    S.dgSteps = 1e6; DG.fl = 2; dfloor(); dgo(); const evs = DG.evs.map(e => e.at), d = [], s0 = S.dgSteps; let n = 0;
    for (let i = 0; i < 5000 && !end; i++) { const b = S.dgSteps; dtick(); if (S.dgSteps != b) { d.push(b - S.dgSteps); n++; } }
    const used = s0 - S.dgSteps;
    // 歩数150 → 1歩だけ進んで止まり、あと50歩
    S.dgSteps = 150; DG.fl = 1; dfloor(); DG.evs = []; dgo(); for (let i = 0; i < 100; i++) dtick();
    const r = { evs, d: [...new Set(d)], n, used, end, pg: DG.pg, left: S.dgSteps, dns: !$('dns').hidden && $('dns').textContent };
    // イベントの位置はすべて整数・重ならない(各階層で何度も作る)
    let bad = 0; for (let t = 0; t < 2000; t++) { DG.fl = 1 + t % 6; dfloor(); const a = DG.evs.map(e => e.at); if (a.some((x, i) => !Number.isInteger(x) || x < 1 || x > 99 || (i && x <= a[i - 1]))) bad++; }
    r.bad = bad; devent = oE; dnext = oN; DG.run = 0; $('ov').hidden = true; return r;`);
  add('ダンジョン: どの1歩でも、歩数が100ずつ減る(イベントの手前でも)', P.d.join() == '100', `減り方 ${P.d.join('・')}歩/1歩(イベントの位置 ${P.evs.join(',')})`);
  add('ダンジョン: 1階層を最後まで歩くと、近道なしでちょうど1万歩減る', P.end && P.used == 10000 && P.n == 100, `${P.n}歩で ${P.used.toLocaleString()}歩減って階層の終わり${P.end ? 'に着いた' : 'に着かない'}`);
  add('ダンジョン: イベントの位置がすべて整数(重ならない)', !P.bad, P.bad ? `整数でない・重なる階層 ${P.bad}/2000` : '2000回作ってすべて整数・1〜99・重なりなし');
  add('ダンジョン: 歩数が150のとき、1歩だけ進んで止まり、あと50歩と表示', P.pg == 1 && P.left == 50 && /あと50歩/.test(P.dns || ''), `進み ${P.pg}・残り ${P.left}歩・表示「${P.dns || 'なし'}」`);
  await page.evaluate(k => __T.setup(k, 12), k);
  await ev(`S.dgSteps = 1e6; S.dg = null; openDungeon(); return 0;`);
  // 途中セーブ: 2階層目を歩いている途中で再読み込み → 入り口に「つづきから(第2階層)」→ 続きから再開
  const C0 = await ev(`S.dgSteps = 1e6; DG.fl = 2; dfloor(); DG.evs = [{ at: 70, k: 'box', done: 0 }, { at: 90, k: 'trp', done: 0 }]; DG.hp = DG.mx - 7; dui();
    await until(() => DG.pg >= 5 && DG.sk == DSN()); dstop(); await w(100); return { pg: DG.pg, hp: DG.hp, mx: DG.mx, steps: S.dgSteps };`);
  await page.screenshot({ path: path.join(OUT, `dungeon-floor2-${size.w}.png`) });
  await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
  const C = await ev(`const r = {}; dgEntry(); await w(300); r.t = $('odn').innerText; r.b = [...$('odn').querySelectorAll('button')].map(b => b.textContent); return r;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-entry-cont-${size.w}.png`) });
  const C2 = await ev(`$('odn').querySelector('.big.ok').click(); const r = { fl: DG.fl, pg: DG.pg, hp: DG.hp, evs: DG.evs.map(e => e.k + '@' + e.at).join(','), steps: S.dgSteps, top: $('odt').textContent }; await w(300); dstop(); return r;`);
  add('ダンジョン: 画面を再読み込みしても続きから再開できる', /つづきから/.test(C.b.join()) && /第2階層/.test(C.b.join()) && C2.fl == 2 && Math.abs(C2.pg - C0.pg) < .01 && C2.hp == C0.hp && C2.evs == 'box@70,trp@90' && C2.steps == C0.steps,
    `入り口「${C.b.join(' / ')}」→ 第${C2.fl}階層・進み ${Math.round(C2.pg)}(前 ${Math.round(C0.pg)})・HP ${C2.hp}(前 ${C0.hp})・イベント ${C2.evs}・歩数 ${C2.steps}`);
  add('ダンジョン: 入り口は 続きがなければ「はじめから」、あれば「つづきから」と小さな「はじめからやり直す」', /はじめから/.test(E0.b[0]) && /第1階層/.test(E0.b[0]) && !E0.b.some(b => b.includes('やり直す')) && C.b.some(b => b == 'はじめからやり直す'),
    `続きなし「${E0.b.join(' / ')}」、続きあり「${C.b.join(' / ')}」`);
  // 戦闘中に閉じると、その戦闘の前に戻る
  const D0 = await ev(`DG.evs = [{ at: DG.pg + 4, k: 'foe', done: 0 }]; dsave(); dgo(); await until(() => !$('ob').hidden && BT && BT.dun); return { pg: DG.pg };`);
  await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
  const D = await ev(`return { pg: S.dg.pg, done: S.dg.evs[0].done, k: S.dg.evs[0].k };`);
  add('ダンジョン: 戦闘中に閉じると、その戦闘の前から', D.k == 'foe' && !D.done && Math.abs(D.pg - D0.pg) < .01, `保存された進み ${Math.round(D.pg)}・敵のイベント ${D.done ? '済み' : 'まだ'}`);
  // やり直す(確認つき)
  const R = await ev(`dgEntry(); await w(200); $('odn').querySelector('.dnr').click(); await w(200); const q = $('odn').innerText; const b0 = !!$('odn').querySelector('.dnq');
    [...$('odn').querySelectorAll('button')].find(b => b.textContent == 'やり直す').click(); await w(300); dstop(); return { q, b0, fl: DG.fl, hp: DG.hp == DG.mx };`);
  add('ダンジョン: はじめからやり直すは確認を出してから1階層へ', R.b0 && /やり直します/.test(R.q) && R.fl == 1 && R.hp, `確認${R.b0 ? 'あり' : 'なし'} → 第${R.fl}階層・HP${R.hp ? '満タン' : '満タンでない'}`);
  // ボスを倒すと次の階層へ。5の倍数の階層は強ボス
  const F = await ev(`const oF = bfight, oM = mkEnemy, out = {}; let cb = null, f = null; bfight = (e, h, d) => { cb = d; }; mkEnemy = (en, x, b) => { if (b) f = x; return oM(en, x, b); };
    window.DAUTO = (o, kind) => 'go'; const msg = [];
    for (const fl of [1, 4, 5, 10]) { DG.fl = fl; dfloor(); cb = null; f = null; DG.hp = DG.mx; const p = dnext(); await until(() => cb); msg.push($('odm').textContent); out[fl] = f; if (fl == 1) { BT = { mp: DG.mp }; cb(1, {}, DG.hp); await until(() => DG.fl == 2 && !DG.pause); out.next = { fl: DG.fl, pg: DG.pg, bs: DG.bs, saved: S.dg.fl, savedPg: S.dg.pg, ob: $('od').hidden }; dstop(); } }
    bfight = oF; mkEnemy = oM; dstop(); out.msg = msg; out.p = [1, 4, 5, 6, 10, 50].map(n => floorParams(n).boss.strong ? 1 : 0).join(''); return out;`);
  add('ダンジョン: ボスを倒すと次の階層に進む(セーブも次の階層)', F.next.fl == 2 && F.next.pg < 9 && !F.next.bs && F.next.saved == 2 && !F.next.ob, `第1階層のボスに勝つ → 第${F.next.fl}階層(進み ${Math.round(F.next.pg)})・セーブ 第${F.next.saved}階層`);
  const r5 = F[5] / F[4], base = await page.evaluate(() => [floorParams(4).lv, floorParams(5).lv]);
  add('ダンジョン: 5の倍数の階層が強ボス(普通ボスの1.5倍)', F.p == '001011' && Math.abs(F[5] / (F[4] * base[1] / base[0]) - 1.5) < .01 && /強大な/.test(F.msg[2]) && !/強大な/.test(F.msg[1]),
    `強ボスの階層(1,4,5,6,10,50) ${F.p}、ボスの強さ 1階層${F[1].toFixed(2)}・4階層${F[4].toFixed(2)}・5階層${F[5].toFixed(2)}・10階層${F[10].toFixed(2)}、5階層「${F.msg[2]}」`);
  // 気絶: その階層の初めから全回復 / 帰還: HPそのままでその階層の初め
  const G = await ev(`const r = {}; window.DAUTO = (o, kind) => kind == 'trp' ? 'bear' : kind == 'back' ? 'yes' : 'go';
    S.dg = null; openDungeon(); dstop(); DG.fl = 3; dfloor(); DG.pg = 40; DG.hp = 1; await devent('trp'); r.t0 = document.querySelector('#or .rt').textContent; r.s0 = Object.assign({}, S.dg); $('ov').hidden = true;
    openDungeon(); dstop(); r.a = { fl: DG.fl, pg: DG.pg, full: DG.hp == DG.mx }; DG.pg = 40; DG.hp = 17; DG.mp = 3; $('dbk').click(); await until(() => !$('or').hidden); r.t1 = document.querySelector('#or .rt').textContent; $('ov').hidden = true;
    openDungeon(); dstop(); r.b = { fl: DG.fl, pg: DG.pg, hp: DG.hp, mp: DG.mp }; clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true; return r;`);
  add('ダンジョン: 気絶するとその階層の初めから全回復', G.t0 == '力尽きた…' && G.a.fl == 3 && G.a.pg == 0 && G.a.full, `「${G.t0}」→ 第${G.a.fl}階層・進み ${G.a.pg}・HP${G.a.full ? '全回復' : '回復していない'}`);
  add('ダンジョン: 帰還するとHPそのままでその階層の初め', G.t1 == '帰還' && G.b.fl == 3 && G.b.pg == 0 && G.b.hp == 17 && G.b.mp == 3, `「${G.t1}」→ 第${G.b.fl}階層・進み ${G.b.pg}・HP ${G.b.hp}・MP ${G.b.mp}`);
  // ひきかえす: 確認(ゲーム内・はい/いいえ)。いいえで続く。オートONでも自動では選ばない
  const K = await ev(`window.DAUTO = null; if (DAU) dauto(); S.dg = null; S.dgSteps = 1e6; openDungeon(); DG.evs = [{ at: 60, k: 'box', done: 0 }];
    await until(() => DG.pg >= 2); $('dbk').click(); await until(() => !$('dch').hidden);
    const r = { gn: $('dgn').textContent, bt: [...$('dcb').querySelectorAll('button')].map(b => b.textContent), h: Math.min(...[...$('dcb').querySelectorAll('button')].map(b => b.offsetHeight)), bk: $('dbk').hidden };
    const p0 = DG.pg; await w(1500); r.still = DG.pg == p0; return r;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-back-confirm-${size.w}.png`) });
  const K2 = await ev(`const p0 = DG.pg; $('dcb').querySelector('[data-k="no"]').click(); await w(1500); const r = { go: DG.pg > p0, ch: $('dch').hidden, bk: !$('dbk').hidden };
    dauto(); $('dbk').click(); await until(() => !$('dch').hidden); await w(2500); r.autoWait = !$('dch').hidden && !document.querySelector('#dcb .pick'); $('dcb').querySelector('[data-k="no"]').click(); dauto();
    // はい: その階層の初めへ(HPそのまま)
    await w(300); DG.hp = DG.mx - 5; $('dbk').click(); await until(() => !$('dch').hidden); $('dcb').querySelector('[data-k="yes"]').click(); await until(() => !$('or').hidden);
    r.t = document.querySelector('#or .rt').textContent; r.s = { fl: S.dg.fl, evs: !!S.dg.evs, hp: S.dg.hp == DG.mx - 5 }; $('ov').hidden = true; openDungeon(); r.re = { fl: DG.fl, pg: DG.pg, hp: DG.hp == DG.mx - 5 }; dstop();
    // たき火のあと: ここで帰る → 確認 → たき火から再開(回復は1回だけ)
    clearInterval(DG.iv); DG.run = 1; DG.evs.forEach(e => e.done = 1); DG.pg = 100; DG.hp = 3; dnext(); await until(() => !$('dch').hidden); const hp1 = DG.hp;
    $('dcb').querySelector('[data-k="back"]').click(); await until(() => !$('dch').hidden && /本当に/.test($('dgn').textContent)); r.fireMsg = $('dgn').textContent;
    $('dcb').querySelector('[data-k="yes"]').click(); await until(() => !$('or').hidden); r.ft = document.querySelector('#or p') ? [...document.querySelectorAll('#or p')].map(x => x.textContent).join(' ') : ''; $('ov').hidden = true;
    r.fs = { pg: S.dg.pg, fire: !!S.dg.fire }; openDungeon(); await until(() => !$('dch').hidden); r.fre = { gn: $('dgn').textContent, t: $('dcb').textContent, hp: DG.hp == hp1 };
    clearInterval(DG.iv); DG.run = 0; DCQ = null; $('dch').hidden = true; $('ov').hidden = true; window.DAUTO = (o, kind) => kind == 'path' || kind == 'back' ? o[0].k : o[0].k; return r;`);
  add('ダンジョン: ひきかえすで確認が出る(ゲーム内・はい/いいえ・44px以上)', /本当にひきかえしますか/.test(K.gn) && /第1階層の初めから再開/.test(K.gn) && K.bt.length == 2 && /^はい/.test(K.bt[0]) && /^いいえ/.test(K.bt[1]) && K.h >= 44 && K.still,
    `「${K.gn}」ボタン ${K.bt.join(' / ')}(高さ${K.h}px)・確認中は${K.still ? '止まる' : '進んでしまう'}`);
  add('ダンジョン: ひきかえすで「いいえ」なら続く・オートONでも自分で選ぶまで待つ', K2.go && K2.ch && K2.bk && K2.autoWait, `いいえ → ${K2.go ? '歩き続ける' : '進まない'}・オートON ${K2.autoWait ? '待つ' : '自動で選んだ'}`);
  add('ダンジョン: ひきかえすで「はい」なら階層の初め(HPそのまま)、たき火のあとはたき火から', K2.t == '帰還' && K2.re.fl == 1 && K2.re.pg == 0 && K2.re.hp && !K2.s.evs && /たき火から再開/.test(K2.fireMsg) && K2.fs.pg == 100 && K2.fs.fire && /たき火から再開/.test(K2.fre.gn) && /魔王に挑む/.test(K2.fre.t) && K2.fre.hp,
    `はい → 「${K2.t}」→ 第${K2.re.fl}階層・進み ${K2.re.pg}・HP${K2.re.hp ? 'そのまま' : 'ちがう'}。たき火のあと「${K2.fireMsg}」→ 再開「${K2.fre.gn.slice(0, 20)}」・HP${K2.fre.hp ? '同じ(回復は1回)' : 'ちがう'}`);
  // 中断(歩数切れで止まる → 画面を閉じる)と未確定のもの
  const M0 = await ev(`S.dg = null; S.dgSteps = 300; openDungeon(); DG.pend = { key: 2 }; DG.evs = [{ at: 50, k: 'box', done: 0 }]; await until(() => !$('dns').hidden); return { pg: DG.pg };`);
  await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
  const M = await ev(`const r = { s: S.dg.pg }; S.dgSteps = 0; openDungeon(); await w(300); r.pg = DG.pg; r.pend = DG.pend.key || 0; r.dns = !$('dns').hidden;
    const it0 = (S.items || {}).key || 0; window.DAUTO = (o, kind) => 'yes'; $('dbk').click(); await until(() => !$('or').hidden); $('ov').hidden = true;
    r.back = ((S.items || {}).key || 0) - it0; r.left = Object.keys(S.dg.pend || {}).length;
    openDungeon(); dstop(); DG.pend = { key: 1 }; DG.hp = 1; window.DAUTO = (o, kind) => 'bear'; await devent('trp'); $('ov').hidden = true;
    r.ko = ((S.items || {}).key || 0) - it0; r.koLeft = Object.keys(S.dg.pend || {}).length; openDungeon(); r.koRe = Object.keys(DG.pend).length; clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true; return r;`);
  add('ダンジョン: 中断して再読み込みすると、同じ位置から再開する', M0.pg == 3 && M.s == 3 && M.pg == 3 && M.dns, `歩数切れで止まった位置 ${M0.pg} → 保存 ${M.s} → 再開 ${M.pg}${M.dns ? '(歩数切れの表示あり)' : ''}`);
  add('ダンジョン: 未確定のものが、ひきかえすで確定・中断で保持・気絶で消える', M.pend == 2 && M.back == 2 && !M.left && M.ko == 2 && !M.koLeft && !M.koRe,
    `中断→再開で ${M.pend}個・ひきかえすで +${M.back}個確定・気絶で ${M.koRe ? '残る' : '消える'}(確定済みは ${M.ko}個のまま)`);
  // 歩数切れで止まったとき: 「中断してホームへ」と「ひきかえす」
  const PS0 = await ev(`window.DAUTO = null; if (DAU) dauto(); S.dg = null; S.dgSteps = 300; openDungeon(); DG.evs = [{ at: 50, k: 'box', done: 0 }]; DG.pend = { key: 3 }; DG.inc = { atk: 2 }; DG.hp = DG.mx - 4; DG.mp = DG.mmx - 1;
    await until(() => !$('dns').hidden); await w(300);
    const R = e => e.getBoundingClientRect(), ov = (a, b) => !(a.right <= b.left || b.right <= a.left || a.bottom <= b.top || b.bottom <= a.top);
    const ps = $('dps'), bk = $('dbk'), r = { ps: !ps.hidden && ps.textContent, bk: !bk.hidden && bk.textContent, h: Math.min(R(ps).height, R(bk).height) };
    r.hit = [ps, bk].some(b => [$('dau'), $('snd')].some(x => x && ov(R(b), R(x)))) || ov(R(ps), R(bk)); r.in = [ps, bk].every(b => R(b).right <= innerWidth && R(b).bottom <= innerHeight && R(b).left >= 0);
    r.pg = DG.pg; r.hp = DG.hp; r.mp = DG.mp; return r;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-nosteps-pause-${size.w}.png`) });
  const PS1 = await ev(`$('dps').click(); await w(200); return { home: $('ov').hidden, s: { pg: S.dg.pg, hp: S.dg.hp, mp: S.dg.mp, pend: S.dg.pend.key, inc: S.dg.inc.atk } };`);
  await page.reload(); await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
  const PS2 = await ev(`S.dgSteps = 1000; dgEntry(); await w(200); const b = $('odn').querySelector('.big.ok').textContent; $('odn').querySelector('.big.ok').click();
    const r = { b, pg: DG.pg, hp: DG.hp, mp: DG.mp, pend: DG.pend.key, inc: DG.inc.atk }; await until(() => DG.pg > r.pg); r.walk = DG.pg > r.pg;
    // ひきかえすは今までどおり(確認 → 階層の初め)
    S.dgSteps = 0; await until(() => !$('dns').hidden); window.DAUTO = (o, k) => k == 'back' ? 'yes' : o[0].k; $('dbk').click(); await until(() => !$('or').hidden);
    r.t = document.querySelector('#or .rt').textContent; r.back = { evs: !!S.dg.evs, pend: Object.keys(S.dg.pend || {}).length, items: (S.items || {}).key || 0 }; $('ov').hidden = true;
    openDungeon(); r.re = DG.pg; clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true; window.DAUTO = null; return r;`);
  add('ダンジョン: 歩数0で止まると「中断してホームへ」と「ひきかえす」の2つが出る(44px以上・重ならない)', /中断してホームへ/.test(PS0.ps) && /ひきかえす/.test(PS0.bk) && PS0.h >= 44 && !PS0.hit && PS0.in,
    `「${PS0.ps}」「${PS0.bk}」高さ${Math.round(PS0.h)}px・${PS0.hit ? '重なりあり' : '重なりなし'}・${PS0.in ? '画面内' : 'はみ出し'}`);
  add('ダンジョン: 中断すると、同じ位置・同じHP・MP・未確定のものから再開して歩きだせる', PS1.home && PS1.s.pg == PS0.pg && PS2.pg == PS0.pg && PS2.hp == PS0.hp && PS2.mp == PS0.mp && PS2.pend == 3 && PS2.inc == 2 && /つづきから/.test(PS2.b) && PS2.walk,
    `中断 → ${PS1.home ? 'ホーム' : 'ホームに戻らない'} → 再読み込み →「${PS2.b}」→ 進み ${PS2.pg}(前 ${PS0.pg})・HP ${PS2.hp}(前 ${PS0.hp})・MP ${PS2.mp}(前 ${PS0.mp})・未確定 ${PS2.pend}個・獲得 攻撃+${PS2.inc}・${PS2.walk ? '歩きだした' : '進まない'}`);
  add('ダンジョン: 歩数0でひきかえすと、今までどおり階層の初めに戻る(未確定は確定)', PS2.t == '帰還' && !PS2.back.evs && !PS2.back.pend && PS2.back.items >= 3 && PS2.re == 0,
    `「${PS2.t}」→ 再開の進み ${PS2.re}・未確定 ${PS2.back.pend}個(確定 ${PS2.back.items}個)`);
  // 突然のイベント(ランダムエンカウント)
  // 1歩ごとの確率のルールを見るので、「7歩なにもなければ必ず出る」(DENC.quiet)はここでは止める(次の ev で元に戻す)
  const N = await ev(`window.__enc = 1; Object.assign(DENC, window.__E0 || DENC, { quiet: 1e9 }); const r = {};
    // 配置イベントにモンスター・罠がない(見えるイベントは3〜4個+分かれ道)
    let bad = 0, cnt = {}; for (let t = 0; t < 2000; t++) { DG.fl = 1 + t % 6; dfloor(); const o = DG.evs.filter(e => e.k != 'frk'); cnt[o.length] = (cnt[o.length] || 0) + 1; if (DG.evs.some(e => e.k == 'foe' || e.k == 'trp')) bad++; }
    r.place = { bad, cnt, w: DEVW.map(([k]) => k).join(',') };
    // 1歩ごとの出現率(たき火・間隔の条件の外で多数回)
    let f = 0, tp = 0; const M = 200000; for (let i = 0; i < M; i++) { DG.pg = 10 + i % 80; DG.lb = -99; const k = denc(); if (k == 'foe') f++; else if (k == 'trp') tp++; } r.rate = { foe: f / M, trp: tp / M };
    // 歩き続けるシミュレーション(出たらすぐ戻る)。間隔・たき火の手前・見えるイベントの位置を調べる
    const oS = dsudden, oE = devent, oN = dnext, hits = []; let fl = 0;
    dsudden = k => { hits.push({ k, pg: DG.pg, fl, at: DG.evs.map(e => e.at) }); if (k == 'foe') DG.lb = DG.pg; dgo(); }; devent = () => { dgo(); }; dnext = () => { fl++; dfloor(); dgo(); };
    clearInterval(DG.iv); DG.run = 1; S.dgSteps = 1e9; DG.fl = 1; dfloor(); dgo();
    for (let i = 0; i < 400000 && fl < 200; i++) dtick();
    dsudden = oS; devent = oE; dnext = oN; DG.run = 0;
    const foes = hits.filter(h => h.k == 'foe'); let gap = 99, near = 0, onEv = 0, last = {};
    for (const h of hits) { if (h.at.includes(h.pg)) onEv++; if (h.k != 'foe') continue; if (h.pg >= 100 - DENC.fire) near++; const p = last[h.fl] != null ? last[h.fl] : 0; gap = Math.min(gap, h.pg - p); last[h.fl] = h.pg; }
    r.sim = { floors: fl, foe: foes.length / fl, trp: hits.filter(h => h.k == 'trp').length / fl, gap, near, onEv, maxPg: Math.max(...foes.map(h => h.pg)) };
    return r;`);
  add('ダンジョン: モンスターと罠が配置イベントに入っていない(見えるイベントは3〜4個)', !N.place.bad && N.place.w == 'box,spr,shr' && Object.keys(N.place.cnt).every(n => n == 3 || n == 4),
    `配置: ${N.place.w}・個数 ${Object.entries(N.place.cnt).map(([n, c]) => n + '個×' + c).join(' ')}・モンスター/罠 ${N.place.bad}回`);
  add('ダンジョン: 1歩ごとの出現率がだいたい7%(罠は1%)', Math.abs(N.rate.foe - .07) < .004 && Math.abs(N.rate.trp - .01) < .002, `モンスター ${(N.rate.foe * 100).toFixed(2)}%・罠 ${(N.rate.trp * 100).toFixed(2)}%(20万回)`);
  add('ダンジョン: バトルの間が最低5歩あく・たき火の手前と見えるイベントの位置では出ない', N.sim.gap >= 5 && !N.sim.near && !N.sim.onEv && N.sim.maxPg < 95,
    `${N.sim.floors}階層歩いて 1階層あたり モンスター${N.sim.foe.toFixed(1)}回・罠${N.sim.trp.toFixed(2)}回、最短の間 ${N.sim.gap}歩、いちばん奥 ${N.sim.maxPg}歩目、たき火の手前 ${N.sim.near}回・イベントの位置 ${N.sim.onEv}回`);
  // 出たときにバトルになる(写真: 出た瞬間)
  await ev(`window.__enc = 1; S.dg = null; S.dgSteps = 1e6; window.DAUTO = null; if (DAU) dauto(); openDungeon(); DG.evs = [{ at: 60, k: 'box', done: 0 }]; DG.lb = -99; DENC.foe = 1;
    await until(() => !$('dex').hidden); await w(150); return 0;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-encounter-${size.w}.png`) });
  const Q = await ev(`await until(() => !$('ob').hidden && BT && BT.dun); const m = $('blog').textContent; const img = !!$('esp').querySelector('img,svg'); const r = { m, img, bt: !$('ob').hidden && !!BT.dun && !BT.en.boss, n: BT.en.n };
    BT.busy = 1; Object.assign(DENC, window.__E0); clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true; window.__enc = 0; return r;`);
  add('ダンジョン: モンスターが突然出たときにバトルになる', Q.bt && Q.img && /あらわれた/.test(Q.m), `「${Q.m}」→ ${Q.bt ? Q.n + 'とバトル' : 'バトルにならない'}`);
  // ボスを倒して次の階層へ(中断・たき火から再開・帰還・オートの切り替えのあと)。バトルは横取りしてすぐ勝ち(結果を2回送って、二重でも1つだけ進むか見る)
  const NF = await ev(`window.__enc = 0; DENC.foe = DENC.trp = 0; if (DAU) dauto(); const oF = bfight, out = {};
    bfight = (e, h, d) => { BT = { en: e, mp: DG.mp, turn: 2 }; setTimeout(() => { d(1, {}, h); d(1, {}, h); }, 100); };
    const AUTO = (o, kind) => kind == 'back' ? 'yes' : kind == 'path' ? 'go' : o[0].k;
    const toEnd = () => { DG.evs.forEach(e => e.done = 1); DG.pg = 97; DG.sk = null; dsave(); };
    const watch = async (name, fl0) => { await until(() => DG.fl != fl0 && !DG.pause && !DCQ, 400); const s0 = S.dgSteps; await w(3000); dstop();
      out[name] = { fl: DG.fl - fl0, pg: DG.pg, done: DG.evs.filter(e => e.done).map(e => e.at), used: (s0 - S.dgSteps) / 100 }; clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true; };
    // たき火から再開
    window.DAUTO = AUTO; S.dg = null; S.dgSteps = 1e6; openDungeon(); DG.fl = 6; dfloor(); toEnd(); window.DAUTO = (o, kind) => kind == 'back' ? 'yes' : kind == 'path' ? 'back' : o[0].k;
    await until(() => !$('or').hidden, 400); $('ov').hidden = true; window.DAUTO = AUTO; openDungeon(); await watch('fire', 6);
    // 歩数切れで中断 → 再開
    S.dg = null; openDungeon(); DG.fl = 3; dfloor(); toEnd(); S.dgSteps = 200; await until(() => !$('dns').hidden, 400); $('dps').click(); S.dgSteps = 1e6; openDungeon(); await watch('pause', 3);
    // 帰還 → 再開(階層の初めから)
    S.dg = null; openDungeon(); DG.fl = 4; dfloor(); await w(300); $('dbk').click(); await until(() => !$('or').hidden, 400); $('ov').hidden = true; openDungeon(); toEnd(); await watch('back', 4);
    // オートON(リザルトは自動で閉じる)→ 途中でOFFに
    S.dg = null; openDungeon(); DG.fl = 2; dfloor(); dauto(); toEnd(); await until(() => DG.bs, 400); dauto(); await watch('auto', 2);
    // リザルトをタップで閉じる(オートOFF・テストの自動選択なし)
    S.dg = null; openDungeon(); DG.fl = 5; dfloor(); toEnd(); window.DAUTO = null; await until(() => !$('dch').hidden, 400); $('dcb').querySelector('[data-k="go"]').click();
    await until(() => !$('brs').hidden, 400); $('brn').click(); await until(() => !$('dch').hidden, 400); $('dcb').querySelector('[data-k="go"]').click(); await watch('tap', 5);
    bfight = oF; window.DAUTO = AUTO;
    // dtick が二重に動かない: 帰らずにもう一度開いても、歩く速さは同じ(約0.6秒に1歩)
    S.dg = null; openDungeon(); openDungeon(); const p0 = DG.pg; await w(3000); out.rate = DG.pg - p0; clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true;
    return out;`);
  const okNF = x => x && x.fl == 1 && x.pg <= 8 && x.done.every(a => a <= x.pg) && Math.abs(x.used - Math.round(x.pg)) <= 1;
  const nfTxt = x => x ? `+${x.fl}階層・進み${Math.round(x.pg)}・歩数${x.used}歩ぶん・起きたイベント${x.done.length}` : 'なし';
  add('ダンジョン: ボスを倒して次の階層に進むと、進み具合が0から始まる', ['fire', 'pause', 'back', 'auto', 'tap'].every(k => NF[k] && NF[k].pg <= 8), ['fire', 'pause', 'back', 'auto', 'tap'].map(k => k + ' ' + nfTxt(NF[k])).join(' / '));
  add('ダンジョン: 次の階層で、歩数を使わずにイベントが起きない', ['fire', 'pause', 'back', 'auto', 'tap'].every(k => okNF(NF[k])), ['fire', 'pause', 'back', 'auto', 'tap'].map(k => k + ' ' + nfTxt(NF[k])).join(' / '));
  add('ダンジョン: 中断・たき火からの再開・帰還・オート切り替えのあとに、ボスを倒しても階層が1つだけ進む(結果が2回来ても)', ['fire', 'pause', 'back', 'auto', 'tap'].every(k => NF[k] && NF[k].fl == 1), ['fire', 'pause', 'back', 'auto', 'tap'].map(k => `${k} +${NF[k] ? NF[k].fl : '?'}`).join('・'));
  add('ダンジョン: dtick が二重に動いていない(もう一度開いても約0.6秒に1歩)', NF.rate >= 3 && NF.rate <= 6, `3秒で ${NF.rate}歩`);
  // 50階層をクリアしたら「ここまでが今の最後」
  const H = await ev(`window.DAUTO = (o, kind) => 'go'; openDungeon(); dstop(); DG.fl = 50; dclear(); await until(() => !$('or').hidden); const r = { t: $('or').innerText, s: S.dg.fl }; $('ov').hidden = true; dgEntry(); await w(200); r.e = $('odn').innerText; r.b = $('odn').querySelector('.big.ok').textContent; $('ov').hidden = true; return r;`);
  add('ダンジョン: 50階層クリアで「ここまでが今の最後」', /ここまでが今の最後/.test(H.t) && /ここまでが今の最後/.test(H.e) && /はじめから/.test(H.b), `結果「${H.t.split('\n')[0]}」・入り口「${H.b}」`);
  // 寿命で新しいたまごになると1階層に戻る(歴代の記録は残る)
  const L = await ev(`S.dg = { fl: 7, pg: 30, hp: 5, mp: 1 }; save(); const h0 = (S.hist || []).length; newEgg(); await w(300); const r = { dg: S.dg || null, cont: dgCont(), h: S.hist.length - h0 }; $('ov').hidden = true; return r;`);
  add('ダンジョン: 寿命で新しいたまごになると1階層に戻る', !L.dg && !L.cont && L.h == 1, `ダンジョンの状態 ${L.dg ? JSON.stringify(L.dg) : 'なし(1階層から)'}・歴代 +${L.h}`);
  // 歩くときの揺れ(視差効果を減らす設定なしの画面で): 歩いている間は揺れ、止まっているとき(イベント・歩数切れ)は揺れない
  {
    const { ctx: c2, page: p2 } = await newPage(browser, size, { reduce: false });
    await p2.evaluate(k => __T.setup(k, 12), k);
    const BB = await p2.evaluate(async () => {
      const w = ms => new Promise(r => setTimeout(r, ms)), samp = async ms => { let m = 0; const t0 = performance.now(); while (performance.now() - t0 < ms) { await new Promise(r => requestAnimationFrame(r)); if (DGV) m = Math.max(m, Math.abs(DGV.bx || 0), Math.abs(DGV.by || 0)); } return +m.toFixed(2); };
      DENC.foe = DENC.trp = 0; window.DAUTO = null; S.dgSteps = 1e6; S.dg = null; openDungeon(); DG.evs = [{ at: 60, k: 'box', done: 0 }];
      const walk = await samp(2000); dstop(); await w(300); const stop = await samp(1000); S.dgSteps = 0; dgo(); await w(1200); const nost = await samp(1000);
      S.dgSteps = 1e6; for (let i = 0; i < 200 && !(DGV && Math.abs(DGV.bx) > .8 * DBOB.x * 187); i++) await new Promise(r => requestAnimationFrame(r)); return { walk, stop, nost };
    });
    await p2.screenshot({ path: path.join(OUT, `dungeon-walk-${size.w}.png`) });
    await c2.close();
    add('ダンジョン: 止まっているとき(イベント・歩数切れ)は揺れない', BB.walk > 0 && BB.stop == 0 && BB.nost == 0, `揺れの最大(画面のドット) 歩いている間 ${BB.walk}・止まったとき ${BB.stop}・歩数切れ ${BB.nost}`);
  }
  add('ダンジョン(冒険)のエラー', !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  await ctx.close();
}

// ---------- ダンジョンのバトル: 出現の演出とリザルト ----------
async function fxCheck(browser, size) {
  const { ctx, page, errors } = await newPage(browser, size, { reduce: true });
  const k = await page.evaluate(() => SPR.fire.find(c => c.g == 3).k);
  await page.evaluate(k => __T.setup(k, 12), k);
  const W = `const w = ms => new Promise(r => setTimeout(r, ms)), until = async (f, n = 400) => { for (let i = 0; i < n && !f(); i++) await w(25); return f(); }, $ = id => document.getElementById(id);`;
  const ev = (src, arg) => page.evaluate(new Function('arg', `return (async () => { ${W} ${src} })()`), arg);
  const px = `[${size.w}px] `;
  // 写真のために演出をゆっくりにする(ピクセル化の途中・影から現れるところ)
  await ev(`DENC.foe = DENC.trp = 0; window.DAUTO = null; if (DAU) dauto(); S.dgSteps = 1e6; S.dg = null; openDungeon(); DG.evs = [{ at: 60, k: 'box', done: 0 }]; await w(1200); dstop();
    DFX.enc = 8000; window.__pr = devent('foe'); await until(() => !$('dpxc').hidden); await w(1400); return 0;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-fx-pixel-${size.w}.png`) });
  await ev(`await until(() => !$('ob').hidden, 600); await w(1700); return 0;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-fx-shadow-${size.w}.png`) });
  const A = await ev(`await until(() => BT && !BT.busy, 600); const r = { ob: !$('ob').hidden, n: BT.en.n, log: $('blog') ? $('blog').textContent : '', c0: !$('c0').disabled, dex: $('dex').hidden, px: $('dpxc').hidden };
    DFX.enc = 1000; BT.turn = 3; BT.busy = 1; bend(1); await until(() => !$('brs').hidden); await w(400); const b = $('brs'), bt = $('brn');
    r.res = { t: b.innerText, h: bt.getBoundingClientRect().height, hp: !!b.querySelector('.hpb i'), mp: !!b.querySelector('.hpb.m i'), inc: Object.keys(DG.inc).length }; return r;`);
  await page.screenshot({ path: path.join(OUT, `dungeon-fx-result-${size.w}.png`) });
  const A2 = await ev(`await w(2500); const still = !$('brs').hidden; $('brn').click(); await w(300); return { still, od: !$('od').hidden && $('brs').hidden, m: $('odm').textContent };`);
  // タップで飛ばす・オートONは短い・オートONでリザルトが自動で閉じる・逃げたときはリザルトなし
  const B = await ev(`dstop(); DFX.enc = 8000; const t0 = performance.now(); window.__pr = devent('foe'); await until(() => !$('dex').hidden); await w(300);
    $('ov').dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); await until(() => !$('ob').hidden && BT && !BT.busy); const skip = performance.now() - t0; DFX.enc = 1000;
    BT.busy = 1; bend(1); await until(() => !$('brs').hidden); $('brn').click(); await w(200); dstop();
    // ふつうの長さ(オートOFF)
    let t1 = performance.now(); window.__pr = devent('foe'); await until(() => !$('ob').hidden && BT && !BT.busy); const man = performance.now() - t1;
    BT.busy = 1; bend(1); await until(() => !$('brs').hidden); $('brn').click(); await w(200); dstop();
    // オートON: 演出が短く、リザルトは自動で閉じる
    dauto(); t1 = performance.now(); window.__pr = devent('foe'); await until(() => !$('ob').hidden && BT && !BT.busy); const auto = performance.now() - t1;
    BT.busy = 1; BT.auto = false; bend(1); await until(() => !$('brs').hidden); const t2 = performance.now(); await until(() => $('brs').hidden, 200); const close = performance.now() - t2, back = !$('od').hidden; dauto(); dstop();
    // 逃げる(リザルトは出さない)
    let seen = false; window.__pr = devent('foe'); await until(() => !$('ob').hidden && BT && !BT.busy && !$('c4').disabled); const iv = setInterval(() => { if (!$('brs').hidden) seen = true; }, 10);
    const oR = Math.random; let n0 = 0; Math.random = () => n0++ ? oR() : 0; $('c4').click(); await until(() => !$('od').hidden); Math.random = oR; await w(200); clearInterval(iv); const ft = $('odm').textContent; dstop(); clearInterval(DG.iv); DG.run = 0; $('ov').hidden = true;
    return { skip: Math.round(skip), man: Math.round(man), auto: Math.round(auto), close: Math.round(close), back, seen, ft };`);
  add(px + 'ダンジョン: 出現の演出(「!」→ピクセル化→影から現れる)のあとバトルになる', A.ob && A.c0 && A.dex && A.px && B.man >= 800 && B.man < 2000 && B.auto >= 350 && B.auto < B.man,
    `${A.n}とバトル・コマンド${A.c0 ? '押せる' : '押せない'}、演出 オートOFF ${B.man}ms・オートON ${B.auto}ms`);
  add(px + 'ダンジョン: 画面のタップで演出を飛ばせる', B.skip < 1500, `ゆっくり(8秒)の演出をタップ → ${B.skip}msでバトル`);
  add(px + 'ダンジョン: 勝ったらリザルトが出る(敵・ターン・獲得・HP/MPゲージ・つぎへ44px以上)', /勝利!/.test(A.res.t) && A.res.t.includes(A.n + 'を倒した') && /3ターン/.test(A.res.t) && /獲得/.test(A.res.t) && A.res.hp && A.res.mp && A.res.h >= 44,
    A.res.t.replace(/\n+/g, ' / ').slice(0, 120) + ` / ボタン${Math.round(A.res.h)}px`);
  add(px + 'ダンジョン: リザルトは「つぎへ」で歩く画面に戻る(オートOFFは待つ)', A2.still && A2.od && /撃退/.test(A2.m), `2.5秒後も${A2.still ? '待つ' : '閉じた'} → つぎへ → ${A2.od ? '歩く画面' : '戻らない'}「${A2.m}」`);
  add(px + 'ダンジョン: オートONでリザルトが自動で閉じる', B.close >= 1200 && B.close < 2500 && B.back, `${B.close}msで閉じて${B.back ? '歩く画面' : '戻らない'}`);
  add(px + 'ダンジョン: 逃げたときはリザルトが出ない', !B.seen && /うまく逃げきった/.test(B.ft), `リザルト${B.seen ? 'が出た' : 'なし'} →「${B.ft}」`);
  add(px + 'ダンジョンの演出・リザルトのエラー', !errors.length, errors.length ? errors.slice(0, 3).join(' / ') : 'エラーなし');
  await ctx.close();
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const t0 = Date.now();
  console.log('ウォークモンスター 自動テスト開始\n');
  syntaxCheck();
  const browser = await chromium.launch();
  const steps = [
    ['読み込み・音', 'sound', () => loadAndSound(browser)],
    ...WIDTHS.map(s => [`キャラ表示 ${s.w}px`, 'home', () => charaCheck(browser, s)]),
    ['一生', 'home', () => lifeCheck(browser)],
    ['お世話', 'home', () => careCheck(browser)],
    ['メッセージ', 'home', () => msgCheck(browser)],
    ['キャラ表示で段階', 'home', () => chrPickCheck(browser)],
    ['歴代の子', 'home', () => histCheck(browser)],
    ['ダークモード', 'other', () => darkCheck(browser)],
    ['空と寝る時間', 'home', () => skyCheck(browser)],
    ...[...WIDTHS, { w: 430, h: 932 }].map(s => [`バトル配置 ${s.w}px`, 'battle', () => battleLayoutCheck(browser, s)]),
    ['敵の見た目', 'battle', () => enemyLookCheck(browser)],
    ...WIDTHS.map(s => [`🔊の位置 ${s.w}px`, 'sound', () => sndCheck(browser, s)]),
    ...WIDTHS.map(s => [`オートボタンの位置 ${s.w}px`, 'dungeon', () => autoLayoutCheck(browser, s)]),
    ['にげる', 'battle', () => fleeCheck(browser)],
    ['バトル・ダンジョン', 'dungeon', () => battleCheck(browser)],
    ['冒険ダンジョン', 'dungeon', () => dgCheck(browser)],
    ...WIDTHS.map(s => [`バトルの演出 ${s.w}px`, 'dungeon', () => fxCheck(browser, s)]),
  ];
  // --only(または ONLY=)グループ名かテスト名の一部(カンマ区切り)で、そのテストだけ動かせる
  const os = optOnly || process.env.ONLY, only = os ? os.split(',') : null;
  console.log(`${FULL ? '全部(重いテストあり)' : 'ふだん用(重いテストなし)'}${only ? '・対象: ' + only.join(',') : ''}\n`);
  // ふだん用は3つずつ同時に動かす(--full は1つずつ)。時間のかかるものから始める
  const list = steps.filter(([n, g]) => !only || only.some(o => o == g || n.includes(o))), C = FULL ? 1 : 3;
  const order = ['冒険ダンジョン', 'バトル・ダンジョン', '敵の見た目', 'バトルの演出'];
  list.sort((a, b) => (order.findIndex(o => a[0].startsWith(o)) + 1 || 99) - (order.findIndex(o => b[0].startsWith(o)) + 1 || 99));
  let qi = 0;
  await Promise.all(Array.from({ length: C }, async () => {
    while (qi < list.length) {
      const [name, , fn] = list[qi++], t1 = Date.now();
      try { await fn(); } catch (e) { add(name, false, 'テストが途中で止まった: ' + e.message.split('\n')[0]); }
      console.log(`   (${name}: ${Math.round((Date.now() - t1) / 1000)}秒)`);
    }
  }));
  oldWordCheck();
  await browser.close();
  const ng = results.filter(r => !r.ok);
  console.log(`\n==== 結果: OK ${results.length - ng.length} / NG ${ng.length}(${Math.round((Date.now() - t0) / 1000)}秒) ====`);
  results.forEach(r => console.log(`${r.ok ? 'OK' : 'NG'}  ${r.name}`));
  if (ng.length) console.log('\nNG の理由:\n' + ng.map(r => `- ${r.name}: ${r.msg}`).join('\n'));
  console.log('\n※音は「鳴らされているか」だけ確認。聞こえ方は確認できません。');
  process.exit(ng.length ? 1 : 0);
})();
