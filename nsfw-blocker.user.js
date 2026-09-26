// ==UserScript==
// @name         NSFW Image Blur
// @version      52
// @match        *://*/*
// @exclude      *://mail.google.com/*
// @exclude      *://docs.google.com/*
// @exclude      *://*.google.*/maps*
// @run-at       document-start
// @grant        GM.xmlHttpRequest
// @grant        GM.getValue
// @grant        GM.setValue
// ==/UserScript==
(function () {
    'use strict';

    // ----- settings -----
    var WHITELIST = ['youtube.com', 'youtube-nocookie.com']; // sites where the script does nothing
    var MODEL_URL = 'https://cdn.jsdelivr.net/gh/infinitered/nsfwjs@4.1.0/models/mobilenet_v2/';
    // TensorFlow.js is downloaded with the model, only on pages that have an image to check. (With
    // @require, 1.4 MB was parsed on every page and frame before it could start loading.)
    var TF_URL = 'https://cdn.jsdelivr.net/npm/@tensorflow/tfjs@4.17.0/dist/tf.min.js';
    // SHA-256 of each download. Anything else (a moved git tag, a compromised CDN) is never run.
    var HASHES = {
        tf: '44262ab5b6f145c30e7f165acc28d1df8db25e7c2b9aff4207535836b618da71',
        json: '11846416217e68bf1eb7b0e651bcfd305973566453c63275bbd16766ab089979',
        weights: '8e7dddbb16acacc1bf1601b1b8a761e730ff934b7f2d7771312b2f000e5f5f13'
    };
    // Explicit words that never occur inside normal words, so they match anywhere, even in hostnames.
    var HARD = /chaturbate|deepthroat|masturbat|spankbang|creampie|gangbang|brazzers|xhamster|onlyfans|pornhub|shemale|bukkake|camgirl|blowjob|handjob|cumshot|xvideos|bigtits|redtube|youporn|hentai|jizz|xnxx|porn/;
    // Ambiguous words (sex = "six" in Swedish, anal -> analysis...): only counted as whole words in short links.
    var SOFT = /^(?:erotic|escort|fetish|webcam|adult|pussy|boobs|nsfw|nude|porr|anal|milf|xxx|sex)$/;
    var HOST_EXCEPTIONS = /pornic/;  // French towns Pornic / Pornichet
    var TEXT_SKIP = ['wikipedia.org', 'wikimedia.org', 'wiktionary.org', 'britannica.com', 'merriam-webster.com',
        'dictionary.com', 'ne.se', 'saob.se']; // reference sites: no page-word check (image checks still run)
    var DEBUG = false;          // show the status badge (tap it to hide)
    var MIN_SIZE = 48;          // images smaller than this are icons -> safe
    var SIZE = 224;             // model input size
    var MAX_PARALLEL = 4;       // checks in flight per frame (mostly downloads)
    var MODEL_DEADLINE = 90000; // give up on the model after this (blur stays, taps work again)
    var MIN_FRAME = 200;        // smaller iframes (ads, widgets) don't load the model: their media stays blurred
    var TIMEOUT = 30000;        // per download
    var PAGE_BLOCK_NSFW = 6;    // block the whole page after this many NSFW images...
    var PAGE_BLOCK_RATIO = 0.6; // ...if they are at least this share of everything checked
    var PAGE_BLOCK_MINUTES = 15; // block the whole domain this long after an image-based block
    var TEXT_BLOCK_MINUTES = 5;  // ...and after a page-word block
    var CLASSES = ['Drawing', 'Hentai', 'Neutral', 'Porn', 'Sexy'];

    var host = location.hostname.toLowerCase();
    function hostIn(list) { return list.some(function (d) { return host === d || host.slice(-d.length - 1) === '.' + d; }); }
    if (hostIn(WHITELIST)) return;

    // ----- 1. blur everything immediately -----
    // Blurred media can't be long-pressed, selected or dragged. The doubled ':not(#x)' beats page CSS
    // that sets 'filter: none !important'.
    var NOT = ':not(#nsfw-x):not(#nsfw-x)', U = NOT + ':not([data-nsfw-safe])';
    var LOCK = '-webkit-touch-callout:none!important;-webkit-user-select:none!important;user-select:none!important;-webkit-user-drag:none!important;';
    var CSS =
        'img' + U + ',image' + U + ',[data-nsfw-bg]' + U + '{filter:blur(28px)!important;' + LOCK + '}' +
        'video' + U + '{filter:blur(40px)!important;' + LOCK + '}' +
        '[data-nsfw-shield]' + NOT + ',[data-nsfw-shield]' + NOT + ' *{' + LOCK + '}';
    function addStyle(root) {
        var s = document.createElement('style');
        s.textContent = CSS;
        return root.appendChild(s);
    }
    var sheet = addStyle(document.head || document.documentElement);
    function ensureStyle() { // pages that replace <head> would otherwise take the blur with them
        if (!sheet.isConnected) (document.head || document.documentElement).appendChild(sheet);
    }

    // ----- status badge -----
    var VERSION = typeof GM !== 'undefined' && GM.info ? 'v' + GM.info.script.version : '';
    var badge = null, counts = { ok: 0, nsfw: 0, err: 0 }, lastErr = '';
    function status(text) {
        if (!DEBUG) return;
        if (!badge) {
            badge = document.createElement('div');
            badge.setAttribute('data-nsfw-ui', '');
            badge.style.cssText = 'position:fixed;top:0;left:0;z-index:2147483647;background:#c00;color:#fff;padding:3px 6px;font:11px sans-serif;';
            badge.onclick = function () { badge.remove(); DEBUG = false; };
        }
        badge.textContent = 'nsfw ' + VERSION + ' ' + text;
        if (!badge.isConnected && document.body) document.body.appendChild(badge);
    }
    function showCounts() {
        if (!failed) status('ok:' + counts.ok + ' nsfw:' + counts.nsfw + ' err:' + counts.err + (lastErr ? ' (' + lastErr + ')' : ''));
    }

    // ----- whole-page block -----
    var blocked = false;
    // The domain to block: example.com for www.example.com, but example.co.uk, not co.uk (Safari
    // silently drops a cookie set for co.uk, so the block wouldn't be remembered at all).
    function siteDomain() {
        var p = host.split('.'), n = p.length;
        var cc = n > 2 && p[n - 1].length === 2 && /^(?:co|com|net|org|gov|edu|ac|or|ne|go)$/.test(p[n - 2]);
        return p.slice(cc ? -3 : -2).join('.');
    }
    // Recent domain blocks ({ domain: expiry time }) live in the script's storage, not in a cookie: a
    // cookie would be sent to the site and tell it the user has a filter.
    var canStore = typeof GM !== 'undefined' && !!GM.getValue && !!GM.setValue;
    function getBlocks() {
        if (!canStore) return Promise.resolve({});
        return Promise.race([GM.getValue('blocks', {}), new Promise(function (r) { setTimeout(r, 1500, {}); })])
            .then(function (b) { return b || {}; }, function () { return {}; });
    }
    function rememberBlock(minutes) {
        getBlocks().then(function (b) {
            var now = Date.now();
            Object.keys(b).forEach(function (d) { if (b[d] <= now) delete b[d]; });
            b[siteDomain()] = now + minutes * 60000;
            return GM.setValue('blocks', b);
        }).catch(function () {});
    }
    function blockPage(minutes, why) {
        if (blocked) return;
        blocked = true;
        if (minutes && canStore) rememberBlock(minutes); // so other pages on the domain are blocked at once
        var o = document.createElement('div');
        o.setAttribute('data-nsfw-ui', '');
        o.style.cssText = 'position:fixed;inset:0;z-index:2147483646;background:#000;color:#fff;display:flex;align-items:center;justify-content:center;text-align:center;padding:24px;font:600 16px -apple-system,sans-serif;';
        o.textContent = 'This page has been blocked (adult content).';
        var attach = function () { if (!o.isConnected) (document.body || document.documentElement).appendChild(o); };
        attach();
        setInterval(function () {
            attach();
            document.querySelectorAll('video, audio').forEach(function (m) { m.pause(); m.muted = true; });
        }, 1000);
        status('PAGE BLOCKED (' + why + ')');
    }
    var blockCheck = Promise.resolve();
    if (HARD.test(host) && !HOST_EXCEPTIONS.test(host)) blockPage(0, 'site name');
    else blockCheck = getBlocks().then(function (b) {
        var now = Date.now();
        if (hostIn(Object.keys(b).filter(function (d) { return b[d] > now; }))) blockPage(0, 'domain blocked recently');
    });

    // ----- 2. block taps on blurred media -----
    var failed = false; // model failed to load: keep blur but let taps through so the page stays usable
    var MEDIA = { IMG: 1, VIDEO: 1, image: 1 }; // 'image' = SVG <image> (tagName is case-sensitive)
    function isLocked(n) {
        return !n.hasAttribute('data-nsfw-safe') && (MEDIA[n.tagName] || n.hasAttribute('data-nsfw-bg'));
    }
    // Tap inside a shielded area? Also catches buttons layered on top of the player that aren't
    // inside it in the DOM (e.g. a positioned "Download" overlay).
    var shields = [];
    function shield(el) {
        if (el.hasAttribute('data-nsfw-shield')) return;
        el.setAttribute('data-nsfw-shield', '');
        shields.push(el);
    }
    function inShield(e) {
        var pt = e.touches ? e.touches[0] : e;
        if (!pt || typeof pt.clientX !== 'number') return false;
        shields = shields.filter(function (el) { return el.isConnected; });
        return shields.some(function (el) {
            var r = el.getBoundingClientRect();
            return pt.clientX >= r.left && pt.clientX <= r.right && pt.clientY >= r.top && pt.clientY <= r.bottom;
        });
    }
    function stop(e) {
        e.stopImmediatePropagation();
        // preventDefault on touch/pointer would also kill scrolling
        if (e.type !== 'touchstart' && e.type !== 'pointerdown') e.preventDefault();
    }
    function guard(e) {
        if (blocked) return;
        var path = e.composedPath ? e.composedPath() : [e.target];
        for (var i = 0; i < path.length; i++) {
            var n = path[i];
            if (!n || n.nodeType !== 1) continue;
            if (n.hasAttribute('data-nsfw-ui')) return;
            // unverified media is released if the model failed; confirmed-NSFW shields never are
            if (n.hasAttribute('data-nsfw-shield') || (!failed && isLocked(n))) return stop(e);
        }
        if (shields.length && inShield(e)) stop(e);
    }
    ['click', 'auxclick', 'contextmenu', 'dragstart', 'pointerdown', 'touchstart'].forEach(function (t) {
        document.addEventListener(t, guard, true);
    });
    // Unverified videos: no fullscreen or Picture-in-Picture (they bypass the blur), muted until
    // verified. Hooked per root because media events don't leave a shadow root.
    function unverifiedVideo(e) {
        var v = e.target;
        return v && v.tagName === 'VIDEO' && !v.hasAttribute('data-nsfw-safe') ? v : null;
    }
    function hookVideos(root) {
        root.addEventListener('webkitbeginfullscreen', function (e) {
            var v = unverifiedVideo(e);
            if (v) try { v.webkitExitFullscreen(); } catch (err) {}
        }, true);
        ['play', 'volumechange'].forEach(function (t) {
            root.addEventListener(t, function (e) {
                var v = unverifiedVideo(e);
                if (!v) return;
                if (!v.muted) { v.muted = true; v._nsfwMuted = true; }
                if (t === 'play') {
                    v.disablePictureInPicture = true;
                    if (v._nsfwBad) v.pause(); // confirmed NSFW: can't be started again
                }
            }, true);
        });
    }
    hookVideos(document);

    if (blocked) return;

    // ----- network (fetch, falling back to GM.xmlHttpRequest for CORS/CSP) -----
    function gmGet(url, type) {
        return new Promise(function (resolve, reject) {
            if (typeof GM === 'undefined' || !GM.xmlHttpRequest) return reject(new Error('no GM'));
            var t = setTimeout(function () { reject(new Error('timeout')); }, TIMEOUT);
            GM.xmlHttpRequest({
                method: 'GET', url: url, responseType: type, timeout: TIMEOUT,
                // Image hosts often refuse requests without one. Only the origin, like Safari sends
                // cross-site: the full URL would leak search terms and tokens to the image host.
                headers: { Referer: location.origin + '/' },
                onload: function (r) {
                    clearTimeout(t);
                    if (r.status >= 200 && r.status < 300 && r.response) resolve(r.response);
                    else reject(new Error('HTTP ' + r.status));
                },
                onerror: function () { clearTimeout(t); reject(new Error('network error')); },
                ontimeout: function () { clearTimeout(t); reject(new Error('timeout')); }
            });
        });
    }
    function timeoutSignal() { // AbortSignal.timeout is missing before iOS 16
        if (AbortSignal.timeout) return AbortSignal.timeout(TIMEOUT);
        var c = new AbortController();
        setTimeout(function () { c.abort(); }, TIMEOUT);
        return c.signal;
    }
    var noFetch = {}; // origins where fetch failed (usually no CORS): go straight to GM next time
    function get(url, type) { // type: 'json' | 'text' | 'arraybuffer' | 'blob'
        var origin = new URL(url, location.href).origin;
        var viaGM = function () {
            return gmGet(url, type === 'json' ? 'text' : type).then(function (d) {
                return type === 'json' && typeof d === 'string' ? JSON.parse(d) : d;
            });
        };
        if (noFetch[origin]) return viaGM();
        return fetch(url, { signal: timeoutSignal() }).then(function (r) {
            if (!r.ok) throw new Error('HTTP ' + r.status);
            return type === 'json' ? r.json() : type === 'text' ? r.text() : type === 'blob' ? r.blob() : r.arrayBuffer();
        }).catch(function () { noFetch[origin] = 1; return viaGM(); });
    }

    // ----- model (loaded lazily, on the first image that needs checking) -----
    // SHA-256 round constants, for pages without crypto.subtle (Safari leaves it out on http:// pages).
    var K = [0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
        0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
        0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
        0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
        0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
        0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
        0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
        0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2];
    function sha256(bytes) {
        var len = bytes.length, total = (len + 72) & ~63; // room for the 0x80 byte and the 64-bit length
        var m = new Uint8Array(total), dv = new DataView(m.buffer), w = new Int32Array(64);
        m.set(bytes);
        m[len] = 0x80;
        dv.setUint32(total - 8, Math.floor(len / 0x20000000));
        dv.setUint32(total - 4, len * 8 >>> 0);
        var H = [0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19];
        for (var off = 0; off < total; off += 64) {
            for (var i = 0; i < 16; i++) w[i] = dv.getInt32(off + i * 4);
            for (i = 16; i < 64; i++) {
                var x = w[i - 15], y = w[i - 2];
                w[i] = w[i - 16] + w[i - 7] + ((x >>> 7 | x << 25) ^ (x >>> 18 | x << 14) ^ (x >>> 3)) +
                    ((y >>> 17 | y << 15) ^ (y >>> 19 | y << 13) ^ (y >>> 10)) | 0;
            }
            var a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7];
            for (i = 0; i < 64; i++) {
                var t1 = h + ((e >>> 6 | e << 26) ^ (e >>> 11 | e << 21) ^ (e >>> 25 | e << 7)) + (e & f ^ ~e & g) + K[i] + w[i] | 0;
                var t2 = ((a >>> 2 | a << 30) ^ (a >>> 13 | a << 19) ^ (a >>> 22 | a << 10)) + (a & b ^ a & c ^ b & c) | 0;
                h = g; g = f; f = e; e = d + t1 | 0; d = c; c = b; b = a; a = t1 + t2 | 0;
            }
            H = [H[0] + a | 0, H[1] + b | 0, H[2] + c | 0, H[3] + d | 0, H[4] + e | 0, H[5] + f | 0, H[6] + g | 0, H[7] + h | 0];
        }
        return H.map(function (v) { return ('0000000' + (v >>> 0).toString(16)).slice(-8); }).join('');
    }
    function toHex(buf) {
        return Array.prototype.map.call(new Uint8Array(buf), function (v) { return ('0' + v.toString(16)).slice(-2); }).join('');
    }
    function verified(buf, name) {
        var slow = function () { return sha256(new Uint8Array(buf)); };
        var hash = crypto.subtle && crypto.subtle.digest
            ? crypto.subtle.digest('SHA-256', buf).then(toHex, slow)
            : Promise.resolve().then(slow);
        return hash.then(function (h) {
            if (h !== HASHES[name]) throw new Error('tampered: ' + name);
            return buf;
        });
    }

    var tf = null;
    function loadTf(buf) {
        try {
            Function('define', 'module', 'exports', new TextDecoder().decode(buf))(); // hide AMD/CommonJS so it attaches globalThis.tf
            tf = globalThis.tf;
        } catch (e) { throw new Error('tf: ' + e.message); }
        if (!tf) throw new Error('tf: did not load');
    }
    var modelPromise = null;
    function getModel() {
        if (!modelPromise) {
            // The badge shows which parts have arrived (tf, json, weights), so a slow one is visible.
            var have = [];
            var got = function (name) { return function (v) { have.push(name); status('loading model... ' + have.join(' ')); return v; }; };
            status('loading model...');
            // Nothing downloaded is used before its hash is checked.
            var fetchVerified = function (url, name) {
                return get(url, 'arraybuffer').then(function (buf) { return verified(buf, name); }).then(got(name));
            };
            var download = function () {
                have = [];
                return Promise.all([
                    fetchVerified(MODEL_URL + 'model.json', 'json').then(function (buf) { return JSON.parse(new TextDecoder().decode(buf)); }),
                    fetchVerified(MODEL_URL + 'group1-shard1of1', 'weights'),
                    tf ? Promise.resolve() : fetchVerified(TF_URL, 'tf').then(loadTf)
                ]);
            };
            var deadline = new Promise(function (_, reject) {
                setTimeout(function () {
                    reject(new Error('took over ' + MODEL_DEADLINE / 1000 + ' s (arrived: ' + (have.join(' ') || 'nothing') + ')'));
                }, MODEL_DEADLINE);
            });
            var load = Promise.resolve().then(download).catch(download) // one retry
                .then(function (res) {
                    var specs = [];
                    res[0].weightsManifest.forEach(function (g) { specs.push.apply(specs, g.weights); });
                    try { tf.env().set('WEBGL_DELETE_TEXTURE_THRESHOLD', 0); } catch (e) {} // iOS GPU memory
                    return tf.loadLayersModel({
                        load: function () {
                            return Promise.resolve({ modelTopology: res[0].modelTopology, weightSpecs: specs, weightData: res[1] });
                        }
                    });
                })
                .then(function (m) { if (!failed) status('model ready'); return m; });
            modelPromise = Promise.race([load, deadline])
                .catch(function (e) {
                    failed = 'MODEL FAILED: ' + e.message;
                    status(failed);
                    throw e;
                });
        }
        return modelPromise;
    }

    var canvas = document.createElement('canvas');
    canvas.width = canvas.height = SIZE;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });

    function predict(model, draw) {
        ctx.fillStyle = '#7f7f7f';
        ctx.fillRect(0, 0, SIZE, SIZE);
        draw();
        var out = tf.tidy(function () {
            var x = tf.div(tf.cast(tf.browser.fromPixels(canvas), 'float32'), 255);
            return model.predict(tf.reshape(x, [1, SIZE, SIZE, 3]));
        });
        return out.data().then(function (v) {
            out.dispose();
            var p = {};
            CLASSES.forEach(function (c, i) { p[c] = v[i]; });
            return p;
        });
    }
    // Hentai only counts alongside some Porn: photos of car interiors, leather and machinery score
    // 0.5-0.9 Hentai with Porn near 0. Drawn content with no Porn score needs `drawn` (below).
    function isNsfw(p) {
        var explicit = p.Porn >= 0.12 ? p.Porn + p.Hentai : p.Porn;
        return explicit >= 0.27 || p.Sexy >= 0.81 || explicit + 0.3 * p.Sexy >= 0.5;
    }
    function drawn(p, p2) { return p.Hentai >= 0.9 && p2.Hentai >= 0.9; } // whole image and crop agree
    // Whole image first; if borderline, also check a zoomed center crop.
    function classify(src, w, h) {
        return getModel().then(function (model) {
            var s = Math.min(SIZE / w, SIZE / h);
            return predict(model, function () {
                ctx.drawImage(src, 0, 0, w, h, (SIZE - w * s) / 2, (SIZE - h * s) / 2, w * s, h * s);
            }).then(function (p) {
                if (isNsfw(p)) return false;
                if (p.Neutral >= 0.6 && p.Porn + p.Hentai < 0.1 && p.Sexy < 0.4) return true;
                var side = Math.min(w, h);
                return predict(model, function () {
                    ctx.drawImage(src, (w - side) / 2, (h - side) / 2, side, side, 0, 0, SIZE, SIZE);
                }).then(function (p2) { return !isNsfw(p2) && !drawn(p, p2); });
            });
        });
    }

    // ----- job queue -----
    var active = 0, queue = [];
    function enqueue(fn) {
        return new Promise(function (resolve, reject) {
            queue.push(function () {
                var t;
                return Promise.race([fn(), new Promise(function (_, rej) { t = setTimeout(rej, 60000, new Error('job timeout')); })])
                    .then(resolve, reject)
                    .finally(function () { clearTimeout(t); });
            });
            pump();
        });
    }
    function pump() {
        while (active < MAX_PARALLEL && queue.length) {
            active++;
            queue.shift()().finally(function () { active--; pump(); });
        }
    }

    // ----- verdict cache -----
    // Loaded on first use (pages without images never read it); saved at most every 10 s and on leaving.
    var cache = {}, cacheReady = null, cacheTimer = null, hasStore = canStore;
    function loadCache() {
        return cacheReady || (cacheReady = blockCheck.then(function () { // a blocked domain classifies nothing
            if (!hasStore) return;
            return Promise.race([GM.getValue('cache2', {}), new Promise(function (r) { setTimeout(r, 1500, {}); })])
                .then(function (c) { cache = c || {}; }, function () {});
        }));
    }
    function saveCache() {
        clearTimeout(cacheTimer);
        cacheTimer = null;
        var keys = Object.keys(cache);
        if (keys.length > 3000) keys.slice(0, keys.length - 3000).forEach(function (k) { delete cache[k]; });
        try { GM.setValue('cache2', cache); } catch (e) {}
    }
    function cachePut(url, safe) {
        if (url.length > 500) return; // skip huge data: URLs
        cache[url] = safe ? 1 : 0;
        if (hasStore && !cacheTimer) cacheTimer = setTimeout(saveCache, 10000);
    }
    addEventListener('pagehide', function () { if (cacheTimer) saveCache(); });

    // ----- loading pixels -----
    // Draw `el` small on a FRESH canvas and read it back; throws if `el` is cross-origin. Never test on
    // the main canvas: one cross-origin draw taints it for good, and every later classification fails
    // with "The operation is insecure".
    function samplePixels(el, n) {
        var c = document.createElement('canvas');
        c.width = c.height = n;
        var x = c.getContext('2d');
        x.drawImage(el, 0, 0, n, n);
        return x.getImageData(0, 0, n, n).data;
    }
    function readable(el) {
        try { samplePixels(el, 1); return true; } catch (e) { return false; }
    }
    function classifyUrl(el, url) {
        if (el.tagName === 'IMG' && el.complete && el.naturalWidth && (el.currentSrc || el.src) === url && readable(el)) {
            return classify(el, el.naturalWidth, el.naturalHeight);
        }
        return get(url, 'blob').catch(function (e) { throw new Error('download: ' + e.message); })
            .then(decode).then(function (bmp) {
                if (bmp.width < MIN_SIZE || bmp.height < MIN_SIZE) return true;
                return classify(bmp, bmp.width, bmp.height).finally(function () { bmp.close && bmp.close(); });
            });
    }
    // createImageBitmap can't decode every format in Safari (e.g. SVG), so fall back to an <img>.
    function decode(blob) {
        return createImageBitmap(blob).catch(function () {
            return new Promise(function (resolve, reject) {
                var img = new Image(), u = URL.createObjectURL(blob);
                img.onload = function () { URL.revokeObjectURL(u); resolve(img); };
                img.onerror = function () { URL.revokeObjectURL(u); reject(new Error('decode: ' + (blob.type || 'unknown type'))); };
                img.src = u;
            });
        });
    }

    // ----- verdicts -----
    // Confirmed-NSFW media: links to its file are blocked. Videos are also stopped for good and their
    // player area is shielded, so "Download"/"Save" buttons next to it can't be tapped.
    var blockedUrls = {};
    function blockUrl(u) { try { if (u) blockedUrls[new URL(u, location.href).href] = 1; } catch (e) {} }
    function markLinks(root) {
        root.querySelectorAll('a[href]:not([data-nsfw-shield])').forEach(function (a) { if (blockedUrls[a.href]) shield(a); });
    }
    function lockVideo(v, fromFrame) {
        v._nsfwBad = true;
        v.pause();
        v.muted = true;
        [v.currentSrc, v.getAttribute('src')].forEach(blockUrl);
        v.querySelectorAll('source').forEach(function (s) { blockUrl(s.src); });
        // the player: the largest ancestor (up to 6 levels) that still covers less than 60% of the screen
        var box = v, screen = innerWidth * innerHeight;
        for (var el = v.parentElement, i = 0; el && i < 6; el = el.parentElement, i++) {
            var r = el.getBoundingClientRect();
            if (r.width * r.height > screen * 0.6) break;
            box = el;
        }
        shield(box);
        // Only a NSFW frame (not a poster) removes the source: a false positive would break the player for good.
        if (fromFrame) {
            v.removeAttribute('src');
            v.querySelectorAll('source').forEach(function (s) { s.remove(); });
            v.load();
        }
    }

    function verdict(el, safe, fromFrame) {
        if (safe && el._nsfwBad) return; // once NSFW, always NSFW
        if (safe) {
            counts.ok++;
            el.setAttribute('data-nsfw-safe', '');
            if (el.tagName === 'VIDEO') {
                el.disablePictureInPicture = false;
                if (el._nsfwMuted) { el._nsfwMuted = false; el.muted = false; }
            }
        }
        else {
            counts.nsfw++;
            el.removeAttribute('data-nsfw-safe');
            if (el.tagName === 'VIDEO') lockVideo(el, fromFrame);
            blockUrl(el._nsfwUrl);
            markLinks(document);
        }
        showCounts();
        if (counts.nsfw >= PAGE_BLOCK_NSFW && counts.nsfw / (counts.ok + counts.nsfw) >= PAGE_BLOCK_RATIO) blockPage(PAGE_BLOCK_MINUTES, 'images');
    }
    // Small iframes are nearly always ads/widgets: they don't each download the model (which slowed
    // the page's own download). Their small icons are still let through by size in check().
    function tinyFrame() { return window.top !== window.self && (innerWidth < MIN_FRAME || innerHeight < MIN_FRAME); }
    // An image shown in several places is downloaded and classified once. The job runs for the first
    // element still showing it when its turn comes.
    var pending = {};
    function classifyOnce(el, url) {
        var p = pending[url];
        if (p) { p.els.push(el); return p.job; }
        p = pending[url] = { els: [el] };
        p.job = enqueue(function () {
            var live = p.els.filter(function (e) { return e.isConnected && e._nsfwUrl === url; });
            if (!live.length) return Promise.reject(new Error('stale'));
            return classifyUrl(live[0], url);
        }).finally(function () { delete pending[url]; });
        return p.job;
    }
    function judge(el, url) {
        if (blocked || failed || tinyFrame()) return;
        try { url = new URL(url, location.href).href; } catch (e) { return; }
        if (el._nsfwUrl === url) return; // already checked or in progress
        el._nsfwUrl = url;
        loadCache().then(function () {
            if (blocked) return;
            if (url in cache) return verdict(el, !!cache[url]);
            classifyOnce(el, url).then(function (safe) {
                cachePut(url, safe);
                if (el._nsfwUrl === url) verdict(el, safe);
            }, function (e) {
                if (e.message === 'stale') {
                    // joined a shared job just as it was dropped: start a new one
                    if (el.isConnected && el._nsfwUrl === url) { el._nsfwUrl = null; judge(el, url); }
                    return;
                }
                // one retry after 4 s: most failures are a slow or dropped download
                if (!el._nsfwRetried) {
                    el._nsfwRetried = true;
                    return setTimeout(function () { if (el.isConnected && el._nsfwUrl === url) recheck(el); }, 4000);
                }
                counts.err++;
                lastErr = String(e.message).slice(0, 40);
                showCounts();
            });
        });
    }
    // SVG icons are safe, unless the SVG embeds a photo via <image>.
    function trustedSvg(url) {
        if (url.indexOf('data:image/svg') !== 0) return false;
        try {
            var i = url.indexOf(','), body = url.slice(i + 1);
            body = url.slice(0, i).indexOf(';base64') >= 0 ? atob(body) : decodeURIComponent(body);
            return !/<image[\s>]/i.test(body);
        } catch (e) { return false; }
    }
    function bgUrl(el) {
        var m = /url\(\s*["']?(.*?)["']?\s*\)/.exec(el.style.backgroundImage || '');
        return m && m[1];
    }
    function check(el) {
        var tag = el.tagName, url, w, h;
        if (tag === 'VIDEO') {
            if (el.poster) judge(el, el.poster);
        } else if (tag === 'IMG' || tag === 'image') {
            if (tag === 'IMG') {
                // Judged once loaded (see the 'load' listener): then its size is known, so icons need no
                // download, and currentSrc is the image actually shown, not the one it is replacing.
                if (!el.complete) return;
                url = el.currentSrc || el.src; w = el.naturalWidth; h = el.naturalHeight;
                el._nsfwShown = url;
                if (url && !w) return; // broken image: nothing to show
            }
            else { url = el.getAttribute('href') || el.getAttribute('xlink:href'); var r = el.getBoundingClientRect(); w = r.width; h = r.height; }
            if (!url) return; // no src yet (lazy image): re-checked on load / attribute change
            if (trustedSvg(url) || (w && (w < MIN_SIZE || h < MIN_SIZE))) return el.setAttribute('data-nsfw-safe', '');
            judge(el, url);
        } else {
            var bg = bgUrl(el);
            if (bg && !trustedSvg(bg)) judge(el, bg); else el.setAttribute('data-nsfw-safe', '');
        }
    }

    // Videos: check the current frame while playing; a safe frame unblurs, an NSFW frame stops it.
    function checkFrame(v) {
        if (v._nsfwBusy || v.paused || !v.videoWidth || blocked || failed || tinyFrame()) return;
        // unverified: every 3 s; already safe: every 12 s (to catch content that turns explicit later)
        if (v.hasAttribute('data-nsfw-safe') && Date.now() - (v._nsfwLast || 0) < 12000) return;
        v._nsfwLast = Date.now();
        v._nsfwBusy = true;
        enqueue(function () {
            if (!usableFrame(v)) { v._nsfwLast = 0; return Promise.reject(new Error('no usable frame')); }
            return classify(v, v.videoWidth, v.videoHeight);
        }).then(function (safe) { verdict(v, safe, true); }, function () {})
          .finally(function () { v._nsfwBusy = false; });
    }
    // iOS often returns a black frame right after play starts (and many videos open on black). The
    // model calls that "Neutral", so skip near-uniform frames. Cross-origin frames throw: also unusable.
    function usableFrame(v) {
        try {
            var px = samplePixels(v, 16), min = 255, max = 0;
            for (var i = 0; i < px.length; i += 4) {
                var l = (px[i] + px[i + 1] + px[i + 2]) / 3;
                if (l < min) min = l;
                if (l > max) max = l;
            }
            return max - min >= 16;
        } catch (e) { return false; }
    }
    var roots = [document]; // document + shadow roots, so videos inside web components get checked too
    setInterval(function () {
        roots = roots.filter(function (r) { return r === document || r.host.isConnected; });
        roots.forEach(function (r) { r.querySelectorAll('video').forEach(checkFrame); });
    }, 3000);

    // ----- 3. page-word check: block evident adult sites before anything is played or downloaded -----
    // Words alone never block: the site must also label itself adult (RTA/rating meta, 2257 or 18+
    // notice, explicit category menu). Search pages for an explicit query only count those self-labels.
    var HARD_ALL = new RegExp(HARD.source, 'g');
    var TX_2257 = /18\s*u\.?\s*s\.?\s*c\.?\s*(?:§|section|sec\.?)?\s*2257|2257\s*(?:record|compliance|statement)/;
    var TX_MODELS18 = /(?:models|persons|performers|individuals)[^.]{0,80}?(?:18\s*years?\s*of\s*age\s*or\s*older|at\s*least\s*18\s*years|over\s*(?:the\s*age\s*of\s*)?18)/;
    var TX_AGEGATE = /you\s+must\s+be\s+(?:at\s+least\s+)?18|i\s+am\s+(?:at\s+least\s+|over\s+)?18|are\s+you\s+(?:at\s+least\s+|over\s+)?18|enter\s+only\s+if\s+you\s+are/;
    function lower(t) { return (t || '').toLowerCase(); }
    function softWord(t) {
        var w = t.split(/[^a-z0-9]+/);
        for (var i = 0; i < w.length; i++) if (SOFT.test(w[i])) return w[i];
        return null;
    }
    function distinctTerms(t) { // variety counts, repetition doesn't
        return new Set(t.match(HARD_ALL)).size;
    }
    function pageText() { // at most ~30 KB of visible text (never innerText: it forces layout)
        var w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT), out = '', n;
        while (out.length < 30000 && (n = w.nextNode())) {
            var tag = n.parentNode.nodeName;
            if (tag !== 'SCRIPT' && tag !== 'STYLE' && tag !== 'NOSCRIPT') out += ' ' + n.nodeValue.slice(0, 200);
        }
        // 2257 notices live in the footer, often past the 30 KB
        [].slice.call(document.querySelectorAll('footer, #footer, .footer'), 0, 3).forEach(function (f) {
            out += ' ' + f.textContent.slice(0, 2000);
        });
        return lower(out);
    }
    function textScore() {
        var score = 0, identity = false, meta = '';
        [].slice.call(document.querySelectorAll('meta[content]'), 0, 80).forEach(function (m) {
            meta += ' ' + lower(m.name || m.getAttribute('property')) + '=' + lower(m.content).slice(0, 300);
        });
        if (/rta-5042-1996-1400-1577-rta/.test(meta)) { score += 6; identity = true; }
        else if (/rating=\s*(?:adult|mature|restricted)/.test(meta)) { score += 3; identity = true; }
        var query = lower(location.search);
        if (!HARD.test(query) && !softWord(query)) {
            if (HARD.test(lower(location.pathname))) score += 2;
            if (HARD.test(lower(document.title))) score += 2;
            score += Math.min(distinctTerms(meta), 2);
            var text = pageText();
            if (text.length >= 200) score += Math.min(distinctTerms(text), 4);
            var declared = (text.indexOf('2257') >= 0 && TX_2257.test(text)) || TX_MODELS18.test(text);
            if (declared) { score += 5; identity = true; }
            if (TX_AGEGATE.test(text) && (declared || HARD.test(text))) score += 2;
            // a menu of short explicit links = a tube site's category navigation
            var links = document.getElementsByTagName('a'), hits = 0, seen = {};
            for (var i = 0; i < links.length && i < 400; i++) {
                var t = lower(links[i].textContent);
                if (t.length > 40) continue;
                var m = t.match(HARD), term = m ? m[0] : softWord(t);
                if (term) { hits++; seen[term] = 1; }
            }
            if (hits >= 8 && Object.keys(seen).length >= 5) { score += 3; identity = true; }
        }
        return { score: score, block: identity && score >= 6 };
    }
    // Run when the page loads, then again as content arrives (max every 2 s, 5 times per page).
    var textSkip = hostIn(TEXT_SKIP) || window.top !== window.self, textRuns = 0, textLast = 0, textPath = '';
    function textCheck(force) {
        if (textSkip || blocked || !document.body || document.readyState === 'loading') return;
        if (location.pathname !== textPath) { textPath = location.pathname; textRuns = 0; force = true; }
        if (textRuns >= 5 || (!force && Date.now() - textLast < 2000)) return;
        textRuns++;
        textLast = Date.now();
        try {
            var r = textScore();
            if (r.block) blockPage(TEXT_BLOCK_MINUTES, 'page text, score ' + r.score);
        } catch (e) {}
    }

    // ----- watching the page -----
    var io = new IntersectionObserver(function (entries) {
        entries.forEach(function (en) {
            if (en.isIntersecting) { io.unobserve(en.target); en.target._nsfwSeen = true; check(en.target); }
        });
    }, { rootMargin: '150%' });
    function watch(el) {
        if (el._nsfwWatched) return;
        el._nsfwWatched = true;
        io.observe(el);
    }
    function recheck(el) {
        el.removeAttribute('data-nsfw-safe'); // re-blur until the new source is verified
        el._nsfwWatched = false;
        el._nsfwUrl = el._nsfwShown = null;
        watch(el);
    }
    function scan(root) {
        if (!root.querySelectorAll) return;
        if (MEDIA[root.tagName]) watch(root);
        root.querySelectorAll('img, video, image').forEach(watch);
        if (counts.nsfw) markLinks(root);
        // inline background-image thumbnails (only small containers, not whole page sections)
        root.querySelectorAll('[style*="url("]').forEach(function (el) {
            if (!el._nsfwWatched && bgUrl(el) && el.childElementCount <= 4) {
                el.setAttribute('data-nsfw-bg', '');
                watch(el);
            }
        });
    }
    function observe(root) {
        scan(root);
        new MutationObserver(function (muts) {
            ensureStyle();
            textCheck(false);
            muts.forEach(function (m) {
                if (m.type === 'attributes') {
                    var t = m.target;
                    if (MEDIA[t.tagName]) recheck(t);
                } else {
                    m.addedNodes.forEach(function (n) { if (n.nodeType === 1 && !n.hasAttribute('data-nsfw-ui')) scan(n); });
                }
            });
        }).observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['src', 'srcset', 'poster', 'href'] });
        // A near-screen image that finished loading, or now shows a different URL than the one judged
        // (lazy loaders swapping a placeholder, srcset). Off-screen images wait for the viewport observer.
        root.addEventListener('load', function (e) {
            var el = e.target;
            if (el.tagName !== 'IMG' || !el._nsfwSeen || el._nsfwShown === (el.currentSrc || el.src)) return;
            el.removeAttribute('data-nsfw-safe');
            check(el);
        }, true);
    }

    // Shadow DOM: document CSS doesn't reach inside, so each shadow root gets its own sheet + observer.
    var origAttach = Element.prototype.attachShadow;
    Element.prototype.attachShadow = function () {
        var root = origAttach.apply(this, arguments);
        try { addStyle(root); hookVideos(root); roots.push(root); observe(root); } catch (e) {}
        return root;
    };

    // Media is watched from document-start, so images unblur while the page is still loading
    // instead of after DOMContentLoaded (which waits for every blocking script).
    observe(document);
    function start() {
        status('running');
        textCheck(true);
    }
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
    else start();
})();
