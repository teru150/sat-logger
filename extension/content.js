/* Ascent と Question Bank の画面で動く部分(v1)。
   - Ascent: 見直し画面(正解と自分の答えの印が出た画面)を見つけたら、1 問ぶんを読んで自動で記録する。
   - Question Bank: 問題のダイアログが開いた時刻から、解説が出た時刻までを秒にする。隅の帯で A〜D を押して「記録」。
   - どちらも、隅の小さな「画面を保存」ボタンで画面をそのまま teru.page に保存できる(読めなかった時の予備。問題ログには書かない)。 */
(function () {
  'use strict';
  if (window.__satLoggerButton) return;            // 画面が切り替わっても 1 つだけ
  window.__satLoggerButton = true;

  var P = window.SatLoggerParse, S = window.SatLoggerShared, T = window.SatLoggerTargets;
  var isQb = /collegeboard\.org$/.test(location.hostname);

  // ---- 隅の帯(ページの CSS と混ざらないよう Shadow DOM) ----
  var host = document.createElement('div');
  host.style.cssText = 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;';
  var root = host.attachShadow({ mode: 'open' });
  root.innerHTML =
    '<style>' +
    '.wrap{font:13px/1.4 system-ui,sans-serif;display:flex;flex-direction:column;align-items:flex-end;gap:6px;color:#fff}' +
    'button{font:inherit;padding:8px 12px;border:1px solid #fff;border-radius:6px;background:#1c1c2e;color:#fff;cursor:pointer;opacity:.9}' +
    '#undo{border-color:#ffd166;color:#ffd166}#undo[hidden]{display:none}' +
    'button:hover{opacity:1}button:disabled{opacity:.45;cursor:not-allowed}button.on{background:#fff;color:#1c1c2e}' +
    '.msg{max-width:300px;padding:6px 8px;border-radius:6px;background:#1c1c2e;display:none}' +
    '.msg.ok{display:block;border:1px solid #6bcf8e}.msg.bad{display:block;border:1px solid #ff6b6b}.msg.info{display:block;border:1px solid #9aa4ff}' +
    '.qb{display:none;padding:8px;border:1px solid #fff;border-radius:8px;background:#1c1c2e;gap:6px;flex-wrap:wrap;align-items:center;max-width:var(--qb-max,320px)}' +
    '.qb.show{display:flex}.qb b{width:100%}' +
    // 帯の折りたたみ(10/6 Teru: 解説の文章に被る)。見出しの行だけ残し、本体は隠す(JS が inline で出す ansrow も !important で隠す)
    '.qb .head{width:100%;display:flex;align-items:center;justify-content:space-between;gap:8px}.qb .head b{width:auto}' +
    '.qb .hint{display:none;margin-left:auto;font-weight:600}.qb[data-folded="1"] .hint{display:inline}' +
    '#fold{padding:2px 8px;font-size:12px;border-radius:4px}' +
    '.qb[data-folded="1"]{flex-wrap:nowrap;max-width:none;white-space:nowrap;padding:6px 8px}.qb[data-folded="1"] > *:not(.head){display:none !important}' +
    '.qb[data-folded="1"] .head{width:auto}' +
    '.wrap.compact .qb{flex-wrap:nowrap;max-width:none;white-space:nowrap}.wrap.compact .qb b,.wrap.compact .qb .head{width:auto}.wrap.compact #why,.wrap.compact #ansrow{width:auto}' +
    // 下の列の間に入らず右寄せになる時は、帯の横幅を広げる(10/6 Mac の画面: 320px の細い帯が 4 段になって背が高くなり、選択肢 D に被った)。広げると 2 段ほどになる
    '.wrap.wide .qb{max-width:var(--qb-max,min(640px,calc(100vw - 80px)))}' +
    '#etype{max-width:100%;padding:6px;border:1px solid #fff;border-radius:4px;background:#0f0f1c;color:#fff;font:inherit}#typerow{width:100%}#typerow[hidden]{display:none}' +
    '.qb .elapsed{font-weight:600}.qb[data-over="1"] .elapsed{color:#ff6b6b;font-weight:800}.qb[data-way="1"]{background:#7a1f1f;border-color:#ff6b6b}' +
    '.qb input{width:64px;padding:6px;border:1px solid #fff;border-radius:4px;background:#0f0f1c;color:#fff;font:inherit}' +
    '</style><div class="wrap"><div class="msg" id="msg" role="status"></div>' +
    '<div class="qb" id="qb"><div class="head"><b>この問題を記録</b><span class="hint" id="hint"></span>' +
    '<button type="button" id="fold" aria-expanded="true" title="帯を小さく畳みます。解説のチェックを外すか、別の問題を開くと自動で元の大きさに戻ります">折りたたむ ▾</button></div><span>選んだ答え:</span>' +
    '<button type="button" data-l="A">A</button><button type="button" data-l="B">B</button><button type="button" data-l="C">C</button><button type="button" data-l="D">D</button>' +
    '<span id="ansrow" style="display:none;width:100%">解説が出ていないので、正解も: <button type="button" data-a="A">A</button><button type="button" data-a="B">B</button><button type="button" data-a="C">C</button><button type="button" data-a="D">D</button></span>' +
    '<span id="typerow" hidden>間違いの型(任意): <select id="etype"><option value="">選ばない</option>' +
      ((S && S.ERROR_TYPES) || []).map(function (t) { return '<option>' + t + '</option>'; }).join('') + '</select></span>' +
    '<span>秒 <input id="sec" type="number" min="0" max="7200" placeholder="?"></span><span class="elapsed" id="elapsed" role="timer"></span>' +
    '<span>目標 <input id="goal" type="number" min="1" max="600" placeholder="秒" title="問題の型から自動で入ります。手で変えるとその型の目標として覚えます。経過が目標を超えると経過の文字が赤く、目標より 30 秒超えると帯が赤くなります(音は出ません)"> <small id="goalnote"></small></span>' +
    '<button type="button" id="rec" disabled>記録</button>' +
    '<span id="why" style="width:100%;color:#ffd166"></span></div>' +
    '<button id="undo" type="button" hidden>いまの記録を取り消す</button><button id="go" type="button" title="問題の記録ではなく、今の画面をそのまま teru.page に保存します(うまく記録できない時の予備)">画面を保存</button></div>';
  document.documentElement.appendChild(host);
  var $ = function (id) { return root.getElementById(id); };

  // Question Bank のダイアログは「ダイアログの外を押すと閉じる」作りになっている(9/30 22:40 に Teru が選んだ答えを押したら問題の窓が消えた)。
  // 帯がダイアログの外(<html> の直下)にあると、帯のボタンが「外」の押下として数えられる。QB では帯をダイアログの中へ移して、
  // 押下がダイアログの内側として扱われるようにする。念のため、押下・キーのイベントを帯の外へ出さず、ボタンで入力欄の焦点を奪わない。
  // 帯の置き場所(2026-10-01 Teru: 右下の「次へ」に重なって押しにくい。10/2: 帯が 1 行高くなって「Add to PDF」に乗った)。
  // 帯の下端を「下の列のボタンの上端 - 12px」に固定して、ボタンの上に置く。横は「Add to PDF」の右端 + 24px と「次へ」の左端 - 24px の間に収め、
  // 収まらなければ帯を 1 行に畳み、それでも入らなければ右寄せにする。位置は、host の基準になっている要素(offsetParent)の矩形で数える
  // (窓の枠 .cb-modal-container が position を持たない作りで、窓の左端から数えると窓の左の余白ぶんだけずれた: 10/2 の画面)。
  var GAP = 24, FOOTER_PX = 140, ABOVE = 12, QB_MAX_W = 640;     // 帯の幅の上限(css px)
  function footerRects(container, cr) {
    var out = [];
    container.querySelectorAll('button, a[role="button"], [role="button"], input[type="button"], input[type="submit"]').forEach(function (el) {
      if (host.contains(el)) return;
      var r = el.getBoundingClientRect();
      if (!(r.width > 0 && r.height > 0) || r.top < cr.bottom - FOOTER_PX) return;     // 下の列だけ(右上の閉じるボタンなどは除く)
      out.push(r);
    });
    return out.sort(function (a, b) { return a.left - b.left; });
  }
  function hostCss(pos) { return 'all:initial;position:absolute;' + pos + 'z-index:2147483647;'; }
  function layoutHost(container) {
    var wrap = root.querySelector('.wrap'), cr = container.getBoundingClientRect();
    var rects = cr.width > 0 ? footerRects(container, cr) : [];
    var pos = 'right:12px;bottom:12px;', maxVar = 0;
    if (rects.length) {
      var op = host.offsetParent, base = op ? op.getBoundingClientRect() : cr;                      // absolute の基準(padding の内側)
      var baseLeft = base.left + (op ? op.clientLeft || 0 : 0);
      var baseBottom = op && op.clientHeight ? base.top + (op.clientTop || 0) + op.clientHeight : base.bottom;
      var top = Math.min.apply(null, rects.map(function (r) { return r.top; }));
      var bottomCss = 'bottom:' + Math.round(baseBottom - (top - ABOVE)) + 'px;';                  // 帯の下端 = 下の列の上端 - 12px
      var last = rects[rects.length - 1];
      var next = (last.left + last.right) / 2 > cr.left + cr.width * 0.6 ? last : null;           // 右端の「次へ」
      var limit = next ? next.left : cr.right;
      var lefts = rects.filter(function (r) { return r !== next; });
      var addRight = lefts.length ? Math.max.apply(null, lefts.map(function (r) { return r.right; })) : cr.left;
      var from = addRight + GAP, to = limit - GAP;
      // 空いている幅いっぱいまで帯を広げる(上限 QB_MAX_W)。細いままだと『正解も』の A〜D や、秒と目標が 2 段に折れる(10/6 Teru の画面)
      var avail = Math.floor(to - from);
      maxVar = Math.max(320, Math.min(QB_MAX_W, avail));
      host.style.setProperty('--qb-max', maxVar + 'px');
      var fits = function () { return from + (host.getBoundingClientRect().width || 320) <= to; };
      wrap.classList.remove('compact'); wrap.classList.remove('wide');
      var placed = fits();
      if (!placed) { wrap.classList.add('compact'); placed = fits(); }
      if (placed) pos = 'left:' + Math.round(from - baseLeft) + 'px;' + bottomCss;
      else {                                                                                        // 間が狭すぎる: 右寄せ(下端は同じ)。窓の幅いっぱいまで広げて背を低くする(選択肢に被らない)
        wrap.classList.remove('compact'); wrap.classList.add('wide');
        maxVar = Math.max(320, Math.min(QB_MAX_W, Math.floor(cr.width - 24)));
        pos = 'right:12px;' + bottomCss;
      }
    }
    var css = hostCss(pos + (maxVar ? '--qb-max:' + maxVar + 'px;' : ''));
    if (host.style.cssText !== css) host.style.cssText = css;
  }
  function placeHost() {
    if (!isQb) return;
    var inside = document.querySelector('#question-modal .cb-modal-container') || document.querySelector('.cb-modal-container');
    var want = inside || document.documentElement;
    if (host.parentNode !== want) {
      want.appendChild(host);
      host.style.cssText = inside ? hostCss('right:12px;bottom:12px;') : 'all:initial;position:fixed;right:12px;bottom:12px;z-index:2147483647;';
    }
    if (inside) layoutHost(inside);
  }
  window.addEventListener('resize', function () { placeHost(); });
  ['pointerdown', 'pointerup', 'mousedown', 'mouseup', 'click', 'dblclick', 'touchstart', 'touchend', 'keydown', 'keyup', 'keypress', 'focusin', 'focusout'].forEach(function (type) {
    root.addEventListener(type, function (ev) { ev.stopPropagation(); });
  });
  root.addEventListener('mousedown', function (ev) {
    if (ev.target.closest && ev.target.closest('button')) ev.preventDefault();      // ボタンを押しても、ダイアログの中の焦点を動かさない
  });
  var why = $('why'), ansRow = $('ansrow'), msg = $('msg'), undoBtn = $('undo'), go = $('go'), qbBox = $('qb'), secInput = $('sec'), recBtn = $('rec'), elapsedEl = $('elapsed'), goalInput = $('goal'), goalNote = $('goalnote'), foldBtn = $('fold'), hintEl = $('hint'), typeRow = $('typerow'), typeSel = $('etype'), timer = null;

  function show(text, kind, ms) {
    msg.textContent = text; msg.className = 'msg ' + kind;
    clearTimeout(timer); timer = setTimeout(function () { msg.className = 'msg'; }, ms || (kind === 'bad' ? 14000 : 5000));
  }
  // 裏の部分へ送る。拡張機能が更新された後の古いページ(context invalidated)や、返事が来ない時に、固まらず理由を返す
  function ask(message) {
    return new Promise(function (resolve) {
      var done = false;
      function finish(res) { if (!done) { done = true; resolve(res); } }
      var timer = setTimeout(function () { finish({ ok: false, reason: '返事がありません(ネットか teru.page を確かめる。拡張機能を更新した後なら、このページを F5 で再読み込み)' }); }, 20000);
      try {
        if (!chrome.runtime || !chrome.runtime.id) throw new Error('invalidated');
        chrome.runtime.sendMessage(message, function (res) {
          clearTimeout(timer);
          finish(chrome.runtime.lastError || !res ? { ok: false, reason: '拡張機能が応答しません。このページを F5 で再読み込みしてください(拡張機能を更新した後は必要です)' } : res);
        });
      } catch (e) {
        clearTimeout(timer);
        finish({ ok: false, reason: '拡張機能が更新されたため、このページを F5 で再読み込みしてください' });
      }
    });
  }

  // ---- 予備: 画面をそのまま送る ----
  go.addEventListener('click', function () {
    go.disabled = true;
    var payload = S.buildPayload(document, location, new Date(), 'button');
    ask({ type: 'capture', payload: payload }).then(function (res) {
      go.disabled = false;
      show(res.ok ? '画面を保存した(SAT 問題ログへの記録ではありません)' + (payload.truncated ? ' ※大きいので一部を切った' : '') : '保存できなかった: ' + res.reason, res.ok ? 'ok' : 'bad', res.ok ? 9000 : undefined);
    });
  });

  // ---- 同じ問題を 2 回送らない(この PC の中で覚える。サーバーも問題番号 + 日付 + 本文の頭で断る) ----
  var sent = {};
  function today() { return new Date().toISOString().slice(0, 10); }
  function remember(key) {
    sent[key + '@' + today()] = 1;
    var keys = Object.keys(sent).slice(-500);
    chrome.storage.local.set({ sentKeys: keys });
  }
  var ready = chrome.storage.local.get(['sentKeys']).then(function (s) { (s.sentKeys || []).forEach(function (k) { sent[k] = 1; }); }, function () {});
  function was(key) { return !!sent[key + '@' + today()]; }

  function report(res, label) {
    if (!res.ok) { show('記録できなかった(' + label + '): ' + res.reason, 'bad'); return false; }
    show(res.duplicate ? '同じ問題は記録済みでした(' + label + ')' : '記録した(' + label + ')', 'ok');
    return true;
  }
  // 記録した直後の 60 秒は「いまの記録を取り消す」を出す(間違えて押した・開いたのに記録されていた、のため。サーバーは記録から 10 分以内だけ受ける)
  var lastRec = null, undoTimer = null;
  function armUndo(res, key) {
    if (!res.ok || res.duplicate || !res.entry || !res.entry.id) return;
    lastRec = { id: res.entry.id, key: key };
    undoBtn.hidden = false; undoBtn.disabled = false;
    clearTimeout(undoTimer); undoTimer = setTimeout(function () { undoBtn.hidden = true; lastRec = null; }, 60000);
  }
  undoBtn.addEventListener('click', function () {
    if (!lastRec) return;
    var rec = lastRec; undoBtn.disabled = true;
    ask({ type: 'undo', id: rec.id }).then(function (res) {
      if (!res.ok) { undoBtn.disabled = false; show('取り消せませんでした: ' + (res.reason || ''), 'bad'); return; }
      delete sent[rec.key + '@' + today()]; chrome.storage.local.set({ sentKeys: Object.keys(sent).slice(-500) });   // もう一度記録できるようにする
      if (qb.recorded) qb.recorded = false;
      qb.recordedId = ''; qb.lastCorrect = '';
      undoBtn.hidden = true; lastRec = null; clearTimeout(undoTimer);
      show('記録を取り消しました。', 'ok');
    });
  });
  function debounce(fn, ms) { var t = null; return function () { clearTimeout(t); t = setTimeout(fn, ms); }; }

  // ---- Ascent: 見直し画面を見つけたら自動で記録 ----
  var failedAt = {};
  function tickAscent() {
    var r = P.parseAscentReview(document);
    if (r.state === 'none') return;
    if (r.state === 'partial') {                                   // 印は出ているのに読めない = 画面の作りが変わったかもしれない
      var k = 'partial|' + (r.data && r.data.number);
      if (!failedAt[k]) { failedAt[k] = 1; show('読めなかった(' + r.reason + ')。「画面を保存」で画面を保存してください。', 'bad', 20000); }
      return;
    }
    if (was(r.key)) return;
    remember(r.key);
    ask({ type: 'log', payload: r.data }).then(function (res) {
      if (!report(res, 'Ascent Q' + r.data.number + ' ' + r.data.correct)) delete sent[r.key + '@' + today()];   // 失敗は覚えず、次の変化でやり直す
      else armUndo(res, r.key);
    });
  }

  // ---- 帯の折りたたみ(2026-10-06 Teru: 解説を出すと、帯が解説の文章に被る) ----
  // 状態は qbBox の data-folded に持つ(className は別の所で書き換えられるので、そこには置かない)。
  // 自動で元の大きさに戻る時: 解説のチェックが外れて解説が消えた時 / 別の問題が開いた時 / 帯が片づいた時(バグって畳んだままにならないように)。
  function setFolded(on) {
    qbBox.dataset.folded = on ? '1' : '0';
    foldBtn.textContent = on ? '開く ▴' : '折りたたむ ▾';
    foldBtn.setAttribute('aria-expanded', on ? 'false' : 'true');
    renderHint();
    placeHost();
  }
  function renderHint() {
    var sec = elapsedNow();
    hintEl.textContent = qbBox.dataset.folded === '1' ? ('選んだ答え: ' + (qb.chosen || '—') + (sec != null ? '  経過 ' + sec + ' 秒' : '')) : '';
  }
  foldBtn.addEventListener('click', function () { setFolded(qbBox.dataset.folded !== '1'); });
  qbBox.dataset.folded = '0';

  // ---- Question Bank: ダイアログが開いた時刻 → 解説が出た時刻 ----
  var qb = { id: '', openedAt: null, rationaleAt: null, chosen: '', answer: '', cache: null, recorded: false, closedAt: null };
  function rationaleShown() {
    var r = document.querySelector('#question-card .rationale');
    return !!r && r.textContent.trim().length > 0 && !r.closest('[hidden], .cb-hidden, .hidden');
  }
  // 窓が閉じても、その問題は記録できる(読み取り結果を覚えておく。解説まで読めていれば正解も分かる)
  function liveOrCached() {
    var live = P.parseQuestionBank(document);
    if (live.ok && (!qb.cache || live.hasRationale || !qb.cache.hasRationale)) qb.cache = live;
    return (live.ok && live.hasRationale) ? live : (qb.cache || live);
  }
  function answerOf(parsed) { return parsed.hasRationale ? parsed.data.answer : qb.answer; }
  function refreshBand() {
    renderElapsed();
    var parsed = liveOrCached();
    var needAnswer = parsed.ok && !parsed.hasRationale;                 // 解説を開かないまま閉じた: 正解も帯で選んでもらう
    ansRow.style.display = needAnswer ? 'block' : 'none';
    qbBox.querySelectorAll('button[data-l]').forEach(function (b) { b.className = b.dataset.l === qb.chosen ? 'on' : ''; });
    qbBox.querySelectorAll('button[data-a]').forEach(function (b) { b.className = b.dataset.a === qb.answer ? 'on' : ''; });
    // 間違いの型(任意): 解答(正解)が分かってから選べる。正解を選んだ・正解で記録済みの時は出さない(2026-10-06 Teru)
    var knownAnswer = parsed.ok ? answerOf(parsed) : '';
    typeRow.hidden = !(knownAnswer && qb.lastCorrect !== '正' && !(qb.chosen && qb.chosen === knownAnswer));
    recBtn.disabled = !(qb.chosen && parsed.ok && answerOf(parsed) && secInput.value !== '');
    // 記録できない理由を帯に出す(灰色のまま黙らない)
    var need = [];
    if (!parsed.ok) need.push(parsed.reason || '問題の読み取り');
    else if (!answerOf(parsed)) need.push('正解(解説を開くか、上の「正解も」を押す)');
    if (!qb.chosen) need.push('選んだ答え');
    if (secInput.value === '') need.push('秒');
    why.textContent = recBtn.disabled && qb.recording !== true ? (need.length ? '足りない物: ' + need.join('、') : '') : '';
    renderHint();
  }
  // 経過秒(2026-10-01 Teru: 速解きの練習で、目標の秒を超えたら切り上げたい)。起点は秒の測り方と同じ(問題の窓が開いた時)。
  // 解説が出た後(や閉じた後)は止めて、記録する秒と同じ値を出す。目標を超えたら文字が赤、目標より 30 秒超えたら帯の背景が赤(音は出ない)。
  function elapsedNow() {
    if (qb.openedAt == null) return null;
    if (qb.rationaleAt != null || qb.closedAt != null) return secInput.value !== '' ? Number(secInput.value) : null;
    return Math.round((Date.now() - qb.openedAt) / 1000);
  }
  function renderElapsed() {
    var sec = elapsedNow(), goal = Number(goalInput.value) > 0 ? Number(goalInput.value) : 0;
    elapsedEl.textContent = sec == null ? '' : '経過 ' + sec + ' 秒';
    qbBox.dataset.over = goal && sec != null && sec > goal ? '1' : '0';
    var extra = window.__SAT_RED_EXTRA_S != null ? window.__SAT_RED_EXTRA_S : (T ? T.RED_EXTRA_S : 30);   // 試験で短くできる
    qbBox.dataset.way = goal && sec != null && sec > goal + extra ? '1' : '0';
    if (hintEl && qbBox.dataset.folded === '1') renderHint();
  }
  // 目標は型(Skill)から自動で入れる。Teru が手で変えたら、その型の目標として覚える(型ごとの上書き。既定より優先)
  var ownGoals = {};
  function skillKey() { return qb.skill || (T && T.UNKNOWN_KEY) || ''; }
  function applyGoal() {
    if (!T || qb.goalTouched) return;
    var g = T.goalFor(qb.skill || '', ownGoals);
    goalInput.value = String(g.seconds);
    goalNote.textContent = g.source === 'own' ? '(自分の設定)' : '(型の既定)';
    renderElapsed();
  }
  goalInput.addEventListener('input', function () {
    qb.goalTouched = true;                                                          // この問題の間は、読み込みで上書きしない
    var n = Number(goalInput.value);
    if (T) {
      if (n > 0) ownGoals[skillKey()] = n; else delete ownGoals[skillKey()];      // 空にしたら、その型の既定に戻す
      var g = T.goalFor(qb.skill || '', ownGoals);
      goalNote.textContent = g.source === 'own' ? '(自分の設定)' : '(型の既定)';
      try { chrome.storage.local.set({ goalBySkill: Object.assign({}, ownGoals) }); } catch (e) { /* 覚えられなくても動く */ }
      if (!(n > 0)) { goalInput.value = String(g.seconds); qb.goalTouched = false; }
    }
    renderElapsed();
  });
  try {
    chrome.storage.local.get(['goalBySkill']).then(function (s) { ownGoals = (s && s.goalBySkill && typeof s.goalBySkill === 'object') ? s.goalBySkill : {}; applyGoal(); }, function () {});
  } catch (e) { /* 覚えが読めなくても動く */ }
  if (isQb) setInterval(renderElapsed, 1000);

  function tickQb() {
    placeHost();
    if (qb.id && !qb.goalTouched && P.qbSkill && !qb.skill) { var sk = P.qbSkill(document); if (sk) { qb.skill = sk; applyGoal(); } }   // 表が遅れて出た時
    renderElapsed();
    var title = document.querySelector('#modalTitle');
    var id = title ? ((/Question ID:\s*([0-9a-f]+)/i.exec(title.textContent) || [])[1] || '') : '';
    if (!id) {
      if (qb.id && !qb.chosen && !qb.recorded && qb.openedAt != null && Date.now() - qb.openedAt < (window.__SAT_QUICK_CLOSE_MS != null ? window.__SAT_QUICK_CLOSE_MS : 5000)) {
        // 開いて、答えを選ばずに 5 秒以内に閉じた = まちがえて開いた(答えを隠し忘れていた時など)。開かなかったことにする
        qb = { id: '', openedAt: null, rationaleAt: null, chosen: '', cache: null };
        qbBox.className = 'qb'; setFolded(false);
        show('5 秒以内に閉じたので、この問題は開かなかったことにしました。', 'info', 4000);
        return;
      }
      if (qb.id && qb.cache && !qb.recorded) {                     // 窓が閉じても、開いて読めた問題は帯に残して記録できるまま(10 分まで)
        if (qb.closedAt == null) {
          qb.closedAt = Date.now();
          if (secInput.value === '' && qb.rationaleAt == null) {      // 解説を開かずに閉じた: 開いてから閉じるまでを秒にする
            var sc = P.qbSeconds(qb.openedAt, qb.closedAt); secInput.value = sc === '' ? '' : String(sc);
          }
          show('問題の窓が閉じました。' + qb.id + ' はこのまま記録できます(選んだ答え' + (qb.cache.hasRationale ? '' : 'と正解') + 'を押す)。', 'info', 9000);
        }
        if (Date.now() - qb.closedAt > 600000) { qb = { id: '', openedAt: null, rationaleAt: null, chosen: '', answer: '', cache: null, recorded: false, closedAt: null }; qbBox.className = 'qb'; setFolded(false); return; }
        qbBox.className = 'qb show';
        refreshBand();
        return;
      }
      qb.id = ''; qbBox.className = 'qb'; if (qbBox.dataset.folded === '1') setFolded(false); return;
    }
    if (id !== qb.id) {                                            // 別の問題が開いた: 計り直す
      if (qbBox.dataset.folded === '1') setFolded(false);             // 畳んだままにしない
      qb = { id: id, openedAt: Date.now(), rationaleAt: null, chosen: '', answer: '', cache: null, recorded: false, closedAt: null, errorType: '', recordedId: '', lastCorrect: '' };
      secInput.value = ''; typeSel.value = '';
      qb.skill = P.qbSkill ? P.qbSkill(document) : '';
      applyGoal();
      qbBox.className = 'qb show';
    }
    var shownNow = rationaleShown();
    if (qb.wasShown && !shownNow && qbBox.dataset.folded === '1') setFolded(false);     // 解説のチェックが外れた: 自動で元の大きさに戻す
    qb.wasShown = shownNow;
    if (shownNow && qb.rationaleAt == null) {
      qb.rationaleAt = Date.now();
      var sec = P.qbSeconds(qb.openedAt, qb.rationaleAt);
      secInput.value = sec === '' ? '' : String(sec);
      if (sec === '') show('時間は測れませんでした(解説が先に出ていました)。秒を手で入れてください。', 'info', 9000);
    }
    refreshBand();
  }
  // 記録する。選んだ答えを押した時に、秒が入っていれば自動で呼ばれる(秒が空の時は、秒を入れて「記録」を押す)
  function doRecord() {
    var parsed = liveOrCached();
    var answer = parsed.ok ? answerOf(parsed) : '';
    if (!parsed.ok || !answer) { show('正解がまだ分かりません。解説を開くか、帯で正解も選んでください。', 'bad'); return; }
    if (was(parsed.key)) { show('この問題は記録済みです(' + parsed.data.number + ')。', 'info'); qb.chosen = ''; refreshBand(); return; }
    var data = Object.assign({}, parsed.data, { answer: answer, seconds: Number(secInput.value), chosen: qb.chosen, correct: qb.chosen === answer ? '正' : '誤' });
    if (data.correct === '誤' && qb.errorType) data.error_type = qb.errorType;          // 型は任意。選んでいれば、記録と一緒に送る
    recBtn.disabled = true; qb.recording = true; why.textContent = '記録しています…';
    ask({ type: 'log', payload: data }).then(function (res) {
      qb.recording = false;
      if (report(res, 'QB ' + data.number + ' ' + data.correct + (res.ok && !res.duplicate ? '。間違えて押したら /app/sat の一覧で取り消せます' : ''))) {
        remember(parsed.key); qb.lastCorrect = data.correct; qb.recordedId = (res.entry && res.entry.id) || ''; qb.chosen = ''; qb.answer = ''; qb.recorded = true; armUndo(res, parsed.key);
        if (!document.querySelector('#modalTitle')) { qb.id = ''; qb.cache = null; qbBox.className = 'qb'; setFolded(false); }      // 窓が閉じていたら帯も片づける
      } else { qb.chosen = ''; }                                                                                   // 失敗した時は選び直して押せる
      refreshBand();
    });
  }
  qbBox.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-l]');
    if (!b) return;
    qb.chosen = b.dataset.l;
    refreshBand();
    if (!recBtn.disabled) doRecord();              // 秒が入っていれば、選んだ時点で記録(押し直しなし)
  });
  ansRow.addEventListener('click', function (ev) {
    var b = ev.target.closest('button[data-a]');
    if (!b) return;
    qb.answer = b.dataset.a; refreshBand();
    if (!recBtn.disabled) doRecord();
  });
  // 間違いの型を選んだ: 記録の前なら覚えておいて記録と一緒に送る。記録済みの誤答なら、その行に型を付ける(サーバーは記録から 10 分以内だけ受ける)
  typeSel.addEventListener('change', function () {
    qb.errorType = typeSel.value;
    if (!qb.errorType || !qb.recordedId || qb.lastCorrect !== '誤') return;
    var id = qb.recordedId, picked = qb.errorType;
    ask({ type: 'settype', id: id, errorType: picked }).then(function (res) {
      show(res && res.ok ? '間違いの型を付けた(' + picked + ')' : '型を付けられなかった: ' + ((res && res.reason) || ''), res && res.ok ? 'ok' : 'bad');
    });
  });
  secInput.addEventListener('input', refreshBand);
  recBtn.addEventListener('click', doRecord);

  var tick = debounce(function () { ready.then(isQb ? tickQb : tickAscent); }, isQb ? 300 : 800);
  new MutationObserver(tick).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['class', 'hidden'] });
  tick();
})();
