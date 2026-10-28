// ダンジョンのバランス測定(ゲームのコードは変えない。ゲームの関数を横から包んで数えるだけ)
// 冒険ダンジョン: 毎回1階層から始めて、5階層のボスを倒したら帰る(1〜5階層の通し)。ダンジョン用の歩数は十分に持たせる
// 使い方: node tests/balance.js [--runs 200] [--stages 1,2,3,4,5] [--modes auto,manual] [--speed 40] [--jobs 4]
//  auto   = オートON(autoPick で戦い、選択は「無難」ルール)
//  manual = 自分で操作する代わりの「いちばん普通の戦い方」のテスト用操作(下の botPick)。選択はオートと同じ無難ルール
// --label 名前  : 結果を balance-名前.md / balance-名前.raw.json に出す(省略時は balance-report.md / balance-raw.json)
// --compare a,b : 保存した結果(balance-a.raw.json …)を並べて、前後の比較表を出す
// --pow a,b,c   : (--sweep と一緒に)敵の強さの倍率 DPOW.r を試しに変えて測る(--pow1 x で1階層の DPOW.f1)
// --sweep 20    : 階層ごとの突破率を測る(1〜20階層)。育てた子=階層 n を「n 日目まで ふつうに育てた子」で、その階層だけ(HP満タンから)。
//                 育てない子=生まれたままの能力の幼体で、1階層から5階層まで通し。結果は balance-sweep.md(--label でも変えられる)
// 結果は tests/output/balance-report.md と balance-raw.json に出す
const { chromium } = require('playwright');
const path = require('path');
const fs = require('fs');
const { spawn } = require('child_process');

const ROOT = path.join(__dirname, '..');
const URL = 'file://' + path.join(ROOT, 'index.html');
const OUT = path.join(__dirname, 'output');
const arg = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
const STNAME = ['', '幼体', '成長体', '成熟体', '完全体', '究極体'];

// ---- 「ふつうに育てた子」のモデル(前提。数字はここで変えられる) ----
// 1日あたり: 7000歩=70SP は全部 必殺技のレベルに(能力には振れない)/ 練習(タップ式 平均3段階、精神統一=MPを含む)を5回 / 進化のたびに全能力ボーナス
// 修行バトルの報酬は入れていない(そのぶん控えめな子)
const MODEL = { sp: 70, trainings: 5, tier: 3, scale: 1 };

// ---------------- 1ジョブ(段階1つ × 操作1つ × 回数)をブラウザで回す ----------------
// sw: 階層ごとの測定 { kind: 'grown'|'raw', start: 始める階層, stop: この階層を突破したら帰る, day: 育てた日数 }
async function worker(stage, mode, runs, speed, sw) {
  const browser = await chromium.launch();
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, reducedMotion: 'reduce' });
  await ctx.addInitScript(({ speed }) => {
    const sT = window.setTimeout, sI = window.setInterval;
    window.__realST = sT;
    // 技のエフェクトなどのアニメーションは測定に関係ないので、待たずに終わったことにする
    Element.prototype.animate = function () { return { finished: Promise.resolve(), cancel() {}, finish() {}, onfinish: null }; };
    window.setTimeout = (f, ms, ...a) => sT(f, (ms || 0) / speed, ...a);
    window.setInterval = (f, ms, ...a) => sI(f, (ms || 0) / speed, ...a);
  }, { speed });
  const page = await ctx.newPage();
  const errs = [];
  page.on('pageerror', e => errs.push(e.message));
  await page.goto(URL);
  await page.waitForFunction(() => typeof S !== 'undefined' && window.SPR);
  const out = await page.evaluate(async ({ stage, mode, runs, MODEL, sw }) => {
    // ---- 描画・バトル前の演出・リザルトは測定に関係ないので止める(速くするため) ----
    dview = () => {}; DFX.off = 1;
    // 調整用: --pow で敵の強さの倍率(DPOW.r)を一時的に変える
    if (sw && sw.pow) DPOW.r = sw.pow;
    if (sw && sw.pow1) DPOW.f1 = sw.pow1;
    // ---- 「ふつうに育てた子」を作る ----
    const k0 = SPR.fire.find(c => c.g == stage).k;
    const mk = () => {
      S = fresh(); S.dgSteps = 1e9; S.attr = ATR(k0); S.chr = k0; S.type = 'dra'; S.stage = stage; setTypeFor(k0); care(dNow());
      S.spLv = 1; checkLearn();
      if (sw && sw.kind == 'raw') return Object.assign({}, S.st);
      const days = sw ? sw.day : TH[stage] + .5, st = S.st, m = MODEL.scale;
      // 必殺技のレベル: その日数ぶんのSPで上げられるところまで
      for (let p = Math.round(days * MODEL.sp * m); spLv() < SPLM && p >= spCost(spLv()); ) { p -= spCost(spLv()); S.spLv = spLv() + 1; }
      const tr = TR.filter(t => !t.min || stage >= t.min);
      for (let i = 0; i < Math.round(days * MODEL.trainings * m); i++) { const t = tr[i % tr.length]; st[t.k] += GR(t.k, MODEL.tier * (t.m || 1)); }
      for (let e = 0; e < stage - 1; e++) { for (const k in st) if (k != 'sp') st[k] += GR(k, k == 'hp' ? 15 : 3); }
      return Object.assign({}, st);
    };
    const base = mk();
    // ---- オート/手動 ----
    if ((mode == 'auto') != DAU) dauto();
    // 選択は「無難」ルール(オートと同じ。dchoose に渡された safe を使う)。進むか帰るかは「進む」(5階層のボスを倒したあとは帰る)
    const stop = sw ? sw.stop : 5;
    window.DAUTO = (o, kind) => kind == 'path' ? (DG.fl > stop ? 'back' : 'go') : (DCQ && DCQ.safe) || o[0].k;
    // 「いちばん普通の戦い方」: HPが30%未満なら持っている一番弱いHP回復を使う(オートと同じ) / 必殺技が使えれば使う / 敵がためているときか、HPが30%未満なら防御
    // それ以外の技の選び方はオートと同じ(aiPick: 回復・補助・弱体・攻撃。MPが足りないときは通常攻撃)
    const botPick = () => {
      if (BT.dun && BT.php < BT.pmax * DAUIT) { const id = Object.keys(IT).filter(k => IT[k].t == 'hp' && (S.items || {})[k] > 0).sort((a, b) => IT[a].v - IT[b].v)[0]; if (id) return { k: 'it', id }; }
      if (BT.stock > 0 && S.stage >= 2) return { k: 'sp' };
      if (BT.en.ch || (BT.php < BT.pmax * .3 && !BT.guard)) return { k: 'g' };
      return { k: 'sk', s: aiPick(sdP(), sdE(), bskills(), BT.mp) };
    };
    // 「上手な操作」: 回復はHP40%未満 / ためているボスにはバリアかぼうぎょ / 強化したボスには攻撃ダウン / ボスには補助・弱体を先に
    // 攻撃は相性も入れて一番ダメージが出る技。ふつうの敵は通常攻撃中心で、MPはボスのために PRO.keep 残す
    const PRO = { heal: .4, keep: .6 };
    const proPick = () => {
      const E = BT.en, P = sdP(), D = sdE(), ok = bskills().filter(s => s.mp <= BT.mp), ef = s => s.ef || {}, boss = !!E.boss;
      if (BT.php < BT.pmax * PRO.heal) {
        if (BT.dun) { const id = Object.keys(IT).filter(k => IT[k].t == 'hp' && (S.items || {})[k] > 0).sort((a, b) => IT[a].v - IT[b].v)[0]; if (id) return { k: 'it', id }; }
        const h = ok.filter(s => ef(s).heal).sort((a, b) => ef(b).heal - ef(a).heal)[0]; if (h) return { k: 'sk', s: h };
      }
      if (E.c3 || E.ch) { const b = ok.find(s => ef(s).bar && !P.fx.bar); return b ? { k: 'sk', s: b } : { k: 'g' }; }
      if (boss && E.fx.upatk && !E.fx.dnatk) { const d = ok.find(s => ef(s).dn && ef(s).dn.atk); if (d) return { k: 'sk', s: d }; }
      if (boss) { const sup = ok.find(s => s.n != BT.last && (s.k == 'u' && Object.keys(ef(s).up).some(k => !P.fx['up' + k]) || s.k == 'd' && ef(s).dn && Object.keys(ef(s).dn).some(k => !D.fx['dn' + k]))); if (sup) return { k: 'sk', s: sup }; }
      if (BT.stock > 0 && S.stage >= 2) return { k: 'sp' };
      const a = est(P), b = est(D), res = (E.tr || []).includes('res'),
        dm = s => Math.max(1, dmg(Object.assign({}, s, { pw: skPw(s, P) }), a, b)) * aff(s.at, D.at) * (res && s.at && s.at == D.at ? BOSSX.res : 1) * s.acc;
      const keep = boss ? 0 : BT.st.mp * PRO.keep, atk = ok.filter(s => s.pw > 0 && (s.mp == 0 || BT.mp - s.mp >= keep)).sort((x, y) => dm(y) - dm(x));
      return { k: 'sk', s: atk[0] || NATK(P.at) };
    };
    if (mode == 'pro') setInterval(() => { if (BT && BT.en && !BT.auto && !BT.busy && !document.getElementById('ob').hidden && !document.getElementById('c0').disabled) bturn(proPick()); }, 30);
    if (mode == 'manual') setInterval(() => { if (BT && BT.en && !BT.auto && !BT.busy && !document.getElementById('ob').hidden && !document.getElementById('c0').disabled) bturn(botPick()); }, 30);
    // ---- 数える(ゲームの関数を包む) ----
    let cur = null, fork = 0, mimic = 0, done = null, strongNow = 0;
    const F = () => cur.fl[DG.fl] || (cur.fl[DG.fl] = { foe: 0, strong: 0, box: 0, spr: 0, shr: 0, trp: 0, mimic: 0, frk: 0, short: 0, viaFork: 0, planned: 0, sud: 0, sudT: 0 });
    const oT = bturn; bturn = async function () { const r = await oT.apply(this, arguments); if (BT && BT.mp <= 0) BT.mpz = 1; return r; };
    const oFloor = dfloor, oDevent = devent, oPick = dfkPick, oBf = bfight, oNext = dnext, oEnd = dend, oDm = dm;
    dfloor = function () { const r = oFloor.apply(this, arguments); const f = F(); f.planned++; cur.entry[DG.fl] = { hp: DG.hp, mp: DG.mp, mx: DG.mx, mmx: DG.mmx }; return r; };
    dm = function (t) { if (/ミミックだった/.test(t)) mimic = 1; return oDm.apply(this, arguments); };
    dfkPick = function () { const o = oPick.apply(this, arguments); if (o == 'short') F().short++; return o; };
    devent = async function (k, ev) {
      if (!cur) return oDevent.apply(this, arguments);
      const f = F(), hp0 = DG.hp, mx = DG.mx, via = fork > 0; mimic = 0;
      if (k == 'frk') { f.frk++; fork++; try { return await oDevent.apply(this, arguments); } finally { fork--; } }
      cur.lastK = k + (DG.fl); f[k]++; if (via) f.viaFork++; if (ev && ev.sudden) f[k == 'foe' ? 'sud' : 'sudT']++; if (k == 'foe' && ev && ev.st) f.strong++;
      strongNow = k == 'foe' && ev && ev.st ? 1 : 0;
      const r = await oDevent.apply(this, arguments);
      if (k == 'box' && mimic) { f.mimic++; cur.dmg.push({ kind: 'mimic', fl: DG.fl, pct: (hp0 - DG.hp) / mx * 100 }); }
      if (k == 'trp') cur.dmg.push({ kind: 'trp', fl: DG.fl, pct: (hp0 - DG.hp) / mx * 100 });
      return r;
    };
    bfight = function (en, php, dun, auto, esc, pmp) {
      if (!dun || !cur) return oBf.apply(this, arguments);
      const hp0 = php, mx = DG.mx, fl = DG.fl, boss = !!en.boss, mp0 = pmp;
      const strong = strongNow, rec = (win, extra) => cur.foes.push(Object.assign({ fl, boss, win: !!win, turns: BT.turn, mp0, mp1: BT.mp, mmx: DG.mmx, strong, mpz: !!BT.mpz }, extra));
      const w = (win, inc, p) => { rec(win, { dmg: (hp0 - Math.max(0, p)) / mx * 100 }); return dun(win, inc, p); };
      const e = esc ? p => { rec(false, { dmg: (hp0 - Math.max(0, p)) / mx * 100, fled: 1 }); return esc(p); } : esc;
      return oBf.call(this, en, php, w, auto, e, pmp);
    };
    dnext = function () { if (cur && !cur.camps[DG.fl]) cur.camps[DG.fl] = { hp: DG.hp, mx: DG.mx, mp: DG.mp, mmx: DG.mmx }; if (cur && DG.fl == 5 && !cur.camp) cur.camp = { hp: DG.hp, mp: DG.mp, mx: DG.mx, mmx: DG.mmx }; return oNext.apply(this, arguments); };
    dend = function (c) { const r = oEnd.apply(this, arguments); if (cur) { cur.end = c; cur.floor = DG.fl; if (c == 0) cur.cause = cur.lastK; if (done) done(); } return r; };
    // ---- 回す ----
    const res = [], stuck = [];
    for (let i = 0; i < runs; i++) {
      S.st = Object.assign({}, base); S.dg = sw && sw.start > 1 ? { fl: sw.start, hp: null, mp: null, pend: {} } : null; S.dgSteps = 1e9; S.stage = stage; S.wins = 0; S.items = {};
      cur = { fl: {}, entry: {}, dmg: [], foes: [], camp: null, camps: {}, end: null };
      const p = new Promise(r => { done = r; });
      openDungeon();
      // 進行(dtick)は本物のゲームと同じ関数。50ms ごとのタイマーの代わりに、すき間なく呼んで速くする
      clearInterval(DG.iv); DG.iv = 0; const mc = new MessageChannel(), me = DG; mc.port1.onmessage = () => { if (DG === me && DG.run) { dtick(); mc.port2.postMessage(0); } }; mc.port2.postMessage(0);
      const ok = await Promise.race([p.then(() => 1), new Promise(r => window.__realST(r, 120000)).then(() => 0)]);
      if (!ok) { stuck.push(i + 1); clearInterval(DG.iv); DG.run = 0; }
      document.getElementById('ov').hidden = true;
      if (sw) cur.cleared = (DG.fl || sw.start) - sw.start;
      res.push(cur); cur = null; done = null;
    }
    return { res, stuck, base: Object.assign({ lv: spLv() }, base) };
  }, { stage, mode, runs, MODEL, sw: sw || null });
  await browser.close();
  return Object.assign(out, { errs });
}

// ---------------- 集計 ----------------
const avg = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const mn = a => a.length ? Math.min(...a) : NaN;
const f1 = x => Number.isFinite(x) ? x.toFixed(1) : '-';
const f2 = x => Number.isFinite(x) ? x.toFixed(2) : '-';
const pc = (n, d) => d ? Math.round(n / d * 100) + '%' : '-';

function summarize(runs) {
  const N = runs.length, floors = [1, 2, 3, 4, 5];
  const ev = {};
  for (const fl of floors) {
    ev[fl] = {};
    // その階層に入った1回あたり
    for (const k of ['foe', 'strong', 'box', 'spr', 'shr', 'trp', 'mimic', 'frk', 'short', 'viaFork', 'planned', 'sud', 'sudT'])
      ev[fl][k] = avg(runs.filter(r => r.fl[fl]).map(r => r.fl[fl][k] || 0));
    ev[fl].n = runs.filter(r => r.fl[fl]).length;
  }
  // たき火に着いたときのHP(回復の前。階層別と全部の平均)
  const campFl = {}, campAll = runs.flatMap(r => Object.values(r.camps).map(c => c.hp / c.mx * 100));
  for (const fl of floors) { const a = runs.map(r => r.camps[fl]).filter(Boolean).map(c => c.hp / c.mx * 100); campFl[fl] = { n: a.length, avg: avg(a), min: mn(a) }; }
  const foes = runs.flatMap(r => r.foes).filter(f => !f.boss), boss = runs.flatMap(r => r.foes).filter(f => f.boss);
  const wins = foes.filter(f => f.win);
  const camp = runs.filter(r => r.camp);
  const dmg = k => runs.flatMap(r => r.dmg).filter(d => d.kind == k);
  const heal = runs.map(r => ['spr', 'shr'].reduce((a, k) => a + Object.values(r.fl).reduce((s, f) => s + (f[k] || 0), 0), 0));
  const entry = {};
  for (const fl of floors) { const e = runs.map(r => r.entry[fl]).filter(Boolean); entry[fl] = { n: e.length, avg: avg(e.map(x => x.hp / x.mx * 100)), min: mn(e.map(x => x.hp / x.mx * 100)), mp: avg(e.map(x => x.mp / x.mmx * 100)) }; }
  const byFl = {};
  for (const fl of floors) { const a = foes.filter(f => f.fl == fl), w = a.filter(f => f.win); byFl[fl] = { n: a.length, dmg: avg(a.map(f => f.dmg)), turns: avg(w.map(f => f.turns)), lose: a.filter(f => !f.win).length / (a.length || 1) * 100 }; }
  const bossFl = {};
  for (const fl of floors) { const a = boss.filter(f => f.fl == fl); bossFl[fl] = { n: a.length, win: a.filter(f => f.win).length }; }
  return {
    causes: runs.filter(r => r.end == 0).reduce((o, r) => (o[r.cause] = (o[r.cause] || 0) + 1, o), {}),
    N, ev, entry, byFl, bossFl, campFl, campAll: avg(campAll),
    heal: avg(heal), campHeal: camp.length / N,
    campHp: { avg: avg(camp.map(r => r.camp.hp / r.camp.mx * 100)), min: mn(camp.map(r => r.camp.hp / r.camp.mx * 100)), mp: avg(camp.map(r => r.camp.mp / r.camp.mmx * 100)), mpMin: mn(camp.map(r => r.camp.mp / r.camp.mmx * 100)) },
    foeDmg: avg(foes.map(f => f.dmg)), foeTurns: avg(wins.map(f => f.turns)), foeN: foes.length, foePerRun: foes.length / N,
    foeLose: foes.filter(f => !f.win).length / (foes.length || 1) * 100,
    trapDmg: avg(dmg('trp').map(d => d.pct)), trapN: dmg('trp').length, mimicDmg: avg(dmg('mimic').map(d => d.pct)), mimicN: dmg('mimic').length,
    boxN: avg(runs.map(r => Object.values(r.fl).reduce((s, f) => s + f.box, 0))),
    died: runs.filter(r => r.end == 0).length, bossLose: runs.filter(r => r.end == 1).length, bossWin: runs.filter(r => r.floor > 5).length, camp: camp.length,
    bossTurns: avg(boss.filter(f => f.win).map(f => f.turns)), bossDmg: avg(boss.map(f => f.dmg)),
  };
}

function report(all, cfg) {
  const L = [];
  const modes = cfg.modes, stages = cfg.stages;
  L.push('# ダンジョンのバランス測定', '');
  L.push(`各条件 ${cfg.runs} 回通し(オートの設定は ${modes.map(m => m == 'auto' ? 'オートON' : '手動(テスト用の普通の戦い方)').join(' / ')})`, '');
  L.push('**前提**', '- キャラ: ドラゴン型・ほのお。各段階の入り口の日数まで「ふつうに育てた」子(1日 4000歩・練習5回・進化ボーナス。修行バトルの報酬なし)',
    `- ステータス: ${stages.map(s => { const b = all[`${stages[0] == s ? '' : ''}${s}|${modes[0]}`].base; return `${STNAME[s]} 攻${b.atk}/防${b.def}/HP${b.hp}/MP${b.mp}`; }).join('、')}`,
    '- 選択: 宝箱・罠・祠・分かれ道は「無難」ルール(オートと同じ)。進むか帰るかは必ず「進む」。手動は 必殺技が使えれば使う・敵がためたらかHP30%未満で防御・ほかは威力の高い技', '');
  for (const mode of modes) {
    const mName = mode == 'auto' ? 'オートON' : '手動(テスト用の普通の戦い方)';
    const S_ = Object.fromEntries(stages.map(s => [s, summarize(all[`${s}|${mode}`].res)]));
    L.push(`## ${mName}`, '', '### 結果(段階別。たき火・魔王は5階層の強ボス)', '| 段階 | 力尽きる | たき火のHP(全階層の平均) | 5階層のたき火に着く | 魔王に勝つ | 敵1体のダメージ | 倒すターン | 敵に負ける率 |', '|---|---|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${pc(x.died, x.N)} | ${f1(x.campAll)}% | ${pc(x.camp, x.N)} | ${pc(x.bossWin, x.N)}(着いた人の${pc(x.bossWin, x.camp)}) | ${f1(x.foeDmg)}% | ${f1(x.foeTurns)} | ${f1(x.foeLose)}% |`); }
    L.push('', '### 罠・ミミック・回復', '| 段階 | 罠のダメージ | ミミックのダメージ | 泉・祠 /回 | たき火のHP(平均/最小) | たき火のMP(平均/最小) |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${f1(x.trapDmg)}%(${x.trapN}件) | ${f1(x.mimicDmg)}%(${x.mimicN}件) | ${f2(x.heal)} | ${f1(x.campHp.avg)}% / ${f1(x.campHp.min)}% | ${f1(x.campHp.mp)}% / ${f1(x.campHp.mpMin)}% |`); }
    L.push('', '(ダメージは最大HPに対する%。回復スポットはほかに各階層の最後のたき火。この表のたき火は5階層のもの)', '');
    L.push('### 力尽きた原因(イベントの種類+階層: 回数)', ...stages.map(s => `- ${STNAME[s]}: ${Object.entries(S_[s].causes).map(([k, n]) => k + ' ' + n).join('、') || 'なし'}`), '');
    L.push('### たき火に着いたときのHP(回復の前。最大HPに対する%、平均/最小・着いた回数)', '| 段階 | 1階層 | 2階層 | 3階層 | 4階層 | 5階層 |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${[1, 2, 3, 4, 5].map(fl => { const c = x.campFl[fl]; return c.n ? `${f1(c.avg)} / ${f1(c.min)}(${c.n})` : '-'; }).join(' | ')} |`); }
    L.push('');
    L.push('### 各階層のボス(勝った/挑んだ。5階層は強ボス)', '| 段階 | 1階層 | 2階層 | 3階層 | 4階層 | 5階層 |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${[1, 2, 3, 4, 5].map(fl => { const b = x.bossFl[fl]; return b.n ? `${b.win}/${b.n}(${pc(b.win, b.n)})` : '-'; }).join(' | ')} |`); }
    L.push('');
    L.push('### 各層の入り口のHP(最大HPに対する%、平均/最小)', '| 段階 | 1階層 | 2階層 | 3階層 | 4階層 | 5階層 |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${[1, 2, 3, 4, 5].map(fl => x.entry[fl].n ? `${f1(x.entry[fl].avg)} / ${f1(x.entry[fl].min)}` : '-').join(' | ')} |`); }
    L.push('', '### 敵1体あたり(層別。受けるダメージ%/倒すターン/負ける率)', '| 段階 | 1階層 | 2階層 | 3階層 | 4階層 | 5階層 |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${[1, 2, 3, 4, 5].map(fl => { const b = x.byFl[fl]; return b.n ? `${f1(b.dmg)}% / ${f1(b.turns)}T / ${f1(b.lose)}%` : '-'; }).join(' | ')} |`); }
    L.push('', '### 1階層あたりのバトル・イベントの回数(その階層に入った1回あたり平均。ボスは別)', '| 段階・層 | バトル(突然/強め) | 宝箱 | ミミック | 泉 | 祠 | 罠(突然) | 分かれ道 | 近道 |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of stages) for (const fl of [1, 2, 3, 4, 5]) { const e = S_[s].ev[fl]; if (!e.n) continue; L.push(`| ${STNAME[s]} ${fl}階層 | ${f2(e.foe)}(${f2(e.sud)}/${f2(e.strong)}) | ${f2(e.box)} | ${f2(e.mimic)} | ${f2(e.spr)} | ${f2(e.shr)} | ${f2(e.trp)}(${f2(e.sudT)}) | ${f2(e.frk)} | ${f2(e.short)} |`); }
    L.push('', '(分かれ道の先から出たものも、それぞれの種類に数えている)', '');
  }
  return L.join('\n');
}

// 前後の比較表(主な指標だけ)
function compare(labels) {
  const raws = labels.map(l => JSON.parse(fs.readFileSync(path.join(OUT, `balance-${l}.raw.json`), 'utf8')));
  const modes = ['auto', 'manual'], L = [];
  const row = (name, f) => { L.push(`| ${name} | ${raws.map(r => f(r)).join(' | ')} |`); };
  for (const mode of modes) {
    const stages = [...new Set(Object.keys(raws[0]).filter(k => k.endsWith('|' + mode)).map(k => +k.split('|')[0]))].filter(st => raws.every(r => r[`${st}|${mode}`])).sort();
    L.push(`## ${mode == 'auto' ? 'オートON' : '手動'}(${labels.join(' → ')})`);
    const metrics = [['魔王に勝つ', x => pc(x.bossWin, x.N)], ['力尽きる', x => pc(x.died, x.N)], ['たき火に着く', x => pc(x.camp, x.N)], ['たき火のHP平均', x => f1(x.campHp.avg) + '%'], ['4層入口のHP平均', x => f1(x.entry[4].avg) + '%'], ['敵を倒すターン', x => f1(x.foeTurns)], ['敵1体のダメージ', x => f1(x.foeDmg) + '%'], ['泉・祠/回', x => f2(x.heal)], ['罠のダメージ', x => f1(x.trapDmg) + '%'], ['ミミック', x => f1(x.mimicDmg) + '%']];
    for (const [mn_, f] of metrics) {
      L.push('', `**${mn_}**`, `| 段階 | ${labels.join(' | ')} |`, `|---|${labels.map(() => '---').join('|')}|`);
      for (const st of stages) L.push(`| ${STNAME[st]} | ${raws.map(r => f(summarize(r[`${st}|${mode}`].res))).join(' | ')} |`);
    }
    L.push('');
  }
  return L.join('\n');
}

// ---------------- 階層ごとの突破率(--sweep) ----------------
const TH = [0, 1, 3, 6, 10, 15], stageOf = d => TH.reduce((g, t, s) => s && d >= t ? s : g, 1);
async function sweep() {
  const pow = arg('pow') ? arg('pow').split(',').map(Number) : null, pow1 = arg('pow1') ? +arg('pow1') : null, F = +arg('sweep', 20), runs = +arg('runs', 30), modes = arg('modes', 'auto,manual').split(','), speed = +arg('speed', 40), jobs = +arg('jobs', 4);
  // --floors 1,2,3,5: 測る階層をしぼる(省略時は 1〜F)
  const FL = arg('floors') ? arg('floors').split(',').map(Number) : Array.from({ length: F }, (_, i) => i + 1);
  fs.mkdirSync(OUT, { recursive: true });
  const queue = [];
  for (const m of modes) {
    for (const n of FL) queue.push({ key: `grown|${m}|${n}`, s: stageOf(n), m, sw: { kind: 'grown', start: n, stop: n, day: n, pow, pow1 } });
    for (let c = 0; c < 2; c++) queue.push({ key: `raw|${m}`, s: 1, m, sw: { kind: 'raw', start: 1, stop: 5, pow, pow1 }, n: runs / 2 });
  }
  const all = {}, t0 = Date.now();
  let active = 0, idx = 0, finished = 0;
  await new Promise(resolve => {
    const next = () => {
      while (active < jobs && idx < queue.length) {
        const q = queue[idx], out = path.join(OUT, `sw-${idx}.json`); idx++; active++;
        const p = spawn(process.execPath, [__filename, '--worker', '--stage', q.s, '--mode', q.m, '--runs', q.n || runs, '--speed', speed, '--out', out, '--sw', JSON.stringify(q.sw)], { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('exit', () => {
          active--; finished++;
          try { const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); const a = all[q.key] || (all[q.key] = { s: q.s, cl: [], base: r.base, stuck: 0, cmp: [], fz: 0, fn: 0 }); a.cl.push(...r.res.map(x => x.cleared)); r.res.forEach(x => { Object.values(x.camps).forEach(c => a.cmp.push(c.mp / c.mmx * 100)); x.foes.forEach(f => { a.fn++; if (f.mpz) a.fz++; }); }); a.stuck += r.stuck.length; } catch (e) { console.error(q.key, e.message); }
          process.stdout.write(`\r進行 ${finished}/${queue.length}(${Math.round((Date.now() - t0) / 1000)}秒)`);
          if (finished == queue.length) resolve(); else next();
        });
      }
    };
    next();
  });
  console.log('');
  const pc = (a, k) => a && a.cl.length ? Math.round(a.cl.filter(c => c >= k).length / a.cl.length * 100) + '%' : '-';
  const L = ['# 階層ごとの突破率', '', `各 ${runs} 回。操作: ${modes.map(m => m == 'auto' ? 'オートON' : '手動(テスト用の普通の戦い方・HP30%未満で回復アイテム)').join(' / ')}`, '',
    '## 育てた子(階層 n を、n 日目まで ふつうに育てた子で。その階層だけ・HP満タンから)', '', `| 階層 | 段階 | 攻/防/HP | ${modes.join(' | ')} |`, `|---|---|---|${modes.map(() => '---').join('|')}|`];
  const mpS = a => a && a.fn ? `${a.cmp.length ? Math.round(a.cmp.reduce((x, y) => x + y, 0) / a.cmp.length) + '%' : '-'} / ${Math.round(a.fz / a.fn * 100)}%` : '-';
  L[L.length - 2] = `| 階層 | 段階 | 攻/防/HP/MP・必殺Lv | ${modes.join(' | ')} | ${modes.map(m => m + ' たき火MP/MP0の戦闘').join(' | ')} |`; L[L.length - 1] = `|---|---|---|${modes.map(() => '---|---').join('|')}|`;
  for (const n of FL) { const a = all[`grown|${modes[0]}|${n}`], b = a && a.base; L.push(`| ${n} | ${STNAME[stageOf(n)]} | ${b ? b.atk + '/' + b.def + '/' + b.hp + '/' + b.mp + '・Lv' + b.lv : '-'} | ${modes.map(m => pc(all[`grown|${m}|${n}`], 1)).join(' | ')} | ${modes.map(m => mpS(all[`grown|${m}|${n}`])).join(' | ')} |`); }
  L.push('', '## 育てない子(生まれたままの能力の幼体。1階層から通しで、その階層まで突破した割合)', '', `| 階層 | ${modes.join(' | ')} |`, `|---|${modes.map(() => '---').join('|')}|`);
  for (let n = 1; n <= 5; n++) L.push(`| ${n} | ${modes.map(m => pc(all[`raw|${m}`], n)).join(' | ')} |`);
  L.push('', '育てない子のたき火MP/MP0の戦闘: ' + modes.map(m => m + ' ' + mpS(all[`raw|${m}`])).join('、'));
  const stuck = Object.entries(all).filter(([, v]) => v.stuck).map(([k, v]) => `${k}: ${v.stuck}回`);
  if (stuck.length) L.push('', '止まった回: ' + stuck.join('、'));
  const md = L.join('\n'), lb = arg('label', 'sweep');
  fs.writeFileSync(path.join(OUT, `balance-${lb}.md`), md);
  fs.writeFileSync(path.join(OUT, `balance-${lb}.raw.json`), JSON.stringify(all));
  console.log(md);
}

// ---------------- 区間ごとの通し(--seg) ----------------
// 1〜5・6〜10・11〜15階層を、HP・MP・アイテムを持ち越して通しで。始めはその区間の最初の階層の日数ぶん育てた子
async function segs() {
  const runs = +arg('runs', 30), modes = arg('modes', 'auto,pro').split(','), speed = +arg('speed', 40), jobs = +arg('jobs', 4), SG = [[1, 5], [6, 10], [11, 15]];
  fs.mkdirSync(OUT, { recursive: true });
  const queue = [];
  for (const m of modes) for (const [a, b] of SG) for (let c = 0; c < 2; c++) queue.push({ key: `${a}-${b}|${m}`, s: stageOf(a), m, sw: { kind: 'grown', start: a, stop: b, day: a }, n: runs / 2 });
  const all = {}, t0 = Date.now(); let active = 0, idx = 0, finished = 0;
  await new Promise(resolve => {
    const next = () => {
      while (active < jobs && idx < queue.length) {
        const q = queue[idx], out = path.join(OUT, `sg-${idx}.json`); idx++; active++;
        const p = spawn(process.execPath, [__filename, '--worker', '--stage', q.s, '--mode', q.m, '--runs', q.n, '--speed', speed, '--out', out, '--sw', JSON.stringify(q.sw)], { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('exit', () => {
          active--; finished++;
          try { const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); const a = all[q.key] || (all[q.key] = { res: [], stuck: 0 }); a.res.push(...r.res); a.stuck += r.stuck.length; } catch (e) { console.error(q.key, e.message); }
          process.stdout.write(`\r進行 ${finished}/${queue.length}(${Math.round((Date.now() - t0) / 1000)}秒)`);
          if (finished == queue.length) resolve(); else next();
        });
      }
    };
    next();
  });
  console.log('');
  const L = ['# 区間ごとの通し(HP・MP・アイテムを持ち越す)', '', `各 ${runs} 回`, '', '| 区間 | 操作 | ふつうの敵で力尽きる | 普通のボスの勝率 | 強ボスの勝率 | ボス戦の平均ターン(普通/強) | 区間を突破 |', '|---|---|---|---|---|---|---|'];
  for (const [a, b] of SG) for (const m of modes) {
    const x = all[`${a}-${b}|${m}`]; if (!x) continue; const R = x.res, N = R.length, bs = R.flatMap(r => r.foes.filter(f => f.boss)), nb = bs.filter(f => f.fl % 5), sb = bs.filter(f => f.fl % 5 == 0);
    const died = R.filter(r => r.end == 0 && /^foe/.test(r.cause || '')).length, wr = a => a.length ? `${Math.round(a.filter(f => f.win).length / a.length * 100)}%(${a.filter(f => f.win).length}/${a.length})` : '-';
    L.push(`| ${a}〜${b} | ${m == 'auto' ? 'オート' : m == 'pro' ? '上手な操作' : m} | ${Math.round(died / N * 100)}% | ${wr(nb)} | ${wr(sb)} | ${f1(avg(nb.map(f => f.turns)))} / ${f1(avg(sb.map(f => f.turns)))} | ${Math.round(R.filter(r => r.floor > b).length / N * 100)}% |`);
  }
  const md = L.join('\n'), lb = arg('label', 'seg');
  fs.writeFileSync(path.join(OUT, `balance-${lb}.md`), md);
  console.log(md);
}

// ---------------- メイン ----------------
(async () => {
  if (process.argv.includes('--compare')) { console.log(compare(arg('compare').split(','))); return; }
  if (process.argv.includes('--worker')) {
    const [stage, mode, runs, speed] = [+arg('stage'), arg('mode'), +arg('runs'), +arg('speed', 40)];
    const r = await worker(stage, mode, runs, speed, arg('sw') ? JSON.parse(arg('sw')) : null);
    fs.writeFileSync(arg('out'), JSON.stringify(r));
    return;
  }
  if (process.argv.includes('--sweep')) return sweep();
  if (process.argv.includes('--seg')) return segs();
  const cfg = { runs: +arg('runs', 200), stages: arg('stages', '1,2,3,4,5').split(',').map(Number), modes: arg('modes', 'auto,manual').split(','), speed: +arg('speed', 40), jobs: +arg('jobs', 4) };
  const chunk = Math.max(1, Math.ceil(cfg.runs / cfg.jobs));
  fs.mkdirSync(OUT, { recursive: true });
  const queue = [];
  for (const s of cfg.stages) for (const m of cfg.modes) for (let c = 0, n = 0; n < cfg.runs; c++, n += chunk) queue.push({ s, m, n: Math.min(chunk, cfg.runs - n), c });
  const all = {}, t0 = Date.now();
  let active = 0, idx = 0, finished = 0;
  await new Promise(resolve => {
    const next = () => {
      while (active < cfg.jobs && idx < queue.length) {
        const q = queue[idx++], out = path.join(OUT, `bal-${q.s}-${q.m}-${q.c}.json`);
        active++;
        const p = spawn(process.execPath, [__filename, '--worker', '--stage', q.s, '--mode', q.m, '--runs', q.n, '--speed', cfg.speed, '--out', out], { stdio: ['ignore', 'inherit', 'inherit'] });
        p.on('exit', code => {
          active--; finished++;
          try { const r = JSON.parse(fs.readFileSync(out, 'utf8')); fs.unlinkSync(out); const key = `${q.s}|${q.m}`; const a = all[key] || (all[key] = { res: [], stuck: 0, base: r.base }); a.res.push(...r.res); a.stuck += r.stuck.length; if (r.errs && r.errs.length) console.log('エラー', r.errs.slice(0, 2)); } catch (e) { console.log('ジョブ失敗', q, code, e.message); }
          process.stdout.write(`\r進行 ${finished}/${queue.length}(${Math.round((Date.now() - t0) / 1000)}秒)`);
          if (finished == queue.length) resolve(); else next();
        });
      }
    };
    next();
  });
  console.log('');
  const md = report(all, cfg);
  const lb = arg('label', null);
  fs.writeFileSync(path.join(OUT, lb ? `balance-${lb}.md` : 'balance-report.md'), md);
  fs.writeFileSync(path.join(OUT, lb ? `balance-${lb}.raw.json` : 'balance-raw.json'), JSON.stringify(all));
  const stuck = Object.entries(all).filter(([, v]) => v.stuck).map(([k, v]) => `${k}: ${v.stuck}回`);
  console.log(md + (stuck.length ? '\n止まった回: ' + stuck.join('、') : ''));
})();
