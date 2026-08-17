(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function truncate(s, n) { s = String(s || ''); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  var S = {
    convs: [],
    plans: [],
    activeConv: null,
    activePlan: null,
    streaming: false,
    streamText: '',
    tab: 'chat',
    busy: false,
    hoverSug: null,
    visionImage: null
  };
  var E = {};
  var tipEl = null;

  function inline(s) {
    return s
      .replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>')
      .replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  }

  function renderMd(text) {
    var lines = String(text || '').split('\n');
    var html = '';
    var inCode = false;
    var codeBuf = [];
    var codeLang = '';
    function flushCode() {
      if (!inCode) return;
      inCode = false;
      var code = esc(codeBuf.join('\n'));
      html += '<div class="code-block"><div class="code-head"><span>' + esc(codeLang || 'code') + '</span><button type="button" class="code-copy">复制</button></div><pre><code>' + code + '</code></pre></div>';
      codeBuf = [];
      codeLang = '';
    }
    lines.forEach(function (line) {
      var fence = line.match(/^```(\w*)\s*$/);
      if (fence) {
        if (inCode) flushCode();
        else { inCode = true; codeLang = fence[1] || 'code'; }
        return;
      }
      if (inCode) { codeBuf.push(line); return; }
      var t = inline(esc(line));
      var m;
      if ((m = t.match(/^###\s+(.*)$/))) html += '<h3>' + m[1] + '</h3>';
      else if ((m = t.match(/^##\s+(.*)$/))) html += '<h2>' + m[1] + '</h2>';
      else if ((m = t.match(/^#\s+(.*)$/))) html += '<h1>' + m[1] + '</h1>';
      else if ((m = t.match(/^\s*[-*]\s+(.*)$/))) html += '<li>' + m[1] + '</li>';
      else if (t.trim() === '') html += '<p></p>';
      else html += '<p>' + t + '</p>';
    });
    flushCode();
    return html;
  }

  function scrollBottom() {
    if (E.wbMsgs) E.wbMsgs.scrollTop = E.wbMsgs.scrollHeight;
  }

  // ---------- 对话 ----------
  function refreshConvList() {
    var sel = E.convSelect;
    if (!sel) return;
    sel.innerHTML = '';
    S.convs.forEach(function (c) {
      var o = document.createElement('option');
      o.value = c.id;
      o.textContent = c.title + '（' + c.messageCount + '）';
      sel.appendChild(o);
    });
    if (S.activeConv) {
      var hit = S.convs.some(function (c) { return c.id === S.activeConv.id; });
      if (hit) sel.value = S.activeConv.id;
    }
  }

  function renderMessages(conv) {
    E.wbMsgs.innerHTML = '';
    if (!conv || !conv.messages || conv.messages.length === 0) {
      E.wbMsgs.innerHTML = '<div class="wb-empty"><div class="wb-empty-title">AI 工作台</div><p class="muted text-small">让 AI 深挖选中的节点、拆解任务、生成追问；也可以把对话一键提炼成问题网络。</p></div>';
      return;
    }
    conv.messages.forEach(function (m) {
      var row = document.createElement('div');
      row.className = 'msg-row ' + (m.role === 'user' ? 'user' : 'ai');
      var b = document.createElement('div');
      b.className = 'msg ' + (m.role === 'user' ? 'msg-user' : 'msg-ai');
      b.innerHTML = m.role === 'user' ? esc(m.content) : renderMd(m.content);
      row.appendChild(b);
      E.wbMsgs.appendChild(row);
    });
    scrollBottom();
  }

  async function openConversation(id) {
    if (!id) return;
    try {
      var data = await Api.getConversation(id);
      S.activeConv = data.conversation;
      S.streamText = '';
      S.streaming = false;
      E.send.disabled = false;
      renderMessages(S.activeConv);
    } catch (e) {
      AppUI.toast('打开对话失败：' + e.message);
    }
  }

  async function loadConversations() {
    try {
      var data = await Api.conversations();
      S.convs = data.conversations;
      refreshConvList();
      if (!S.activeConv && S.convs.length) {
        await openConversation(S.convs[0].id);
      } else {
        renderMessages(S.activeConv);
      }
    } catch (e) {
      AppUI.toast('对话列表加载失败：' + e.message);
    }
  }

  async function newConversation() {
    try {
      var data = await Api.createConversation({});
      await loadConversations();
      S.activeConv = data.conversation;
      refreshConvList();
      renderMessages(S.activeConv);
      E.wbInput.focus();
    } catch (e) {
      AppUI.toast('新建对话失败：' + e.message);
    }
  }

  function deleteConversation() {
    if (!S.activeConv) return;
    var conv = S.activeConv;
    AppUI.confirm('删除对话「' + conv.title + '」？', '对话记录删除后不可恢复。', async function () {
      try {
        await Api.deleteConversation(conv.id);
        S.activeConv = null;
        await loadConversations();
      } catch (e) {
        AppUI.toast('删除失败：' + e.message);
      }
    });
  }

  function addStreamBubble() {
    var row = document.createElement('div');
    row.className = 'msg-row ai';
    var b = document.createElement('div');
    b.className = 'msg msg-ai';
    row.appendChild(b);
    E.wbMsgs.appendChild(row);
    return b;
  }

  function sendChat() {
    var text = E.input.value.trim();
    if (!text) return;
    if (S.streaming) { AppUI.toast('正在回复中，请稍候'); return; }
    if (!S.activeConv) { AppUI.toast('请先新建对话'); return; }
    E.input.value = '';
    var conv = S.activeConv;
    if (!conv.messages) conv.messages = [];
    conv.messages.push({ role: 'user', content: text, ts: new Date().toISOString() });
    renderMessages(conv);
    var bubble = addStreamBubble();
    S.streaming = true;
    S.streamText = '';
    E.send.disabled = true;
    E.input.disabled = true;
    Api.chatStream({ conversationId: conv.id, message: text }, function (ev) {
      if (ev.type === 'token') {
        S.streamText += ev.text;
        bubble.innerHTML = renderMd(S.streamText);
        scrollBottom();
      } else if (ev.type === 'error') {
        bubble.innerHTML = '<div class="msg-error">' + esc(ev.message) + '</div>';
        S.streaming = false;
        E.send.disabled = false;
        E.input.disabled = false;
      } else if (ev.type === 'done') {
        conv.messages.push({ role: 'assistant', content: S.streamText, ts: new Date().toISOString() });
        S.streaming = false;
        E.send.disabled = false;
        E.input.disabled = false;
        var hit = S.convs.find(function (c) { return c.id === conv.id; });
        if (hit) { hit.messageCount = conv.messages.length; hit.title = ev.title || hit.title; }
        refreshConvList();
      }
    }).catch(function (e) {
      bubble.innerHTML = '<div class="msg-error">' + esc(e.message) + '</div>';
      S.streaming = false;
      E.send.disabled = false;
      E.input.disabled = false;
    });
  }

  async function toNetwork() {
    if (!S.activeConv || !S.activeConv.messages || S.activeConv.messages.length === 0) {
      AppUI.toast('对话还没有内容');
      return;
    }
    try {
      var res = await Api.chatExtract(S.activeConv.id);
      var title = '对话提炼 · ' + truncate(S.activeConv.title, 12);
      var created = await Api.createNetwork({ title: title, desc: '从工作台对话自动提炼的问题网络', nodes: [], links: [] });
      var base = Date.now().toString(36);
      var nodes = res.questions.map(function (q, i) {
        return {
          id: 'n' + base + i + Math.floor(Math.random() * 999),
          label: q.title,
          type: 'think',
          x: 120 + (i % 4) * 230,
          y: 120 + Math.floor(i / 4) * 170,
          depth: [{ q: q.title, a: '', opts: [], extra: '' }]
        };
      });
      await Api.updateNetwork(created.network.id, { title: created.network.title, desc: created.network.desc, nodes: nodes, links: [] });
      await AppMain.refreshNetworks();
      await AppMain.openNetwork(created.network.id);
      AppUI.toast('已生成问题网络：' + nodes.length + ' 个节点');
    } catch (e) {
      AppUI.toast('提炼失败：' + e.message);
    }
  }

  async function toDepth() {
    var net = AppMain.getNet();
    var sel = AppMain.getSelected();
    if (!net || !sel) { AppUI.toast('请先在画布上选中一个节点'); return; }
    if (!S.activeConv || !S.activeConv.messages || S.activeConv.messages.length === 0) {
      AppUI.toast('对话还没有内容');
      return;
    }
    try {
      var res = await Api.chatExtract(S.activeConv.id);
      var node = net.nodes.find(function (n) { return n.id === sel; });
      if (!node) { AppUI.toast('节点不存在'); return; }
      res.questions.slice(0, 3).forEach(function (q) {
        node.depth.push({ q: q.title, a: '', opts: [], extra: '' });
      });
      AppMain.markDirty();
      AppMain.selectNode(sel);
      if (window.AppDepth && window.AppDepth.isOpen()) window.AppDepth.refresh();
      AppUI.toast('已加入纵深：' + Math.min(3, res.questions.length) + ' 条追问');
    } catch (e) {
      AppUI.toast('加入纵深失败：' + e.message);
    }
  }

  // ---------- 规划 ----------
  function refreshPlanList() {
    var sel = E.planSelect;
    if (!sel) return;
    sel.innerHTML = '';
    S.plans.forEach(function (pl) {
      var o = document.createElement('option');
      o.value = pl.id;
      o.textContent = pl.title + '（' + pl.doneCount + '/' + pl.stepCount + '）';
      sel.appendChild(o);
    });
    if (S.activePlan) {
      var hit = S.plans.some(function (pl) { return pl.id === S.activePlan.id; });
      if (hit) sel.value = S.activePlan.id;
    }
  }

  function statusChip(st) {
    var map = { pending: ['待执行', 'st-pending'], running: ['执行中', 'st-running'], done: ['已完成', 'st-done'], failed: ['失败', 'st-failed'] };
    var m = map[st] || map.pending;
    return '<span class="step-status ' + m[1] + '">' + m[0] + '</span>';
  }

  function renderPlanDetail(plan) {
    if (!plan) {
      E.planDetail.innerHTML = '<div class="wb-empty"><div class="wb-empty-title">自主规划</div><p class="muted text-small">输入一个目标，AI 会自动拆解成可执行步骤，然后逐条执行。</p></div>';
      return;
    }
    var steps = (plan.steps || []).map(function (st, i) {
      var actions = '';
      if (st.status === 'pending' || st.status === 'failed') {
        actions = '<button type="button" class="btn btn-primary" data-run="' + st.id + '"' + (S.busy ? ' disabled' : '') + '>' + (st.status === 'failed' ? '重试' : '执行此步') + '</button>' +
          '<button type="button" class="btn btn-ghost" data-done="' + st.id + '"' + (S.busy ? ' disabled' : '') + '>标记完成</button>';
      } else if (st.status === 'running') {
        actions = '<span class="text-small muted">正在执行…</span>';
      }
      var body = st.result
        ? '<div class="step-result">' + renderMd(st.result) + '</div>'
        : (st.error ? '<div class="step-error">' + esc(st.error) + '</div>' : '');
      return '<div class="step-card">' +
        '<div class="step-head">' + statusChip(st.status) + '<span class="step-title">' + (i + 1) + '. ' + esc(st.title) + '</span></div>' +
        (st.detail ? '<div class="step-detail text-small muted">' + esc(st.detail) + '</div>' : '') +
        body +
        '<div class="step-actions">' + actions + '</div>' +
        '</div>';
    }).join('');
    var pending = (plan.steps || []).filter(function (s) { return s.status === 'pending' || s.status === 'failed'; }).length;
    E.planDetail.innerHTML =
      '<div class="plan-goal"><div class="side-head">目标</div><p>' + esc(plan.goal) + '</p></div>' +
      '<div class="plan-tools">' +
      (pending > 0 ? '<button type="button" class="btn btn-primary" id="btnRunAll">▶ 自动执行全部（' + pending + '）</button>' : '<span class="text-small muted">全部步骤已完成</span>') +
      '</div>' +
      '<div class="step-list">' + steps + '</div>';
    var ra = $('btnRunAll');
    if (ra) ra.addEventListener('click', runAll);
    E.planDetail.querySelectorAll('[data-run]').forEach(function (b) {
      b.addEventListener('click', function () { runStep(b.dataset.run); });
    });
    E.planDetail.querySelectorAll('[data-done]').forEach(function (b) {
      b.addEventListener('click', function () { markDone(b.dataset.done); });
    });
  }

  async function openPlan(id) {
    if (!id) return;
    try {
      var data = await Api.getPlan(id);
      S.activePlan = data.plan;
      renderPlanDetail(S.activePlan);
    } catch (e) {
      AppUI.toast('打开规划失败：' + e.message);
    }
  }

  async function loadPlans() {
    try {
      var data = await Api.plans();
      S.plans = data.plans;
      refreshPlanList();
      if (S.activePlan) {
        var hit = S.plans.some(function (pl) { return pl.id === S.activePlan.id; });
        if (hit) openPlan(S.activePlan.id);
        else { S.activePlan = null; renderPlanDetail(null); }
      } else {
        renderPlanDetail(null);
      }
    } catch (e) {
      AppUI.toast('规划列表加载失败：' + e.message);
    }
  }

  function newPlan() {
    var prefill = '';
    if (S.activeConv && S.activeConv.messages) {
      for (var i = S.activeConv.messages.length - 1; i >= 0; i--) {
        if (S.activeConv.messages[i].role === 'assistant') { prefill = truncate(S.activeConv.messages[i].content, 300); break; }
      }
    }
    AppUI.modal({
      title: '新建自主规划',
      desc: '输入目标，AI 会拆解成 3-6 个可执行步骤，然后可以一键自动执行。',
      fields: [
        { key: 'goal', label: '目标', type: 'textarea', placeholder: '例如：为问络设计一套用户增长方案', required: true, value: prefill },
        { key: 'title', label: '规划名称（可选）', placeholder: '留空则用目标前 20 字', maxlength: 40 }
      ],
      okText: '生成规划',
      onOk: async function (v) {
        try {
          var data = await Api.createPlan({ goal: v.goal, title: v.title || undefined });
          S.activePlan = data.plan;
          await loadPlans();
          renderPlanDetail(data.plan);
          AppUI.toast('规划已生成：' + data.plan.steps.length + ' 个步骤');
        } catch (e) {
          AppUI.toast('创建规划失败：' + e.message);
        }
      }
    });
  }

  function deletePlan() {
    if (!S.activePlan) return;
    var plan = S.activePlan;
    AppUI.confirm('删除规划「' + plan.title + '」？', '执行记录将一并删除。', async function () {
      try {
        await Api.deletePlan(plan.id);
        S.activePlan = null;
        await loadPlans();
      } catch (e) {
        AppUI.toast('删除失败：' + e.message);
      }
    });
  }

  async function runStep(sid) {
    if (!S.activePlan || S.busy) return;
    S.busy = true;
    var st = S.activePlan.steps.find(function (s) { return s.id === sid; });
    if (!st) { S.busy = false; return; }
    st.status = 'running';
    renderPlanDetail(S.activePlan);
    try {
      var data = await Api.runPlanStep(S.activePlan.id, sid);
      S.activePlan = data.plan;
      renderPlanDetail(S.activePlan);
      var done = data.plan.steps.find(function (s) { return s.id === sid; });
      if (done && done.status === 'done') AppUI.toast('步骤完成：' + done.title);
      else AppUI.toast('步骤执行失败，可重试');
    } catch (e) {
      AppUI.toast('执行失败：' + e.message);
      try {
        var d2 = await Api.getPlan(S.activePlan.id);
        S.activePlan = d2.plan;
        renderPlanDetail(S.activePlan);
      } catch (e2) { /* ignore */ }
    }
    S.busy = false;
  }

  async function runAll() {
    if (!S.activePlan || S.busy) return;
    S.busy = true;
    var targets = S.activePlan.steps.filter(function (s) { return s.status === 'pending' || s.status === 'failed'; });
    for (var i = 0; i < targets.length; i++) {
      if (!S.activePlan) break;
      var st = S.activePlan.steps.find(function (s) { return s.id === targets[i].id; });
      if (!st || (st.status !== 'pending' && st.status !== 'failed')) continue;
      await runStep(st.id);
    }
    S.busy = false;
    AppUI.toast('自动执行完成');
  }

  async function markDone(sid) {
    if (!S.activePlan || S.busy) return;
    try {
      var data = await Api.setPlanStep(S.activePlan.id, sid, { status: 'done' });
      S.activePlan = data.plan;
      renderPlanDetail(S.activePlan);
    } catch (e) {
      AppUI.toast('操作失败：' + e.message);
    }
  }

  // ---------- 融合 ----------
  function suggestionsOf() {
    var net = AppMain.getNet();
    if (!net) return [];
    if (!Array.isArray(net.fusionSuggestions)) net.fusionSuggestions = [];
    return net.fusionSuggestions;
  }

  function nodeLabel(id) {
    var net = AppMain.getNet();
    if (!net) return '';
    var n = net.nodes.find(function (x) { return x.id === id; });
    return n ? n.label : id;
  }

  function renderFusionList() {
    if (!E.fusionList) return;
    var list = suggestionsOf().filter(function (s) { return s.status !== 'dismissed'; });
    if (list.length === 0) {
      E.fusionList.innerHTML = '<div class="wb-empty"><div class="wb-empty-title">融合建议</div><p class="muted text-small">点击「分析两个节点」，或把鼠标悬停在节点上查看高融合提示。</p></div>';
      return;
    }
    E.fusionList.innerHTML = list.map(function (s) {
      var pct = Math.round((Number(s.fusionProbability) || 0) * 100);
      var accepted = s.status === 'accepted';
      return '<div class="fusion-item" data-sug="' + esc(s.id) + '">' +
        '<div class="fusion-pair">' + esc(truncate(nodeLabel(s.sourceId), 14)) + ' ↔ ' + esc(truncate(nodeLabel(s.targetId), 14)) + '</div>' +
        '<div class="fusion-score"><span>融合 ' + pct + '%</span><span class="fusion-bar"><i style="width:' + pct + '%"></i></span>' +
        (accepted ? '<span class="fusion-tag">已接受</span>' : '') + '</div>' +
        (s.reason ? '<div class="fusion-reason">' + esc(truncate(s.reason, 60)) + '</div>' : '') +
        (accepted
          ? ''
          : '<div class="fusion-actions"><button type="button" class="btn btn-primary" data-accept="' + esc(s.id) + '">接受</button><button type="button" class="btn btn-ghost" data-dismiss="' + esc(s.id) + '">忽略</button></div>') +
        '</div>';
    }).join('');
    E.fusionList.querySelectorAll('.fusion-item').forEach(function (item) {
      item.addEventListener('click', function (e) {
        if (e.target.closest('button')) return;
        var sug = suggestionsOf().find(function (s) { return s.id === item.dataset.sug; });
        if (sug) AppMain.selectNode(sug.sourceId);
      });
    });
    E.fusionList.querySelectorAll('[data-accept]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sug = suggestionsOf().find(function (s) { return s.id === b.dataset.accept; });
        if (sug) acceptSuggestion(sug);
      });
    });
    E.fusionList.querySelectorAll('[data-dismiss]').forEach(function (b) {
      b.addEventListener('click', function () {
        var sug = suggestionsOf().find(function (s) { return s.id === b.dataset.dismiss; });
        if (sug) dismissSuggestion(sug);
      });
    });
  }

  function showFusionAnalyze() {
    var net = AppMain.getNet();
    if (!net) { AppUI.toast('请先打开一个网络'); return; }
    if (net.nodes.length < 2) { AppUI.toast('至少需要两个节点'); return; }
    var opts = net.nodes.map(function (n) {
      return { value: n.id, label: n.label + '（' + (AppMain.types[n.type] ? AppMain.types[n.type].name : n.type) + '）' };
    });
    var a = AppMain.getSelected() || net.nodes[0].id;
    var b = net.nodes.find(function (n) { return n.id !== a; });
    AppUI.modal({
      title: 'AI 融合分析',
      desc: '选择两个问题，让 AI 评估相似度、创新度与融合概率。高概率建议会自动推送到飞书（若已配置）。',
      fields: [
        { key: 'source', label: '问题 A', type: 'select', options: opts, value: a },
        { key: 'target', label: '问题 B', type: 'select', options: opts, value: b ? b.id : opts[0].value }
      ],
      okText: '开始分析',
      onOk: async function (v) {
        if (v.source === v.target) {
          AppUI.toast('请选择两个不同的节点');
          return false;
        }
        AppUI.toast('AI 正在分析…');
        try {
          var data = await Api.fusionAnalyze({ networkId: net.id, source: v.source, target: v.target });
          var r = data.result;
          var sug = {
            id: 'f' + Date.now().toString(36) + Math.floor(Math.random() * 1e6).toString(36),
            sourceId: r.source,
            targetId: r.target,
            similarity: r.similarity,
            innovation: r.innovation,
            fusionProbability: r.fusionProbability,
            reason: r.reason,
            status: 'pending',
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
          };
          suggestionsOf().push(sug);
          AppMain.markDirty();
          renderFusionList();
          showFusionDetail(sug);
        } catch (e) {
          AppUI.toast('分析失败：' + e.message);
        }
      }
    });
  }

  function scoreBar(label, val) {
    var pct = Math.round((Number(val) || 0) * 100);
    return '<div class="fusion-score"><span>' + label + ' ' + pct + '%</span><span class="fusion-bar"><i style="width:' + pct + '%"></i></span></div>';
  }

  function showFusionDetail(sug) {
    AppUI.closeModal();
    var root = $('modalRoot');
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    var box = document.createElement('div');
    box.className = 'modal';
    box.innerHTML =
      '<h3>融合建议</h3>' +
      '<p class="modal-desc">「' + esc(nodeLabel(sug.sourceId)) + '」 × 「' + esc(nodeLabel(sug.targetId)) + '」</p>' +
      scoreBar('相似度', sug.similarity) +
      scoreBar('创新度', sug.innovation) +
      scoreBar('融合概率', sug.fusionProbability) +
      (sug.reason ? '<p class="fusion-reason" style="margin:12px 0">' + esc(sug.reason) + '</p>' : '') +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost" data-act="close">稍后</button>' +
      '<button type="button" class="btn btn-ghost" data-act="dismiss">忽略</button>' +
      '<button type="button" class="btn btn-primary" data-act="accept">接受融合</button>' +
      '</div>';
    backdrop.appendChild(box);
    root.appendChild(backdrop);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeFusionDetail(); });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.dataset.act;
      if (act === 'close') closeFusionDetail();
      else if (act === 'dismiss') dismissSuggestion(sug);
      else if (act === 'accept') acceptSuggestion(sug);
    });
  }

  function closeFusionDetail() {
    var root = $('modalRoot');
    if (root) root.innerHTML = '';
  }

  function acceptSuggestion(sug) {
    sug.status = 'accepted';
    sug.updatedAt = new Date().toISOString();
    var ok = AppMain.addLink(sug.sourceId, sug.targetId);
    AppMain.markDirty();
    renderFusionList();
    closeFusionDetail();
    AppUI.toast(ok ? '已接受融合，连线已建立' : '已接受融合（连线已存在）');
  }

  function dismissSuggestion(sug) {
    sug.status = 'dismissed';
    sug.updatedAt = new Date().toISOString();
    AppMain.markDirty();
    renderFusionList();
    closeFusionDetail();
    AppUI.toast('已忽略该建议');
  }

  function readVisionFile(file) {
    if (!file || !file.type || file.type.indexOf('image/') !== 0) {
      AppUI.toast('请选择图片文件');
      return;
    }
    if (file.size > 5 * 1024 * 1024) {
      AppUI.toast('图片不能超过 5MB');
      return;
    }
    var reader = new FileReader();
    reader.onload = function () {
      S.visionImage = reader.result;
      E.visionImg.src = reader.result;
      E.visionPreview.classList.remove('hidden');
      E.visionDrop.classList.add('hidden');
      E.visionResult.innerHTML = '';
    };
    reader.readAsDataURL(file);
  }

  function clearVision() {
    S.visionImage = null;
    E.visionImg.removeAttribute('src');
    E.visionPreview.classList.add('hidden');
    E.visionDrop.classList.remove('hidden');
    E.visionResult.innerHTML = '';
    if (E.visionFile) E.visionFile.value = '';
  }

  async function runVision() {
    if (!S.visionImage) { AppUI.toast('请先上传或拖入一张图片'); return; }
    E.btnVisionRun.disabled = true;
    E.visionResult.innerHTML = '<div class="text-small muted">AI 正在识图…</div>';
    try {
      var data = await Api.vision({ image: S.visionImage, prompt: E.visionPrompt.value });
      E.visionResult.innerHTML = '<div class="vision-result-text">' + renderMd(data.description) + '</div>' +
        '<button type="button" class="btn btn-ghost" id="btnVisionCopy">复制描述</button>';
      var bc = $('btnVisionCopy');
      if (bc) bc.addEventListener('click', function () {
        if (navigator.clipboard && navigator.clipboard.writeText) {
          navigator.clipboard.writeText(data.description).then(function () { AppUI.toast('已复制'); }, function () { AppUI.toast('复制失败'); });
        }
      });
    } catch (e) {
      E.visionResult.innerHTML = '<div class="msg-error">' + esc(e.message) + '</div>';
    } finally {
      E.btnVisionRun.disabled = false;
    }
  }

  function hoverNode(id, x, y) {
    var list = suggestionsOf().filter(function (s) { return s.status === 'pending' && (s.sourceId === id || s.targetId === id); });
    if (list.length === 0) { clearHover(); return; }
    var sug = list.sort(function (a, b) { return b.fusionProbability - a.fusionProbability; })[0];
    var other = sug.sourceId === id ? sug.targetId : sug.sourceId;
    if (window.AppCanvas) AppCanvas.showFusionHint(id, other);
    S.hoverSug = sug;
    if (!tipEl) return;
    tipEl.innerHTML = '<div class="fusion-tip-text">⚡ 与「' + esc(truncate(nodeLabel(other), 14)) + '」融合 ' + Math.round((Number(sug.fusionProbability) || 0) * 100) + '%</div>' +
      (sug.reason ? '<div class="fusion-tip-reason">' + esc(truncate(sug.reason, 48)) + '</div>' : '') +
      '<button type="button" class="btn btn-primary">查看</button>';
    tipEl.classList.remove('hidden');
    var w = 230;
    var left = x + 16;
    if (left + w > window.innerWidth - 8) left = x - w - 16;
    tipEl.style.left = Math.max(8, left) + 'px';
    tipEl.style.top = Math.max(8, y + 16) + 'px';
  }

  function clearHover() {
    if (window.AppCanvas) AppCanvas.clearFusionHint();
    S.hoverSug = null;
    if (tipEl) tipEl.classList.add('hidden');
  }

  // ---------- 设置 ----------
  async function openSettings() {
    var cfg = null;
    var me = null;
    try {
      cfg = await Api.config();
      me = await Api.me();
    } catch (e) {
      AppUI.toast('读取设置失败：' + e.message);
      return;
    }
    AppUI.modal({
      title: 'AI 设置',
      desc: 'DeepSeek Key 与飞书 Webhook 仅保存在本机 data/config.json；记忆保存在账号里，AI 每次对话都会参考。' +
        (cfg.hasKey ? '（已配置 Key）' : '（未配置 Key）') + (cfg.hasFeishu ? '（已配置飞书）' : ''),
      fields: [
        { key: 'deepseekKey', label: 'DeepSeek API Key', type: 'password', placeholder: cfg.hasKey ? '已配置，留空保持不变' : 'sk-...', maxlength: 200 },
        { key: 'model', label: '模型', type: 'select', options: [
          { value: 'deepseek-chat', label: 'deepseek-chat（默认，便宜）' },
          { value: 'deepseek-reasoner', label: 'deepseek-reasoner（推理更强）' }
        ], value: cfg.model },
        { key: 'baseUrl', label: '接口地址（可选）', value: cfg.baseUrl, maxlength: 200 },
        { key: 'visionKey', label: '识图 API Key（可选）', type: 'password', placeholder: cfg.hasVisionKey ? '已配置，留空保持不变' : '智谱 / 千问等视觉模型 Key', maxlength: 200 },
        { key: 'visionModel', label: '识图模型', type: 'select', options: [
          { value: 'glm-4v-flash', label: 'glm-4v-flash（智谱，免费）' },
          { value: 'glm-4.6v-flash', label: 'glm-4.6v-flash（智谱，免费，更强）' },
          { value: 'qwen-vl-max', label: 'qwen-vl-max（千问）' },
          { value: 'qwen3.5-omni-plus', label: 'qwen3.5-omni-plus（千问）' }
        ], value: cfg.visionModel },
        { key: 'visionBaseUrl', label: '识图接口地址（可选）', value: cfg.visionBaseUrl, maxlength: 200 },
        { key: 'feishuWebhook', label: '飞书机器人 Webhook（可选）', placeholder: cfg.hasFeishu ? '已配置，留空保持不变' : 'https://open.feishu.cn/open-apis/bot/v2/hook/xxx', maxlength: 300 },
        { key: 'memory', label: '记忆（长期偏好 / 背景）', type: 'textarea', value: (me.user && me.user.memory) || '', placeholder: '例如：我是产品经理，喜欢简洁的中文回答，正在做「问络」…' }
      ],
      okText: '保存',
      onOk: async function (v) {
        var body = { model: v.model, baseUrl: v.baseUrl };
        if (v.deepseekKey) body.deepseekKey = v.deepseekKey;
        if (v.feishuWebhook) body.feishuWebhook = v.feishuWebhook;
        if (v.visionKey) body.visionKey = v.visionKey;
        if (v.visionModel) body.visionModel = v.visionModel;
        if (v.visionBaseUrl) body.visionBaseUrl = v.visionBaseUrl;
        try {
          await Api.saveConfig(body);
          await Api.updateMe({ memory: v.memory });
          AppUI.toast('设置已保存');
          if (v.feishuWebhook) {
            try {
              var t = await Api.testIntegration();
              AppUI.toast(t.ok ? '飞书测试通知已发送' : '飞书测试失败');
            } catch (e2) {
              AppUI.toast('飞书测试失败：' + e2.message);
            }
          }
        } catch (e) {
          AppUI.toast('保存失败：' + e.message);
        }
      }
    });
  }

  // ---------- 面板与导航 ----------
  function setTab(tab) {
    S.tab = tab;
    document.querySelectorAll('#aiPanel .wb-tab').forEach(function (b) {
      var on = b.dataset.tab === tab;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    document.querySelectorAll('#aiPanel .wb-tab-pane').forEach(function (p) {
      p.classList.toggle('hidden', p.dataset.pane !== tab);
    });
    if (tab === 'fusion') renderFusionList();
    if (tab === 'plan' && !S.activePlan && S.plans.length) openPlan(S.plans[0].id);
    if (tab === 'chat' && !S.activeConv && S.convs.length) openConversation(S.convs[0].id);
  }

  function openPanel() {
    E.aiPanel.classList.remove('hidden');
    E.aiPanel.classList.add('open');
    E.aiMask.classList.remove('hidden');
    var insp = $('inspector');
    if (insp) {
      insp.classList.add('hidden');
      insp.classList.remove('open');
    }
    var im = $('inspMask');
    if (im) im.classList.add('hidden');
    loadConversations();
    loadPlans();
    setTab(S.tab);
  }

  function closePanel() {
    E.aiPanel.classList.add('hidden');
    E.aiPanel.classList.remove('open');
    E.aiMask.classList.add('hidden');
  }

  function toggleSyn() {
    var on = !window.AudioSynesthesia.isEnabled();
    window.AudioSynesthesia.setEnabled(on);
    E.btnSyn.classList.toggle('on', on);
    AppUI.toast(on ? '音阶模式已开启：点击节点会发声' : '音阶模式已关闭');
  }

  // ---------- 初始化 ----------
  function init() {
    E.aiPanel = $('aiPanel');
    E.aiBody = $('aiBody');
    E.aiMask = $('aiMask');
    E.btnAI = $('btnAI');
    E.btnAIClose = $('btnAIClose');
    E.btnAISettings = $('btnAISettings');
    E.btnSyn = $('btnSyn');
    E.convSelect = $('convSelect');
    E.btnConvNew = $('btnConvNew');
    E.btnConvDel = $('btnConvDel');
    E.wbMsgs = $('wbMsgs');
    E.input = $('wbInput');
    E.send = $('btnSend');
    E.btnToNet = $('btnToNet');
    E.btnToDepth = $('btnToDepth');
    E.planSelect = $('planSelect');
    E.btnPlanNew = $('btnPlanNew');
    E.btnPlanDel = $('btnPlanDel');
    E.planDetail = $('planDetail');
    E.btnFusionAnalyze = $('btnFusionAnalyze');
    E.fusionList = $('fusionList');
    E.visionDrop = $('visionDrop');
    E.visionFile = $('visionFile');
    E.visionPreview = $('visionPreview');
    E.visionImg = $('visionImg');
    E.btnVisionRemove = $('btnVisionRemove');
    E.visionPrompt = $('visionPrompt');
    E.btnVisionRun = $('btnVisionRun');
    E.visionResult = $('visionResult');

    if (!E.btnAI) return;

    if (window.AudioSynesthesia) {
      window.AudioSynesthesia.init();
      E.btnSyn.classList.toggle('on', window.AudioSynesthesia.isEnabled());
    }
    E.btnSyn.addEventListener('click', toggleSyn);
    E.btnAI.addEventListener('click', function () {
      if (E.aiPanel.classList.contains('hidden')) openPanel();
      else closePanel();
    });
    E.btnAIClose.addEventListener('click', closePanel);
    E.aiMask.addEventListener('click', closePanel);
    E.btnAISettings.addEventListener('click', openSettings);

    document.querySelectorAll('#aiPanel .wb-tab').forEach(function (b) {
      b.addEventListener('click', function () { setTab(b.dataset.tab); });
    });

    E.convSelect.addEventListener('change', function () { openConversation(E.convSelect.value); });
    E.btnConvNew.addEventListener('click', newConversation);
    E.btnConvDel.addEventListener('click', deleteConversation);
    E.send.addEventListener('click', sendChat);
    E.input.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        sendChat();
      }
    });
    E.btnToNet.addEventListener('click', toNetwork);
    E.btnToDepth.addEventListener('click', toDepth);

    E.planSelect.addEventListener('change', function () { openPlan(E.planSelect.value); });
    E.btnPlanNew.addEventListener('click', newPlan);
    E.btnPlanDel.addEventListener('click', deletePlan);

    E.btnFusionAnalyze.addEventListener('click', showFusionAnalyze);
    E.visionDrop.addEventListener('click', function () { E.visionFile.click(); });
    E.visionFile.addEventListener('change', function () {
      if (E.visionFile.files && E.visionFile.files[0]) readVisionFile(E.visionFile.files[0]);
    });
    ['dragover', 'dragenter'].forEach(function (ev) {
      E.visionDrop.addEventListener(ev, function (e) { e.preventDefault(); E.visionDrop.classList.add('drag'); });
    });
    ['dragleave', 'drop'].forEach(function (ev) {
      E.visionDrop.addEventListener(ev, function (e) { e.preventDefault(); E.visionDrop.classList.remove('drag'); });
    });
    E.visionDrop.addEventListener('drop', function (e) {
      var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
      if (f) readVisionFile(f);
    });
    E.btnVisionRemove.addEventListener('click', clearVision);
    E.btnVisionRun.addEventListener('click', runVision);
    E.wbMsgs.addEventListener('click', function (e) {
      var b = e.target.closest('.code-copy');
      if (!b) return;
      var pre = b.closest('.code-block').querySelector('pre');
      var txt = pre ? pre.textContent : '';
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(txt).then(function () { AppUI.toast('已复制代码'); }, function () { AppUI.toast('复制失败'); });
      }
    });

    tipEl = document.createElement('div');
    tipEl.className = 'fusion-tip hidden';
    tipEl.addEventListener('click', function () {
      if (S.hoverSug) showFusionDetail(S.hoverSug);
    });
    document.body.appendChild(tipEl);

    refreshConvList();
    renderMessages(null);
  }

  window.WorkbenchAI = {
    init: init,
    openSettings: openSettings,
    openPanel: openPanel,
    closePanel: closePanel,
    hoverNode: hoverNode,
    clearHover: clearHover,
    onNetworkOpened: function () { renderFusionList(); }
  };

  document.addEventListener('DOMContentLoaded', init);
})();
