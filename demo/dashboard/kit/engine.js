/* ============================================================
   Sequence engine — data-driven, unified across explainers.
   A step is { caption, state }. `state` is written to the
   container's data-step attribute; CSS renders each state.
   Playback: auto-advance on a timer AND loops, with controls
   (play/pause, prev/next, clickable segments). Any manual control
   pauses autoplay. prefers-reduced-motion → static legend, no
   auto-advance, all frames resolved (handled by CSS media query;
   here we just skip anim mode and leave controls hidden).

   UNION NOTE: md's source-of-truth sub-tabs are PURE CSS (radio
   inputs + `:checked ~` selectors) — no JS is needed here. This
   engine runs each `[data-seq]` INDEPENDENTLY via forEach, so
   "N sequences per page" (md's 3 sub-tabbed sequences, sqlite's 1)
   is already handled by the structure. This file is the feature
   superset (segmented bar + fill-clock + typing caret + causal
   timing gates) applied per-`[data-seq]`.
   ============================================================ */
(function () {
  var reduce = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var INTERVAL = 2600;

  document.querySelectorAll('[data-seq]').forEach(function (seq) {
    // Steps derive from the legend (single source of truth for captions).
    var legendItems = seq.querySelectorAll('.seq-legend li');
    var steps = Array.prototype.map.call(legendItems, function (li, i) {
      return { caption: li.getAttribute('data-cap') || li.textContent.trim(), state: String(i + 1) };
    });
    if (!steps.length) return;

    var capEl = seq.querySelector('[data-cap]');
    var segsEl = seq.querySelector('[data-segs]');
    var countEl = seq.querySelector('[data-count]');
    var toggleBtn = seq.querySelector('[data-act="toggle"]');
    var icPlay = toggleBtn && toggleBtn.querySelector('.ic-play');
    var icPause = toggleBtn && toggleBtn.querySelector('.ic-pause');

    var idx = 0, timer = null, playing = false;
    // Single clock: the fill transition AND the advance timeout both read
    // `legRemaining` (INTERVAL fresh, the pinned remainder on resume) — so the
    // active segment's fill stays in lockstep with auto-advance, no 2nd timer.
    var legStart = 0, legRemaining = INTERVAL;

    // Build one segment per step (muted track + accent fill).
    var segs = [], fills = [];
    steps.forEach(function (s, i) {
      var seg = document.createElement('button');
      seg.type = 'button';
      seg.className = 'seq-seg';
      seg.setAttribute('data-i', i);
      seg.setAttribute('aria-label', 'Go to step ' + (i + 1));
      var fill = document.createElement('span');
      fill.className = 'seq-seg-fill';
      seg.appendChild(fill);
      segsEl.appendChild(seg);
      segs.push(seg); fills.push(fill);
    });

    function activeFill() { return fills[idx]; }
    // Prior segments = full, later = empty, active reset to empty (no transition).
    function paintStatic() {
      fills.forEach(function (f, i) { f.style.transition = 'none'; f.style.width = i < idx ? '100%' : '0%'; });
    }
    // Animate the active fill from its current width to 100% over `dur` ms.
    function fillTo100(dur) {
      var f = activeFill(); if (!f) return;
      var cur = getComputedStyle(f).width;   // resume point: 0 fresh, pinned px after pause
      f.style.transition = 'none'; f.style.width = cur;
      void f.offsetWidth;                     // commit the start, then transition
      f.style.transition = 'width ' + dur + 'ms linear'; f.style.width = '100%';
    }
    // Freeze the active fill at its current computed width (pause).
    function freezeFill() {
      var f = activeFill(); if (!f) return;
      var w = getComputedStyle(f).width;
      f.style.transition = 'none'; f.style.width = w;
    }

    function render() {
      seq.setAttribute('data-step', steps[idx].state);
      if (capEl) capEl.textContent = steps[idx].caption;
      if (countEl) countEl.textContent = (idx + 1) + ' / ' + steps.length;
      segs.forEach(function (d, i) {
        d.classList.toggle('is-on', i === idx);
        if (i === idx) d.setAttribute('aria-current', 'step'); else d.removeAttribute('aria-current');
      });
      if (toggleBtn) {
        toggleBtn.setAttribute('aria-pressed', String(playing));
        toggleBtn.setAttribute('aria-label', playing ? 'Pause' : 'Play');
        if (icPlay) icPlay.style.display = playing ? 'none' : '';
        if (icPause) icPause.style.display = playing ? '' : 'none';
      }
    }
    function clearTimer() { if (timer) { clearTimeout(timer); timer = null; } }
    // One leg = fill + advance, both driven by `legRemaining`.
    function runLeg() {
      clearTimer();
      fillTo100(legRemaining);
      legStart = Date.now();
      timer = setTimeout(function () { go(idx + 1); }, legRemaining);
    }
    function go(i) {
      idx = (i % steps.length + steps.length) % steps.length;
      legRemaining = INTERVAL;                 // fresh leg = full duration
      paintStatic();
      render();
      if (playing) runLeg();
    }
    function start() {                          // begin / resume from the pinned remainder
      if (playing) return;
      playing = true;
      render();
      runLeg();
    }
    function stop() {                           // pause: keep elapsed, pin the fill width
      if (playing && legStart) legRemaining = Math.max(0, legRemaining - (Date.now() - legStart));
      playing = false; legStart = 0;
      clearTimer();
      freezeFill();
      render();
    }
    function toggle() { playing ? stop() : start(); }

    seq.addEventListener('click', function (e) {
      var act = e.target.closest('[data-act]');
      if (act) {
        var a = act.getAttribute('data-act');
        if (a === 'toggle') toggle();
        else if (a === 'next') { stop(); go(idx + 1); }
        else if (a === 'prev') { stop(); go(idx - 1); }
        return;
      }
      var seg = e.target.closest('.seq-seg');   // clicking a segment jumps to that step
      if (seg) { stop(); go(parseInt(seg.getAttribute('data-i'), 10)); }
    });

    // Expose a tiny hook for deterministic screenshotting/testing.
    seq._seq = { go: function (i) { stop(); go(i); }, play: start, pause: stop,
                 get index() { return idx; }, get playing() { return playing; } };

    if (reduce) { seq.setAttribute('data-mode', 'static'); return; }
    seq.setAttribute('data-mode', 'anim');
    go(0);
    start();
  });
})();
