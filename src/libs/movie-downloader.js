"use strict";
/**
 * @file movie-downloader.ts
 * @description Downloads movies from the screenfetch2.xyz / cloudnestra.com chain.
 *
 * Request chain:
 *  1. GET screenfetch2.xyz/embed/movie?tmdb={ID}&o=https%3A%2F%2Ffilmpire.sc
 *     → Parse iframe src → cloudnestra.com/rcp/{hash}
 *  2. GET cloudnestra.com/rcp/{hash}
 *     → Parse /prorcp/{hash2} from JS (loadIframe call)
 *  3. GET cloudnestra.com/prorcp/{hash2}
 *     → Parse Playerjs({file: "…{v1}…/master.m3u8 or …{v2}…"})
 *     → Parse test_doms[] to get candidate domain list
 *     → Replace {v1},{v2},… with corresponding domains
 *     → Try each m3u8 URL until one responds 200
 *  4. Download the working m3u8 via youtube-dl-exec (yt-dlp), save to tmp file.
 *
 * Domain-injection strategy (from the site's own test_doms array):
 *   {v1} → test_doms[0] host, {v2} → test_doms[1] host, …
 * Additional fallback {v5} uses the app2.{host} pattern from the last URL.
 *
 * Cloudflare bypass strategy:
 *   Raw HTTP fetch is tried first (fast, zero overhead on clean IPs).
 *   If the response is 403 / Cloudflare-blocked, we automatically fall back
 *   to a headless Chromium browser (Puppeteer) which passes bot challenges.
 *   Puppeteer is imported lazily — no startup cost unless the fallback fires.
 */
var __assign = (this && this.__assign) || function () {
    __assign = Object.assign || function(t) {
        for (var s, i = 1, n = arguments.length; i < n; i++) {
            s = arguments[i];
            for (var p in s) if (Object.prototype.hasOwnProperty.call(s, p))
                t[p] = s[p];
        }
        return t;
    };
    return __assign.apply(this, arguments);
};
var __awaiter = (this && this.__awaiter) || function (thisArg, _arguments, P, generator) {
    function adopt(value) { return value instanceof P ? value : new P(function (resolve) { resolve(value); }); }
    return new (P || (P = Promise))(function (resolve, reject) {
        function fulfilled(value) { try { step(generator.next(value)); } catch (e) { reject(e); } }
        function rejected(value) { try { step(generator["throw"](value)); } catch (e) { reject(e); } }
        function step(result) { result.done ? resolve(result.value) : adopt(result.value).then(fulfilled, rejected); }
        step((generator = generator.apply(thisArg, _arguments || [])).next());
    });
};
var __generator = (this && this.__generator) || function (thisArg, body) {
    var _ = { label: 0, sent: function() { if (t[0] & 1) throw t[1]; return t[1]; }, trys: [], ops: [] }, f, y, t, g = Object.create((typeof Iterator === "function" ? Iterator : Object).prototype);
    return g.next = verb(0), g["throw"] = verb(1), g["return"] = verb(2), typeof Symbol === "function" && (g[Symbol.iterator] = function() { return this; }), g;
    function verb(n) { return function (v) { return step([n, v]); }; }
    function step(op) {
        if (f) throw new TypeError("Generator is already executing.");
        while (g && (g = 0, op[0] && (_ = 0)), _) try {
            if (f = 1, y && (t = op[0] & 2 ? y["return"] : op[0] ? y["throw"] || ((t = y["return"]) && t.call(y), 0) : y.next) && !(t = t.call(y, op[1])).done) return t;
            if (y = 0, t) op = [op[0] & 2, t.value];
            switch (op[0]) {
                case 0: case 1: t = op; break;
                case 4: _.label++; return { value: op[1], done: false };
                case 5: _.label++; y = op[1]; op = [0]; continue;
                case 7: op = _.ops.pop(); _.trys.pop(); continue;
                default:
                    if (!(t = _.trys, t = t.length > 0 && t[t.length - 1]) && (op[0] === 6 || op[0] === 2)) { _ = 0; continue; }
                    if (op[0] === 3 && (!t || (op[1] > t[0] && op[1] < t[3]))) { _.label = op[1]; break; }
                    if (op[0] === 6 && _.label < t[1]) { _.label = t[1]; t = op; break; }
                    if (t && _.label < t[2]) { _.label = t[2]; _.ops.push(op); break; }
                    if (t[2]) _.ops.pop();
                    _.trys.pop(); continue;
            }
            op = body.call(thisArg, _);
        } catch (e) { op = [6, e]; y = 0; } finally { f = t = 0; }
        if (op[0] & 5) throw op[1]; return { value: op[0] ? op[1] : void 0, done: true };
    }
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.downloadM3u8 = downloadM3u8;
exports.downloadMovie = downloadMovie;
exports.getMovieStreamUrls = getMovieStreamUrls;
var https = require("https");
var http = require("http");
var zlib = require("zlib");
var fs = require("fs");
var path = require("path");
var os = require("os");
var youtube_dl_exec_1 = require("youtube-dl-exec");
// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
var EMBED_HOST = 'screenfetch2.xyz';
var CLOUDNESTRA_HOST = 'cloudnestra.com';
var FILMPIRE_ORIGIN = 'https://filmpire.sc';
/** Browser-like headers to avoid bot detection */
var BROWSER_HEADERS = {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/147.0.0.0 Safari/537.36 Edg/147.0.0.0',
    Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,image/apng,*/*;q=0.8',
    'Accept-Language': 'en-GB,en;q=0.9,en-US;q=0.8',
    'Accept-Encoding': 'gzip, deflate, br',
    DNT: '1',
    'Upgrade-Insecure-Requests': '1',
};
// ---------------------------------------------------------------------------
// HTTP helper: fetch raw HTML, following up to 3 redirects
// ---------------------------------------------------------------------------
/**
 * Module-level cookie jar: maps hostname → raw Cookie header value.
 * Populated from Set-Cookie response headers and re-sent on subsequent
 * requests to the same host, mimicking real browser session behaviour.
 */
var cookieJar = new Map();
/**
 * Parse Set-Cookie header(s) into name=value pairs and merge into the jar
 * for the given hostname.
 */
function absorbCookies(hostname, raw) {
    var _a;
    if (!raw)
        return;
    var entries = Array.isArray(raw) ? raw : [raw];
    var existing = {};
    // Parse already-stored cookies for this host
    var stored = cookieJar.get(hostname);
    if (stored) {
        for (var _i = 0, _b = stored.split(';'); _i < _b.length; _i++) {
            var pair = _b[_i];
            var _c = pair.trim().split('='), k = _c[0], rest = _c.slice(1);
            if (k)
                existing[k.trim()] = rest.join('=');
        }
    }
    // Merge new cookies (only name=value, ignore attributes like Path/Expires)
    for (var _d = 0, entries_1 = entries; _d < entries_1.length; _d++) {
        var entry = entries_1[_d];
        var nameValue = (_a = entry.split(';')[0]) === null || _a === void 0 ? void 0 : _a.trim();
        if (!nameValue)
            continue;
        var eqIdx = nameValue.indexOf('=');
        if (eqIdx < 1)
            continue;
        var name_1 = nameValue.slice(0, eqIdx).trim();
        var value = nameValue.slice(eqIdx + 1).trim();
        existing[name_1] = value;
    }
    cookieJar.set(hostname, Object.entries(existing)
        .map(function (_a) {
        var k = _a[0], v = _a[1];
        return "".concat(k, "=").concat(v);
    })
        .join('; '));
}
/**
 * Fetch URL as a browser would: follows redirects, decompresses gzip/br/deflate,
 * and maintains a per-hostname cookie jar across calls.
 */
function fetchHtml(url, extraHeaders, maxRedirects) {
    if (extraHeaders === void 0) { extraHeaders = {}; }
    if (maxRedirects === void 0) { maxRedirects = 5; }
    return new Promise(function (resolve, reject) {
        var attempt = function (targetUrl, redirectsLeft) {
            var parsed = new URL(targetUrl);
            var lib = parsed.protocol === 'https:' ? https : http;
            // Attach any previously collected cookies for this host
            var jar = cookieJar.get(parsed.hostname);
            var cookieHeader = jar ? { Cookie: jar } : {};
            var options = {
                hostname: parsed.hostname,
                port: parsed.port || (parsed.protocol === 'https:' ? 443 : 80),
                path: parsed.pathname + parsed.search,
                method: 'GET',
                headers: __assign(__assign(__assign(__assign({}, BROWSER_HEADERS), { Host: parsed.hostname }), cookieHeader), extraHeaders),
            };
            var req = lib.request(options, function (res) {
                // Collect Set-Cookie from every response (including redirects)
                absorbCookies(parsed.hostname, res.headers['set-cookie']);
                // Follow redirect
                if (res.statusCode &&
                    res.statusCode >= 300 &&
                    res.statusCode < 400 &&
                    res.headers.location) {
                    if (redirectsLeft <= 0) {
                        reject(new Error("Too many redirects from ".concat(targetUrl)));
                        return;
                    }
                    var nextUrl = res.headers.location;
                    if (nextUrl.startsWith('/')) {
                        nextUrl = "".concat(parsed.protocol, "//").concat(parsed.host).concat(nextUrl);
                    }
                    res.resume();
                    attempt(nextUrl, redirectsLeft - 1);
                    return;
                }
                if (res.statusCode && res.statusCode >= 400) {
                    res.resume();
                    reject(new Error("HTTP ".concat(res.statusCode, " from ").concat(targetUrl)));
                    return;
                }
                // Decompress response based on Content-Encoding header
                var encoding = res.headers['content-encoding'];
                var stream = res;
                if (encoding === 'gzip') {
                    stream = res.pipe(zlib.createGunzip());
                }
                else if (encoding === 'deflate') {
                    stream = res.pipe(zlib.createInflate());
                }
                else if (encoding === 'br') {
                    stream = res.pipe(zlib.createBrotliDecompress());
                }
                var chunks = [];
                stream.on('data', function (c) { return chunks.push(c); });
                stream.on('end', function () { return resolve(Buffer.concat(chunks).toString('utf-8')); });
                stream.on('error', reject);
            });
            req.on('error', reject);
            req.setTimeout(15000, function () {
                req.destroy(new Error("Timeout fetching ".concat(targetUrl)));
            });
            req.end();
        };
        attempt(url, maxRedirects);
    });
}
// ---------------------------------------------------------------------------
// Cloudflare-aware HTML fetch: raw HTTP with Puppeteer fallback
// ---------------------------------------------------------------------------
/**
 * Detects whether an HTTP error (or HTML string) indicates Cloudflare blocked us.
 * Cloudflare returns 403 or a 200 with a challenge page when blocking bots.
 */
function isCloudflareBlock(err, html) {
    if (err instanceof Error && err.message.includes('HTTP 403'))
        return true;
    if (html) {
        // Cloudflare challenge pages contain these markers
        return (html.includes('cf-browser-verification') ||
            html.includes('cf_chl_') ||
            html.includes('Cloudflare Ray ID') ||
            (html.includes('Just a moment') && html.includes('cloudflare')));
    }
    return false;
}
/**
 * Fetch the fully-rendered HTML of a page using Puppeteer (headless Chromium).
 * Used as a fallback when Cloudflare blocks raw Node.js HTTP requests.
 * Puppeteer bundles its own Chromium — no separate install step needed.
 */
function fetchHtmlViaBrowser(url, referer) {
    return __awaiter(this, void 0, void 0, function () {
        var response, errorText, data, err_1;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 5, , 6]);
                    return [4 /*yield*/, fetch('http://127.0.0.1:8000/get_html', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ url: url }),
                        })];
                case 1:
                    response = _a.sent();
                    if (!!response.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, response.text()];
                case 2:
                    errorText = _a.sent();
                    throw new Error("Python API failed: ".concat(response.status, " ").concat(errorText));
                case 3: return [4 /*yield*/, response.json()];
                case 4:
                    data = (_a.sent());
                    return [2 /*return*/, data.html];
                case 5:
                    err_1 = _a.sent();
                    throw err_1;
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Extract the /prorcp/ URL from the cloudnestra /rcp/ page using a local Python SeleniumBase API.
 * The python server bypasses Cloudflare and extracts the URL.
 */
function browserGetProRcpUrl(rcpUrl) {
    return __awaiter(this, void 0, void 0, function () {
        var response, errorText, data, err_2;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 5, , 6]);
                    return [4 /*yield*/, fetch('http://127.0.0.1:8000/get_prorcp', {
                            method: 'POST',
                            headers: {
                                'Content-Type': 'application/json',
                            },
                            body: JSON.stringify({ url: rcpUrl }),
                        })];
                case 1:
                    response = _a.sent();
                    if (!!response.ok) return [3 /*break*/, 3];
                    return [4 /*yield*/, response.text()];
                case 2:
                    errorText = _a.sent();
                    throw new Error("Python API failed: ".concat(response.status, " ").concat(errorText));
                case 3: return [4 /*yield*/, response.json()];
                case 4:
                    data = (_a.sent());
                    return [2 /*return*/, data.url];
                case 5:
                    err_2 = _a.sent();
                    throw err_2;
                case 6: return [2 /*return*/];
            }
        });
    });
}
/**
 * Fetch HTML for a URL — fast raw HTTP first, Playwright fallback on Cloudflare block.
 *
 * @param url          Target URL
 * @param extraHeaders Additional HTTP headers(e.g.Referer, Sec - Fetch -*)
 * @param referer      Referer to pass to the browser fallback(optional)
 */
function fetchHtmlWithFallback(url_1) {
    return __awaiter(this, arguments, void 0, function (url, extraHeaders, referer) {
        var html, err_3;
        if (extraHeaders === void 0) { extraHeaders = {}; }
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, fetchHtml(url, extraHeaders)];
                case 1:
                    html = _a.sent();
                    // Cloudflare can return 200 with a challenge page instead of 403
                    if (isCloudflareBlock(null, html)) {
                        return [2 /*return*/, fetchHtmlViaBrowser(url, referer !== null && referer !== void 0 ? referer : extraHeaders['Referer'])];
                    }
                    return [2 /*return*/, html];
                case 2:
                    err_3 = _a.sent();
                    if (isCloudflareBlock(err_3)) {
                        return [2 /*return*/, fetchHtmlViaBrowser(url, referer !== null && referer !== void 0 ? referer : extraHeaders['Referer'])];
                    }
                    throw err_3;
                case 3: return [2 /*return*/];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// HTTP HEAD check: verify an m3u8 URL is reachable
// ---------------------------------------------------------------------------
function headCheck(url, timeoutMs) {
    if (timeoutMs === void 0) { timeoutMs = 8000; }
    return new Promise(function (resolve) {
        try {
            var parsed = new URL(url);
            var lib = parsed.protocol === 'https:' ? https : http;
            var req_1 = lib.request({
                hostname: parsed.hostname,
                port: parsed.port || 443,
                path: parsed.pathname + parsed.search,
                method: 'HEAD',
                headers: {
                    'User-Agent': BROWSER_HEADERS['User-Agent'],
                },
            }, function (res) {
                res.resume();
                resolve(!!(res.statusCode && res.statusCode < 400));
            });
            req_1.setTimeout(timeoutMs, function () {
                req_1.destroy();
                resolve(false);
            });
            req_1.on('error', function () { return resolve(false); });
            req_1.end();
        }
        catch (_a) {
            resolve(false);
        }
    });
}
// ---------------------------------------------------------------------------
// Step 1: Get /rcp/{hash} URL from screenfetch2 embed page
// ---------------------------------------------------------------------------
/**
 * Fetches the screenfetch2.xyz embed page and extracts the cloudnestra /rcp/ URL
 * from the iframe src attribute.
 */
function getRcpUrl(tmdbId, mediaType) {
    return __awaiter(this, void 0, void 0, function () {
        var type, embedUrl, html, rcpMatch;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    type = mediaType === 'tv' ? 'tv' : 'movie';
                    embedUrl = "https://".concat(EMBED_HOST, "/embed/").concat(type, "?tmdb=").concat(tmdbId, "&o=").concat(encodeURIComponent(FILMPIRE_ORIGIN));
                    return [4 /*yield*/, fetchHtmlWithFallback(embedUrl, {
                            Referer: "".concat(FILMPIRE_ORIGIN, "/"),
                            'Sec-Fetch-Dest': 'iframe',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-Site': 'cross-site',
                        }, "".concat(FILMPIRE_ORIGIN, "/"))];
                case 1:
                    html = _a.sent();
                    rcpMatch = html.match(/src=["'](?:https?:)?\/\/cloudnestra\.com(\/rcp\/[^"']+)["']/i);
                    if (!rcpMatch || !rcpMatch[1]) {
                        throw new Error('Could not find /rcp/ iframe src in screenfetch2 embed page');
                    }
                    return [2 /*return*/, "https://".concat(CLOUDNESTRA_HOST).concat(rcpMatch[1])];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Step 2: Get /prorcp/{hash} URL from the cloudnestra /rcp/ page
// ---------------------------------------------------------------------------
/**
 * Fetches the cloudnestra /rcp/ page and extracts the /prorcp/ URL
 * from the loadIframe() JS call.
 */
function getProRcpUrl(rcpUrl) {
    return __awaiter(this, void 0, void 0, function () {
        var html, proRcpMatch, err_4;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _a.trys.push([0, 2, , 3]);
                    return [4 /*yield*/, fetchHtml(rcpUrl, {
                            Referer: "https://".concat(EMBED_HOST, "/"),
                            'Sec-Fetch-Dest': 'iframe',
                            'Sec-Fetch-Mode': 'navigate',
                            'Sec-Fetch-Site': 'cross-site',
                        })];
                case 1:
                    html = _a.sent();
                    if (!isCloudflareBlock(null, html)) {
                        proRcpMatch = html.match(/['"]\/prorcp\/([^'"]+)['"]/i);
                        if (proRcpMatch && proRcpMatch[1]) {
                            return [2 /*return*/, "https://".concat(CLOUDNESTRA_HOST, "/prorcp/").concat(proRcpMatch[1])];
                        }
                    }
                    return [3 /*break*/, 3];
                case 2:
                    err_4 = _a.sent();
                    if (!isCloudflareBlock(err_4))
                        throw err_4;
                    return [3 /*break*/, 3];
                case 3: 
                // Cloudflare blocked — use browser with request interception
                return [2 /*return*/, browserGetProRcpUrl(rcpUrl)];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Step 3: Extract m3u8 URLs from the /prorcp/ player page
// ---------------------------------------------------------------------------
/**
 * Fetches the cloudnestra /prorcp/ page and extracts:
 *  - The `file:` string from `new Playerjs({…})`
 *  - The `test_doms` array
 *  - Any filename hint from `atob(…)` in `var flnm`
 *
 * Then resolves {v1},{v2},… placeholders using test_doms domain suffixes.
 */
function extractM3u8Urls(proRcpUrl) {
    return __awaiter(this, void 0, void 0, function () {
        var html, testDomsMatch, testDoms, rawDoms, domMatches, fileMatch, rawFileStr, rawUrls, resolvedUrls, _i, rawUrls_1, rawUrl, placeholders, resolved, _a, placeholders_1, ph, vNum, domainIdx, domEntry, domHost, tldPart, lastDom, domHost, tldPart, filenamehint, flnmMatch, decoded, parts;
        var _b, _c;
        return __generator(this, function (_d) {
            switch (_d.label) {
                case 0: return [4 /*yield*/, fetchHtmlWithFallback(proRcpUrl, {
                        Referer: "https://".concat(CLOUDNESTRA_HOST, "/rcp/"),
                        'Sec-Fetch-Dest': 'iframe',
                        'Sec-Fetch-Mode': 'navigate',
                        'Sec-Fetch-Site': 'same-origin',
                    }, "https://".concat(CLOUDNESTRA_HOST, "/rcp/"))];
                case 1:
                    html = _d.sent();
                    testDomsMatch = html.match(/var\s+test_doms\s*=\s*\[([^\]]+)\]/);
                    testDoms = [];
                    if (testDomsMatch && testDomsMatch[1]) {
                        rawDoms = testDomsMatch[1];
                        domMatches = rawDoms.match(/["']([^"']+)["']/g);
                        if (domMatches) {
                            testDoms = domMatches.map(function (d) { return d.replace(/['"]/g, '').trim(); });
                        }
                    }
                    // Fallback domains from the known list (in case the array isn't in HTML)
                    if (testDoms.length === 0) {
                        testDoms = [
                            'https://tmstr1.neonhorizonworkshops.com',
                            'https://fasdf1.wanderlynest.com',
                            'https://tmstr1.orchidpixelgardens.com',
                            'https://tmstr1.cloudnestra.com',
                        ];
                    }
                    fileMatch = html.match(/new\s+Playerjs\s*\(\s*\{[\s\S]*?file\s*:\s*["']([^"']+)["']/);
                    if (!fileMatch || !fileMatch[1]) {
                        throw new Error('Could not find Playerjs file: parameter in prorcp page');
                    }
                    rawFileStr = fileMatch[1];
                    rawUrls = rawFileStr
                        .split(/\s+or\s+/)
                        .map(function (u) { return u.trim(); })
                        .filter(Boolean);
                    resolvedUrls = [];
                    for (_i = 0, rawUrls_1 = rawUrls; _i < rawUrls_1.length; _i++) {
                        rawUrl = rawUrls_1[_i];
                        placeholders = rawUrl.match(/\{v(\d+)\}/g);
                        if (!placeholders || placeholders.length === 0) {
                            // No placeholder → use as-is
                            resolvedUrls.push(rawUrl);
                            continue;
                        }
                        resolved = rawUrl;
                        for (_a = 0, placeholders_1 = placeholders; _a < placeholders_1.length; _a++) {
                            ph = placeholders_1[_a];
                            vNum = parseInt(ph.replace(/\{v(\d+)\}/, '$1'), 10);
                            domainIdx = vNum - 1;
                            if (domainIdx >= 0 && domainIdx < testDoms.length) {
                                domEntry = testDoms[domainIdx];
                                domHost = new URL(domEntry).hostname;
                                tldPart = domHost.includes('.') ? domHost.split('.').slice(1).join('.') : domHost;
                                resolved = resolved.replace(ph, tldPart);
                            }
                            else {
                                lastDom = (_b = testDoms[testDoms.length - 1]) !== null && _b !== void 0 ? _b : '';
                                if (lastDom) {
                                    domHost = new URL(lastDom).hostname;
                                    tldPart = domHost.includes('.') ? domHost.split('.').slice(1).join('.') : domHost;
                                    resolved = resolved.replace(ph, tldPart);
                                }
                            }
                        }
                        resolvedUrls.push(resolved);
                    }
                    filenamehint = '';
                    flnmMatch = html.match(/var\s+flnm\s*=\s*removeExtension\s*\(\s*atob\s*\(\s*['"]([^'"]+)['"]\s*\)/);
                    if (flnmMatch && flnmMatch[1]) {
                        try {
                            decoded = Buffer.from(flnmMatch[1], 'base64').toString('utf-8');
                            parts = decoded.split('/');
                            filenamehint = (_c = parts[parts.length - 1]) !== null && _c !== void 0 ? _c : decoded;
                        }
                        catch (_e) {
                            // ignore
                        }
                    }
                    resolvedUrls.forEach(function (u, i) { return console.log("  [".concat(i, "] ").concat(u)); });
                    return [2 /*return*/, { urls: resolvedUrls, filenamehint: filenamehint }];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Step 4: Find the first reachable m3u8 URL
// ---------------------------------------------------------------------------
/**
 * Checks each resolved m3u8 URL with a HEAD request and returns the first
 * one that responds successfully. Falls back to the first URL if none pass.
 */
function pickWorkingUrl(urls) {
    return __awaiter(this, void 0, void 0, function () {
        var _i, urls_1, url, ok;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0:
                    _i = 0, urls_1 = urls;
                    _a.label = 1;
                case 1:
                    if (!(_i < urls_1.length)) return [3 /*break*/, 4];
                    url = urls_1[_i];
                    return [4 /*yield*/, headCheck(url)];
                case 2:
                    ok = _a.sent();
                    if (ok) {
                        return [2 /*return*/, url];
                    }
                    _a.label = 3;
                case 3:
                    _i++;
                    return [3 /*break*/, 1];
                case 4:
                    // Fallback: just use the first URL and hope for the best
                    console.log('[MovieDL] No reachable URL found via HEAD; falling back to first URL');
                    return [2 /*return*/, urls[0]];
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Step 5: Download via yt-dlp
// ---------------------------------------------------------------------------
/**
 * Downloads the HLS stream at `m3u8Url` to a temporary mp4 file using yt-dlp.
 * Calls `onProgress` periodically with status updates.
 *
 * @returns Path to the downloaded file
 */
function downloadM3u8(m3u8Url, title, onProgress, outputDir) {
    return __awaiter(this, void 0, void 0, function () {
        var safeTitle, tmpDir, outputPath, titleBase, _i, _a, ext, candidate;
        return __generator(this, function (_b) {
            switch (_b.label) {
                case 0:
                    safeTitle = title.replace(/[^\w\s\-().]/g, '').trim().slice(0, 60);
                    tmpDir = outputDir !== null && outputDir !== void 0 ? outputDir : os.tmpdir();
                    outputPath = path.join(tmpDir, "".concat(safeTitle, ".%(ext)s"));
                    return [4 /*yield*/, onProgress('📥 *Downloading movie stream...*')];
                case 1:
                    _b.sent();
                    return [4 /*yield*/, (0, youtube_dl_exec_1.default)(m3u8Url, {
                            output: outputPath,
                            // Best video+audio
                            format: 'bestvideo[ext=mp4]+bestaudio[ext=m4a]/best[ext=mp4]/best',
                            mergeOutputFormat: 'mp4',
                            // Spoof browser
                            addHeader: [
                                "Referer:https://".concat(CLOUDNESTRA_HOST, "/"),
                                "User-Agent:".concat(BROWSER_HEADERS['User-Agent']),
                            ],
                            // HLS-specific
                            hlsPreferNative: true,
                            noWarnings: true,
                            noCheckCertificate: true,
                            retries: 5,
                            fragmentRetries: 10,
                        })];
                case 2:
                    _b.sent();
                    titleBase = path.join(tmpDir, safeTitle);
                    for (_i = 0, _a = ['mp4', 'mkv', 'ts', 'webm']; _i < _a.length; _i++) {
                        ext = _a[_i];
                        candidate = "".concat(titleBase, ".").concat(ext);
                        if (fs.existsSync(candidate)) {
                            return [2 /*return*/, candidate];
                        }
                    }
                    throw new Error("yt-dlp completed but output file not found in ".concat(tmpDir));
            }
        });
    });
}
// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------
/**
 * Full pipeline: TMDB ID → screenfetch2 embed → cloudnestra chain → download.
 *
 * @param tmdbId     TMDB movie/show ID
 * @param mediaType  'movie' or 'tv'
 * @param title      Human-readable title (for filename & caption)
 * @param onProgress Callback for WhatsApp status updates
 * @returns          Path + metadata of the downloaded file
 */
function downloadMovie(tmdbId, mediaType, title, onProgress) {
    return __awaiter(this, void 0, void 0, function () {
        var rcpUrl, proRcpUrl, m3u8Info, workingUrl, filePath, filename;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, onProgress('🔗 *Fetching video sources...*')];
                case 1:
                    _a.sent();
                    return [4 /*yield*/, getRcpUrl(tmdbId, mediaType)];
                case 2:
                    rcpUrl = _a.sent();
                    return [4 /*yield*/, getProRcpUrl(rcpUrl)];
                case 3:
                    proRcpUrl = _a.sent();
                    return [4 /*yield*/, extractM3u8Urls(proRcpUrl)];
                case 4:
                    m3u8Info = _a.sent();
                    if (m3u8Info.urls.length === 0) {
                        throw new Error('No m3u8 stream URLs found for this title');
                    }
                    // Step 4
                    return [4 /*yield*/, onProgress('🌐 *Probing stream servers...*')];
                case 5:
                    // Step 4
                    _a.sent();
                    return [4 /*yield*/, pickWorkingUrl(m3u8Info.urls)];
                case 6:
                    workingUrl = _a.sent();
                    return [4 /*yield*/, downloadM3u8(workingUrl, title, onProgress)];
                case 7:
                    filePath = _a.sent();
                    filename = m3u8Info.filenamehint
                        ? m3u8Info.filenamehint.replace(/\.[^.]+$/, '') + '.mp4'
                        : "".concat(title, ".mp4");
                    return [2 /*return*/, {
                            filePath: filePath,
                            filename: filename,
                            mimetype: 'video/mp4',
                            caption: "\uD83C\uDFAC *".concat(title, "*\n") +
                                "\uD83D\uDCE5 Downloaded via CloudNestra\n" +
                                "_".concat(filename, "_"),
                        }];
            }
        });
    });
}
/**
 * Only resolves and returns the m3u8 URL(s) without downloading.
 * Useful for generating a watch/stream link.
 *
 * @returns Array of resolved m3u8 URLs (best quality first)
 */
function getMovieStreamUrls(tmdbId, mediaType) {
    return __awaiter(this, void 0, void 0, function () {
        var rcpUrl, proRcpUrl, info;
        return __generator(this, function (_a) {
            switch (_a.label) {
                case 0: return [4 /*yield*/, getRcpUrl(tmdbId, mediaType)];
                case 1:
                    rcpUrl = _a.sent();
                    return [4 /*yield*/, getProRcpUrl(rcpUrl)];
                case 2:
                    proRcpUrl = _a.sent();
                    return [4 /*yield*/, extractM3u8Urls(proRcpUrl)];
                case 3:
                    info = _a.sent();
                    return [2 /*return*/, info.urls];
            }
        });
    });
}
