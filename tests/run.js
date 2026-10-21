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
    reducedMotion: opt.reduce ? 'reduce' : 'no-preference', locale: 'ja-JP',
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
