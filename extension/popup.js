(function () {
  'use strict';
  var DEFAULT_URL = 'https://teru.page';
  var $ = function (id) { return document.getElementById(id); };
  var status = $('status');

  function say(text, ok) { status.textContent = text; status.className = ok ? 'ok' : 'bad'; }

  chrome.storage.local.get(['baseUrl', 'token']).then(function (s) {
    $('url').value = s.baseUrl || DEFAULT_URL;
    $('token').value = s.token || '';
    $('token-hint').textContent = SatLoggerShared.tokenGuide(s.token) + '。合言葉を設定に貼って保存してください。';
    if (!s.token) { $('settings').open = true; say(SatLoggerShared.tokenGuide('') + '。先に「設定」で合言葉を貼ってください。', false); }
  });

  $('save').addEventListener('click', async function () {
    var url = ($('url').value || DEFAULT_URL).trim().replace(/\/+$/, '');
    var token = $('token').value.trim();
    try {
      var origin = new URL(url).origin;
      if (origin !== DEFAULT_URL && !(await chrome.permissions.contains({ origins: [origin + '/*'] }))) {
        var granted = await chrome.permissions.request({ origins: [origin + '/*'] });      // teru.page 以外に送る時だけ、許可を聞く
        if (!granted) { say('その URL に送る許可が得られませんでした。', false); return; }
      }
    } catch (e) { say('URL の形が違います(https://teru.page のように)。', false); return; }
    if (!/^satx_/.test(token)) { say('合言葉は satx_ で始まります。' + SatLoggerShared.tokenGuide(token) + '。', false); return; }
    await chrome.storage.local.set({ baseUrl: url, token: token });
    $('token-hint').textContent = SatLoggerShared.tokenGuide(token) + '。合言葉を設定に貼って保存してください。';
    say('保存しました。', true);
  });

  $('send').addEventListener('click', async function () {
    var btn = $('send'); btn.disabled = true; say('保存しています…', true);
    try {
      var tabs = await chrome.tabs.query({ active: true, currentWindow: true });
      var tab = tabs[0];
      if (!tab || !/^https?:/.test(tab.url || '')) { say('このページは送れません(https のページで押してください)。', false); return; }
      await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: ['shared.js'] });      // activeTab: いま押したページだけ
      var results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: function () { return self.SatLoggerShared.buildPayload(document, location, new Date(), 'popup'); }
      });
      var payload = results && results[0] && results[0].result;
      if (!payload) { say('ページの中身を読めませんでした。', false); return; }
      var res = await chrome.runtime.sendMessage({ type: 'capture', payload: payload });
      if (res && res.ok) say('画面を保存しました(SAT 問題ログへの記録ではありません)' + (payload.truncated ? ' ※大きいので一部を切りました' : ''), true);
      else say('保存できませんでした: ' + ((res && res.reason) || '応答がありません'), false);
    } catch (e) {
      say('送れませんでした: ' + (e && e.message ? e.message : e), false);
    } finally {
      btn.disabled = false;
    }
  });
})();
