/* 本物の画面(Ascent の見直し画面、College Board の Question Bank のダイアログ)から 1 問ぶんを読み取る部品。
   画面の部品は data/sat/page-samples/ の本物の HTML(ascent-review.html、qb-results.html)で確かめてある。
   DOM だけに頼る(innerText は使わない)ので、node(jsdom)からも同じ関数を通せる。 */
(function (root) {
  'use strict';

  var DOMAIN_FIELD = [['informationandideas', 'I&I'], ['craftandstructure', 'C&S'], ['expressionofideas', 'EoI'], ['standardenglishconventions', 'SEC']];
  var SKILL_SUB = [['centralideas', 'Central Ideas'], ['commandofevidence', 'Command of Evidence'], ['inferences', 'Inferences'],
                   ['wordsincontext', 'Words in Context'], ['textstructure', 'Text Structure'], ['crosstext', 'Cross-Text'],
                   ['transitions', 'Transitions'], ['rhetoricalsynthesis', 'Rhetorical Synthesis'], ['boundaries', 'Boundaries'],
                   ['formstructure', 'Form Structure Sense']];
  var BLOCK = { p: '\n\n', div: '\n', li: '\n', h1: '\n\n', h2: '\n\n', h3: '\n\n', h4: '\n\n', h5: '\n\n', h6: '\n\n', section: '\n', ul: '\n', ol: '\n', table: '\n' };

  function squash(t) { return String(t || '').toLowerCase().replace(/[^a-z]/g, ''); }
  function pick(table, text) { var k = squash(text); for (var i = 0; i < table.length; i++) if (k.indexOf(table[i][0]) >= 0) return table[i][1]; return ''; }

  function mathText(node) {
    if (!node) return '';
    if (node.nodeType === 3) return node.nodeValue.trim();
    var tag=(node.localName || '').toLowerCase(), kids=Array.from(node.children || []);
    var parts=kids.map(mathText);
    function atom(s) { return /^[\w.]+$/.test(s) ? s : '('+s+')'; }
    if(tag==='annotation' || tag==='annotation-xml')return '';
    if(tag==='semantics')return kids.length ? mathText(kids[0]) : '';
    if(tag==='mfrac')return atom(parts[0]||'')+'/'+atom(parts[1]||'');
    if(tag==='msup')return atom(parts[0]||'')+'^'+atom(parts[1]||'');
    if(tag==='msub')return atom(parts[0]||'')+'_'+atom(parts[1]||'');
    if(tag==='msubsup')return atom(parts[0]||'')+'_'+atom(parts[1]||'')+'^'+atom(parts[2]||'');
    if(tag==='msqrt')return '√('+parts.join('')+')';
    if(tag==='mroot')return 'root('+parts[0]+','+parts[1]+')';
    if(tag==='mtable')return '\n'+parts.join('\n')+'\n';
    if(tag==='mtr' || tag==='mlabeledtr')return parts.join('\t');
    if(tag==='mfenced')return (node.getAttribute('open')||'(')+parts.join(node.getAttribute('separators')||',')+(node.getAttribute('close')||')');
    if(tag==='mo'||tag==='mi'||tag==='mn'||tag==='mtext')return node.textContent;
    return kids.length ? parts.join('') : node.textContent || '';
  }

  function isCalculator(node) {
    var classes=Array.from(node.classList || []);
    var label=node.getAttribute('aria-label') || '';
    return classes.some(function(c){return /^(?:calculator(?:[-_].*)?|graphing-calculator|scientific-calculator|desmos-calculator|dcg-.*)$/i.test(c);}) ||
      /(?:graphing|scientific)?\s*calculator/i.test(label) && /^(application|dialog|region|group)$/.test(node.getAttribute('role')||'');
  }

  // 要素の文字。<br> は改行、段落は空行、表は行ごとに改行・セルはタブ、スクリーンリーダー用(sr-only)は読まない。
  function nodeText(node, formatted) {
    var out = [];
    (function walk(n, active) {
      active = active || {};
      if (n.nodeType === 3) { out.push(n.nodeValue); return; }
      if (n.nodeType !== 1) return;
      var tag = n.tagName.toLowerCase();
      if (isCalculator(n)) return;
      if (tag === 'math') { out.push(mathText(n)); return; }
      // MathJax supplies SVG plus assistive MathML: serialize the semantic copy once.
      if (tag === 'mjx-container') {
        var math=n.querySelector('math');
        if(math) { out.push(mathText(math)); return; }
      }
      if (tag === 'script' || tag === 'style' || (n.classList && n.classList.contains('sr-only'))) return;
      if (tag === 'br') { out.push('\n'); return; }
      if (tag === 'tr') {
        var cells = [];
        Array.prototype.forEach.call(n.children, function (c) { cells.push(nodeText(c, formatted).replace(/\s+/g, ' ').trim()); });
        out.push('\n' + cells.join('\t') + '\n');
        return;
      }
      var before = (tag === 'p' || /^h[1-6]$/.test(tag)) ? '\n\n' : (BLOCK[tag] ? '\n' : '');
      out.push(before);
      var next = Object.assign({}, active), markers = [];
      if (formatted === true) {
        var css = n.style || {}, computed = {};
        try { computed = n.ownerDocument.defaultView.getComputedStyle(n); } catch (e) { /* detached DOM */ }
        var classes = Array.from(n.classList || []);
        var underline = tag === 'u' || /underline/.test(css.textDecoration || css.textDecorationLine || computed.textDecorationLine || computed.textDecoration || '') ||
          classes.some(function (c) { return /^(underline|underlined|text-underline|text-decoration-underline|cb-underline)$/.test(c); });
        var weight = css.fontWeight || computed.fontWeight || '';
        var bold = tag === 'b' || tag === 'strong' || weight === 'bold' || Number(weight) >= 600 ||
          classes.some(function (c) { return /^(bold|font-bold|font-weight-bold|cb-font-weight-bold)$/.test(c); });
        var italic = tag === 'i' || tag === 'em' || /italic|oblique/.test(css.fontStyle || computed.fontStyle || '') ||
          classes.some(function (c) { return /^(italic|font-italic|font-style-italic|text-italic)$/.test(c); });
        [[underline,'u','__'],[bold,'b','**'],[italic,'i','*']].forEach(function (spec) {
          if (spec[0] && !active[spec[1]]) { markers.push(spec[2]); next[spec[1]] = true; }
        });
      }
      var start = out.length;
      Array.prototype.forEach.call(n.childNodes, function (c) { walk(c, next); });
      if (markers.length) {
        var content = out.splice(start).join('');
        if (content.trim()) {
          var leading = /^\s*/.exec(content)[0], trailing = /\s*$/.exec(content)[0];
          out.push(leading + markers.join('') + content.trim() + markers.slice().reverse().join('') + trailing);
        } else out.push(content);
      }
      out.push(BLOCK[tag] || '');
    })(node);
    return tidy(out.join(''));
  }

  function tidy(text) {
    return text.replace(/ /g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n[ ]+/g, '\n').replace(/[ ]{2,}/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
  }

  function splitQuestion(text) {
    var paras = text.split(/\n\s*\n/).map(function (p) { return p.trim(); }).filter(Boolean);
    if (!paras.length) return { passage: '', question: '' };
    var question = paras.pop();
    return { passage: paras.join('\n\n'), question: question.replace(/\s*\n\s*/g, ' ') };
  }

  function seconds(text) {
    var t = String(text || '').toLowerCase(), colon = /\b(\d{1,2}):(\d{2})\b/.exec(t);
    if (colon) return Number(colon[1]) * 60 + Number(colon[2]);
    var m = /(\d+)\s*(?:minutes?|mins?)\b/.exec(t), s = /(\d+)\s*(?:seconds?|secs?)\b/.exec(t);
    if (!m && !s) return '';
    return (m ? Number(m[1]) * 60 : 0) + (s ? Number(s[1]) : 0);
  }

  function fail(state, reason) { return { ok: false, state: state, reason: reason }; }

  // ---- Ascent: 見直し画面(正解と自分の答えの印が出ている画面) ----
  function parseAscentReview(doc) {
    var screen = doc.querySelector('#mainQuestionScreen');
    if (!screen) return fail('none', 'no-screen');
    var marks = screen.querySelector('.text-correctAnswer, .text-incorrectAnswer, .correct-answer-border, .incorrect-answer-border');
    if (!marks) return fail('none', 'not-review');                       // 解いている途中の画面には、まだ印が無い
    var chips = Array.prototype.map.call(screen.querySelectorAll('span.text-body-3'), function (s) { return s.textContent.trim(); });
    var numberSpan = screen.querySelector('span.font-weight-bold');
    var number = numberSpan ? (/(\d+)/.exec(numberSpan.textContent) || [])[1] || '' : '';
    var difficulty = '', time = '', field = '', subfield = '';
    chips.forEach(function (c) {
      if (/^(easy|medium|hard)$/i.test(c)) difficulty = c.charAt(0).toUpperCase() + c.slice(1).toLowerCase();
      else if (/(minutes?|seconds?)\b/i.test(c)) time = c;
      else if (!field && pick(DOMAIN_FIELD, c)) field = pick(DOMAIN_FIELD, c);
      else if (!subfield && pick(SKILL_SUB, c)) subfield = pick(SKILL_SUB, c);
    });
    var blocks = Array.prototype.filter.call(screen.querySelectorAll('.htmlClassTest'), function (b) { return !b.classList.contains('htmlClassTestOption'); })
      .map(function (b) { return nodeText(b, true); }).filter(Boolean);
    var split = splitQuestion(blocks[0] || '');
    var passage = [split.passage].concat(blocks.slice(1)).filter(Boolean).join('\n\n');
    var choices = { A: '', B: '', C: '', D: '' }, answer = '', chosen = '';
    Array.prototype.forEach.call(screen.querySelectorAll('.option-box'), function (box) {
      var avatar = box.querySelector('.v-avatar'), letter = avatar ? avatar.textContent.trim().charAt(0).toUpperCase() : '';
      if (!/^[A-D]$/.test(letter)) return;
      var body = box.querySelector('.htmlClassTestOption');
      choices[letter] = body ? nodeText(body) : '';
      if (box.classList.contains('correct-answer-border')) answer = letter;
      if (box.classList.contains('incorrect-answer-border')) chosen = letter;
      var input = box.querySelector('input[type="radio"]');
      if (input && (input.checked || input.hasAttribute('checked')) && !chosen) chosen = letter;
    });
    var label = screen.querySelector('.text-incorrectAnswer, .text-correctAnswer');
    if (!chosen && answer && /your answer\s*-\s*correct/i.test(screen.textContent)) chosen = answer;     // 正解した時は、自分の答え = 正解
    var solution = doc.querySelector('#solutionSection .htmlClassTest');
    var data = {
      source: 'Ascent', number: number, difficulty: difficulty, seconds: seconds(time), field: field, subfield: subfield,
      answer: answer, chosen: chosen, correct: answer && chosen ? (answer === chosen ? '正' : '誤') : '',
      passage: passage, question: split.question, choices: choices, rationale: solution ? nodeText(solution) : ''
    };
    var missing = [];
    if (!data.passage && !data.question) missing.push('本文');
    if (!data.question) missing.push('設問');
    if (!(choices.A && choices.B && choices.C && choices.D)) missing.push('選択肢');
    if (data.seconds === '') missing.push('かかった時間');
    if (!answer) missing.push('正解');
    if (!chosen) missing.push('自分の答え');
    if (missing.length) return { ok: false, state: 'partial', reason: '読めなかった所: ' + missing.join('、'), data: data };
    return { ok: true, state: 'ready', data: data, key: dedupeKey(number, data.passage || data.question) };
  }

  // ---- Question Bank: 問題のダイアログ(解説が出ていれば正解と解説も) ----
  function parseQuestionBank(doc) {
    var title = doc.querySelector('#modalTitle');
    var id = title ? (/Question ID:\s*([0-9a-f]+)/i.exec(title.textContent) || [])[1] || '' : '';
    if (!id) return fail('none', 'no-dialog');
    var head = [], cells = [];
    var table = doc.querySelector('.question-banner table');
    if (table) {
      head = Array.prototype.map.call(table.querySelectorAll('th'), function (t) { return squash(t.textContent); });
      cells = Array.prototype.map.call(table.querySelectorAll('td'), function (t) { return t.textContent.trim(); });
    }
    var at = function (name) { var i = head.indexOf(name); return i >= 0 ? cells[i] || '' : ''; };
    var diffEl = doc.querySelector('.question-banner .difficultyLabel .sr-only');
    var difficultyText = diffEl ? diffEl.textContent : at('difficulty');
    var difficulty = (/(easy|medium|hard)/i.exec(difficultyText) || [])[1] || '';
    difficulty = difficulty ? difficulty.charAt(0).toUpperCase() + difficulty.slice(1).toLowerCase() : '';
    var prompt = doc.querySelector('#question-card .prompt'), stem = doc.querySelector('#question-card .question');
    var lis = doc.querySelectorAll('#question-card .answer-choices li');
    var choices = { A: '', B: '', C: '', D: '' };
    Array.prototype.forEach.call(lis, function (li, i) { if (i < 4) choices['ABCD'.charAt(i)] = nodeText(li); });
    var rat = doc.querySelector('#question-card .rationale');
    var answer = '', rationale = '';
    if (rat) {
      var raw = nodeText(rat);
      answer = (/Correct Answer:\s*([A-D])/i.exec(raw) || [])[1] || '';
      rationale = raw.replace(/^Rationale\s*/i, '').replace(/^Correct Answer:\s*[A-D]\s*/i, '').trim();
    }
    var data = {
      source: '公式QB', number: id, difficulty: difficulty, field: pick(DOMAIN_FIELD, at('domain')), subfield: pick(SKILL_SUB, at('skill')),
      answer: answer.toUpperCase(), passage: prompt ? nodeText(prompt, true) : '', question: stem ? nodeText(stem) : '', choices: choices, rationale: rationale
    };
    var missing = [];
    if (!data.passage && !data.question) missing.push('本文');
    if (!data.question) missing.push('設問');
    if (!(choices.A && choices.B && choices.C && choices.D)) missing.push('選択肢');
    if (missing.length) return { ok: false, state: 'partial', reason: '読めなかった所: ' + missing.join('、'), data: data, hasRationale: !!rat };
    return { ok: true, state: 'ready', data: data, hasRationale: !!rat && !!answer, key: dedupeKey(id, data.passage || data.question) };
  }

  // 同じ問題を 2 回送らない鍵(拡張機能の中で覚える。サーバー側でも 問題番号 + 日付 + 本文の頭 50 字 で断る)
  function dedupeKey(number, passage) {
    return String(number || '') + '|' + String(passage || '').trim().split(/\s+/).join(' ').slice(0, 50);
  }

  // QB の秒: ダイアログが開いた時刻から、解説が出た時刻まで。開いてすぐ(1.5 秒以内)に解説が出ていたら、先に解説を開いていた =
  // 測れないので空(帯の欄に手で入れる)
  function qbSeconds(openedAt, rationaleAt) {
    if (rationaleAt == null || openedAt == null) return '';
    var ms = rationaleAt - openedAt;
    return ms < 1500 ? '' : Math.round(ms / 1000);
  }

  // QB の窓の表の Skill の列から型(小分野の名前)。窓が無い・読めない時は ''(目標の既定を決めるのに使う)
  function qbSkill(doc) {
    var table = doc.querySelector('.question-banner table');
    if (!table) return '';
    var head = Array.prototype.map.call(table.querySelectorAll('th'), function (t) { return squash(t.textContent); });
    var cells = Array.prototype.map.call(table.querySelectorAll('td'), function (t) { return t.textContent.trim(); });
    var i = head.indexOf('skill');
    return i >= 0 ? pick(SKILL_SUB, cells[i] || '') : '';
  }

  var api = { mathText: mathText, qbSkill: qbSkill, nodeText: nodeText, splitQuestion: splitQuestion, seconds: seconds, parseAscentReview: parseAscentReview,
              parseQuestionBank: parseQuestionBank, dedupeKey: dedupeKey, qbSeconds: qbSeconds };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  root.SatLoggerParse = api;
})(typeof self !== 'undefined' ? self : this);
