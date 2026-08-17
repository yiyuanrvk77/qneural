(function () {
  'use strict';
  var ctx = null;
  var enabled = false;
  var WAVE = { goal: 'sine', ask: 'triangle', think: 'triangle', act: 'sawtooth' };
  var DEG = { goal: 0, ask: 1, think: 2, act: 3 };
  // 大调五声音阶（C D E G A），不同节点类型落在不同音级上，保证怎么点都和谐
  var SCALE = [0, 2, 4, 7, 9];
  var C4 = 261.63;

  function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }

  function ensureCtx() {
    if (!ctx) {
      var AC = window.AudioContext || window.webkitAudioContext;
      if (AC) ctx = new AC();
    }
    if (ctx && ctx.state === 'suspended') {
      try { ctx.resume(); } catch (e) { /* ignore */ }
    }
    return ctx;
  }

  function freqFor(node) {
    var deg = DEG[node.type] !== undefined ? DEG[node.type] : 2;
    var oct = clamp(Math.round((600 - (Number(node.y) || 0)) / 280), 0, 2);
    return C4 * Math.pow(2, (oct * 12 + SCALE[deg]) / 12);
  }

  function play(node) {
    var c = ensureCtx();
    if (!c || !enabled) return;
    var t = c.currentTime;
    var osc = c.createOscillator();
    var gain = c.createGain();
    osc.type = WAVE[node.type] || 'sine';
    osc.frequency.setValueAtTime(freqFor(node), t);
    gain.gain.setValueAtTime(0.0001, t);
    gain.gain.exponentialRampToValueAtTime(0.12, t + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.0001, t + 0.6);
    osc.connect(gain);
    gain.connect(c.destination);
    osc.start(t);
    osc.stop(t + 0.65);
  }

  window.AudioSynesthesia = {
    init: function () {
      try { enabled = localStorage.getItem('qn_syn') === '1'; } catch (e) { /* ignore */ }
    },
    setEnabled: function (v) {
      enabled = !!v;
      try { localStorage.setItem('qn_syn', enabled ? '1' : '0'); } catch (e) { /* ignore */ }
    },
    isEnabled: function () { return enabled; },
    play: play
  };
})();
