// ダンジョンのバランス測定(ゲームのコードは変えない。ゲームの関数を横から包んで数えるだけ)
// 使い方: node tests/balance.js [--runs 200] [--stages 1,2,3,4,5] [--modes auto,manual] [--speed 40] [--jobs 4]
//  auto   = オートON(autoPick で戦い、選択は「無難」ルール)
//  manual = 自分で操作する代わりの「いちばん普通の戦い方」のテスト用操作(下の botPick)。選択はオートと同じ無難ルール
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
// 1日あたり: 4000歩=40ポイントを 攻・防・素・魔攻・魔防に6ずつ、HPに6、MPに4 / 練習(タップ式 平均3段階)を5回 / 進化のたびに全能力ボーナス
// 修行バトルの報酬は入れていない(そのぶん控えめな子)
const MODEL = { pts: { atk: 6, def: 6, spd: 6, matk: 6, mdef: 6, hp: 6, mp: 4 }, trainings: 5, tier: 3, scale: 1 };

// ---------------- 1ジョブ(段階1つ × 操作1つ × 回数)をブラウザで回す ----------------
async function worker(stage, mode, runs, speed) {
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
  const out = await page.evaluate(async ({ stage, mode, runs, MODEL }) => {
    // ---- 描画は測定に関係ないので止める(速くするため) ----
    dview = () => {};
    // ---- 「ふつうに育てた子」を作る ----
    const k0 = SPR.fire.find(c => c.g == stage).k;
    const mk = () => {
      S = fresh(); S.attr = ATR(k0); S.chr = k0; S.type = 'dra'; S.stage = stage; setTypeFor(k0); care(dNow());
      const days = TH[stage] + .5, st = S.st, m = MODEL.scale;
      for (const k in MODEL.pts) st[k] += Math.round(days * MODEL.pts[k] * m) * (UP[k] || 1);
      const tr = TR.filter(t => !t.min || stage >= t.min);
      for (let i = 0; i < Math.round(days * MODEL.trainings * m); i++) { const t = tr[i % tr.length]; st[t.k] += GR(t.k, MODEL.tier * (t.m || 1)); }
      for (let e = 0; e < stage - 1; e++) { for (const k in st) if (k != 'sp') st[k] += GR(k, k == 'hp' ? 15 : 3); }
      if (stage >= 2) st.sp = Math.max(st.sp, 5);
      return Object.assign({}, st);
    };
    const base = mk();
    // ---- オート/手動 ----
    if ((mode == 'auto') != DAU) dauto();
    // 選択は「無難」ルール(オートと同じ。dchoose に渡された safe を使う)。進むか帰るかは「進む」
    window.DAUTO = (o, kind) => kind == 'path' ? 'go' : (DCQ && DCQ.safe) || o[0].k;
    // 「いちばん普通の戦い方」: 必殺技が使えれば使う / 敵がためているときか、HPが30%未満なら防御 / それ以外はMPが足りる中でいちばん威力×命中の高い技
    const botPick = () => {
      if (BT.stock > 0 && S.stage >= 2) return { k: 'sp' };
      if (BT.en.ch || (BT.php < BT.pmax * .3 && !BT.guard)) return { k: 'g' };
      const ks = known().filter(s => s.mp <= BT.mp).sort((a, b) => b.pw * b.acc - a.pw * a.acc);
      return ks.length ? { k: 'sk', s: ks[0] } : { k: 'g' };
    };
    if (mode == 'manual') setInterval(() => { if (BT && BT.en && !BT.auto && !BT.busy && !document.getElementById('ob').hidden && !document.getElementById('c0').disabled) bturn(botPick()); }, 30);
    // ---- 数える(ゲームの関数を包む) ----
    let cur = null, fork = 0, mimic = 0, done = null;
    const F = () => cur.fl[DG.fl] || (cur.fl[DG.fl] = { foe: 0, strong: 0, box: 0, spr: 0, shr: 0, trp: 0, mimic: 0, frk: 0, short: 0, viaFork: 0, planned: 0 });
    const oFloor = dfloor, oDevent = devent, oPick = dfkPick, oBf = bfight, oNext = dnext, oEnd = dend, oDm = dm;
    dfloor = function () { const r = oFloor.apply(this, arguments); const f = F(); f.planned++; cur.entry[DG.fl] = { hp: DG.hp, mp: DG.mp, mx: DG.mx, mmx: DG.mmx }; return r; };
    dm = function (t) { if (/ミミックだった/.test(t)) mimic = 1; return oDm.apply(this, arguments); };
    dfkPick = function () { const o = oPick.apply(this, arguments); if (o == 'short') F().short++; return o; };
    devent = async function (k, ev) {
      if (!cur) return oDevent.apply(this, arguments);
      const f = F(), hp0 = DG.hp, mx = DG.mx, via = fork > 0; mimic = 0;
      if (k == 'frk') { f.frk++; fork++; try { return await oDevent.apply(this, arguments); } finally { fork--; } }
      f[k]++; if (via) f.viaFork++; if (k == 'foe' && ev && ev.st) f.strong++;
      const r = await oDevent.apply(this, arguments);
      if (k == 'box' && mimic) { f.mimic++; cur.dmg.push({ kind: 'mimic', fl: DG.fl, pct: (hp0 - DG.hp) / mx * 100 }); }
      if (k == 'trp') cur.dmg.push({ kind: 'trp', fl: DG.fl, pct: (hp0 - DG.hp) / mx * 100 });
      return r;
    };
    bfight = function (en, php, dun, auto, esc, pmp) {
      if (!dun || !cur) return oBf.apply(this, arguments);
      const hp0 = php, mx = DG.mx, fl = DG.fl, boss = !!en.boss, mp0 = pmp;
      const rec = (win, extra) => cur.foes.push(Object.assign({ fl, boss, win: !!win, turns: BT.turn, mp0, mmx: DG.mmx }, extra));
      const w = (win, inc, p) => { rec(win, { dmg: (hp0 - Math.max(0, p)) / mx * 100 }); return dun(win, inc, p); };
      const e = esc ? p => { rec(false, { dmg: (hp0 - Math.max(0, p)) / mx * 100, fled: 1 }); return esc(p); } : esc;
      return oBf.call(this, en, php, w, auto, e, pmp);
    };
    dnext = function () { if (cur && DG.fl >= 4 && !cur.camp) cur.camp = { hp: DG.hp, mp: DG.mp, mx: DG.mx, mmx: DG.mmx }; return oNext.apply(this, arguments); };
    dend = function (c) { const r = oEnd.apply(this, arguments); if (cur) { cur.end = c; cur.floor = Math.min(DG.fl, 5); if (done) done(); } return r; };
    // ---- 回す ----
    const res = [], stuck = [];
    for (let i = 0; i < runs; i++) {
      S.st = Object.assign({}, base); S.dun = -99; S.stage = stage; S.wins = 0;
      cur = { fl: {}, entry: {}, dmg: [], foes: [], camp: null, end: null };
      const p = new Promise(r => { done = r; });
      openDungeon();
      // 進行(dtick)は本物のゲームと同じ関数。50ms ごとのタイマーの代わりに、すき間なく呼んで速くする
      clearInterval(DG.iv); DG.iv = 0; const mc = new MessageChannel(), me = DG; mc.port1.onmessage = () => { if (DG === me && DG.run) { dtick(); mc.port2.postMessage(0); } }; mc.port2.postMessage(0);
      const ok = await Promise.race([p.then(() => 1), new Promise(r => window.__realST(r, 120000)).then(() => 0)]);
      if (!ok) { stuck.push(i + 1); clearInterval(DG.iv); DG.run = 0; }
      document.getElementById('ov').hidden = true;
      res.push(cur); cur = null; done = null;
    }
    return { res, stuck, base };
  }, { stage, mode, runs, MODEL });
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
    for (const k of ['foe', 'strong', 'box', 'spr', 'shr', 'trp', 'mimic', 'frk', 'short', 'viaFork', 'planned'])
      ev[fl][k] = avg(runs.map(r => (r.fl[fl] || {})[k] || 0));
  }
  const foes = runs.flatMap(r => r.foes).filter(f => !f.boss), boss = runs.flatMap(r => r.foes).filter(f => f.boss);
  const wins = foes.filter(f => f.win);
  const camp = runs.filter(r => r.camp);
  const dmg = k => runs.flatMap(r => r.dmg).filter(d => d.kind == k);
  const heal = runs.map(r => ['spr', 'shr'].reduce((a, k) => a + Object.values(r.fl).reduce((s, f) => s + (f[k] || 0), 0), 0));
  const entry = {};
  for (const fl of floors) { const e = runs.map(r => r.entry[fl]).filter(Boolean); entry[fl] = { n: e.length, avg: avg(e.map(x => x.hp / x.mx * 100)), min: mn(e.map(x => x.hp / x.mx * 100)), mp: avg(e.map(x => x.mp / x.mmx * 100)) }; }
  const byFl = {};
  for (const fl of [1, 2, 3, 4]) { const a = foes.filter(f => f.fl == fl), w = a.filter(f => f.win); byFl[fl] = { n: a.length, dmg: avg(a.map(f => f.dmg)), turns: avg(w.map(f => f.turns)), lose: a.filter(f => !f.win).length / (a.length || 1) * 100 }; }
  return {
    N, ev, entry, byFl,
    heal: avg(heal), campHeal: camp.length / N,
    campHp: { avg: avg(camp.map(r => r.camp.hp / r.camp.mx * 100)), min: mn(camp.map(r => r.camp.hp / r.camp.mx * 100)), mp: avg(camp.map(r => r.camp.mp / r.camp.mmx * 100)), mpMin: mn(camp.map(r => r.camp.mp / r.camp.mmx * 100)) },
    foeDmg: avg(foes.map(f => f.dmg)), foeTurns: avg(wins.map(f => f.turns)), foeN: foes.length, foePerRun: foes.length / N,
    foeLose: foes.filter(f => !f.win).length / (foes.length || 1) * 100,
    trapDmg: avg(dmg('trp').map(d => d.pct)), trapN: dmg('trp').length, mimicDmg: avg(dmg('mimic').map(d => d.pct)), mimicN: dmg('mimic').length,
    boxN: avg(runs.map(r => Object.values(r.fl).reduce((s, f) => s + f.box, 0))),
    died: runs.filter(r => r.end == 0).length, bossLose: runs.filter(r => r.end == 1).length, bossWin: runs.filter(r => r.end == 2).length, camp: camp.length,
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
    L.push(`## ${mName}`, '', '### 結果(段階別)', '| 段階 | 力尽きる | たき火に着く | 魔王に勝つ | 敵1体のダメージ | 倒すターン | 敵に負ける率 |', '|---|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${pc(x.died, x.N)} | ${pc(x.camp, x.N)} | ${pc(x.bossWin, x.N)}(着いた人の${pc(x.bossWin, x.camp)}) | ${f1(x.foeDmg)}% | ${f1(x.foeTurns)} | ${f1(x.foeLose)}% |`); }
    L.push('', '### 罠・ミミック・回復', '| 段階 | 罠のダメージ | ミミックのダメージ | 泉・祠 /回 | たき火のHP(平均/最小) | たき火のMP(平均/最小) |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${f1(x.trapDmg)}%(${x.trapN}件) | ${f1(x.mimicDmg)}%(${x.mimicN}件) | ${f2(x.heal)} | ${f1(x.campHp.avg)}% / ${f1(x.campHp.min)}% | ${f1(x.campHp.mp)}% / ${f1(x.campHp.mpMin)}% |`); }
    L.push('', '(ダメージは最大HPに対する%。回復スポットはほかにたき火が1回)', '');
    L.push('### 各層の入り口のHP(最大HPに対する%、平均/最小)', '| 段階 | 1層 | 2層 | 3層 | 4層 | 5層(魔王) |', '|---|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${[1, 2, 3, 4, 5].map(fl => x.entry[fl].n ? `${f1(x.entry[fl].avg)} / ${f1(x.entry[fl].min)}` : '-').join(' | ')} |`); }
    L.push('', '### 敵1体あたり(層別。受けるダメージ%/倒すターン/負ける率)', '| 段階 | 1層 | 2層 | 3層 | 4層 |', '|---|---|---|---|---|');
    for (const s of stages) { const x = S_[s]; L.push(`| ${STNAME[s]} | ${[1, 2, 3, 4].map(fl => { const b = x.byFl[fl]; return b.n ? `${f1(b.dmg)}% / ${f1(b.turns)}T / ${f1(b.lose)}%` : '-'; }).join(' | ')} |`); }
    L.push('', '### イベントの出現数(1回のダンジョンあたり平均)', '| 段階・層 | 敵(強め) | 宝箱 | ミミック | 泉 | 祠 | 罠 | 分かれ道 | 近道 |', '|---|---|---|---|---|---|---|---|---|');
    for (const s of stages) for (const fl of [1, 2, 3, 4]) { const e = S_[s].ev[fl]; L.push(`| ${STNAME[s]} ${fl}層 | ${f2(e.foe)}(${f2(e.strong)}) | ${f2(e.box)} | ${f2(e.mimic)} | ${f2(e.spr)} | ${f2(e.shr)} | ${f2(e.trp)} | ${f2(e.frk)} | ${f2(e.short)} |`); }
    L.push('', '(分かれ道の先から出たものも、それぞれの種類に数えている)', '');
  }
  return L.join('\n');
}

// ---------------- メイン ----------------
(async () => {
  if (process.argv.includes('--worker')) {
    const [stage, mode, runs, speed] = [+arg('stage'), arg('mode'), +arg('runs'), +arg('speed', 40)];
    const r = await worker(stage, mode, runs, speed);
    fs.writeFileSync(arg('out'), JSON.stringify(r));
    return;
  }
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
  fs.writeFileSync(path.join(OUT, 'balance-report.md'), md);
  fs.writeFileSync(path.join(OUT, 'balance-raw.json'), JSON.stringify(all));
  const stuck = Object.entries(all).filter(([, v]) => v.stuck).map(([k, v]) => `${k}: ${v.stuck}回`);
  console.log(md + (stuck.length ? '\n止まった回: ' + stuck.join('、') : ''));
})();
