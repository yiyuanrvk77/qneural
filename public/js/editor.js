(function () {
  'use strict';
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function fmtTime(iso) {
    if (!iso) return '';
    var d = new Date(iso);
    if (isNaN(d.getTime())) return '';
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + p(d.getHours()) + ':' + p(d.getMinutes());
  }

  var toastTimer = null;
  function toast(msg, action, fn) {
    var el = document.getElementById('toast');
    if (!el) return;
    el.innerHTML = '';
    var span = document.createElement('span');
    span.textContent = msg;
    el.appendChild(span);
    if (action && fn) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'btn';
      b.textContent = action;
      b.addEventListener('click', function () {
        clearTimeout(toastTimer);
        el.classList.remove('show');
        fn();
      });
      el.appendChild(b);
    }
    el.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { el.classList.remove('show'); }, 3600);
  }

  function closeModal() {
    var root = document.getElementById('modalRoot');
    if (root) root.innerHTML = '';
  }

  function modal(opts) {
    var root = document.getElementById('modalRoot');
    closeModal();
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    var box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    var title = opts.title || '';
    var desc = opts.desc || '';
    var fields = (opts.fields || []).map(function (f) {
      var req = f.required ? ' required' : '';
      var html = '<div class="field"><label for="mf-' + esc(f.key) + '">' + esc(f.label || f.key) + '</label>';
      if (f.type === 'select') {
        html += '<select id="mf-' + esc(f.key) + '"' + req + '>' +
          (f.options || []).map(function (o) {
            var val = typeof o === 'object' ? o.value : o;
            var lab = typeof o === 'object' ? o.label : o;
            return '<option value="' + esc(val) + '"' + (String(f.value) === String(val) ? ' selected' : '') + '>' + esc(lab) + '</option>';
          }).join('') + '</select>';
      } else if (f.type === 'textarea') {
        html += '<textarea id="mf-' + esc(f.key) + '" rows="3" placeholder="' + esc(f.placeholder || '') + '"' + req + '>' + esc(f.value || '') + '</textarea>';
      } else {
        html += '<input id="mf-' + esc(f.key) + '" type="' + (f.type || 'text') + '" placeholder="' + esc(f.placeholder || '') + '" value="' + esc(f.value || '') + '" maxlength="' + (f.maxlength || 200) + '"' + req + '>';
      }
      html += '</div>';
      return html;
    }).join('');
    box.innerHTML =
      (title ? '<h3>' + esc(title) + '</h3>' : '') +
      (desc ? '<p class="modal-desc">' + esc(desc) + '</p>' : '') +
      fields +
      '<div class="modal-actions">' +
      '<button type="button" class="btn btn-ghost" data-act="cancel">取消</button>' +
      '<button type="button" class="btn' + (opts.danger ? ' btn-danger' : ' btn-primary') + '" data-act="ok">' + esc(opts.okText || '确定') + '</button>' +
      '</div>';
    backdrop.appendChild(box);
    root.appendChild(backdrop);
    backdrop.addEventListener('click', function (e) {
      if (e.target === backdrop && !opts.preventClose) closeModal();
    });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (!b) return;
      if (b.dataset.act === 'cancel') { closeModal(); return; }
      var values = {};
      var ok = true;
      (opts.fields || []).forEach(function (f) {
        var el = document.getElementById('mf-' + f.key);
        if (!el) return;
        values[f.key] = el.value.trim();
        if (f.required && !values[f.key]) ok = false;
      });
      if (!ok) { toast('请填写必填项'); return; }
      var ret = opts.onOk ? opts.onOk(values) : null;
      if (ret === false) return;
      closeModal();
    });
    var first = box.querySelector('input,select,textarea');
    if (first) first.focus();
  }

  function confirmDialog(title, desc, onOk, okText) {
    modal({ title: title, desc: desc, okText: okText || '删除', danger: true, onOk: onOk });
  }

  function renderNetworks(list, activeId, handlers) {
    var el = document.getElementById('netList');
    var count = document.getElementById('netCount');
    if (!el) return;
    count.textContent = list.length;
    if (list.length === 0) {
      el.innerHTML = '<p class="text-small muted" style="padding:6px 4px">还没有网络，点击右上角“新建网络”开始。</p>';
      return;
    }
    el.innerHTML = list.map(function (n) {
      return '<div class="net-item' + (n.id === activeId ? ' active' : '') + '" data-id="' + esc(n.id) + '" role="button" tabindex="0">' +
        '<div class="net-item-main">' +
        '<div class="net-item-title">' + esc(n.title) + '</div>' +
        '<div class="net-item-sub">' + n.nodeCount + ' 个节点 · ' + fmtTime(n.updatedAt) + '</div>' +
        '</div>' +
        '<button type="button" class="net-del" data-del="' + esc(n.id) + '" aria-label="删除网络 ' + esc(n.title) + '">' +
        '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M9 7V5h6v2m-8 0l1 12h8l1-12M10 11v5M14 11v5" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>' +
        '</button></div>';
    }).join('');
    el.querySelectorAll('.net-item').forEach(function (item) {
      var open = function () { if (handlers.open) handlers.open(item.dataset.id); };
      item.addEventListener('click', open);
      item.addEventListener('keydown', function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); open(); } });
    });
    el.querySelectorAll('.net-del').forEach(function (b) {
      b.addEventListener('click', function (e) {
        e.stopPropagation();
        if (handlers.del) handlers.del(b.dataset.del);
      });
    });
  }

  function renderTemplates(list, handlers) {
    var el = document.getElementById('tplList');
    if (!el) return;
    if (!list || list.length === 0) {
      el.innerHTML = '<p class="text-small muted">模板库为空。</p>';
      return;
    }
    el.innerHTML = list.map(function (t) {
      return '<div class="tpl-item">' +
        '<div class="tpl-title">' + esc(t.title) + '</div>' +
        '<div class="tpl-desc">' + esc(t.desc) + ' · ' + t.nodeCount + ' 个节点</div>' +
        '<button type="button" class="btn btn-ghost" data-use="' + esc(t.id) + '">使用此模板</button>' +
        '</div>';
    }).join('');
    el.querySelectorAll('[data-use]').forEach(function (b) {
      b.addEventListener('click', function () { if (handlers.use) handlers.use(b.dataset.use); });
    });
  }

  function levelCardHtml(node, i) {
    var d = node.depth[i] || { q: '', a: '', opts: [], extra: '' };
    var optsText = (d.opts || []).join('，');
    return '<div class="level-card" data-lv="' + i + '">' +
      '<div class="level-head">' +
      '<span class="level-badge">第 ' + (i + 1) + ' 层</span>' +
      '<span class="level-tools">' +
      '<button type="button" data-tool="up" aria-label="上移">↑</button>' +
      '<button type="button" data-tool="down" aria-label="下移">↓</button>' +
      '<button type="button" class="del" data-tool="del" aria-label="删除层级">✕</button>' +
      '</span></div>' +
      '<div class="field"><label>问题</label><input type="text" data-f="q" value="' + esc(d.q) + '" placeholder="这一层要问什么"></div>' +
      '<div class="field"><label>提示回答</label><textarea data-f="a" placeholder="一句话提示">' + esc(d.a || '') + '</textarea></div>' +
      '<div class="field"><label>可选方向（用逗号分隔）</label><input type="text" data-f="opts" value="' + esc(optsText) + '" placeholder="例如：是，不是，不确定"></div>' +
      '<div class="field"><label>深层提示（双指捏合展开）</label><textarea data-f="extra" placeholder="展开细节时显示的内容">' + esc(d.extra || '') + '</textarea></div>' +
      '</div>';
  }

  function renderInspector(node, handlers) {
    var el = document.getElementById('inspBody');
    if (!el) return;
    if (!node) {
      el.innerHTML = '<div class="insp-empty">在画布上点击一个节点<br>即可编辑它的问题与纵深链路</div>';
      return;
    }
    var typeOpts = Object.keys(AppCanvas.types).map(function (k) {
      return '<option value="' + k + '"' + (node.type === k ? ' selected' : '') + '>' + AppCanvas.types[k].name + '</option>';
    }).join('');
    var levels = node.depth.map(function (_, i) { return levelCardHtml(node, i); }).join('');
    el.innerHTML =
      '<div class="insp-section">' +
      '<div class="insp-section-title">基本信息</div>' +
      '<div class="field"><label for="nLabel">节点名称</label><input id="nLabel" type="text" value="' + esc(node.label) + '" maxlength="40"></div>' +
      '<div class="field"><label for="nType">节点类型</label><select id="nType">' + typeOpts + '</select></div>' +
      '<div class="insp-actions">' +
      '<button type="button" class="btn btn-ghost" data-act="dive">打开纵深</button>' +
      '<button type="button" class="btn btn-ghost" data-act="ask">追问建议</button>' +
      '<button type="button" class="btn btn-ghost btn-danger" data-act="delete">删除节点</button>' +
      '</div></div>' +
      '<div class="insp-section" id="depthEditorSection">' +
      '<div class="insp-section-title">纵深层级 <span class="count">' + node.depth.length + '</span></div>' +
      '<div id="levelList">' + levels + '</div>' +
      '<button type="button" class="btn btn-block btn-ghost" data-act="addLevel">＋ 添加层级</button>' +
      '</div>' +
      '<div class="insp-section">' +
      '<div class="insp-section-title">追问建议</div>' +
      '<button type="button" class="btn btn-block btn-ghost" data-act="suggest">生成追问建议</button>' +
      '<div class="suggest-list" id="suggestList"></div>' +
      '</div>';

    el.querySelector('#nLabel').addEventListener('input', function (e) {
      if (handlers.label) handlers.label(e.target.value);
    });
    el.querySelector('#nType').addEventListener('change', function (e) {
      if (handlers.type) handlers.type(e.target.value);
    });
    el.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-act]');
      if (b) {
        var act = b.dataset.act;
        if (act === 'dive' && handlers.dive) handlers.dive();
        else if (act === 'delete' && handlers.delete) handlers.delete();
        else if (act === 'ask' && handlers.ask) handlers.ask();
        else if (act === 'addLevel' && handlers.addLevel) handlers.addLevel();
        else if (act === 'suggest' && handlers.suggest) handlers.suggest();
        return;
      }
      var tool = e.target.closest('button[data-tool]');
      if (tool) {
        var card = tool.closest('.level-card');
        var i = parseInt(card.dataset.lv, 10);
        if (tool.dataset.tool === 'up' && handlers.moveLevel) handlers.moveLevel(i, -1);
        else if (tool.dataset.tool === 'down' && handlers.moveLevel) handlers.moveLevel(i, 1);
        else if (tool.dataset.tool === 'del' && handlers.removeLevel) handlers.removeLevel(i);
        return;
      }
      var sug = e.target.closest('[data-add-sug]');
      if (sug && handlers.addSuggestion) handlers.addSuggestion(sug.dataset.addSug);
    });
    el.querySelectorAll('.level-card').forEach(function (card) {
      var i = parseInt(card.dataset.lv, 10);
      card.querySelectorAll('[data-f]').forEach(function (input) {
        input.addEventListener('input', function () {
          var patch = {};
          if (input.dataset.f === 'opts') {
            patch.opts = input.value.split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean).slice(0, 6);
          } else {
            patch[input.dataset.f] = input.value;
          }
          if (handlers.level) handlers.level(i, patch);
        });
      });
    });
  }

  function suggestModal(suggestions, nodeTitle, onAdd, onCodex) {
    var root = document.getElementById('modalRoot');
    closeModal();
    var backdrop = document.createElement('div');
    backdrop.className = 'modal-backdrop';
    var box = document.createElement('div');
    box.className = 'modal';
    box.setAttribute('role', 'dialog');
    box.setAttribute('aria-modal', 'true');
    var items = (suggestions || []).map(function (s, i) {
      return '<button type="button" class="suggest-item" data-s="' + i + '"><span class="add">＋</span><span>' + esc(s) + '</span></button>';
    }).join('');
    var codex = onCodex
      ? '<button type="button" class="btn btn-primary btn-block" data-act="codex" style="margin-bottom:10px">✦ 交给 Codex 继续深挖</button>'
      : '';
    box.innerHTML = '<h3>追问建议</h3><p class="modal-desc">围绕「' + esc(nodeTitle) + '」继续深挖，选择一条加入纵深链路。</p>' +
      codex +
      '<div class="suggest-list">' + items + '</div>' +
      '<div class="modal-actions"><button type="button" class="btn btn-ghost" data-act="cancel">关闭</button></div>';
    backdrop.appendChild(box);
    root.appendChild(backdrop);
    backdrop.addEventListener('click', function (e) { if (e.target === backdrop) closeModal(); });
    box.addEventListener('click', function (e) {
      var b = e.target.closest('[data-s]');
      if (b) {
        var q = suggestions[parseInt(b.dataset.s, 10)];
        if (q && onAdd) onAdd(q);
        closeModal();
        return;
      }
      if (e.target.closest('[data-act="codex"]')) {
        closeModal();
        if (onCodex) onCodex();
        return;
      }
      if (e.target.closest('[data-act="cancel"]')) closeModal();
    });
  }

  function exportNetwork(net) {
    var payload = {
      app: 'qneural',
      version: 1,
      exportedAt: new Date().toISOString(),
      title: net.title,
      desc: net.desc,
      nodes: net.nodes,
      links: net.links,
      fusionSuggestions: net.fusionSuggestions || []
    };
    var blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = (net.title || '问题网络') + '.qneural.json';
    document.body.appendChild(a);
    a.click();
    setTimeout(function () {
      URL.revokeObjectURL(a.href);
      a.remove();
    }, 300);
  }

  function parseImport(text) {
    var data = JSON.parse(text);
    if (!Array.isArray(data.nodes) || !Array.isArray(data.links)) throw new Error('文件格式不正确');
    if (data.nodes.length > 500) throw new Error('节点数超过上限（500）');
    return { title: data.title || '', desc: data.desc || '', nodes: data.nodes, links: data.links, fusionSuggestions: data.fusionSuggestions || [] };
  }

  window.AppUI = {
    toast: toast,
    modal: modal,
    confirm: confirmDialog,
    closeModal: closeModal,
    suggestModal: suggestModal,
    exportNetwork: exportNetwork,
    parseImport: parseImport,
    fmtTime: fmtTime
  };
  window.AppEditor = {
    renderNetworks: renderNetworks,
    renderTemplates: renderTemplates,
    renderInspector: renderInspector
  };
})();
