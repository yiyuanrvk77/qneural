(function () {
  'use strict';
  var CDN = 'https://cdn.jsdelivr.net/npm/@mediapipe/';
  var cb = {};
  var state = {
    active: false,
    ready: false,
    pinchOn: false,
    lastPinch: 0,
    lastY: null,
    lastT: 0,
    swipeCd: 0
  };
  var hands = null, cam = null;
  var video = null, cursor = null, card = null;

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var s = document.createElement('script');
      s.src = src;
      s.onload = resolve;
      s.onerror = function () { reject(new Error('load failed')); };
      document.head.appendChild(s);
    });
  }

  async function ensureLib() {
    if (window.Hands && window.Camera) return;
    await Promise.all([
      loadScript(CDN + 'camera_utils/camera_utils.js'),
      loadScript(CDN + 'hands/hands.js')
    ]);
  }

  function initLib() {
    hands = new window.Hands({
      locateFile: function (file) { return CDN + 'hands/' + file; }
    });
    hands.setOptions({
      maxNumHands: 1,
      modelComplexity: 1,
      minDetectionConfidence: 0.6,
      minTrackingConfidence: 0.6
    });
    hands.onResults(onResults);
  }

  function dist(a, b) {
    return Math.hypot(a.x - b.x, a.y - b.y);
  }

  function hideCursor() {
    if (cursor) cursor.classList.add('hidden');
  }

  function showCursor(x, y) {
    cursor.classList.remove('hidden');
    cursor.style.left = x + 'px';
    cursor.style.top = y + 'px';
  }

  function onResults(results) {
    if (!state.active) return;
    var lm = results.multiHandLandmarks && results.multiHandLandmarks[0];
    if (!lm) {
      state.hand = null;
      hideCursor();
      if (cb.onWake) cb.onWake(false);
      if (cb.onHover) cb.onHover(null);
      return;
    }
    if (cb.onWake) cb.onWake(true);
    var r = card.getBoundingClientRect();
    var lx = (1 - lm[8].x) * r.width;
    var ly = lm[8].y * r.height;
    var idx = lm[8], mid = lm[12], wrist = lm[0], thumb = lm[4];
    var dIdxW = dist(idx, wrist), dMidW = dist(mid, wrist);
    var pointing = dIdxW > dMidW * 1.12 && idx.y < mid.y;

    if (pointing) {
      showCursor(lx, ly);
      var mode = cb.mode ? cb.mode() : 'net';
      var target = mode === 'net' ? AppCanvas.nodeAtScreen(lx, ly) : null;
      if (cb.onHover) cb.onHover(target);
    } else {
      hideCursor();
      if (cb.onHover) cb.onHover(null);
    }

    var pinchDist = dist(thumb, idx);
    var pinching = pinchDist < 0.055;
    var now = performance.now();
    if (pinching && !state.pinchOn && now - state.lastPinch > 450) {
      state.pinchOn = true;
      state.lastPinch = now;
      var mode2 = cb.mode ? cb.mode() : 'net';
      var target2 = mode2 === 'net' ? AppCanvas.nodeAtScreen(lx, ly) : null;
      if (cb.onPinch) cb.onPinch(target2);
    }
    if (!pinching) state.pinchOn = false;

    var mode3 = cb.mode ? cb.mode() : 'net';
    if (mode3 === 'depth' && pointing) {
      if (state.lastT && now - state.lastT > 90 && now > state.swipeCd) {
        var dy = lm[8].y - state.lastY;
        if (Math.abs(dy) > 0.07) {
          state.swipeCd = now + 550;
          if (cb.onLevelSwipe) cb.onLevelSwipe(dy < 0 ? 1 : -1);
        }
      }
      state.lastY = lm[8].y;
      state.lastT = now;
    } else {
      state.lastY = null;
      state.lastT = 0;
    }
  }

  async function start() {
    if (state.active) return;
    state.active = true;
    if (!state.ready) {
      try {
        await ensureLib();
        initLib();
        state.ready = true;
      } catch (e) {
        state.active = false;
        if (cb.onError) cb.onError('手势库加载失败，请检查网络后重试');
        return;
      }
    }
    video.classList.remove('hidden');
    try {
      var stream = await navigator.mediaDevices.getUserMedia({ video: { width: 480, height: 360 } });
    } catch (e) {
      state.active = false;
      video.classList.add('hidden');
      hideCursor();
      if (cb.onError) cb.onError('无法访问摄像头，已切换回触控模式');
      return;
    }
    cam = new window.Camera(video, {
      onFrame: async function () {
        if (hands) await hands.send({ image: video });
      },
      width: 480,
      height: 360
    });
    cam.start();
  }

  function stop() {
    state.active = false;
    if (cam) { try { cam.stop(); } catch (e) { } }
    if (video) video.classList.add('hidden');
    hideCursor();
    if (cb.onWake) cb.onWake(false);
    if (cb.onHover) cb.onHover(null);
  }

  function init(opts) {
    cb = opts || {};
    video = document.getElementById('gestureVideo');
    cursor = document.getElementById('gestureCursor');
    card = document.getElementById('canvasCard');
  }

  window.GestureMode = {
    init: init,
    start: start,
    stop: stop,
    isActive: function () { return state.active; }
  };
})();
