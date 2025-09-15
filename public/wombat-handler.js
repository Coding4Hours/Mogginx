(function() {
    try {
        // Prevent multiple inits (in case script is re-injected)
        var INIT_FLAG = "__womginx_inited__";
        if (window[INIT_FLAG]) return;

        // processed flag added by Nginx sub_filter (ex: womginx-processed)
        var processedAttr =
            (document.currentScript && document.currentScript.getAttribute("processed-attribute")) ||
            "womginx-processed";

        // Parse /main(/mod_)?/<targeturl>
        var path = window.location.pathname || "/";
        var mainMatch = path.match(/^\/main(\/[^/_]+_)?\/(.*)$/);
        if (!mainMatch) return; // Not on proxied HTML route

        var mod = mainMatch[1] || "";
        var dest_fullurl = mainMatch[2] || "";

        // If target has malformed scheme (https:/, ws:/), fix in address bar without reload
        if (/^(?:http|ws)s?:\/[^/]/i.test(dest_fullurl)) {
            var fixedDest = dest_fullurl.replace(/^((?:http|ws)s?):\/([^/])/, "$1://$2");
            if (fixedDest !== dest_fullurl) {
                var newPath = "/main" + mod + "/" + fixedDest + window.location.hash;
                try {
                    window.history.replaceState(null, "", newPath);
                } catch (_) {}
                dest_fullurl = fixedDest;
            }
        }

        var proxy_prefix = window.location.origin;
        var proxy_path = "/main" + mod + "/";

        var dest_scheme = "";
        var dest_host = "";
        var mScheme = dest_fullurl.match(/^[^:]+/);
        if (mScheme) dest_scheme = mScheme[0] || "";
        var mHost = dest_fullurl.match(/^[^:]*:\/\/([^/]+)/);
        if (mHost) dest_host = mHost[1] || "";

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

        function rewriteIfPossible(u) {
            try {
                if (!u || /^(?:blob:|data:|javascript:)/i.test(String(u))) return u;

                // Check if already rewritten - if it contains /main/ followed by a scheme
                var uStr = String(u);
                if (/\/main\/(?:[^/_]+_\/)?(?:https?|wss?):\/\//i.test(uStr)) {
                    return u; // Already rewritten, return as-is
                }

                if (window._wb_wombat && window._wb_wombat.rewriteUrl) {
                    return window._wb_wombat.rewriteUrl(u);
                }
            } catch (_) {}
            return u;
        }

        // Wombat init info
        var wbinfo = {
            url: dest_fullurl,
            timestamp: "",
            request_ts: "",
            prefix: proxy_prefix + proxy_path,
            mod: "",
            top_url: proxy_prefix + proxy_path + dest_fullurl,
            is_framed: false,
            is_live: true,
            coll: "",
            proxy_magic: "",
            static_prefix: proxy_prefix + "/wombat/dist/",
            wombat_ts: "",
            wombat_scheme: dest_scheme,
            wombat_host: dest_host,
            wombat_sec: "1",
            wombat_opts: {}
        };

        function getProxyUrl() {
            var m = window.location.href.match(/^https?:\/\/[^/]+\/main(?:\/[^/_]+_)?\/(.*)$/i);
            return m ? m[1] : window.location.href;
        }

        // Initialize wombat and patches only if wombat exists
        if (window && window._WBWombat && !window._wb_wombat) {
            // Idempotency for our own patch set
            if (window[INIT_FLAG]) return;

            // Make History patches idempotent and safe
            (function patchHistory() {
                try {
                    var H = window.history;
                    if (!H || H.__womginx_patched__) return;
                    H.__womginx_patched__ = true;

                    H._womginx_replaceState = H.replaceState;
                    H._womginx_pushState = H.pushState;

                    H.replaceState = function(stateObj, title, url) {
                        try {
                            if (/^\/main(?:\/[^/_]+_)?\/https:\/\/www\.google\.com/i.test(window.location.pathname)) {
                                url = "/";
                            }
                        } catch (_) {}
                        return this._womginx_replaceState(stateObj, title, url);
                    };

                    H.pushState = function(stateObj, title, url) {
                        // Allow apps to pass relative URLs and keep currentLocation in sync
                        var r = this._womginx_pushState(stateObj, title, url);
                        try {
                            _syncLocationObj();
                        } catch (_) {}
                        return r;
                    };
                } catch (_) {}
            })();

            // XMLHttpRequest: correct malformed protocols and rewrite if Wombat available
            (function patchXHR() {
                try {
                    var xhrProto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
                    if (!xhrProto || !xhrProto.open || xhrProto._womginx_open) return;
                    xhrProto._womginx_open = xhrProto.open;
                    xhrProto.open = function(method, url, async, username, password) {
                        try {
                            url = normalizeProxyUrl(url);
                            url = rewriteIfPossible(url);
                        } catch (_) {}
                        return this._womginx_open(method, url, async, username, password);
                    };
                } catch (_) {}
            })();

            // fetch: rebuild a Request to preserve method/headers/body and normalize/rewrite URL
            (function patchFetch() {
                try {
                    if (!window.fetch || window._womginx_fetch) return;
                    window._womginx_fetch = window.fetch.bind(window);

                    function requestFrom(input, init, newUrl) {
                        try {
                            if (input instanceof Request) {
                                // Clone Request into a new one with a different URL, preserving semantics
                                // Note: body may be a stream; if bodyUsed, let browser throw naturally for consistency
                                var headers = new Headers(input.headers);
                                var body = input.bodyUsed ? undefined : input.body;

                                var reqInit = {
                                    method: input.method,
                                    headers: headers,
                                    body: body,
                                    mode: input.mode,
                                    credentials: input.credentials,
                                    cache: input.cache,
                                    redirect: input.redirect,
                                    referrer: input.referrer,
                                    referrerPolicy: input.referrerPolicy,
                                    integrity: input.integrity,
                                    keepalive: input.keepalive,
                                    signal: (init && init.signal) || input.signal,
                                    // Pass through duplex if present (for streaming uploads in some browsers)
                                    duplex: (init && init.duplex) || input.duplex
                                };
                                if (init) {
                                    // init overrides input
                                    for (var k in init) {
                                        try {
                                            reqInit[k] = init[k];
                                        } catch (_) {}
                                    }
                                }
                                return new Request(newUrl, reqInit);
                            } else {
                                // input is URL-like
                                return new Request(newUrl, init);
                            }
                        } catch (e) {
                            // Fallback: let native fetch handle it as-is
                            return null;
                        }
                    }

                    window.fetch = function(input, init) {
                        try {
                            var urlLike = input instanceof Request ? input.url : input;
                            var fixed = normalizeProxyUrl(urlLike);
                            fixed = rewriteIfPossible(fixed);

                            // If nothing changed, call native directly
                            if (input instanceof Request) {
                                if (fixed === input.url) return window._womginx_fetch(input, init);
                            } else {
                                if (String(fixed) === String(urlLike)) return window._womginx_fetch(input, init);
                            }

                            var rebuilt = requestFrom(input, init, fixed);
                            if (rebuilt) return window._womginx_fetch(rebuilt);
                        } catch (_) {}
                        return window._womginx_fetch(input, init);
                    };
                } catch (_) {}
            })();

            // WebSocket: add origin hint and normalize/rewrite protocol slashes
            (function patchWebSocket() {
                try {
                    if (!window.WebSocket || window._womginx_WebSocket) return;
                    window._womginx_WebSocket = window.WebSocket;

                    window.WebSocket = function(url, protocols) {
                        var originForWs = dest_scheme + "://" + dest_host;
                        // Normalize early
                        try {
                            url = normalizeProxyUrl(url);
                            // Ensure URL is absolute/resolved; if relative, resolve against current doc
                            var uObj = new URL(url, window.location.href);
                            // Add pass-through origin hint for upstream handling
                            uObj.searchParams.set("womginx_ws_origin_header", originForWs);
                            url = uObj.toString();
                        } catch (_) {
                            var sep = (String(url).indexOf("?") === -1) ? "?" : "&";
                            url = String(url) + sep + "womginx_ws_origin_header=" + encodeURIComponent(originForWs);
                        }

                        // Let wombat rewrite ws/wss -> proxy route if needed
                        try {
                            url = rewriteIfPossible(url);
                        } catch (_) {}

                        return new window._womginx_WebSocket(url, protocols);
                    };
                } catch (_) {}
            })();

            // Keep wombat minimal overrides to avoid breaking apps like Discord
            _WBWombat.prototype.initDateOverride = function() {};
            _WBWombat.prototype.initSeededRandom = function() {};
            _WBWombat.prototype.initStorageOverride = function() {};

            // Host-scoped localStorage shim with length + insertion order
            (function() {
                try {
                    var ls = window.localStorage;
                    if (!ls || ls.__womginx_patched__) return;
                    ls.__womginx_patched__ = true;

                    var realSetItem = ls.setItem.bind(ls);
                    var realRemoveItem = ls.removeItem ? ls.removeItem.bind(ls) : null;
                    var realGetItem = ls.getItem.bind(ls);
                    var storeKey = dest_host || "default_host";
                    var hostLocal = Object.create(null);
                    var keyOrder = []; // maintain insertion order for .key()

                    function load() {
                        try {
                            var raw = realGetItem(storeKey);
                            if (raw) {
                                var parsed = JSON.parse(raw) || {};
                                hostLocal = parsed.data || Object.create(null);
                                keyOrder = Array.isArray(parsed.keyOrder) ? parsed.keyOrder : Object.keys(hostLocal);
                            }
                        } catch (_) {}
                    }
                    load();

                    var saveTimer = -1;

                    function scheduleSave() {
                        if (saveTimer !== -1) return;
                        saveTimer = setTimeout(function() {
                            saveTimer = -1;
                            try {
                                realSetItem(storeKey, JSON.stringify({
                                    data: hostLocal,
                                    keyOrder: keyOrder
                                }));
                            } catch (_) {}
                        }, 50);
                    }

                    function indexOfKey(k) {
                        for (var i = 0; i < keyOrder.length; i++)
                            if (keyOrder[i] === k) return i;
                        return -1;
                    }

                    Object.defineProperty(ls, "length", {
                        configurable: true,
                        enumerable: false,
                        get: function() {
                            return keyOrder.length;
                        }
                    });


                    ls.key = function(n) {
                        n = Number(n);
                        return keyOrder[n] || null;
                    };

                    ls.getItem = function(k) {
                        k = String(k);
                        return Object.prototype.hasOwnProperty.call(hostLocal, k) ? hostLocal[k] : null;
                    };

                    ls.setItem = function(k, v) {
                        k = String(k);
                        var exists = Object.prototype.hasOwnProperty.call(hostLocal, k);
                        hostLocal[k] = String(v);
                        if (!exists) keyOrder.push(k);
                        scheduleSave();
                    };

                    ls.removeItem = function(k) {
                        k = String(k);
                        if (Object.prototype.hasOwnProperty.call(hostLocal, k)) {
                            delete hostLocal[k];
                            var idx = indexOfKey(k);
                            if (idx !== -1) keyOrder.splice(idx, 1);
                            scheduleSave();
                        }
                    };

                    ls.clear = function() {
                        hostLocal = Object.create(null);
                        keyOrder = [];
                        scheduleSave();
                    };
                } catch (_) {}
            })();

            // Init wombat
            window._wb_wombat = new _WBWombat(window, wbinfo);
            window._wb_wombat.wombatInit();

            // Blob fix (ensure options defaults) while preserving instanceof
            (function patchBlob() {
                try {
                    if (!window.Blob || window._womginx_Blob) return;
                    var NativeBlob = window.Blob;

                    function BlobWrapper(data, options) {
                        return new NativeBlob(data, options || {});
                    }
                    BlobWrapper.prototype = NativeBlob.prototype;
                    // Keep name mostly cosmetic; ignore if it throws
                    try {
                        Object.defineProperty(BlobWrapper, "name", {
                            value: "Blob"
                        });
                    } catch (_) {}
                    window._womginx_Blob = NativeBlob;
                    window.Blob = BlobWrapper;
                } catch (_) {}
            })();

            // rewriteWorker: create a tiny proxy blob that importScripts() the (rewritten) worker URL
            // rewriteWorker: create a tiny proxy blob that importScripts() the (rewritten) worker URL
            (function patchWorkerRewriter() {
                try {
                    if (!window._wb_wombat || window._wb_wombat._womginx_rewriteWorker) return;
                    window._wb_wombat._womginx_rewriteWorker = window._wb_wombat.rewriteWorker;
                    window._wb_wombat.rewriteWorker = function(workerUrl) {
                        // Convert to string regardless of input type (URL object, etc.)
                        try {
                            if (workerUrl && typeof workerUrl === 'object' && workerUrl.href) {
                                workerUrl = workerUrl.href;
                            } else if (workerUrl) {
                                workerUrl = workerUrl.toString();
                            }
                        } catch (_) {}

                        if (!workerUrl || typeof workerUrl !== 'string') {
                            console.warn('[Worker Rewrite] Invalid URL type:', typeof workerUrl, workerUrl);
                            return workerUrl;
                        }

                        console.log('[Worker Rewrite] Original URL:', workerUrl);

                        // Don't rewrite blob URLs - they're already local
                        if (/^blob:/i.test(workerUrl)) {
                            return workerUrl;
                        }

                        var proxyOrigin = window.location.origin;
                        var targetUrl = workerUrl;

                        try {
                            // Check if URL is already rewritten (contains /main/)
                            if (workerUrl.indexOf('/main/') !== -1) {
                                // Extract the actual target URL from the already-rewritten URL
                                var match = workerUrl.match(/\/main(?:\/[^/_]+_)?\/(.+)$/);
                                if (match) {
                                    targetUrl = match[1];
                                    console.log('[Worker Rewrite] Extracted target URL from rewritten URL:', targetUrl);

                                    // If it's STILL double-rewritten (has another /main/), extract again
                                    if (targetUrl.indexOf('/main/') === 0) {
                                        var match2 = targetUrl.match(/\/main(?:\/[^/_]+_)?\/(.+)$/);
                                        if (match2) {
                                            targetUrl = match2[1];
                                            console.log('[Worker Rewrite] Extracted again (was double-rewritten):', targetUrl);
                                        }
                                    }
                                }
                            } else if (!/^https?:\/\//i.test(workerUrl)) {
                                // Handle relative URLs - resolve them against the target domain
                                if (workerUrl.charAt(0) === '/') {
                                    targetUrl = dest_scheme + '://' + dest_host + workerUrl;
                                } else {
                                    // Relative path - resolve against current target URL
                                    var currentTargetUrl = dest_fullurl;
                                    var baseUrl = currentTargetUrl.substring(0, currentTargetUrl.lastIndexOf('/') + 1);
                                    targetUrl = baseUrl + workerUrl;
                                }
                                console.log('[Worker Rewrite] Resolved relative URL to:', targetUrl);
                            }

                            // Ensure targetUrl has proper protocol (fix https:/ -> https://)
                            targetUrl = normalizeProxyUrl(targetUrl);

                            // Now create the correct worker URL with wkr_ modifier
                            var rewrittenUrl = proxyOrigin + '/main/wkr_/' + targetUrl;
                            console.log('[Worker Rewrite] Final rewritten URL:', rewrittenUrl);

                            // Create loader blob that initializes wombat in worker context
                            var loader = `
          // Initialize minimal wombat context for workers
          if (!self.__WB_pmw) {
            self.__WB_pmw = function(win) {
              return {
                postMessage: function(data, targetOrigin, transfer) {
                  // Just pass through for now
                  if (win && win.postMessage) {
                    return win.postMessage(data, targetOrigin, transfer);
                  }
                  return self.postMessage(data, transfer);
                }
              };
            };
          }
          
          // Also ensure postMessage works
          if (!self.window) {
            self.window = self;
          }
          
          // Import wombat if available
          try {
            importScripts('${proxyOrigin}/wombat/dist/wombat.js');
          } catch(e) {
            console.warn('[Worker] Could not load wombat:', e);
          }
          
          // Now import the actual worker script
          try {
            importScripts(${JSON.stringify(rewrittenUrl)});
          } catch(e) {
            console.error('[Worker] Import failed:', e);
            setTimeout(function() { throw e; });
          }
        `;

                            var blobUrl = window.URL.createObjectURL(new Blob([loader], {
                                type: "application/javascript"
                            }));
                            return blobUrl;

                        } catch (e) {
                            console.error('[Worker Rewrite] Failed:', e);
                            // Fallback: return the URL as-is and let wombat's default handling try
                            return workerUrl;
                        }
                    };
                } catch (e) {
                    console.error('[Worker Rewrite] Patch failed:', e);
                }
            })();
            // Minimal DOM rewrite pass with targeted selectors; skip already-processed nodes
            var absoluteMatch = /^(\/|https?:\/\/|wss?:\/\/|\/\/|data:|blob:)/i;

            function rewriteAndMark(el) {
                try {
                    if (!el || (el.hasAttribute && el.hasAttribute(processedAttr))) return;
                    if (window._wb_wombat && window._wb_wombat.rewriteElem) {
                        window._wb_wombat.rewriteElem(el);
                        if (el.setAttribute) el.setAttribute(processedAttr, "1");
                    }
                } catch (_) {}
            }

            function initialRewrite() {
                try {
                    // Focus on attributes that actually carry URLs
                    var nodes = document.querySelectorAll([
                        "img[src]:not([" + processedAttr + "])",
                        "script[src]:not([" + processedAttr + "])",
                        "iframe[src]:not([" + processedAttr + "])",
                        "source[src]:not([" + processedAttr + "])",
                        "video[src]:not([" + processedAttr + "])",
                        "audio[src]:not([" + processedAttr + "])",
                        "track[src]:not([" + processedAttr + "])",
                        "embed[src]:not([" + processedAttr + "])",
                        "object[data]:not([" + processedAttr + "])",
                        "a[href]:not([" + processedAttr + "])",
                        "link[href]:not([" + processedAttr + "])",
                        "form[action]:not([" + processedAttr + "])",
                        "input[formaction]:not([" + processedAttr + "])",
                        "meta[http-equiv='refresh']:not([" + processedAttr + "])"
                    ].join(","));
                    for (var i = 0; i < nodes.length; i++) {
                        var el = nodes[i];
                        rewriteAndMark(el);
                    }
                } catch (_) {}
            }

            // Observe future mutations (SPAs)
            function observeMutations() {
                try {
                    var mo = new MutationObserver(function(mutations) {
                        for (var i = 0; i < mutations.length; i++) {
                            var m = mutations[i];
                            if (m.type === "childList") {
                                for (var j = 0; j < m.addedNodes.length; j++) {
                                    var n = m.addedNodes[j];
                                    if (!(n instanceof Element)) continue;
                                    // Direct element
                                    rewriteAndMark(n);
                                    // And any descendants that carry URL attributes
                                    var inner = n.querySelectorAll && n.querySelectorAll([
                                        "img[src]:not([" + processedAttr + "])",
                                        "script[src]:not([" + processedAttr + "])",
                                        "iframe[src]:not([" + processedAttr + "])",
                                        "source[src]:not([" + processedAttr + "])",
                                        "video[src]:not([" + processedAttr + "])",
                                        "audio[src]:not([" + processedAttr + "])",
                                        "track[src]:not([" + processedAttr + "])",
                                        "embed[src]:not([" + processedAttr + "])",
                                        "object[data]:not([" + processedAttr + "])",
                                        "a[href]:not([" + processedAttr + "])",
                                        "link[href]:not([" + processedAttr + "])",
                                        "form[action]:not([" + processedAttr + "])",
                                        "input[formaction]:not([" + processedAttr + "])",
                                        "meta[http-equiv='refresh']:not([" + processedAttr + "])"
                                    ].join(","));
                                    if (inner && inner.length) {
                                        for (var k = 0; k < inner.length; k++) rewriteAndMark(inner[k]);
                                    }
                                }
                            } else if (m.type === "attributes") {
                                if (m.target && m.target instanceof Element) {
                                    // If a watched attribute changed, rewrite
                                    var name = m.attributeName || "";
                                    if (/^(src|href|action|formaction|data)$/i.test(name)) rewriteAndMark(m.target);
                                }
                            }
                        }
                    });

                    mo.observe(document.documentElement || document, {
                        childList: true,
                        subtree: true,
                        attributes: true,
                        attributeFilter: ["src", "href", "action", "formaction", "data"]
                    });
                } catch (_) {}
            }

            // currentLocation: reflect upstream location; keep state in sync
            var previousLocation = window.location.href;
            var locationObj = new URL(getProxyUrl(), window.location.href);

            function _syncLocationObj() {
                // Called by history patches and getters
                if (window.location.href !== previousLocation) {
                    previousLocation = window.location.href;
                    locationObj = new URL(getProxyUrl(), window.location.href);
                }
            }
            var currentLocationProp = {
                get ancestorOrigins() {
                    _syncLocationObj();
                    return window.location.ancestorOrigins;
                },
                get href() {
                    _syncLocationObj();
                    return locationObj.href;
                },
                set href(value) {
                    window.location.href = window._wb_wombat.rewriteUrl(value);
                },
                get protocol() {
                    _syncLocationObj();
                    return locationObj.protocol;
                },
                set protocol(value) {
                    window.location.protocol = value;
                },
                get host() {
                    _syncLocationObj();
                    return locationObj.host;
                },
                set host(value) {
                    window.location.host = value;
                },
                get hostname() {
                    _syncLocationObj();
                    return locationObj.hostname;
                },
                set hostname(value) {
                    window.location.hostname = value;
                },
                get port() {
                    _syncLocationObj();
                    return locationObj.port;
                },
                set port(value) {
                    window.location.port = value;
                },
                get pathname() {
                    _syncLocationObj();
                    return locationObj.pathname;
                },
                set pathname(value) {
                    window.location.pathname = value;
                },
                get search() {
                    _syncLocationObj();
                    return locationObj.search;
                },
                set search(value) {
                    window.location.search = value;
                },
                get hash() {
                    _syncLocationObj();
                    return locationObj.hash;
                },
                set hash(value) {
                    window.location.hash = value;
                },
                get origin() {
                    _syncLocationObj();
                    return locationObj.origin;
                },
                assign(url) {
                    window.location.assign(window._wb_wombat.rewriteUrl(url));
                },
                reload() {
                    window.location.reload();
                },
                replace(url) {
                    window.location.replace(window._wb_wombat.rewriteUrl(url));
                },
                toString() {
                    _syncLocationObj();
                    return locationObj.href;
                }
            };
            Object.defineProperty(window, "currentLocation", {
                configurable: true,
                get: function() {
                    return currentLocationProp;
                },
                set: function(value) {
                    window.location = window._wb_wombat.rewriteUrl(value);
                },
            });
            Object.defineProperty(document, 'currentLocation', {
                get() {
                    return window.currentLocation;
                },
                set(value) {
                    window.currentLocation = value;
                },
                enumerable: true,
                configurable: true
            });

            // DOM lifecycle
            if (document.readyState === "loading") {
                window.addEventListener("DOMContentLoaded", function() {
                    try {
                        initialRewrite();
                        observeMutations();
                    } catch (_) {}
                });
            } else {
                try {
                    initialRewrite();
                    observeMutations();
                } catch (_) {}
            }

            window[INIT_FLAG] = true;
        }
    } catch (_) {
        // keep page functional even if the handler fails
    }
})();
