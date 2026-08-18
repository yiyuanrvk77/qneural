(function () {
  'use strict';
  var NS = 'http://www.w3.org/2000/svg';
  var TYPES = {
    goal: { name: '起点', cls: 'sh-goal', color: 'var(--series-1)' },
    ask: { name: '输入', cls: 'sh-ask', color: 'var(--series-2)' },
    think: { name: '思考', cls: 'sh-think', color: 'var(--series-3)' },
    act: { name: '行动', cls: 'sh-act', color: 'var(--series-4)' }
  };
  var S = {
    nodes: [], links: [], selected: null,
    tx: 0, ty: 0, s: 1, touched: false, locked: false,
    hovered: null, hoverPos: null, awake: false,
    onSelect: null, onDive: null, onChanged: null, onLink: null, onRename: null,
    onEdgeClick: null, onNodeTap: null, onNodeHover: null, onEmptyDouble: null,
    pointers: new Map(), drag: null, pinch: null, lastTap: null,
    editing: null, cancelEdit: false
  };
  var card, svg, world, edgeG, nodeG, linkPrev, editEl;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
  function esc(s) { return String(s).replace(/[&<>"']/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]; }); }
  function truncate(s, n) { s = String(s); return s.length > n ? s.slice(0, n - 1) + '…' : s; }
  function splitPos(s) {
    var m = Math.ceil(s.length / 2);
    var sp = s.indexOf(' ', m);
    var sp2 = s.lastIndexOf(' ', m);
    if (sp > -1 && (sp2 < 0 || sp - m <= m - sp2)) return sp;
    if (sp2 > -1) return sp2;
    return m;
  }
  function byId(id) {
    for (var i = 0; i < S.nodes.length; i++) if (S.nodes[i].id === id) return S.nodes[i];
    return null;
  }

  function shapeHtml(n) {
    var c = TYPES[n.type].cls;
    var halo = '<circle class="halo" r="28"></circle>';
    var s;
    if (n.type === 'goal') s = '<rect class="shape ' + c + '" x="-18" y="-18" width="36" height="36" rx="7" transform="rotate(45)"></rect>';
    else if (n.type === 'ask') s = '<circle class="shape ' + c + '" r="21"></circle>';
    else if (n.type === 'think') s = '<rect class="shape ' + c + '" x="-23" y="-17" width="46" height="34" rx="9"></rect>';
    else s = '<polygon class="shape ' + c + '" points="-15,-18 18,0 -15,18"></polygon>';
    return halo + s;
  }

  function labelHtml(label) {
    var s = esc(truncate(label, 16));
    if (s.length <= 8) return '<text class="nlabel" y="40" text-anchor="middle">' + s + '</text>';
    var mid = splitPos(s);
    return '<text class="nlabel" y="33" text-anchor="middle">' + s.slice(0, mid) + '</text><text class="nlabel" y="49" text-anchor="middle">' + s.slice(mid) + '</text>';
  }

  function edgePath(a, b, i) {
    // 横纵坐标轴式折线：先横向、再纵向、再横向；竖向为主的节点对则先纵向
    var x1 = a.x, y1 = a.y, x2 = b.x, y2 = b.y;
    var mx = (x1 + x2) / 2, my = (y1 + y2) / 2;
    if (Math.abs(x2 - x1) >= Math.abs(y2 - y1)) {
      return 'M ' + x1 + ' ' + y1 + ' H ' + mx + ' V ' + y2 + ' H ' + x2;
    }
    return 'M ' + x1 + ' ' + y1 + ' V ' + my + ' H ' + x2 + ' V ' + y2;
  }

  function updateEdges() {
    var idx = new Map();
    S.links.forEach(function (l, i) { idx.set(l.s + '>' + l.t, i); });
    Array.prototype.forEach.call(edgeG.children, function (p) {
      var key = p.getAttribute('data-key');
      if (!key) return;
      var a = byId(p.getAttribute('data-s')), b = byId(p.getAttribute('data-t'));
      var i = idx.has(key) ? idx.get(key) : S.links.length;
      if (a && b) p.setAttribute('d', edgePath(a, b, i));
    });
  }

  function updateLabels() {
    var fs = Math.max(10, 12 / S.s);
    Array.prototype.forEach.call(nodeG.querySelectorAll('.nlabel'), function (t) { t.setAttribute('font-size', fs); });
  }

  function applyT() {
    world.setAttribute('transform', 'translate(' + S.tx + ' ' + S.ty + ') scale(' + S.s + ')');
    updateLabels();
  }

  function render() {
    edgeG.innerHTML = '';
    S.links.forEach(function (l, i) {
      var a = byId(l.s), b = byId(l.t);
      if (!a || !b) return;
      var key = l.s + '>' + l.t;
      var hit = document.createElementNS(NS, 'path');
      hit.setAttribute('d', edgePath(a, b, i));
      hit.setAttribute('data-s', l.s);
      hit.setAttribute('data-t', l.t);
      hit.setAttribute('data-key', key);
      hit.setAttribute('class', 'edge-hit');
      edgeG.appendChild(hit);
      var p = document.createElementNS(NS, 'path');
      p.setAttribute('d', edgePath(a, b, i));
      p.setAttribute('data-s', l.s);
      p.setAttribute('data-t', l.t);
      p.setAttribute('data-key', key);
      p.setAttribute('class', 'edge' + (S.selected && (S.selected === l.s || S.selected === l.t) ? ' hot' : ''));
      edgeG.appendChild(p);
    });
    nodeG.innerHTML = '';
    S.nodes.forEach(function (n) {
      var g = document.createElementNS(NS, 'g');
      g.setAttribute('class', 'node' + (S.selected === n.id ? ' sel' : '') + (S.hovered === n.id ? ' hovered' : ''));
      g.setAttribute('data-id', n.id);
      g.setAttribute('transform', 'translate(' + n.x + ' ' + n.y + ')');
      g.innerHTML = shapeHtml(n) + labelHtml(n.label);
      if (S.selected === n.id) g.insertAdjacentHTML('beforeend', '<circle class="handle" cx="20" cy="-16" r="7"></circle>');
      nodeG.appendChild(g);
    });
    updateLabels();
    if (S.awake) buildParticles();
  }

  function buildParticles() {
    clearParticles();
    if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return;
    var g = document.createElementNS(NS, 'g');
    g.setAttribute('id', 'particles');
    S.links.forEach(function (l, i) {
      var a = byId(l.s), b = byId(l.t);
      if (!a || !b) return;
      var c = document.createElementNS(NS, 'circle');
      c.setAttribute('r', '2.4');
      c.setAttribute('fill', 'var(--primary)');
      var am = document.createElementNS(NS, 'animateMotion');
      am.setAttribute('dur', (2 + (i % 3)) + 's');
      am.setAttribute('repeatCount', 'indefinite');
      am.setAttribute('path', edgePath(a, b, i));
      c.appendChild(am);
      g.appendChild(c);
    });
    world.insertBefore(g, nodeG);
  }

  function clearParticles() {
    var g = world.querySelector('#particles');
    if (g) g.remove();
  }

  function hover(id, sx, sy) {
    if (!id) return;
    if (S.hovered === id) {
      S.hoverPos = { x: sx, y: sy };
      if (S.onNodeHover) S.onNodeHover(id, sx, sy);
      return;
    }
    clearHover();
    S.hovered = id;
    S.hoverPos = { x: sx, y: sy };
    var g = nodeG.querySelector('[data-id="' + id + '"]');
    if (g) g.classList.add('hovered');
    if (S.onNodeHover) S.onNodeHover(id, sx, sy);
  }

  function clearHover() {
    if (!S.hovered) return;
    var g = nodeG.querySelector('[data-id="' + S.hovered + '"]');
    if (g) g.classList.remove('hovered');
    S.hovered = null;
    S.hoverPos = null;
    if (S.onNodeHover) S.onNodeHover(null);
  }

  function showFusionHint(s, t) {
    clearFusionHint();
    var a = byId(s), b = byId(t);
    if (!a || !b) return;
    var key = a.id + '>' + b.id;
    var p = document.createElementNS(NS, 'path');
    p.setAttribute('class', 'ghost-edge');
    p.setAttribute('data-s', a.id);
    p.setAttribute('data-t', b.id);
    p.setAttribute('data-key', key);
    p.setAttribute('d', edgePath(a, b, S.links.length));
    edgeG.appendChild(p);
  }

  function clearFusionHint() {
    var g = edgeG.querySelector('.ghost-edge');
    if (g) g.remove();
  }

  function nodeAtScreen(x, y) {
    var best = null, bd = 70;
    S.nodes.forEach(function (n) {
      var sx = n.x * S.s + S.tx, sy = n.y * S.s + S.ty;
      var d = Math.hypot(x - sx, y - sy);
      if (d < bd) { bd = d; best = n.id; }
    });
    return best;
  }

  function fit() {
    var w = card.clientWidth || 800, h = card.clientHeight || 540;
    if (S.nodes.length === 0) {
      S.s = 1; S.tx = w / 2; S.ty = h / 2;
      applyT();
      return;
    }
    var minX = 1e9, minY = 1e9, maxX = -1e9, maxY = -1e9;
    S.nodes.forEach(function (n) {
      minX = Math.min(minX, n.x); maxX = Math.max(maxX, n.x);
      minY = Math.min(minY, n.y); maxY = Math.max(maxY, n.y);
    });
    var bw = Math.max(maxX - minX, 220) + 220, bh = Math.max(maxY - minY, 220) + 220;
    S.s = clamp(Math.min(w / bw, h / bh), 0.25, 1.3);
    S.tx = w / 2 - (minX + maxX) / 2 * S.s;
    S.ty = h / 2 - (minY + maxY) / 2 * S.s;
    applyT();
  }

  function zoomAt(mx, my, f) {
    var ns = clamp(S.s * f, 0.25, 2.5), k = ns / S.s;
    S.tx = mx - (mx - S.tx) * k;
    S.ty = my - (my - S.ty) * k;
    S.s = ns;
    S.touched = true;
    applyT();
  }

  function startRename(id) {
    var n = byId(id);
    if (!n) return;
    var r = card.getBoundingClientRect();
    var sx = n.x * S.s + S.tx, sy = n.y * S.s + S.ty;
    editEl.classList.remove('hidden');
    editEl.style.left = clamp(sx - 105, 8, Math.max(8, card.clientWidth - 218)) + 'px';
    editEl.style.top = clamp(sy - 22, 8, card.clientHeight - 44) + 'px';
    editEl.value = n.label;
    editEl.focus();
    editEl.select();
    S.editing = id;
  }

  function commitRename() {
    if (!S.editing) return;
    var id = S.editing;
    S.editing = null;
    var n = byId(id);
    if (n) {
      var v = editEl.value.trim();
      if (v && !S.cancelEdit) {
        n.label = v.slice(0, 40);
        if (S.onRename) S.onRename(id, n.label);
      }
    }
    S.cancelEdit = false;
    editEl.classList.add('hidden');
    render();
  }

  function pointerDown(e) {
    if (S.locked) return;
    if (e.target.closest('button,input,textarea')) return;
    if (e.target.closest('#toast')) return;
    e.preventDefault();
    var edgeEl = e.target.closest('.edge-hit');
    if (edgeEl) {
      if (S.onEdgeClick) S.onEdgeClick(edgeEl.getAttribute('data-s'), edgeEl.getAttribute('data-t'));
      return;
    }
    if (card.setPointerCapture) { try { card.setPointerCapture(e.pointerId); } catch (err) { } }
    S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (S.pointers.size === 2) {
      var ps = Array.from(S.pointers.values());
      var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      S.pinch = { d0: d, s0: S.s, m: { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 } };
      S.drag = null;
      var dg = nodeG.querySelector('.drag');
      if (dg) dg.classList.remove('drag');
      S.touched = true;
      return;
    }
    var nodeEl = e.target.closest('.node');
    var handleEl = e.target.closest('.handle');
    if (handleEl && nodeEl) {
      S.drag = { type: 'link', from: nodeEl.dataset.id, moved: 0, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
      return;
    }
    if (nodeEl) {
      S.drag = { type: 'node', id: nodeEl.dataset.id, moved: 0, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
      nodeEl.classList.add('drag');
    } else {
      S.drag = { type: 'pan', moved: 0, sx: e.clientX, sy: e.clientY, lx: e.clientX, ly: e.clientY };
    }
  }

  function pointerMove(e) {
    if (S.locked) return;
    if (!S.pointers.has(e.pointerId)) return;
    S.pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (S.pointers.size >= 2 && S.pinch) {
      var ps = Array.from(S.pointers.values());
      var d = Math.hypot(ps[0].x - ps[1].x, ps[0].y - ps[1].y);
      var m = { x: (ps[0].x + ps[1].x) / 2, y: (ps[0].y + ps[1].y) / 2 };
      var r = card.getBoundingClientRect();
      var mx = m.x - r.left, my = m.y - r.top;
      var ns = clamp(S.pinch.s0 * d / S.pinch.d0, 0.25, 2.5), k = ns / S.s;
      S.tx += m.x - S.pinch.m.x;
      S.ty += m.y - S.pinch.m.y;
      S.tx = mx - (mx - S.tx) * k;
      S.ty = my - (my - S.ty) * k;
      S.s = ns;
      S.pinch.m = m;
      S.touched = true;
      applyT();
      return;
    }
    if (!S.drag) return;
    var dx = e.clientX - S.drag.lx, dy = e.clientY - S.drag.ly;
    S.drag.lx = e.clientX; S.drag.ly = e.clientY;
    S.drag.moved += Math.abs(dx) + Math.abs(dy);
    if (S.drag.type === 'pan') {
      S.tx += dx; S.ty += dy;
      S.touched = true;
      applyT();
    } else if (S.drag.type === 'node') {
      var n = byId(S.drag.id);
      if (!n) return;
      n.x += dx / S.s; n.y += dy / S.s;
      var g = nodeG.querySelector('[data-id="' + S.drag.id + '"]');
      if (g) g.setAttribute('transform', 'translate(' + n.x + ' ' + n.y + ')');
      updateEdges();
      S.touched = true;
    } else if (S.drag.type === 'link') {
      var r = card.getBoundingClientRect();
      var from = byId(S.drag.from);
      if (!from) return;
      var wx = (e.clientX - r.left - S.tx) / S.s, wy = (e.clientY - r.top - S.ty) / S.s;
      linkPrev.setAttribute('d', 'M ' + from.x + ' ' + from.y + ' L ' + wx + ' ' + wy);
      S.touched = true;
    }
  }

  function pointerUp(e) {
    if (S.locked) return;
    S.pointers.delete(e.pointerId);
    if (S.pointers.size < 2) S.pinch = null;
    if (!S.drag) return;
    var d = S.drag;
    S.drag = null;
    if (d.type === 'pan') {
      if (d.moved < 6) {
        select(null);
      }
    } else if (d.type === 'node') {
      var g = nodeG.querySelector('[data-id="' + d.id + '"]');
      if (g) g.classList.remove('drag');
      if (d.moved < 6) {
        var now = performance.now();
        var p = { x: e.clientX, y: e.clientY };
        if (S.lastTap && S.lastTap.id === d.id && now - S.lastTap.t < 340 && Math.hypot(p.x - S.lastTap.x, p.y - S.lastTap.y) < 48) {
          S.lastTap = null;
          if (S.onDive) S.onDive(d.id);
          return;
        }
        S.lastTap = { id: d.id, t: now, x: p.x, y: p.y };
        select(d.id);
        if (S.onNodeTap) S.onNodeTap(d.id);
      } else if (S.onChanged) {
        S.onChanged();
      }
    } else if (d.type === 'link') {
      linkPrev.setAttribute('d', '');
      if (d.moved < 6) { select(d.from); return; }
      var el = document.elementFromPoint(e.clientX, e.clientY);
      var tg = el && el.closest('.node');
      if (tg && tg.dataset.id && tg.dataset.id !== d.from) {
        if (S.onLink) S.onLink(d.from, tg.dataset.id);
      }
    }
  }

  function select(id) {
    S.selected = id;
    render();
    if (S.onSelect) S.onSelect(id);
  }

  function init() {
    card = document.getElementById('canvasCard');
    svg = document.getElementById('netSvg');
    world = document.getElementById('world');
    edgeG = document.getElementById('edges');
    nodeG = document.getElementById('nodes');
    linkPrev = document.getElementById('linkPrev');
    editEl = document.getElementById('inlineEdit');
    card.addEventListener('pointerdown', pointerDown);
    card.addEventListener('pointermove', pointerMove);
    card.addEventListener('pointerup', pointerUp);
    card.addEventListener('pointercancel', pointerUp);
    card.addEventListener('dblclick', function (e) {
      if (S.locked) return;
      if (e.target.closest('.node') || e.target.closest('.edge-hit') || e.target.closest('.handle')) return;
      if (e.target.closest('#seedState') || e.target.closest('#emptyState')) return;
      if (S.onEmptyDouble) S.onEmptyDouble();
    });
    card.addEventListener('wheel', function (e) {
      if (S.locked) return;
      e.preventDefault();
      var r = card.getBoundingClientRect();
      zoomAt(e.clientX - r.left, e.clientY - r.top, Math.exp(-e.deltaY * 0.0016));
    }, { passive: false });
    editEl.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') commitRename();
      else if (e.key === 'Escape') { S.cancelEdit = true; commitRename(); }
    });
    editEl.addEventListener('blur', commitRename);
    nodeG.addEventListener('mouseover', function (e) {
      var g = e.target.closest('.node');
      if (g && g.dataset.id) hover(g.dataset.id, e.clientX, e.clientY);
    });
    nodeG.addEventListener('mouseout', function (e) {
      var g = e.target.closest('.node');
      if (g && g.dataset.id && S.hovered === g.dataset.id) clearHover();
    });
    if (typeof ResizeObserver !== 'undefined') {
      new ResizeObserver(function () {
        if (!S.touched) fit();
      }).observe(card);
    }
  }

  window.AppCanvas = {
    init: init,
    types: TYPES,
    update: function (nodes, links, selectedId) {
      S.nodes = nodes;
      S.links = links;
      S.selected = selectedId || null;
      render();
    },
    select: select,
    getSelected: function () { return S.selected; },
    getNode: byId,
    fit: fit,
    setLocked: function (v) { S.locked = v; },
    hover: hover,
    clearHover: clearHover,
    showFusionHint: showFusionHint,
    clearFusionHint: clearFusionHint,
    setAwake: function (on) {
      S.awake = !!on;
      card.classList.toggle('awake', S.awake);
      if (S.awake) buildParticles();
      else clearParticles();
    },
    nodeAtScreen: nodeAtScreen,
    getNodes: function () { return S.nodes; },
    startRename: startRename,
    addNode: function (label, type) {
      var w = card.clientWidth || 800, h = card.clientHeight || 540;
      var x = (w / 2 - S.tx) / S.s + (Math.random() * 80 - 40);
      var y = (h / 2 - S.ty) / S.s + (Math.random() * 60 - 30);
      return { id: 'n' + Date.now() + Math.floor(Math.random() * 999), label: label || '新问题', type: type || 'think', x: Math.round(x), y: Math.round(y), depth: [{ q: '这个问题具体指什么？', a: '先缩小边界，再给出一个例子。', opts: ['定义', '边界', '例子'], extra: '' }] };
    },
    setCallbacks: function (cb) {
      S.onSelect = cb.onSelect;
      S.onDive = cb.onDive;
      S.onChanged = cb.onChanged;
      S.onLink = cb.onLink;
      S.onRename = cb.onRename;
      S.onEdgeClick = cb.onEdgeClick;
      S.onNodeTap = cb.onNodeTap;
      S.onNodeHover = cb.onNodeHover;
      S.onEmptyDouble = cb.onEmptyDouble;
    }
  };
})();
