// Privacy Guard — injected into the page's MAIN world to fully block Canvas LMS
// logging, tab-switch detection, quiz event auditing, and fingerprinting.
(function () {
  if (window.__answerlyPGInstalled) {
    window.__answerlyPGActive = true;
    return;
  }
  window.__answerlyPGInstalled = true;
  window.__answerlyPGActive = true;

  // ── Blocked URL patterns ─────────────────────────────────────────
  // Covers every known Canvas LMS logging / tracking / auditing endpoint.
  var BLOCKED = [
    /\/quizzes\/\d+\/submissions\/\d+\/events/,
    /\/quiz_submissions\/\d+\/events/,
    /quiz_submission_events/,
    /\/page_views/,
    /\/api\/v1\/audit/,
    /\/api\/v1\/.*\/analytics/,
    /\/live_events/,
    /\/api\/v1\/courses\/\d+\/activity_stream/,
    /\/api\/v1\/users\/.*\/activity/,
    /\/api\/v1\/.*\/quiz_reports/,
    /\/api\/v1\/.*\/quiz_statistics/,
    /log_participation/,
    /\/api\/quiz_sessions/,
    /\/quiz-lti.*\/events/,
    /\/log_event/,
    /\/api\/v1\/.*\/enrollments\/.*\/last_attended/,
    /\/api\/quiz\/v1\/.*\/events/,
    /\/api\/quiz\/v1\/.*\/sessions/,
    /\/quizzes\/.*\/events/,
    /\/quiz_api\/.*\/events/,
    /\/sessions\/\d+\/events/,
    /\/submission_events/,
  ];

  function blocked(url) {
    if (!window.__answerlyPGActive) return false;
    var s = String(url || '');
    return BLOCKED.some(function (r) { return r.test(s); });
  }

  // ── Wrap addEventListener on window/document ─────────────────────
  // Intercepts listener registration so blur/focus/visibilitychange
  // handlers added by page scripts are silenced when PG is active.
  var _addEvt = EventTarget.prototype.addEventListener;
  EventTarget.prototype.addEventListener = function (type, listener, opts) {
    if ((type === 'blur' || type === 'focus' || type === 'visibilitychange') &&
        (this === window || this === document) && typeof listener === 'function') {
      var orig = listener;
      var wrapped = function (e) {
        if (window.__answerlyPGActive) return;
        return orig.apply(this, arguments);
      };
      return _addEvt.call(this, type, wrapped, opts);
    }
    return _addEvt.call(this, type, listener, opts);
  };

  // ── Intercept fetch ──────────────────────────────────────────────
  var _fetch = window.fetch;
  window.fetch = function (input) {
    var url = input instanceof Request ? input.url : String(input);
    if (blocked(url)) return Promise.resolve(new Response('{}', { status: 204 }));
    return _fetch.apply(this, arguments);
  };

  // ── Intercept XMLHttpRequest ─────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    this._pgBlock = blocked(url);
    return _xhrOpen.apply(this, arguments);
  };

  XMLHttpRequest.prototype.send = function () {
    if (this._pgBlock) return;
    return _xhrSend.apply(this, arguments);
  };

  // ── Intercept sendBeacon ─────────────────────────────────────────
  var _beacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  if (_beacon) {
    navigator.sendBeacon = function (url) {
      if (blocked(url)) return true;
      return _beacon.apply(navigator, arguments);
    };
  }

  // ── Intercept tracking-pixel images (new Image().src = '/log_...') ──
  var imgSrcDesc = Object.getOwnPropertyDescriptor(HTMLImageElement.prototype, 'src');
  if (imgSrcDesc && imgSrcDesc.set) {
    Object.defineProperty(HTMLImageElement.prototype, 'src', {
      get: imgSrcDesc.get,
      set: function (val) {
        if (blocked(val)) return;
        return imgSrcDesc.set.call(this, val);
      },
      configurable: true,
    });
  }

  // ── Spoof Visibility API ─────────────────────────────────────────
  var hDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'hidden');
  var vDesc = Object.getOwnPropertyDescriptor(Document.prototype, 'visibilityState');

  if (hDesc && hDesc.get) {
    Object.defineProperty(document, 'hidden', {
      get: function () { return window.__answerlyPGActive ? false : hDesc.get.call(document); },
      configurable: true,
    });
  }
  if (vDesc && vDesc.get) {
    Object.defineProperty(document, 'visibilityState', {
      get: function () { return window.__answerlyPGActive ? 'visible' : vDesc.get.call(document); },
      configurable: true,
    });
  }

  // Always report page as focused
  var _hasFocus = Document.prototype.hasFocus;
  Document.prototype.hasFocus = function () {
    return window.__answerlyPGActive ? true : _hasFocus.call(this);
  };

  // ── Suppress visibility / focus / blur events ────────────────────
  // Capture phase fires before any page listener, so stopImmediatePropagation
  // prevents Canvas from ever seeing these events.
  document.addEventListener('visibilitychange', function (e) {
    if (window.__answerlyPGActive) e.stopImmediatePropagation();
  }, true);

  window.addEventListener('blur', function (e) {
    if (window.__answerlyPGActive && e.target === window) e.stopImmediatePropagation();
  }, true);

  window.addEventListener('focus', function (e) {
    if (window.__answerlyPGActive && e.target === window) e.stopImmediatePropagation();
  }, true);

  // Also intercept on document (some Canvas builds listen there instead of window)
  document.addEventListener('blur', function (e) {
    if (window.__answerlyPGActive && (e.target === document || e.target === window)) e.stopImmediatePropagation();
  }, true);

  document.addEventListener('focus', function (e) {
    if (window.__answerlyPGActive && (e.target === document || e.target === window)) e.stopImmediatePropagation();
  }, true);

  // ── Block property-based event handlers ──────────────────────────
  // Canvas can assign document.onvisibilitychange = fn or window.onblur = fn.
  Object.defineProperty(document, 'onvisibilitychange', {
    get: function () { return null; },
    set: function () { /* silently discard */ },
    configurable: true,
  });
  // Block onblur / onfocus on both window and document
  ['onblur', 'onfocus'].forEach(function (prop) {
    [window, document].forEach(function (target) {
      var _stored = null;
      Object.defineProperty(target, prop, {
        get: function () { return window.__answerlyPGActive ? null : _stored; },
        set: function (fn) { _stored = fn; },
        configurable: true,
      });
    });
  });

  // ── Freeze page-leave / beforeunload detection ───────────────────
  // Canvas may use these to fire a final log event when leaving a quiz.
  window.addEventListener('beforeunload', function (e) {
    if (window.__answerlyPGActive) e.stopImmediatePropagation();
  }, true);

  window.addEventListener('pagehide', function (e) {
    if (window.__answerlyPGActive) e.stopImmediatePropagation();
  }, true);

  // ── Prevent copy/paste/right-click detection ─────────────────────
  var inputEvents = ['copy', 'cut', 'paste', 'contextmenu'];
  inputEvents.forEach(function (evtName) {
    document.addEventListener(evtName, function (e) {
      if (!window.__answerlyPGActive) return;
      e.stopImmediatePropagation();
    }, true);
  });

  // ── Neuter Fullscreen-change detection ───────────────────────────
  document.addEventListener('fullscreenchange', function (e) {
    if (window.__answerlyPGActive) e.stopImmediatePropagation();
  }, true);
  document.addEventListener('webkitfullscreenchange', function (e) {
    if (window.__answerlyPGActive) e.stopImmediatePropagation();
  }, true);

  // ── Spoof mouseleave / mouseenter on document ────────────────────
  document.addEventListener('mouseleave', function (e) {
    if (window.__answerlyPGActive && (e.target === document || e.target === document.documentElement || e.target === document.body)) {
      e.stopImmediatePropagation();
    }
  }, true);

  // ── Block resize event logging ───────────────────────────────────
  window.addEventListener('resize', function (e) {
    if (window.__answerlyPGActive) e.stopImmediatePropagation();
  }, true);

  // ── Block devtools detection via outer/inner dimension trick ─────
  var owDesc = Object.getOwnPropertyDescriptor(window, 'outerWidth') ||
               Object.getOwnPropertyDescriptor(Window.prototype, 'outerWidth');
  var ohDesc = Object.getOwnPropertyDescriptor(window, 'outerHeight') ||
               Object.getOwnPropertyDescriptor(Window.prototype, 'outerHeight');

  if (owDesc) {
    Object.defineProperty(window, 'outerWidth', {
      get: function () {
        if (window.__answerlyPGActive) return window.innerWidth;
        return owDesc.get ? owDesc.get.call(window) : owDesc.value;
      },
      configurable: true,
    });
  }
  if (ohDesc) {
    Object.defineProperty(window, 'outerHeight', {
      get: function () {
        if (window.__answerlyPGActive) return window.innerHeight;
        return ohDesc.get ? ohDesc.get.call(window) : ohDesc.value;
      },
      configurable: true,
    });
  }

  // ── Block WebSocket connections to logging endpoints ──────────────
  var _WebSocket = window.WebSocket;
  window.WebSocket = function (url, protocols) {
    if (window.__answerlyPGActive && blocked(url)) {
      var dummy = { readyState: 3, send: function(){}, close: function(){},
                    addEventListener: function(){}, removeEventListener: function(){},
                    onopen: null, onclose: null, onmessage: null, onerror: null };
      return dummy;
    }
    return protocols !== undefined ? new _WebSocket(url, protocols) : new _WebSocket(url);
  };
  window.WebSocket.prototype = _WebSocket.prototype;
  window.WebSocket.CONNECTING = _WebSocket.CONNECTING;
  window.WebSocket.OPEN = _WebSocket.OPEN;
  window.WebSocket.CLOSING = _WebSocket.CLOSING;
  window.WebSocket.CLOSED = _WebSocket.CLOSED;
})();
