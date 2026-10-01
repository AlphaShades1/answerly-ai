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
  //
  // Every entry must be something the browser SENDS to record what the student
  // did. Endpoints the browser READS to draw the page do not belong here: the
  // student's own activity stream was on this list, and since nothing reads a
  // reply we fake, the dashboard got an empty object where it expected an array
  // of notifications. Blocking a read hides nothing from the instructor — the
  // access report is built from page_views — and only breaks Canvas.
  // The quiz event feed. These carry a BATCH of mixed event types, so they are
  // filtered rather than dropped — see filterEventBody below.
  var EVENT_FEED = [
    /\/quizzes\/\d+\/submissions\/\d+\/events/,
    /\/quiz_submissions\/\d+\/events/,
    /quiz_submission_events/,
    // Events only. Bare /api/quiz_sessions also matched the session itself and
    // its /questions and /session_items — the calls New Quizzes makes to fetch
    // the quiz — so the quiz sat on "Loading…" forever instead of opening.
    /\/api\/quiz_sessions\/[^/]+\/events/,
    /\/quiz-lti.*\/events/,
    /\/api\/quiz\/v1\/.*\/events/,
    /\/quizzes\/.*\/events/,
    /\/quiz_api\/.*\/events/,
    /\/sessions\/\d+\/events/,
    /\/submission_events/,
  ];

  // Pure telemetry: nothing an instructor reads is built from these, so there
  // is no innocuous half to preserve and they stay dropped outright.
  var TELEMETRY = [
    /\/page_views/,
    /\/api\/v1\/audit/,
    /\/api\/v1\/.*\/analytics/,
    /\/live_events/,
    /\/api\/v1\/.*\/quiz_reports/,
    /\/api\/v1\/.*\/quiz_statistics/,
    /log_participation/,
    /\/log_event/,
    /\/api\/v1\/.*\/enrollments\/.*\/last_attended/,
  ];

  var BLOCKED = EVENT_FEED.concat(TELEMETRY);

  function blocked(url) {
    if (!window.__answerlyPGActive) return false;
    var s = String(url || '');
    return BLOCKED.some(function (r) { return r.test(s); });
  }

  function isEventFeed(url) {
    var s = String(url || '');
    return EVENT_FEED.some(function (r) { return r.test(s); });
  }

  // The event endpoints answer GET as well as POST, and the GET is how an
  // instructor's own log page loads. Dropping that reported nothing and only
  // blanked the teacher's screen — a log that read "there were no events logged
  // during the quiz-taking session" while the server held the events all along,
  // which is worse than useless because it looks like proof of something.
  // Reads cannot record what a student did, so on this feed they pass through.
  // Scoped to the feed on purpose: telemetry stays blocked whatever the method,
  // since a tracking pixel is a GET too.
  function isRead(method) {
    var m = String(method || 'GET').toUpperCase();
    return m === 'GET' || m === 'HEAD';
  }

  function blockedRequest(url, method) {
    return blocked(url) && !(isEventFeed(url) && isRead(method));
  }

  // ── Quiz event feed: filter the batch, don't discard it ──────────
  // The instructor's quiz log is assembled from two sources, and dropping the
  // whole feed only reaches one of them:
  //
  //   question_answered — synthesised SERVER-side from the answer autosave.
  //                       Unreachable from here; blocking the autosave would
  //                       stop answers saving at all.
  //   question_viewed   — exists ONLY because the browser posts it on this
  //                       feed. Drop the feed and it is gone for good.
  //
  // So discarding the feed deleted the views while the answers survived,
  // leaving a log that reads "answered 40, never looked at one" — a far louder
  // signal than the tab switches it was hiding. Filtering keeps the innocuous
  // events flowing and strips only the ones that record leaving the page.
  //
  // An ALLOWLIST, not a denylist: an event type we have never seen is stripped
  // rather than forwarded, so a type Canvas adds later cannot leak by default.
  // Verified against canvas-lms ui/shared/quiz-log-auditing/jquery/constants.js
  // — the client sends exactly five types, and question_answered is not one.
  var ALLOWED_EVENTS = {
    // Classic — verified against the Canvas source.
    question_viewed: 1,
    question_flagged: 1,
    session_started: 1,

    // New Quizzes — speculative, and measured since to be beside the point.
    // Native New Quizzes does not POST an event batch anywhere: it fetches
    // credentials from /api/quiz_sessions/:id/kinesis_credentials and streams
    // events straight to kinesis.us-east-1.amazonaws.com. Watched end to end
    // through a real attempt, nothing on this page's event feed was intercepted
    // at all, so every New Quizzes pattern below is effectively dead.
    //
    // Two consequences worth keeping written down. New Quizzes never had the
    // Classic defect, because its events were never being dropped — views were
    // always reaching the instructor. And the Kinesis stream must stay
    // untouched: blocking it would delete views along with everything else and
    // recreate on New Quizzes exactly the hole this change closed on Classic.
    // Tab switching there is already handled a layer up, by the listener
    // suppression further down this file — the app cannot report a blur it is
    // never told about, whatever transport it would have used.
    item_viewed: 1,
    item_flagged: 1,
    session_created: 1,

    // page_blurred / page_focused and their New Quizzes equivalents are the
    // whole point of the feature and are deliberately absent.
  };

  // New Quizzes is closed source, so its event names could not be read off a
  // repository the way Classic's were. Unknown names fail closed (stripped, so
  // the feed is dropped exactly as before this change), and setting
  // localStorage.answerlyPGDebug = '1' records the names actually seen in
  // window.__answerlyPGSeen so they can be confirmed against a real attempt.
  window.__answerlyPGSeen = window.__answerlyPGSeen || {};
  function noteEvent(type, kept) {
    try {
      window.__answerlyPGSeen[type] = kept ? 'forwarded' : 'stripped';
      if (localStorage.getItem('answerlyPGDebug') === '1') {
        console.log('[PG] event ' + type + ' -> ' + (kept ? 'forwarded' : 'stripped'));
      }
    } catch (e) { /* storage can throw in private windows */ }
  }

  // Returns a body string to forward, '' when nothing innocuous remains, or
  // null when the payload could not be understood. Both of the latter two mean
  // "drop the request", i.e. the behaviour that shipped before this change.
  function filterEventBody(raw) {
    if (typeof raw !== 'string' || !raw) return null;

    var payload;
    try { payload = JSON.parse(raw); } catch (e) { return null; }
    if (!payload || typeof payload !== 'object') return null;

    // Classic wraps the batch in quiz_submission_events. Accept a bare array or
    // some other wrapper key too, so New Quizzes can reuse this path once its
    // event names are confirmed.
    var key = null;
    var list = null;
    if (Array.isArray(payload)) {
      list = payload;
    } else {
      for (var k in payload) {
        if (Object.prototype.hasOwnProperty.call(payload, k) && Array.isArray(payload[k])) {
          key = k;
          list = payload[k];
          break;
        }
      }
    }
    if (!list) return null;

    var kept = [];
    for (var i = 0; i < list.length; i++) {
      var ev = list[i];
      if (!ev || typeof ev !== 'object') continue;
      var type = String(ev.event_type || ev.type || ev.name || '');
      var ok = Object.prototype.hasOwnProperty.call(ALLOWED_EVENTS, type);
      noteEvent(type, ok);
      if (ok) kept.push(ev);
    }

    if (!kept.length) return '';
    if (kept.length === list.length) return raw;
    if (key === null) return JSON.stringify(kept);

    var out = {};
    for (var k2 in payload) {
      if (Object.prototype.hasOwnProperty.call(payload, k2)) out[k2] = payload[k2];
    }
    out[key] = kept;
    return JSON.stringify(out);
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

  // A dropped request must look to the caller like one that SUCCEEDED and
  // returned nothing interesting. Anything else and the page breaks instead of
  // the log being quietly discarded.
  //
  // 204 is a "null body status": `new Response('{}', { status: 204 })` throws
  // TypeError "Response with null body status cannot have body". The throw is
  // synchronous, so callers got an exception where they expected a promise —
  // which is how a blocked telemetry call took the whole Canvas dashboard down
  // with "Failed loading course cards". 200 with a real body is constructible
  // and safe to `.json()`.
  function pgEmptyOk() {
    return new Response('{}', {
      status: 200,
      statusText: 'OK',
      headers: { 'Content-Type': 'application/json' },
    });
  }

  // ── Intercept fetch ──────────────────────────────────────────────
  var _fetch = window.fetch;

  // Re-sends an event-feed request carrying only the allowed events. A Request
  // object's body can only be read asynchronously, hence the promise.
  function pgFilteredFetch(input, init) {
    function forward(bodyText) {
      var filtered = filterEventBody(bodyText);
      if (typeof filtered !== 'string' || !filtered) return pgEmptyOk();
      if (input instanceof Request) {
        return _fetch.call(window, new Request(input, { body: filtered }));
      }
      var next = {};
      for (var k in (init || {})) {
        if (Object.prototype.hasOwnProperty.call(init, k)) next[k] = init[k];
      }
      next.body = filtered;
      return _fetch.call(window, input, next);
    }
    try {
      if (init && typeof init.body === 'string') return Promise.resolve(forward(init.body));
      if (input instanceof Request) {
        return input.clone().text().then(forward, function () { return pgEmptyOk(); });
      }
    } catch (e) { /* fall through to the plain drop */ }
    return Promise.resolve(pgEmptyOk());
  }

  window.fetch = function (input, init) {
    // This override sits in front of every request the page makes, so it must
    // never be the thing that throws. On any surprise, fall through to the real
    // fetch: failing open costs one unblocked log, failing closed breaks Canvas.
    try {
      var url = input instanceof Request ? input.url : String(input);
      var method = (input instanceof Request ? input.method : (init && init.method)) || 'GET';
      if (blockedRequest(url, method)) {
        if (isEventFeed(url)) return pgFilteredFetch(input, init);
        return Promise.resolve(pgEmptyOk());
      }
    } catch (e) { /* fall through */ }
    return _fetch.apply(this, arguments);
  };

  // ── Intercept XMLHttpRequest ─────────────────────────────────────
  var _xhrOpen = XMLHttpRequest.prototype.open;
  var _xhrSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function (method, url) {
    try {
      this._pgBlock = blockedRequest(url, method);
      this._pgFeed = this._pgBlock && isEventFeed(url);
    } catch (e) { this._pgBlock = false; this._pgFeed = false; }
    return _xhrOpen.apply(this, arguments);
  };

  // Returning silently leaves the request parked at readyState 1 forever, so
  // anything awaiting it waits for good — a spinner that never resolves. Hand
  // the caller an empty 200 on the next tick instead, the XHR-shaped equivalent
  // of what the fetch path returns.
  XMLHttpRequest.prototype.send = function (body) {
    // Classic Quizzes delivers its event batch through jQuery, so this is the
    // path that matters there. Forwarding the filtered batch also lets the real
    // response through, which is what makes Canvas drop the whole batch from
    // its localStorage queue — including the events stripped here. Faking a
    // response instead would be fine too, but a real one is one less lie.
    if (this._pgBlock && this._pgFeed) {
      var filtered = filterEventBody(body);
      if (typeof filtered === 'string' && filtered) return _xhrSend.call(this, filtered);
      // null (unreadable) or '' (nothing innocuous left) fall through and drop.
    }
    if (!this._pgBlock) return _xhrSend.apply(this, arguments);
    var xhr = this;
    setTimeout(function () {
      var body = '{}';
      try {
        Object.defineProperty(xhr, 'readyState',   { value: 4,    configurable: true });
        Object.defineProperty(xhr, 'status',       { value: 200,  configurable: true });
        Object.defineProperty(xhr, 'statusText',   { value: 'OK', configurable: true });
        Object.defineProperty(xhr, 'responseText', { value: body, configurable: true });
        Object.defineProperty(xhr, 'response', {
          value: xhr.responseType === 'json' ? {} : body, configurable: true,
        });
      } catch (e) { /* some engines lock these down — events still fire */ }
      ['readystatechange', 'load', 'loadend'].forEach(function (t) {
        try { xhr.dispatchEvent(new Event(t)); } catch (e) {}
      });
    }, 0);
  };

  // ── Intercept sendBeacon ─────────────────────────────────────────
  var _beacon = navigator.sendBeacon ? navigator.sendBeacon.bind(navigator) : null;
  if (_beacon) {
    navigator.sendBeacon = function (url, data) {
      if (blocked(url)) {
        if (isEventFeed(url) && typeof data === 'string') {
          var filtered = filterEventBody(data);
          if (typeof filtered === 'string' && filtered) return _beacon.call(navigator, url, filtered);
        }
        return true;
      }
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
