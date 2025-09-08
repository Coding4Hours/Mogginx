(function () {
  try {
    // processed flag added by Nginx sub_filter (ex: womginx-processed)
    var processedAttr =
      (document.currentScript && document.currentScript.getAttribute("processed-attribute")) ||
      "womginx-processed";

    // Parse /main(/mod_)?/<targeturl>
    var path = window.location.pathname;
    var mainMatch = path.match(/^\/main(\/[^/_]+_)?\/(.*)$/);
    if (!mainMatch) return; // Not on proxied HTML route

    var mod = mainMatch[1] || "";
    var dest_fullurl = mainMatch[2];

    // If target has malformed scheme (https:/, ws:/), fix in address bar without reload
    if (/^(?:http|ws)s?:\/[^/]/i.test(dest_fullurl)) {
      var fixedDest = dest_fullurl.replace(/^((?:http|ws)s?):\/([^/])/, "$1://$2");
      if (fixedDest !== dest_fullurl) {
        var newPath = "/main" + mod + "/" + fixedDest + window.location.hash;
        window.history.pushState(null, "", newPath);
        dest_fullurl = fixedDest;
      }
    }

    var proxy_prefix = window.location.origin;
    var proxy_path = "/main" + mod + "/";

    var dest_scheme = "";
    var dest_host = "";
    var mScheme = dest_fullurl.match(/^[^:]+/);
    if (mScheme) dest_scheme = mScheme[0];
    var mHost = dest_fullurl.match(/^[^:]*:\/\/([^/]+)/);
    if (mHost) dest_host = mHost[1];

    // Only normalize protocol slashes (https:/ -> https://), do not collapse other '//' (e.g. protocol-relative)
    function normalizeProxyUrl(u) {
      if (!u) return u;
      var s;
      try {
        s = u.toString();
      } catch (_) {
        return u;
      }
      if (/^(?:blob:|data:|javascript:)/i.test(s)) return u;

      // fix http:/, https:/, ws:/, wss:/
      s = s.replace(/^((?:https?|wss?):)\/(?!\/)/i, "$1//");
      s = s.replace(/^((?:http|ws):)\/(?!\/)/i, "$1//"); // also cover http:/ and ws:/
      return s;
    }

    // Wombat init info
    var wbinfo = {};
    wbinfo.url = dest_fullurl;
    wbinfo.timestamp = "";
    wbinfo.request_ts = "";
    wbinfo.prefix = proxy_prefix + proxy_path;
    wbinfo.mod = "";
    wbinfo.top_url = proxy_prefix + proxy_path + dest_fullurl;
    wbinfo.is_framed = false;
    wbinfo.is_live = true;
    wbinfo.coll = "";
    wbinfo.proxy_magic = "";
    wbinfo.static_prefix = proxy_prefix + "/wombat/dist/";
    wbinfo.wombat_ts = "";
    wbinfo.wombat_scheme = dest_scheme;
    wbinfo.wombat_host = dest_host;
    wbinfo.wombat_sec = "1";
    wbinfo.wombat_opts = {};

    if (window && window._WBWombat && !window._wb_js_inited && !window._wb_wombat) {
      // Fix Google SPA replaceState while proxied (supports optional mod prefix)
      window.history._womginx_replaceState = window.history.replaceState;
      window.history.replaceState = function (stateObj, title, url) {
        try {
          if (/^\/main(?:\/[^/_]+_)?\/https:\/\/www\.google\.com/i.test(window.location.pathname)) {
            url = "/";
          }
        } catch (_) {}
        return this._womginx_replaceState(stateObj, title, url);
      };

      // XMLHttpRequest: correct malformed protocols only
      var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (xhrProto && xhrProto.open) {
        xhrProto._womginx_open = xhrProto.open;
        xhrProto.open = function (method, url, async, username, password) {
          try {
            url = normalizeProxyUrl(url);
          } catch (_) {}
          return this._womginx_open(method, url, async, username, password);
        };
      }

      // fetch: rebuild a Request to preserve method/headers/body and normalize URL
      window._womginx_fetch = window.fetch.bind(window);
      window.fetch = function (input, init) {
        try {
          if (input instanceof Request) {
            var fixedUrl = normalizeProxyUrl(input.url);
            var req = new Request(fixedUrl, input);
            return window._womginx_fetch(req);
          } else {
            var fixed = normalizeProxyUrl(input);
            return window._womginx_fetch(fixed, init);
          }
        } catch (_) {
          return window._womginx_fetch(input, init);
        }
      };

      // WebSocket: add origin hint and normalize protocol slashes
      window._womginx_WebSocket = window.WebSocket;
      window.WebSocket = function (url, protocols) {
        var originForWs = dest_scheme + "://" + dest_host;
        try {
          var uObj = new URL(url, window.location.href);
          uObj.searchParams.set("womginx_ws_origin_header", originForWs);
          url = uObj.toString();
        } catch (_) {
          var sep = (String(url).indexOf("?") === -1) ? "?" : "&";
          url = String(url) + sep + "womginx_ws_origin_header=" + encodeURIComponent(originForWs);
        }
        url = normalizeProxyUrl(url);
        return new window._womginx_WebSocket(url, protocols);
      };

      // Keep wombat minimal overrides to avoid breaking apps like Discord
      _WBWombat.prototype.initDateOverride = function () {};
      _WBWombat.prototype.initSeededRandom = function () {};
      _WBWombat.prototype.initStorageOverride = function () {};

      // Host-scoped localStorage shim
      (function () {
        try {
          var ls = window.localStorage;
          var realSetItem = ls.setItem.bind(ls);
          var storeKey = dest_host || "default_host";
          var hostLocal = {};
          try {
            var raw = ls.getItem(storeKey);
            if (raw) hostLocal = JSON.parse(raw) || {};
          } catch (_) {}
          var saveTimer = -1;
          function scheduleSave() {
            if (saveTimer !== -1) return;
            saveTimer = setTimeout(function () {
              saveTimer = -1;
              try { realSetItem(storeKey, JSON.stringify(hostLocal)); } catch (_) {}
            }, 50);
          }
          ls.key = function (n) { return Object.keys(hostLocal)[n]; };
          ls.getItem = function (k) { return Object.prototype.hasOwnProperty.call(hostLocal, k) ? hostLocal[k] : null; };
          ls.setItem = function (k, v) { hostLocal[k] = String(v); scheduleSave(); };
          ls.removeItem = function (k) { delete hostLocal[k]; scheduleSave(); };
          ls.clear = function () { hostLocal = {}; scheduleSave(); };
        } catch (_) {}
      })();

      // Init wombat
      window._wb_wombat = new _WBWombat(window, wbinfo);
      window._wb_wombat.wombatInit();

      // Blob fix (ensure options defaults)
      window._womginx_Blob = window.Blob;
      window.Blob = function (data, options) {
        return new window._womginx_Blob(data, options || {});
      };

      // rewriteWorker: support TrustedScriptURL and force client-side rewrite via Blob
      window._wb_wombat._womginx_rewriteWorker = window._wb_wombat.rewriteWorker;
      window._wb_wombat.rewriteWorker = function (workerUrl) {
        try { workerUrl = workerUrl && workerUrl.toString(); } catch (_) {}
        if (!workerUrl) return workerUrl;
        var isBlob = workerUrl.indexOf("blob:") === 0;
        var isJS = workerUrl.indexOf("javascript:") === 0;
        if (!isBlob && !isJS) {
          try {
            var request = new XMLHttpRequest();
            request.open("GET", workerUrl, false);
            request.send();
            workerUrl = window.URL.createObjectURL(new Blob([request.responseText], { type: "application/javascript" }));
          } catch (_) {}
        }
        return this._womginx_rewriteWorker(workerUrl);
      };

      // Minimal DOM rewrite pass; skip elements already touched by Nginx sub_filter
      var absoluteMatch = /^(\/|https?:\/\/|wss?:\/\/|\/\/|data:|blob:)/i;
      window.addEventListener("DOMContentLoaded", function () {
        try {
          var elements = Array.from(document.getElementsByTagName("*"));
          for (var i = 0; i < elements.length; i++) {
            var el = elements[i];
            if (el.tagName !== "IMG" && el.hasAttribute && el.hasAttribute(processedAttr)) continue;
            if (el.tagName === "SCRIPT" && el.src && absoluteMatch.test(el.src)) {
              // Clone trick to work around some script-src edge cases while proxied
              var script = el.cloneNode();
              if (el.parentNode) el.parentNode.insertBefore(script, el);
            } else if (window._wb_wombat && window._wb_wombat.rewriteElem) {
              window._wb_wombat.rewriteElem(el);
            }
          }
        } catch (_) {}
      });

      // currentLocation: reflect upstream location; keep state in sync
      function getProxyUrl() {
        var m = window.location.href.match(/^https?:\/\/[^/]+\/main(?:\/[^/_]+_)?\/(.*)$/i);
        return m ? m[1] : window.location.href;
      }
      var previousLocation = window.location.href;
      var locationObj = new URL(getProxyUrl(), window.location.href);
      function updateLocationObj() {
        if (window.location.href !== previousLocation) {
          previousLocation = window.location.href;
          locationObj = new URL(getProxyUrl(), window.location.href);
        }
      }
      var currentLocationProp = {
        get ancestorOrigins() { updateLocationObj(); return window.location.ancestorOrigins; },
        get href() { updateLocationObj(); return locationObj.href; },
        set href(value) { window.location.href = window._wb_wombat.rewriteUrl(value); },
        get protocol() { updateLocationObj(); return locationObj.protocol; },
        set protocol(value) { window.location.protocol = value; },
        get host() { updateLocationObj(); return locationObj.host; },
        set host(value) { window.location.host = value; },
        get hostname() { updateLocationObj(); return locationObj.hostname; },
        set hostname(value) { window.location.hostname = value; },
        get port() { updateLocationObj(); return locationObj.port; },
        set port(value) { window.location.port = value; },
        get pathname() { updateLocationObj(); return locationObj.pathname; },
        set pathname(value) { window.location.pathname = value; },
        get search() { updateLocationObj(); return locationObj.search; },
        set search(value) { window.location.search = value; },
        get hash() { updateLocationObj(); return locationObj.hash; },
        set hash(value) { window.location.hash = value; },
        get origin() { updateLocationObj(); return locationObj.origin; },
        assign(url) { window.location.assign(window._wb_wombat.rewriteUrl(url)); },
        reload() { window.location.reload(); },
        replace(url) { window.location.replace(window._wb_wombat.rewriteUrl(url)); },
        toString() { updateLocationObj(); return locationObj.href; }
      };
      Object.defineProperty(window, "currentLocation", {
        configurable: true,
        get: function () { return currentLocationProp; },
        set: function (value) { window.location = window._wb_wombat.rewriteUrl(value); },
      });
    }
  } catch (_) {
    // keep page functional even if the handler fails
  }
})();
