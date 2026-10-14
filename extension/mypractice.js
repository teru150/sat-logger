/* MyPractice Details: explicit bulk import. Never infer missing answers or skills. */
(function (root) {
  'use strict';
  var fields = { 'Craft and Structure': 'C&S', 'Information and Ideas': 'I&I',
    'Expression of Ideas': 'EoI', 'Standard English Conventions': 'SEC' };
  var months = ['January','February','March','April','May','June','July','August','September','October','November','December'];
  function text(el) { return el ? el.textContent.trim() : ''; }
  function parse(doc) {
    var heading = Array.from(doc.querySelectorAll('h2,h4')).map(text).find(function (s) {
      return /^SAT Practice \d+\s*[-–]/.test(s);
    }) || '';
    var m = /^SAT Practice (\d+)\s*[-–]\s*(\w+) (\d{1,2}), (\d{4})/.exec(heading);
    if (!m || months.indexOf(m[2]) < 0) throw new Error('模試番号と実施日を読み取れません');
    var practice = m[1], date = m[4] + '-' + String(months.indexOf(m[2])+1).padStart(2,'0') + '-' + m[3].padStart(2,'0');
    var seen = new Set();
    var rows = Array.from(doc.querySelectorAll('.table-row')).map(function (row) {
      var mod = /\bmodule-(\d+)\b/.exec(row.className);
      var section = row.classList.contains('reading-and-writing') ? 'RW' : row.classList.contains('math') ? 'Math' : '';
      var cells = row.querySelectorAll('th,td'), q = text(cells[0]);
      var rawChosen = text(cells[3]), mark = row.querySelector('.correct, .cb-red1-color');
      var verdict = text(mark) || rawChosen, number = 'P'+practice+(section === 'RW' ? 'R' : 'M')+mod?.[1]+'Q'+q;
      var verdictMatch = /\b(Correct|Incorrect|Unanswered|Omitted)\b/i.exec(verdict);
      if (!mod || !section || !/^\d+$/.test(q) || !verdictMatch)
        throw new Error('問題の行を読み取れません。送信せず停止しました');
      if (seen.has(number)) throw new Error('同じ問題番号の行が重なっています');
      seen.add(number);
      var answer = text(cells[2]), chosenMatch = /\b([A-D])\b/i.exec(rawChosen.replace(/Correct|Incorrect|Unanswered/gi,''));
      return { row: row, q: q, data: { source: 'Bluebook 模試', date: date, number: number,
        section: section, module: Number(mod[1]), practice: Number(practice),
        correct: /^Correct$/i.test(verdictMatch[1]) ? '正' : '誤',
        chosen: chosenMatch ? chosenMatch[1].toUpperCase() : '', answer: /^[A-D]$/.test(answer) ? answer : '',
        answers_unknown: true, seconds_unknown: true, seconds: '', field: fields[text(cells[5])] || '', subfield: '',
        passage: '', question: '', choices: {},
        memo: 'Practice '+practice+' / '+section+' / Module '+mod[1]+' / Question '+q } };
    });
    var total = Number(text(doc.querySelector('.total-quetions .number, .total-questions .number')));
    if (!rows.length || (total && total !== rows.length)) throw new Error('全問が表示されていません。フィルターを解除してください');
    var correct = Number(text(doc.querySelector('.correct-answers .number')));
    var wrong = Number(text(doc.querySelector('.incorrect-answers .number')));
    if ((correct || wrong) && (rows.filter(function (r) { return r.data.correct === '正'; }).length !== correct || rows.length - correct !== wrong))
      throw new Error('集計と問題の行の正誤が一致しません');
    return { date: date, practice: Number(practice), rows: rows };
  }
  function detail(doc, item, parser) {
    var modal = doc.querySelector('.test-questions-modal[aria-hidden="false"]');
    if (!modal) return {};
    var panel = modal.querySelector('.question-panel'), title = text(panel?.querySelector('h3'));
    var prefix = item.data.section === 'RW' ? 'Reading and Writing' : 'Math';
    if (title !== prefix+': Question '+item.q) return {};
    var blocks = Array.from(panel.querySelectorAll(':scope > div')).filter(function(b){return parser.nodeText(b,true).trim();});
    var out = { passage: blocks.length>1 ? parser.nodeText(blocks[0],true) : '',
      question: blocks.length ? parser.nodeText(blocks[blocks.length-1],true) : '', choices: {} };
    panel.querySelectorAll('.answer-options > li').forEach(function (li, n) { if(n<4) out.choices['ABCD'[n]] = parser.nodeText(li,true); });
    var responseNode=modal.querySelector('.answer-panel .response') || modal.querySelector('.answer-panel');
    var a = responseNode ? parser.nodeText(responseNode) : '';
    var chosen = /(?:You selected answer|You answered|Your answer(?: is)?)[\s:]+(.+?)\.\s*The correct answer is/i.exec(a);
    var answer = /(?:The correct answer is|Correct Answer)[\s:]+(.+?)(?:\.(?:\s|$)|$)/i.exec(a);
    if (chosen) out.chosen = chosen[1].trim();
    if (answer) out.answer = answer[1].trim();
    var rationale=modal.querySelector('.answer-panel .rationale');
    if (rationale) out.rationale = parser.nodeText(rationale,true).replace(/^Rationale\s*/,'').slice(0,6000);
    return out;
  }
  function waitFor(doc, predicate, timeout) {
    return new Promise(function(resolve,reject) {
      var timer, observer = new doc.defaultView.MutationObserver(check);
      function done(value,error) { observer.disconnect();clearTimeout(timer);error?reject(error):resolve(value); }
      function check() { var value=predicate();if(value)done(value); }
      observer.observe(doc.documentElement,{childList:true,subtree:true,attributes:true,characterData:true});
      timer=setTimeout(function(){done(null,new Error('Reviewの描画を待っても読み取れません'));},timeout);
      check();
    });
  }
  var api = { parse: parse, detail: detail, waitFor: waitFor };
  if (typeof module !== 'undefined' && module.exports) { module.exports = api; return; }
  root.SatLoggerMyPractice = api;
  if (location.hostname !== 'mypractice.collegeboard.org' || root.__satMyPractice) return;
  root.__satMyPractice = true;
  var host = document.createElement('div');
  host.style.cssText = 'position:fixed;right:12px;bottom:12px;z-index:2147483647';
  var shadow = host.attachShadow({mode:'open'});
  shadow.innerHTML = '<style>div{font:14px system-ui;background:#151522;color:white;padding:12px;max-width:480px;display:flex;align-items:center;gap:8px;flex-wrap:wrap}button{padding:10px;cursor:pointer}p{margin:0;flex:1;min-width:150px}</style><div><button>この模試を全部記録</button><button id="details">本文だけ取り直す</button><p role="status"></p></div>';
  var btn = shadow.querySelector('button'), msg = shadow.querySelector('p');
  var detailBtn = shadow.querySelector('#details');
  document.documentElement.appendChild(host);
  var busy = false;
  function showButton() { host.hidden = !/^\/details\/?$/.test(location.pathname); }
  new MutationObserver(showButton).observe(document.documentElement,{childList:true,subtree:true});
  showButton();
  function send(data, type) { return new Promise(function(resolve) {
    chrome.runtime.sendMessage({type:type || 'logBatch',payload:data},function(r) { resolve(chrome.runtime.lastError ? {ok:false,reason:'拡張機能を読み込み直してください'} : r); });
  }); }
  function visibleModal() { return document.querySelector('.test-questions-modal[aria-hidden="false"]'); }
  async function ensureAnswers() {
    var label=Array.from(document.querySelectorAll('label')).find(function(el){
      return !el.closest('.test-questions-modal') && /^Show correct answers$/i.test(text(el));
    });
    var toggle=label && (label.control || document.getElementById(label.htmlFor) || label.querySelector('input'));
    var hint='Show correct answers を ON にして押し直して';
    if(!toggle)throw new Error(hint);
    if(!toggle.checked)toggle.click();
    try {
      await waitFor(document,function(){
        return toggle.checked && !document.querySelector('.table-row td.hide-answer');
      },2000);
    } catch(e) { throw new Error(hint); }
  }
  async function closeReview() {
    var open=visibleModal();
    if(open) {
      var close=open.querySelector('.cb-btn-close');
      if(!close)throw new Error('Reviewを閉じるボタンが見つかりません');
      close.click();
      await waitFor(document,function(){return !visibleModal();},1200);
    }
  }
  async function readReview(item) {
    await closeReview();
    // React may replace the row when answers are shown; reacquire by section/module/number.
    var current=Array.from(document.querySelectorAll('.table-row')).find(function(row) {
      return row.classList.contains(item.data.section==='RW'?'reading-and-writing':'math') &&
        row.classList.contains('module-'+item.data.module) && text(row.querySelector('th'))===item.q;
    });
    var review=current?.querySelector('button');
    if(!review)throw new Error('対象のReviewボタンが見つかりません');
    review.click();
    await waitFor(document,function(){var d=detail(document,item,root.SatLoggerParse);return d.question || d.passage;},1200);
    var check=visibleModal()?.querySelector('input[type="checkbox"]');
    if(check && !check.checked)check.click();
    await waitFor(document,function(){
      var modal=visibleModal(), d=detail(document,item,root.SatLoggerParse);
      return modal && !modal.querySelector('.question-content')?.classList.contains('hide-answer') && d.answer;
    },1200);
    return detail(document,item,root.SatLoggerParse);
  }
  btn.addEventListener('click',async function() {
    if(busy) return;
    busy=true;btn.disabled=detailBtn.disabled=true;
    var saved=0,duplicates=0;
    try {
      await ensureAnswers();
      var batch=parse(document);
      msg.textContent=batch.rows.length+'問をまとめて記録しています…';
      // One POST and one Sheets append for a complete test (up to 100 questions).
      var response=await send(batch.rows.map(function(item){return Object.assign({},item.data);}));
      if(!response?.ok) throw new Error(response?.reason || '送信できません');
      saved=response.saved || 0;duplicates=response.duplicates || 0;
      msg.textContent=saved+'問を記録・'+duplicates+'問は登録済み。詳細を続けて読みます…';
      await importDetails(batch);
    } catch(e) { msg.textContent='停止: '+e.message+' ('+saved+'問記録済み)。再度押すと続きから登録できます'; }
    finally {
      busy=false;btn.disabled=detailBtn.disabled=false;
    }
  });
  async function importDetails(batch, repairMath) {
    btn.disabled=detailBtn.disabled=true;
    var started=Date.now(), entries=[], failed=0, count=0, firstError='';
    try {
      count=batch.rows.length;
      for(var i=0;i<batch.rows.length;i++) {
        if(Date.now()-started>165000) { failed+=batch.rows.length-i;break; }
        var item=batch.rows[i];msg.textContent=(i+1)+'/'+count+'問のReviewを読んでいます…';
        try {
          var d=await readReview(item);
          entries.push(Object.assign({date:batch.date,number:item.data.number},d));
        } catch(e) { failed++;if(!firstError)firstError=item.data.number+': '+e.message; }
      }
      await closeReview();
      var response=entries.length ? await send({action:'enrich',entries:entries,repair_math:repairMath===true},'enrichBatch') : null;
      if(!response?.ok)throw new Error(response?.reason || firstError || '詳細を読み取れませんでした');
      var chosenCount=entries.filter(function(e){return e.chosen;}).length;
      var answerCount=entries.filter(function(e){return e.answer;}).length;
      msg.textContent='詳細完了: '+response.updated+'問の空欄を補充 / 自分の答え'+chosenCount+'問・正解'+answerCount+'問 / 読取不可'+failed+'問 / 未登録'+response.missing+'問 / '+((Date.now()-started)/1000).toFixed(1)+'秒'+(firstError?' / '+firstError:'');
    } catch(e) { msg.textContent='詳細停止: '+e.message+'。既存の記録は消していません'; }
  }
  detailBtn.addEventListener('click',async function() {
    if(busy)return;
    busy=true;btn.disabled=detailBtn.disabled=true;
    try { await ensureAnswers();await importDetails(parse(document),true); }
    catch(e) { msg.textContent='停止: '+e.message; }
    finally { busy=false;btn.disabled=detailBtn.disabled=false; }
  });
})(typeof window !== 'undefined' ? window : this);
