(function () {
  'use strict';
  var els = {};
  var node = null, level = 0, offset = 0, detail = 1;
  var dpointers = new Map(), ddrag = null, dpinch = null;
  var optsSel = {};
  var cb = { onBack: null, onAsk: null, onEdit: null, onAssociate: null, onLevel: null };

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }

  function cardHtml(d, i) {
    var opts = (d.opts || []).map(function (o, j) {
      return '<button type="button" class="btn" data-opt="' + j + '" aria-pressed="' + (optsSel[i] === j ? 'true' : 'false') + '">' + esc(o) + '</button>';
    }).join('');
    var extra = d.extra ? '<div class="depth-deep text-small">深层提示：' + esc(d.extra) + '</div>' : '';
    var lv = i === 0 ? '起点问题' : '第 ' + i + ' 层 · 追问';
    return '<div class="text-small muted">' + lv + '</div>' +
      '<div class="dq">' + esc(d.q) + '</div>' +
      '<div class="da text-small">' + esc(d.a || '') + '</div>' +
      '<div class="depth-opts">' + opts + '</div>' + extra;
  }

  function layout() {
    if (!node) return;
    var L = node.depth.length;
    Array.prototype.forEach.call(els.stack.children, function (c, i) {
      var rel = i - level;
      var y = rel * 96 + offset;
      var sc = rel === 0 ? 1 + (detail - 1) * 0.55 : 0.86;
      c.style.transform = 'translate(-50%,calc(-50% + ' + y + 'px)) scale(' + sc + ')';
      c.style.opacity = rel === 0 ? 1 : 0.45;
      c.style.zIndex = 20 - Math.abs(rel);
      c.classList.toggle('curr', rel === 0);
    });
    els.rail.innerHTML = '';
    node.depth.forEach(function (d, i) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'depth-dot' + (i === level ? ' on' : '');
      b.dataset.i = i;
      b.setAttribute('aria-label', '第' + (i + 1) + '层：' + d.q);
      b.textContent = i + 1;
      b.addEventListener('click', function () { setLevel(i); });
      els.rail.appendChild(b);
    });
    els.title.textContent = node.label;
    els.count.textContent = '第 ' + (level + 1) + ' / ' + L + ' 层';
  }

  function render() {
    if (!node) return;
    els.stack.innerHTML = '';
    node.depth.forEach(function (d, i) {
      var c = document.createElement('div');
      c.className = 'depth-card';
      c.dataset.i = i;
      c.innerHTML = cardHtml(d, i);
      els.stack.appendChild(c);
    });
    layout();
  }

  function setLevel(i) {
    if (!node) return;
    level = clamp(i, 0, node.depth.length - 1);
    offset = 0;
    layout();
    if (cb.onLevel) cb.onLevel(level);
  }

  function open(n) {
    node = n;
    level = 0;
    offset = 0;
    detail = 1;
    optsSel = {};
    els.body.classList.remove('depth-exp', 'depth-drag');
    els.view.classList.remove('hidden');
    render();
  }

  function close() {
    els.view.classList.add('hidden');
    node = null;
  }

  function refresh() {
    if (node && !els.view.classList.contains('hidden')) render();
  }

  function isOpen() { return !els.view.classList.contains('hidden'); }
  function getNode() { return node; }
  function getLevel() { return level; }
  function changeLevel(delta) { if (node) setLevel(level + delta); }

  function toggleDetail() {
    if (!node) return;
    var exp = els.body.classList.toggle('depth-exp');
    detail = exp ? 1.35 : 1;
    layout();
  }

  function pointerDown(e) {
    if (e.target.closest('button')) return;
    e.preventDefault();
    if (els.body.setPointerCapture) { try { els.body.setPointerCapture(e.pointerId); } catch (err) { } }
    dpointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (dpointers.size === 2) {
      var ps = Array.from(dpointers.values());
      var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      dpinch = { d0: d, s0: detail };
      ddrag = null;
      return;
    }
    ddrag = { sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY, moved: 0, startOff: offset };
    els.body.classList.add('depth-drag');
  }

  function pointerMove(e) {
    if (!dpointers.has(e.pointerId)) return;
    dpointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (dpointers.size >= 2 && dpinch) {
      var ps = Array.from(dpointers.values());
      var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      detail = clamp(dpinch.s0 * d / dpinch.d0, 1, 1.7);
      els.body.classList.toggle('depth-exp', detail > 1.22);
      layout();
      return;
    }
    if (!ddrag) return;
    var dx = e.clientX - ddrag.lx, dy = e.clientY - ddrag.ly;
    ddrag.lx = e.clientX; ddrag.ly = e.clientY;
    ddrag.moved += Math.abs(dx) + Math.abs(dy);
    offset = clamp(ddrag.startOff + (e.clientY - ddrag.sy), -260, 260);
    layout();
  }

  function pointerUp(e) {
    dpointers.delete(e.pointerId);
    var wasPinch = !!dpinch;
    if (dpointers.size < 2) dpinch = null;
    if (wasPinch) {
      var exp = detail > 1.22;
      els.body.classList.toggle('depth-exp', exp);
      detail = exp ? 1.35 : 1;
    }
    var d = ddrag;
    ddrag = null;
    els.body.classList.remove('depth-drag');
    if (d && node) {
      if (d.moved < 6) {
        var card = e.target.closest('.depth-card');
        if (card) { setLevel(parseInt(card.dataset.i, 10)); return; }
      } else {
        var hx = e.clientX - d.sx;
        if (hx < -70 && Math.abs(e.clientY - d.sy) < 50) {
          if (cb.onAssociate) cb.onAssociate(level);
          return;
        }
        level = clamp(Math.round(level - offset / 96), 0, node.depth.length - 1);
        offset = 0;
        if (cb.onLevel) cb.onLevel(level);
      }
    }
    requestAnimationFrame(layout);
  }

  function init() {
    els.view = document.getElementById('depthView');
    els.body = document.getElementById('depthBody');
    els.stack = document.getElementById('depthStack');
    els.rail = document.getElementById('depthRail');
    els.title = document.getElementById('depthTitle');
    els.count = document.getElementById('depthCount');
    document.getElementById('depthBack').addEventListener('click', function () { if (cb.onBack) cb.onBack(); });
    document.getElementById('depthAsk').addEventListener('click', function () { if (cb.onAsk) cb.onAsk(level); });
    document.getElementById('depthEdit').addEventListener('click', function () { if (cb.onEdit) cb.onEdit(level); });
    els.body.addEventListener('click', function (e) {
      var b = e.target.closest('button[data-opt]');
      if (!b) return;
      var i = parseInt(b.closest('.depth-card').dataset.i, 10);
      Array.prototype.forEach.call(b.parentElement.querySelectorAll('[data-opt]'), function (x) { x.setAttribute('aria-pressed', 'false'); });
      b.setAttribute('aria-pressed', 'true');
      optsSel[i] = parseInt(b.dataset.opt, 10);
    });
    els.body.addEventListener('pointerdown', pointerDown);
    els.body.addEventListener('pointermove', pointerMove);
    els.body.addEventListener('pointerup', pointerUp);
    els.body.addEventListener('pointercancel', pointerUp);
  }

  window.AppDepth = {
    init: init,
    open: open,
    close: close,
    refresh: refresh,
    isOpen: isOpen,
    getNode: getNode,
    getLevel: getLevel,
    changeLevel: changeLevel,
    toggleDetail: toggleDetail,
    setCallbacks: function (c) {
      cb.onBack = c.onBack;
      cb.onAsk = c.onAsk;
      cb.onEdit = c.onEdit;
      cb.onAssociate = c.onAssociate;
      cb.onLevel = c.onLevel;
    }
  };
})();
