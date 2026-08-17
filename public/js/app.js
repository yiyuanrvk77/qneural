(function () {
  'use strict';
  function $(id) { return document.getElementById(id); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }

  var S = {
    user: null,
    networks: [],
    templates: [],
    net: null,
    selected: null,
    dirty: false,
    saving: false,
    rev: 0,
    saveTimer: null,
    retryTimer: null
  };
  var E = {};
  var authMode = 'login';

  function setSaveStatus(cls, text) {
    E.saveStatus.className = 'save-status ' + cls;
    E.saveStatus.textContent = text;
  }

  function markDirty() {
    if (!S.net) return;
    S.dirty = true;
    S.rev += 1;
    setSaveStatus('saving', '保存中…');
    clearTimeout(S.saveTimer);
    S.saveTimer = setTimeout(doSave, 700);
  }

  async function doSave() {
    if (!S.net || !S.dirty || S.saving) return;
    clearTimeout(S.saveTimer);
    clearTimeout(S.retryTimer);
    S.saving = true;
    setSaveStatus('saving', '保存中…');
    var rev = S.rev;
    try {
      var data = await Api.updateNetwork(S.net.id, {
        title: S.net.title,
        desc: S.net.desc,
        nodes: S.net.nodes,
        links: S.net.links,
        fusionSuggestions: S.net.fusionSuggestions || []
      });
      S.net.updatedAt = data.network.updatedAt;
      var idx = S.networks.findIndex(function (n) { return n.id === S.net.id; });
      if (idx > -1) {
        S.networks[idx].updatedAt = data.network.updatedAt;
        S.networks[idx].nodeCount = data.network.nodes.length;
        AppEditor.renderNetworks(S.networks, S.net.id, netHandlers());
      }
      if (S.rev === rev) {
        S.dirty = false;
        setSaveStatus('ok', '已保存');
      } else {
        setSaveStatus('saving', '保存中…');
        clearTimeout(S.saveTimer);
        S.saveTimer = setTimeout(doSave, 700);
      }
      S.saving = false;
    } catch (e) {
      S.saving = false;
      setSaveStatus('error', '同步失败 · 自动重试');
      AppUI.toast('保存失败：' + e.message);
      S.retryTimer = setTimeout(doSave, 4000);
    }
  }

  async function flushSave() {
    if (S.dirty && S.net) {
      clearTimeout(S.saveTimer);
      await doSave();
    }
  }

  function defaultLevel() {
    return { q: '这个问题具体指什么？', a: '先缩小边界，再给出一个例子。', opts: ['定义', '边界', '例子'], extra: '' };
  }

  function byId(id) {
    if (!S.net) return null;
    for (var i = 0; i < S.net.nodes.length; i++) if (S.net.nodes[i].id === id) return S.net.nodes[i];
    return null;
  }

  function addLink(a, b) {
    if (a === b || !S.net) return false;
    for (var i = 0; i < S.net.links.length; i++) {
      if ((S.net.links[i].s === a && S.net.links[i].t === b) || (S.net.links[i].s === b && S.net.links[i].t === a)) return false;
    }
    S.net.links.push({ s: a, t: b });
    return true;
  }

  function selectNode(id) {
    S.selected = id;
    AppCanvas.select(id);
    renderStatus();
    AppEditor.renderInspector(id ? byId(id) : null, inspHandlers());
  }

  function onCanvasSelect(id) {
    S.selected = id;
    renderStatus();
    AppEditor.renderInspector(id ? byId(id) : null, inspHandlers());
  }

  function addNode() {
    if (!S.net) { AppUI.toast('请先创建或选择一个网络'); return; }
    var n = AppCanvas.addNode();
    S.net.nodes.push(n);
    selectNode(n.id);
    AppCanvas.startRename(n.id);
    markDirty();
  }

  function deleteNode(id) {
    var n = byId(id);
    if (!n) return;
    var idx = S.net.nodes.indexOf(n);
    var removedLinks = S.net.links.filter(function (l) { return l.s === id || l.t === id; });
    S.net.links = S.net.links.filter(function (l) { return l.s !== id && l.t !== id; });
    S.net.nodes.splice(idx, 1);
    if (S.selected === id) S.selected = null;
    AppCanvas.update(S.net.nodes, S.net.links, null);
    renderStatus();
    AppEditor.renderInspector(null, inspHandlers());
    markDirty();
    AppUI.toast('已删除「' + n.label + '」', '撤销', function () {
      S.net.nodes.splice(idx, 0, n);
      removedLinks.forEach(function (l) { S.net.links.push(l); });
      selectNode(id);
      markDirty();
    });
  }

  function renderStatus() {
    if (!S.net) {
      E.statusBar.innerHTML = '<span class="text-small muted">选择或创建一个问题网络开始</span>';
      return;
    }
    if (AppDepth.isOpen()) {
      var dn = AppDepth.getNode();
      E.statusBar.innerHTML = '<span class="text-small muted">' + (dn ? esc(dn.label) + ' · 第 ' + (AppDepth.getLevel() + 1) + ' 层 · 上滑/下滑换层' : '纵深模式') + '</span>';
      return;
    }
    var n = S.selected && byId(S.selected);
    if (!n) {
      E.statusBar.innerHTML = '<span class="text-small muted">点击节点查看问题 · 双击纵深 · 拖拽节点重排 · 拖拽连接点建链 · 滚轮/双指缩放</span>';
      return;
    }
    var t = AppCanvas.types[n.type];
    E.statusBar.innerHTML =
      '<span class="dot" style="background:' + t.color + '"></span>' +
      '<span style="font-weight:500">' + esc(n.label) + '</span>' +
      '<span class="text-small muted">' + t.name + ' · ' + esc((n.depth[0] || {}).q || '') + '</span>' +
      '<span class="spacer"></span>' +
      '<button type="button" class="btn btn-primary" data-act="dive">深挖</button>' +
      '<button type="button" class="btn btn-ghost" data-act="ask">追问</button>' +
      '<button type="button" class="btn btn-ghost" data-act="rename">改名</button>' +
      '<button type="button" class="btn btn-ghost" data-act="del">删除</button>';
  }

  function openDepth(n) {
    AppCanvas.setLocked(true);
    AppDepth.setCallbacks(depthHandlers());
    AppDepth.open(n);
    renderStatus();
  }

  function depthHandlers() {
    return {
      onBack: function () {
        AppDepth.close();
        AppCanvas.setLocked(false);
        AppCanvas.clearHover();
        renderStatus();
      },
      onAsk: function (level) {
        var n = AppDepth.getNode();
        if (n) askSuggestions(n, level);
      },
      onEdit: function () {
        var n = AppDepth.getNode();
        AppDepth.close();
        AppCanvas.setLocked(false);
        AppCanvas.clearHover();
        if (n) {
          selectNode(n.id);
          openInspector();
          setTimeout(function () {
            var sec = $('depthEditorSection');
            if (sec) sec.scrollIntoView({ behavior: 'smooth', block: 'start' });
          }, 80);
        }
      },
      onAssociate: function (level) {
        var n = AppDepth.getNode();
        if (!n) return;
        var lvl = n.depth[level];
        if (!lvl) return;
        var label = truncate(lvl.q, 16);
        var nn = AppCanvas.addNode(label);
        nn.x = Math.round(n.x + 220);
        nn.y = Math.round(n.y + (Math.random() * 160 - 80));
        S.net.nodes.push(nn);
        S.net.links.push({ s: n.id, t: nn.id });
        AppDepth.close();
        AppCanvas.setLocked(false);
        selectNode(nn.id);
        markDirty();
        AppUI.toast('已从纵深建立关联：' + label);
      },
      onLevel: renderStatus
    };
  }

  function buildSuggestions(node, level) {
    var lvl = node.depth[Math.min(level, node.depth.length - 1)];
    var base = [
      '这个问题的前提假设是什么？',
      '如果这个答案是错的，最可能错在哪里？',
      '谁有资格验证这个结论？',
      '完成这件事后，多久能收到反馈？',
      '这个问题 10 秒能回答吗？如果不能，先拆哪一个？',
      '和「' + node.label + '」相关的哪个问题最容易被忽略？',
      '有没有一个反例能推翻现在的答案？',
      '下一步最小的验证动作是什么？'
    ];
    if (lvl && lvl.opts && lvl.opts.length) {
      base.unshift('这些方向里，哪个最接近真实情况？');
    }
    var start = (level * 2) % base.length;
    var out = [];
    for (var k = 0; k < 3; k++) out.push(base[(start + k) % base.length]);
    return out;
  }

  function askSuggestions(node, level) {
    var sugg = buildSuggestions(node, level);
    var onCodex = null;
    if (window.openai && typeof window.openai.sendFollowUpMessage === 'function') {
      onCodex = function () {
        var lvl = node.depth[Math.min(level, node.depth.length - 1)];
        var chain = node.depth.map(function (d, i) { return i + (i === level ? ' ▶' : '') + ' ' + d.q; }).join('\n');
        var prompt = '我在“问络·问题神经网络平台”上深挖「' + node.label + '」。\n当前链路：\n' + chain + '\n当前层问题：' + (lvl ? lvl.q : '') + '\n候选方向：' + ((lvl && lvl.opts) || []).join(' / ') + '\n请简短回答，并给出下一步最值得追问的问题。';
        try {
          var p = window.openai.sendFollowUpMessage({ prompt: prompt, title: '深挖：' + node.label });
          if (p && typeof p.catch === 'function') p.catch(function () { AppUI.toast('无法创建追问'); });
        } catch (err) {
          AppUI.toast('无法创建追问');
        }
      };
    }
    AppUI.suggestModal(sugg, node.label, function (q) { addSuggestionToNode(node, q); }, onCodex);
  }

  function addSuggestionToNode(node, q) {
    node.depth.push({ q: q, a: '', opts: [], extra: '' });
    markDirty();
    AppUI.toast('已加入纵深链路');
    if (AppDepth.isOpen()) AppDepth.refresh();
    if (S.selected === node.id) renderInspectorForSelected();
  }

  function inspHandlers() {
    return {
      label: function (v) {
        var n = byId(S.selected);
        if (!n) return;
        n.label = v;
        AppCanvas.update(S.net.nodes, S.net.links, S.selected);
        renderStatus();
        markDirty();
      },
      type: function (v) {
        var n = byId(S.selected);
        if (!n) return;
        n.type = v;
        AppCanvas.update(S.net.nodes, S.net.links, S.selected);
        renderStatus();
        markDirty();
      },
      delete: function () { if (S.selected) deleteNode(S.selected); },
      dive: function () {
        var n = byId(S.selected);
        if (n) openDepth(n);
      },
      ask: function () {
        var n = byId(S.selected);
        if (n) askSuggestions(n, 0);
      },
      level: function (i, patch) {
        var n = byId(S.selected);
        if (!n || !n.depth[i]) return;
        Object.keys(patch).forEach(function (k) { n.depth[i][k] = patch[k]; });
        markDirty();
      },
      addLevel: function () {
        var n = byId(S.selected);
        if (!n) return;
        n.depth.push({ q: '', a: '', opts: [], extra: '' });
        renderInspectorForSelected();
        markDirty();
      },
      removeLevel: function (i) {
        var n = byId(S.selected);
        if (!n) return;
        n.depth.splice(i, 1);
        if (n.depth.length === 0) n.depth.push(defaultLevel());
        renderInspectorForSelected();
        markDirty();
      },
      moveLevel: function (i, dir) {
        var n = byId(S.selected);
        if (!n) return;
        var j = i + dir;
        if (j < 0 || j >= n.depth.length) return;
        var tmp = n.depth[i];
        n.depth[i] = n.depth[j];
        n.depth[j] = tmp;
        renderInspectorForSelected();
        markDirty();
      },
      suggest: function () {
        var n = byId(S.selected);
        if (!n) return;
        var list = $('suggestList');
        if (!list) return;
        var sugg = buildSuggestions(n, 0);
        list.innerHTML = sugg.map(function (s) {
          return '<button type="button" class="suggest-item" data-add-sug="' + esc(s) + '"><span class="add">＋</span><span>' + esc(s) + '</span></button>';
        }).join('');
      },
      addSuggestion: function (q) {
        var n = byId(S.selected);
        if (!n) return;
        addSuggestionToNode(n, q);
      }
    };
  }

  function renderInspectorForSelected() {
    AppEditor.renderInspector(S.selected ? byId(S.selected) : null, inspHandlers());
  }

  async function openNetwork(id) {
    await flushSave();
    try {
      var data = await Api.getNetwork(id);
      S.net = data.network;
      S.selected = null;
      S.dirty = false;
      AppCanvas.update(S.net.nodes, S.net.links, null);
      AppCanvas.fit();
      AppCanvas.setLocked(false);
      AppCanvas.clearHover();
      AppDepth.close();
      E.netTitle.textContent = S.net.title;
      setSaveStatus('ok', '已保存');
      E.emptyState.classList.add('hidden');
      renderStatus();
      AppEditor.renderInspector(null, inspHandlers());
      AppEditor.renderNetworks(S.networks, S.net.id, netHandlers());
      closeDrawers();
      if (window.WorkbenchAI && window.WorkbenchAI.onNetworkOpened) window.WorkbenchAI.onNetworkOpened();
    } catch (e) {
      AppUI.toast('打开失败：' + e.message);
    }
  }

  function showEmpty() {
    S.net = null;
    S.selected = null;
    AppCanvas.update([], [], null);
    E.netTitle.textContent = '未选择网络';
    setSaveStatus('ok', '');
    E.emptyState.classList.remove('hidden');
    renderStatus();
    AppEditor.renderInspector(null, inspHandlers());
  }

  function netHandlers() {
    return {
      open: function (id) { openNetwork(id); },
      del: function (id) {
        var net = S.networks.find(function (n) { return n.id === id; });
        AppUI.confirm('删除网络「' + (net ? net.title : '') + '」？', '删除后不可恢复，建议先导出备份。', async function () {
          try {
            await Api.deleteNetwork(id);
            S.networks = S.networks.filter(function (n) { return n.id !== id; });
            AppEditor.renderNetworks(S.networks, S.net ? S.net.id : null, netHandlers());
            if (S.net && S.net.id === id) {
              if (S.networks.length) openNetwork(S.networks[0].id);
              else showEmpty();
            }
          } catch (e) {
            AppUI.toast('删除失败：' + e.message);
          }
        });
      }
    };
  }

  async function refreshNetworks() {
    var data = await Api.networks();
    S.networks = data.networks;
    AppEditor.renderNetworks(S.networks, S.net ? S.net.id : null, netHandlers());
  }

  function newNetworkModal() {
    AppUI.modal({
      title: '新建问题网络',
      desc: '创建空白网络，之后可从模板库一键套用现成结构。',
      fields: [
        { key: 'title', label: '网络名称', placeholder: '例如：我的问题网络', required: true, maxlength: 40 },
        { key: 'desc', label: '一句话描述（可选）', placeholder: '这个网络要解决什么', maxlength: 200 }
      ],
      okText: '创建',
      onOk: async function (v) {
        try {
          var data = await Api.createNetwork({ title: v.title, desc: v.desc, nodes: [], links: [] });
          await refreshNetworks();
          await openNetwork(data.network.id);
          addNode();
        } catch (e) {
          AppUI.toast('创建失败：' + e.message);
        }
      }
    });
  }

  async function useTemplate(tplId) {
    try {
      var data = await Api.createNetwork({ fromTemplate: tplId });
      await refreshNetworks();
      await openNetwork(data.network.id);
      AppUI.toast('已从模板创建：' + data.network.title);
    } catch (e) {
      AppUI.toast('创建失败：' + e.message);
    }
  }

  async function loadSidebar() {
    try {
      var res = await Promise.all([Api.networks(), Api.templates()]);
      S.networks = res[0].networks;
      S.templates = res[1].templates;
      AppEditor.renderNetworks(S.networks, S.net ? S.net.id : null, netHandlers());
      AppEditor.renderTemplates(S.templates, { use: useTemplate });
      if (!S.net) {
        if (S.networks.length) openNetwork(S.networks[0].id);
        else showEmpty();
      }
    } catch (e) {
      AppUI.toast('加载失败：' + e.message);
    }
  }

  function showAuth() {
    E.authView.classList.remove('hidden');
    E.appView.classList.add('hidden');
  }

  function showApp(user) {
    S.user = user;
    E.authView.classList.add('hidden');
    E.appView.classList.remove('hidden');
    E.userName.textContent = user.name;
    E.userAvatar.textContent = user.name.slice(0, 1).toUpperCase();
    loadSidebar();
  }

  function setAuthTab(mode) {
    authMode = mode;
    E.authTabs.forEach(function (b) {
      var on = b.dataset.tab === mode;
      b.classList.toggle('active', on);
      b.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    E.fieldName.classList.toggle('hidden', mode !== 'register');
    E.fieldPass2.classList.toggle('hidden', mode !== 'register');
    E.authSubmit.textContent = mode === 'login' ? '登录' : '注册并创建示例网络';
    E.authPass.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    E.authError.classList.add('hidden');
  }

  function showAuthError(msg) {
    E.authError.textContent = msg;
    E.authError.classList.remove('hidden');
  }

  function closeDrawers() {
    E.sidebar.classList.remove('open');
    E.sidebarMask.classList.add('hidden');
    E.inspector.classList.remove('open');
    E.inspMask.classList.add('hidden');
    E.userDropdown.classList.add('hidden');
  }

  function openInspector() {
    E.inspector.classList.add('open');
    E.inspMask.classList.remove('hidden');
  }

  function initGesture() {
    if (!window.GestureMode) return;
    GestureMode.init({
      onHover: function (id, x, y) {
        if (id && S.net) AppCanvas.hover(id, x, y);
        else AppCanvas.clearHover();
      },
      onPinch: function (id) {
        if (AppDepth.isOpen()) {
          AppDepth.toggleDetail();
          return;
        }
        if (id && byId(id)) openDepth(byId(id));
      },
      onLevelSwipe: function (dir) {
        if (AppDepth.isOpen()) AppDepth.changeLevel(dir);
      },
      onWake: function (on) {
        AppCanvas.setAwake(on);
      },
      onError: function (msg) {
        AppUI.toast(msg);
        setGestureBtn(false);
      }
    });
    E.btnGesture.addEventListener('click', function () {
      if (GestureMode.isActive()) {
        GestureMode.stop();
        setGestureBtn(false);
        AppCanvas.setAwake(false);
      } else {
        GestureMode.start();
      }
    });
  }

  function setGestureBtn(on) {
    E.btnGesture.classList.toggle('on', !!on);
    E.btnGesture.innerHTML = on
      ? '<span class="gesture-dot"></span>手势模式 · 运行中'
      : '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M7 11V6a2 2 0 0 1 4 0v5m0-4a2 2 0 0 1 4 0v4m-4-2v5.5a4.5 4.5 0 0 0 9 0V12" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"/><path d="M5 12a3 3 0 0 0 3 3" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>手势模式';
  }

  function exportNet() {
    if (!S.net) { AppUI.toast('还没有可导出的网络'); return; }
    AppUI.exportNetwork(S.net);
  }

  function importNet(file) {
    var reader = new FileReader();
    reader.onload = function () {
      try {
        var data = AppUI.parseImport(String(reader.result));
        if (!S.net) {
          AppUI.toast('请先创建一个网络再导入');
          return;
        }
        S.net.nodes = data.nodes;
        S.net.links = data.links;
        S.net.fusionSuggestions = data.fusionSuggestions || [];
        if (data.title) S.net.title = data.title;
        if (data.desc !== undefined) S.net.desc = data.desc;
        S.selected = null;
        AppCanvas.update(S.net.nodes, S.net.links, null);
        AppCanvas.fit();
        E.netTitle.textContent = S.net.title;
        renderStatus();
        AppEditor.renderInspector(null, inspHandlers());
        markDirty();
        doSave();
        AppUI.toast('导入成功：' + S.net.nodes.length + ' 个节点');
      } catch (e) {
        AppUI.toast('导入失败：' + e.message);
      }
    };
    reader.readAsText(file);
  }

  function wireEvents() {
    E.authTabs.forEach(function (b) {
      b.addEventListener('click', function () { setAuthTab(b.dataset.tab); });
    });
    E.authForm.addEventListener('submit', async function (e) {
      e.preventDefault();
      var email = E.authEmail.value.trim();
      var password = E.authPass.value;
      var payload = { email: email, password: password };
      if (authMode === 'register') {
        var name = E.authName.value.trim();
        if (!name) { showAuthError('请输入昵称'); return; }
        if (password !== E.authPass2.value) { showAuthError('两次输入的密码不一致'); return; }
        payload.name = name;
      }
      E.authSubmit.disabled = true;
      E.authSubmit.textContent = '请稍候…';
      try {
        var data = authMode === 'login' ? await Api.login(payload) : await Api.register(payload);
        showApp(data.user);
      } catch (err) {
        setAuthTab(authMode);
        showAuthError(err.message);
        E.authSubmit.disabled = false;
      }
    });

    E.btnNewNet.addEventListener('click', newNetworkModal);
    E.btnEmptyNew.addEventListener('click', newNetworkModal);
    E.btnEmptyTpl.addEventListener('click', function () {
      E.sidebar.classList.add('open');
      E.sidebarMask.classList.remove('hidden');
      AppUI.toast('在左侧“模板库”选择模板');
    });
    E.btnExport.addEventListener('click', exportNet);
    E.importFile.addEventListener('change', function () {
      if (E.importFile.files && E.importFile.files[0]) importNet(E.importFile.files[0]);
      E.importFile.value = '';
    });
    E.btnImport.addEventListener('click', function () {
      if (!S.net) { AppUI.toast('请先创建或选择一个网络'); return; }
      E.importFile.click();
    });
    E.btnUser.addEventListener('click', function (e) {
      e.stopPropagation();
      E.userDropdown.classList.toggle('hidden');
    });
    document.addEventListener('click', function () { E.userDropdown.classList.add('hidden'); });
    E.btnLogout.addEventListener('click', async function () {
      if (S.dirty) await flushSave();
      try { await Api.logout(); } catch (e) { /* ignore */ }
      S.net = null;
      S.selected = null;
      S.dirty = false;
      showAuth();
      setAuthTab('login');
    });
    E.statusBar.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      var act = b.dataset.act;
      var n = S.selected && byId(S.selected);
      if (!n) return;
      if (act === 'dive') openDepth(n);
      else if (act === 'ask') askSuggestions(n, 0);
      else if (act === 'rename') AppCanvas.startRename(n.id);
      else if (act === 'del') deleteNode(n.id);
    });

    E.btnSidebar.addEventListener('click', function () {
      E.sidebar.classList.toggle('open');
      E.sidebarMask.classList.toggle('hidden');
    });
    E.sidebarMask.addEventListener('click', closeDrawers);
    E.btnInspector.addEventListener('click', function () {
      openInspector();
      if (window.WorkbenchAI) window.WorkbenchAI.closePanel();
    });
    E.btnInspClose.addEventListener('click', function () {
      E.inspector.classList.remove('open');
      E.inspMask.classList.add('hidden');
    });
    E.inspMask.addEventListener('click', closeDrawers);

    window.addEventListener('beforeunload', function (e) {
      if (S.dirty) {
        e.preventDefault();
        e.returnValue = '';
      }
    });

    window.addEventListener('keydown', function (e) {
      if (e.target.closest('input,textarea,select')) return;
      if (e.key === 'Escape') {
        if (AppDepth.isOpen()) {
          AppDepth.close();
          AppCanvas.setLocked(false);
          AppCanvas.clearHover();
          renderStatus();
        } else if (S.selected) {
          selectNode(null);
        }
        return;
      }
      if (AppDepth.isOpen()) {
        if (e.key === 'ArrowUp') { e.preventDefault(); AppDepth.changeLevel(-1); }
        else if (e.key === 'ArrowDown') { e.preventDefault(); AppDepth.changeLevel(1); }
        return;
      }
      if (S.selected) {
        var n = byId(S.selected);
        if (!n) return;
        if (e.key === 'Delete' || e.key === 'Backspace') {
          e.preventDefault();
          deleteNode(n.id);
        } else if (e.key === 'ArrowLeft' || e.key === 'ArrowRight' || e.key === 'ArrowUp' || e.key === 'ArrowDown') {
          e.preventDefault();
          var step = 6;
          if (e.key === 'ArrowLeft') n.x -= step;
          else if (e.key === 'ArrowRight') n.x += step;
          else if (e.key === 'ArrowUp') n.y -= step;
          else n.y += step;
          AppCanvas.update(S.net.nodes, S.net.links, S.selected);
          markDirty();
        }
      }
    });
  }

  async function boot() {
    E.authView = $('authView');
    E.appView = $('appView');
    E.userName = $('userName');
    E.userAvatar = $('userAvatar');
    E.netTitle = $('netTitle');
    E.saveStatus = $('saveStatus');
    E.statusBar = $('statusBar');
    E.authTabs = Array.prototype.slice.call(document.querySelectorAll('.auth-tab'));
    E.authForm = $('authForm');
    E.authName = $('authName');
    E.authEmail = $('authEmail');
    E.authPass = $('authPass');
    E.authPass2 = $('authPass2');
    E.fieldName = $('fieldName');
    E.fieldPass2 = $('fieldPass2');
    E.authError = $('authError');
    E.authSubmit = $('authSubmit');
    E.sidebar = $('sidebar');
    E.sidebarMask = $('sidebarMask');
    E.inspector = $('inspector');
    E.inspMask = $('inspMask');
    E.btnSidebar = $('btnSidebar');
    E.btnInspector = $('btnInspector');
    E.btnInspClose = $('btnInspClose');
    E.btnNewNet = $('btnNewNet');
    E.btnEmptyNew = $('btnEmptyNew');
    E.btnEmptyTpl = $('btnEmptyTpl');
    E.btnExport = $('btnExport');
    E.btnImport = $('btnImport');
    E.importFile = $('importFile');
    E.btnUser = $('btnUser');
    E.userDropdown = $('userDropdown');
    E.btnLogout = $('btnLogout');
    E.btnGesture = $('btnGesture');

    AppCanvas.init();
    AppCanvas.setCallbacks({
      onSelect: onCanvasSelect,
      onDive: function (id) { var n = byId(id); if (n) openDepth(n); },
      onChanged: markDirty,
      onLink: function (a, b) {
        if (!S.net) return;
        if (addLink(a, b)) {
          AppCanvas.update(S.net.nodes, S.net.links, S.selected);
          markDirty();
          AppUI.toast('已建立连接');
        } else {
          AppUI.toast('连接已存在');
        }
      },
      onRename: function () {
        markDirty();
        renderStatus();
        renderInspectorForSelected();
      },
      onEdgeClick: function (s, t) {
        if (!S.net) return;
        var idx = -1;
        for (var i = 0; i < S.net.links.length; i++) {
          if ((S.net.links[i].s === s && S.net.links[i].t === t) || (S.net.links[i].s === t && S.net.links[i].t === s)) {
            idx = i;
            break;
          }
        }
        if (idx < 0) return;
        var link = S.net.links[idx];
        S.net.links.splice(idx, 1);
        AppCanvas.update(S.net.nodes, S.net.links, S.selected);
        markDirty();
        AppUI.toast('已删除连线', '撤销', function () {
          S.net.links.splice(idx, 0, link);
          AppCanvas.update(S.net.nodes, S.net.links, S.selected);
          markDirty();
        });
      },
      onNodeTap: function (id) {
        if (window.AudioSynesthesia && window.AudioSynesthesia.isEnabled()) {
          var n = byId(id);
          if (n) window.AudioSynesthesia.play(n);
        }
      },
      onNodeHover: function (id, x, y) {
        if (!window.WorkbenchAI) return;
        if (id) window.WorkbenchAI.hoverNode(id, x, y);
        else window.WorkbenchAI.clearHover();
      }
    });
    AppDepth.init();
    AppDepth.setCallbacks(depthHandlers());
    wireEvents();
    initGesture();
    setAuthTab('login');
    try {
      var me = await Api.me();
      showApp(me.user);
    } catch (e) {
      showAuth();
    }
  }

  document.addEventListener('DOMContentLoaded', boot);

  window.AppMain = {
    openNetwork: openNetwork,
    refreshNetworks: refreshNetworks,
    getNet: function () { return S.net; },
    getSelected: function () { return S.selected; },
    selectNode: selectNode,
    markDirty: markDirty,
    addLink: function (a, b) {
      var ok = addLink(a, b);
      if (ok) {
        AppCanvas.update(S.net.nodes, S.net.links, S.selected);
        markDirty();
      }
      return ok;
    },
    types: AppCanvas.types
  };
})();
