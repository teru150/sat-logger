/* 型(Skill)ごとの目標の秒の既定(2026-10-01 Teru: 目標は問題の型を見て勝手に判断してほしい)。ここ 1 か所に置く。
   キーは parse.js の小分野の名前(SKILL_SUB)。Teru が帯の目標の欄を手で変えたら、その型の値を chrome.storage に覚えて、既定より優先する。 */
(function (root) {
  'use strict';
  var DEFAULT_TARGETS = {
    'Words in Context': 35, 'Text Structure': 60, 'Cross-Text': 75, 'Central Ideas': 60, 'Command of Evidence': 90,
    'Inferences': 75, 'Boundaries': 30, 'Form Structure Sense': 45, 'Transitions': 45, 'Rhetorical Synthesis': 60
  };
  var RED_EXTRA_S = 30;                   // 帯の背景が赤になるのは、目標より 30 秒超えた時(文字の赤は目標を超えた時。Teru/OG 10/1 23:35 確定)
  var FALLBACK = 60;                      // 型が読めない時
  var UNKNOWN_KEY = '(型不明)';           // 型が読めない時に Teru が手で変えた値を覚えるキー

  // own = { 型: 秒 }(Teru の設定)。返す: { seconds, source: 'own' | 'default' }
  function goalFor(skill, own) {
    own = own || {};
    var key = skill || UNKNOWN_KEY, mine = Number(own[key]);
    if (mine > 0) return { seconds: mine, source: 'own' };
    return { seconds: (skill && DEFAULT_TARGETS[skill]) || FALLBACK, source: 'default' };
  }
  var api = { DEFAULT_TARGETS: DEFAULT_TARGETS, FALLBACK: FALLBACK, RED_EXTRA_S: RED_EXTRA_S, UNKNOWN_KEY: UNKNOWN_KEY, goalFor: goalFor };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SatLoggerTargets = api;
})(typeof self !== 'undefined' ? self : this);
