/* 画面の中身を集める・送りの失敗の理由を言葉にする、共通の部品。content.js、popup、background.js が使う。
   ブラウザ以外(node のテスト)からも読めるようにしてある。 */
(function (root) {
  'use strict';

  var HTML_BUDGET = 1300000;     // outerHTML の上限(バイト)。受け口の 1 回 2 MB に、JSON の引用符の分を足しても収まる大きさ
  var TEXT_BUDGET = 300000;      // innerText の上限(バイト)

  function byteLength(text) {
    return (typeof TextEncoder !== 'undefined') ? new TextEncoder().encode(text).length : unescape(encodeURIComponent(text)).length;
  }

  // 文字列を budget バイト以内に切る(二分探索。日本語などの多バイト文字でも守る)。切ったら第 2 の値が true
  function fitBytes(text, budget) {
    text = String(text || '');
    if (byteLength(text) <= budget) return [text, false];
    var lo = 0, hi = text.length;
    while (lo < hi) {
      var mid = Math.ceil((lo + hi) / 2);
      if (byteLength(text.slice(0, mid)) <= budget) lo = mid; else hi = mid - 1;
    }
    return [text.slice(0, lo), true];
  }

  function pickMain(doc) {
    return doc.querySelector('main') || doc.querySelector('[role="main"]') || doc.body || null;
  }

  // 今の画面(main、無ければ body)を、受け口 /app/sat/capture に送る形にする
  function buildPayload(doc, loc, now, source) {
    var el = pickMain(doc);
    var html = fitBytes(el ? el.outerHTML : '', HTML_BUDGET);
    var text = fitBytes(el ? (el.innerText || el.textContent || '') : '', TEXT_BUDGET);
    return {
      url: String(loc.href || ''),
      title: String(doc.title || ''),
      html: html[0],
      text: text[0],
      sent_at: (now || new Date()).toISOString(),
      source: source || 'button',
      truncated: html[1] || text[1],
      main_tag: el && el.tagName ? String(el.tagName).toLowerCase() : ''
    };
  }

  // 受け口の応答(HTTP の状態)を、画面に出す 1 行にする
  function tokenGuide(token) {
    return /^satx_/.test(String(token || '')) && !String(token).startsWith('satx_u_')
      ? 'teru.page の /app/sat で合言葉を作り直す'
      : 'https://teru.page/sat で登録して合言葉をもらう';
  }

  function reasonFor(status, body, token) {
    if (status === 401) return '合言葉が違うか、取り消されています(' + tokenGuide(token) + ')';
    if (status === 413) return '大きすぎます(1 回 2 MB まで)';
    if (status === 429) return '送りすぎです(1 分に 30 回まで)。少し待ってください';
    if (status === 404) return 'URL が違うようです(https://teru.page のままか確かめる)';
    if (status === 400) return (body && body.message) || '受け口が中身を受け取れませんでした';
    if (status >= 500) return 'teru.page のサーバーが ' + status + ' を返しました。少し待ってからもう一度';
    return '送れませんでした(HTTP ' + status + ')';
  }

  // 記録後に選べる間違いの型の初期値。
  var ERROR_TYPES = ['本文に無い因果や区別を足した', '本文と逆', '語彙を知らなかった', '選択肢を本文や表と照合していない',
    '挿入句に引っぱられた', '二択で外した', '時間切れ', '読み違え', '選択肢を最後まで読まなかった', '本文を飛ばして読んだ', 'その他'];

  var api = { ERROR_TYPES: ERROR_TYPES, buildPayload: buildPayload, reasonFor: reasonFor, tokenGuide: tokenGuide, fitBytes: fitBytes, HTML_BUDGET: HTML_BUDGET, TEXT_BUDGET: TEXT_BUDGET };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SatLoggerShared = api;
})(typeof self !== 'undefined' ? self : this);
