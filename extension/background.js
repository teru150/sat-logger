/* 裏で動く部分(service worker)。画面から来た中身を teru.page の受け口に送る。CORS は関係しない(拡張機能の権限で送る)。 */
importScripts('shared.js');

var DEFAULT_URL = 'https://teru.page';

// New invitation-only accounts have a separate receiver. Existing Teru tokens
// and URLs retain exactly the original /app/sat route.
function satEndpoint(base, token, action) {
  return base + (String(token || '').startsWith('satx_u_') ? '/sat/' : '/app/sat/') + action;
}

async function send(payload) {
  var saved = await chrome.storage.local.get(['baseUrl', 'token']);
  if (!saved.token) return { ok: false, reason: '合言葉が未設定です(' + SatLoggerShared.tokenGuide('') + ')' };
  var base = String(saved.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  try {
    var res = await fetch(satEndpoint(base, saved.token, 'capture'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + saved.token },
      body: JSON.stringify(payload)
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* 本文が JSON でなくてもよい */ }
    if (res.ok) return { ok: true, saved: body.saved || '' };
    return { ok: false, status: res.status, reason: SatLoggerShared.reasonFor(res.status, body, saved.token) };
  } catch (e) {
    return { ok: false, reason: 'つながりませんでした(ネットと、URL が https:// で始まっているかを確かめる)' };
  }
}

// 1 問ぶんを SAT 問題ログに記録する(POST /app/sat/log、合言葉で受ける)。重複(同じ問題)はサーバーが断って duplicate: true を返す
async function log(payload) {
  var saved = await chrome.storage.local.get(['baseUrl', 'token']);
  if (!saved.token) return { ok: false, reason: '合言葉が未設定です(' + SatLoggerShared.tokenGuide('') + ')' };
  var base = String(saved.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  try {
    var res = await fetch(satEndpoint(base, saved.token, 'log'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + saved.token },
      body: JSON.stringify(Array.isArray(payload) ? payload : Object.assign({}, payload, { auto: true }))
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* 本文が JSON でなくてもよい */ }
    if (res.ok) return { ok: true, duplicate: !!body.duplicate, entry: body.entry || null,
      saved: body.saved || 0, duplicates: body.duplicates || 0,
      updated: body.updated || 0, cells: body.cells || 0, missing: body.missing || 0 };
    return { ok: false, status: res.status, reason: res.status === 401 ? SatLoggerShared.reasonFor(res.status, body, saved.token) : (body && body.message) || SatLoggerShared.reasonFor(res.status, body, saved.token) };
  } catch (e) {
    return { ok: false, reason: 'つながりませんでした(ネットと、URL が https:// で始まっているかを確かめる)' };
  }
}

// 直前に記録した 1 問を取り消す(POST /app/sat/undo、合言葉。サーバーは記録から 10 分以内の行だけ受ける)
async function undo(id) {
  var saved = await chrome.storage.local.get(['baseUrl', 'token']);
  if (!saved.token) return { ok: false, reason: '合言葉が未設定です(' + SatLoggerShared.tokenGuide('') + ')' };
  var base = String(saved.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  try {
    var res = await fetch(satEndpoint(base, saved.token, 'undo'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + saved.token },
      body: JSON.stringify({ id: id })
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* 本文が JSON でなくてもよい */ }
    if (res.ok) return { ok: !!body.removed, reason: body.removed ? '' : 'その行は見つかりませんでした' };
    return { ok: false, status: res.status, reason: res.status === 401 ? SatLoggerShared.reasonFor(res.status, body, saved.token) : (body && body.message) || SatLoggerShared.reasonFor(res.status, body, saved.token) };
  } catch (e) {
    return { ok: false, reason: 'つながりませんでした' };
  }
}

// 記録した誤答に、間違いの型をあとから付ける(POST /app/sat/type、合言葉。サーバーは記録から 10 分以内の行だけ受ける)
async function setType(id, errorType) {
  var saved = await chrome.storage.local.get(['baseUrl', 'token']);
  if (!saved.token) return { ok: false, reason: '合言葉が未設定です(' + SatLoggerShared.tokenGuide('') + ')' };
  var base = String(saved.baseUrl || DEFAULT_URL).replace(/\/+$/, '');
  try {
    var res = await fetch(satEndpoint(base, saved.token, 'type'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer ' + saved.token },
      body: JSON.stringify({ id: id, error_type: errorType })
    });
    var body = {};
    try { body = await res.json(); } catch (e) { /* 本文が JSON でなくてもよい */ }
    if (res.ok) return { ok: true };
    return { ok: false, status: res.status, reason: res.status === 401 ? SatLoggerShared.reasonFor(res.status, body, saved.token) : (body && body.message) || SatLoggerShared.reasonFor(res.status, body, saved.token) };
  } catch (e) {
    return { ok: false, reason: 'つながりませんでした' };
  }
}

chrome.runtime.onMessage.addListener(function (message, sender, sendResponse) {
  if (message && message.type === 'capture') {
    send(message.payload).then(sendResponse);
    return true;                 // 非同期で返す
  }
  if (message && (message.type === 'log' || message.type === 'logBatch' || message.type === 'enrichBatch')) {
    log(message.payload).then(sendResponse);
    return true;
  }
  if (message && message.type === 'undo') {
    undo(message.id).then(sendResponse);
    return true;
  }
  if (message && message.type === 'settype') {
    setType(message.id, message.errorType).then(sendResponse);
    return true;
  }
  return false;
});
