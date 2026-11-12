// ==UserScript==
// @name         YTDL
// @namespace    ytdl-userscript
// @version      1.0.0
// @description  Download any YouTube video in any available format.
// @author       sunuazizrahayu
// @license      MIT
// @homepageURL  https://github.com/sunuazizrahayu/ytdl-userscript
// @supportURL   https://github.com/sunuazizrahayu/ytdl-userscript/issues
// @updateURL    https://github.com/sunuazizrahayu/ytdl-userscript/releases/latest/download/ytdl.user.js
// @downloadURL  https://github.com/sunuazizrahayu/ytdl-userscript/releases/latest/download/ytdl.user.js
// @match        https://www.youtube.com/*
// @match        https://m.youtube.com/*
// @icon         https://www.youtube.com/favicon.ico
// @require      https://cdn.jsdelivr.net/npm/mp4box@0.5.2/dist/mp4box.all.min.js
// @run-at       document-start
// @grant        none
// @noframes
// ==/UserScript==

(function () {
  'use strict';

  if (window.__ytDownloaderLoaded) return;
  window.__ytDownloaderLoaded = true;

  /* ============================================================
   * CONFIGURATION
   * ============================================================ */
  const DEBUG = false;
  const VERSION = '1.0.0';

  const log = (...a) => DEBUG && console.log('[YT-DL]', ...a);
  console.info(`[YT-DL] v${VERSION} active on`, location.href);

  /* ============================================================
   * DOM HELPERS
   * ============================================================ */
  function h(tag, props, ...children) {
    const node = document.createElement(tag);
    if (props) {
      for (const [key, val] of Object.entries(props)) {
        if (val === undefined || val === null || val === false) continue;
        if (key === 'class') node.className = val;
        else if (key === 'text') node.textContent = val;
        else if (key === 'dataset') Object.assign(node.dataset, val);
        else if (key.startsWith('on') && typeof val === 'function') {
          node.addEventListener(key.slice(2).toLowerCase(), val);
        } else node.setAttribute(key, val === true ? '' : String(val));
      }
    }
    for (const child of children.flat()) {
      if (child === undefined || child === null || child === false) continue;
      node.append(child instanceof Node ? child : document.createTextNode(String(child)));
    }
    return node;
  }

  // Icons are built via createElementNS — REQUIRED, because YouTube uses
  // CSP Trusted Types, which blocks innerHTML.
  function svgIcon() {
    const NS = 'http://www.w3.org/2000/svg';
    const make = (tag, attrs) => {
      const el = document.createElementNS(NS, tag);
      for (const [k, v] of Object.entries(attrs)) el.setAttribute(k, v);
      return el;
    };
    const svg = make('svg', {
      viewBox: '0 0 24 24',
      width: '15',
      height: '15',
      fill: 'currentColor',
      'aria-hidden': 'true',
    });
    svg.append(
      make('path', {
        d: 'M12 3a1 1 0 0 1 1 1v9.6l3.3-3.3a1 1 0 1 1 1.4 1.4l-5 5a1 1 0 0 1-1.4 0l-5-5a1 1 0 0 1 1.4-1.4L11 13.6V4a1 1 0 0 1 1-1Z',
      }),
      make('path', {
        d: 'M4 18a1 1 0 0 1 1 1v1h14v-1a1 1 0 1 1 2 0v1.5A1.5 1.5 0 0 1 19.5 22h-15A1.5 1.5 0 0 1 3 20.5V19a1 1 0 0 1 1-1Z',
      }),
    );
    return svg;
  }

  const $ = (sel, root = document) => root.querySelector(sel);

  function formatBytes(n) {
    const num = Number(n);
    if (!num || !isFinite(num)) return '—';
    const units = ['B', 'KB', 'MB', 'GB'];
    let i = 0;
    let v = num;
    while (v >= 1024 && i < units.length - 1) {
      v /= 1024;
      i += 1;
    }
    return `${i === 0 ? v : v < 10 ? v.toFixed(1) : Math.round(v)} ${units[i]}`;
  }

  function sanitize(name) {
    return String(name || 'video')
      .replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 120) || 'video';
  }

  /* ============================================================
   * STATE
   * ============================================================ */
  const state = {
    btn: null,
    bar: null,
    slot: null,
    panel: null,
    mode: 'attached',
    response: null,
    source: 'player',
    formats: [],
    videoId: null,
    downloads: new Map(), // key -> download entry (running/done/error)
    lastResult: null,
    restore: null,
  };

  // Stable key for a row, so progress stays attached even when the
  // format list is re-rendered (open/close panel, switch video, ⟳).
  const dlKey = (f, vid) => `${vid || 'x'}|${f.kind}|${f.itag}|${f.audioItag || ''}`;

  function runningDownloads() {
    return [...state.downloads.values()].filter((d) => d.status === 'running');
  }

  /* ============================================================
   * FETCH VIDEO DATA
   * ============================================================ */
  function currentVideoId() {
    const url = new URL(location.href);
    if (url.pathname.startsWith('/shorts/')) return url.pathname.split('/')[2] || null;
    if (url.pathname.startsWith('/live/')) return url.pathname.split('/')[2] || null;
    return url.searchParams.get('v');
  }

  function getPlayerResponse() {
    let pr = null;
    try {
      const player = document.getElementById('movie_player');
      if (player && typeof player.getPlayerResponse === 'function') {
        pr = player.getPlayerResponse();
      }
    } catch (err) {
      log('getPlayerResponse failed', err);
    }
    if (!pr || !pr.streamingData) {
      const init = window.ytInitialPlayerResponse;
      if (init && init.streamingData) pr = init;
    }
    if (!pr) return null;

    const vid = currentVideoId();
    const prVid = pr.videoDetails && pr.videoDetails.videoId;
    if (vid && prVid && vid !== prVid) return null; // stale data after switching video (SPA)
    return pr;
  }

  /* ============================================================
   * STREAM URL CAPTURE
   * YouTube sometimes does not put the URL in streamingData, but the player
   * still requests /videoplayback. We record the URL here.
   * ============================================================ */
  const captured = new Map(); // itag -> url
  let captureTimer = null;

  function scheduleCaptureRender() {
    if (!state.panel || !state.panel.classList.contains('ytdl-open')) return;
    clearTimeout(captureTimer);
    captureTimer = setTimeout(() => {
      loadFormats();
    }, 400);
  }

  function rememberUrl(raw) {
    if (!raw || typeof raw !== 'string' || raw.indexOf('/videoplayback') === -1) return;
    let url;
    try {
      url = new URL(raw, location.href);
    } catch (err) {
      return;
    }
    const itag = Number(url.searchParams.get('itag'));
    if (!itag) return;

    // Strip the range parameters so we get the full file.
    url.searchParams.delete('range');
    url.searchParams.delete('rn');
    url.searchParams.delete('rbuf');
    url.searchParams.delete('ump');

    const value = url.toString();
    if (captured.get(itag) !== value) {
      captured.set(itag, value);
      log('URL captured for itag', itag);
      scheduleCaptureRender();
    }
  }

  function hookNetwork() {
    try {
      const proto = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
      if (proto && !proto.__ytdlHooked) {
        const origOpen = proto.open;
        proto.open = function (method, url) {
          try {
            rememberUrl(String(url));
          } catch (err) { /* ignore */ }
          return origOpen.apply(this, arguments);
        };
        proto.__ytdlHooked = true;
      }
    } catch (err) {
      log('failed to hook XHR', err);
    }

    try {
      if (window.fetch && !window.fetch.__ytdlHooked) {
        const origFetch = window.fetch;
        const patched = function (input) {
          try {
            const url = typeof input === 'string' ? input : (input && input.url);
            if (url) rememberUrl(String(url));
          } catch (err) { /* ignore */ }
          return origFetch.apply(this, arguments);
        };
        patched.__ytdlHooked = true;
        window.fetch = patched;
      }
    } catch (err) {
      log('failed to hook fetch', err);
    }

    try {
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) rememberUrl(entry.name);
      }).observe({ type: 'resource', buffered: true });
    } catch (err) {
      log('PerformanceObserver not available', err);
    }
  }

  /* ============================================================
   * FORMAT SOURCE: innertube
   * VISIONOS provides URLs that can be fetched in full (all offsets).
   * The ANDROID client without a PO token only allows the first ~16 MB
   * per URL — enough to start playback, but downloads stop at
   * 16 MB with a 403. That is why VISIONOS is used first, then the
   * ANDROID format list (more complete) is merged in.
   * ============================================================ */
  const API_CLIENTS = [
    {
      clientName: 'VISIONOS', clientVersion: '1.02', __id: 101,
      deviceMake: 'Apple', deviceModel: 'RealityDevice17,1',
      osName: 'visionOS', osVersion: '26.5.23O471',
    },
    {
      clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 34,
      osName: 'Android', osVersion: '14', __id: 3,
    },
    {
      clientName: 'ANDROID_VR', clientVersion: '1.62.27', androidSdkVersion: 32,
      osName: 'Android', osVersion: '12', deviceMake: 'Oculus', deviceModel: 'Quest 3', __id: 28,
    },
    {
      clientName: 'IOS', clientVersion: '20.10.4', deviceMake: 'Apple',
      deviceModel: 'iPhone16,2', osName: 'iPhone', osVersion: '18.3.2.22D82', __id: 5,
    },
  ];

  let lastApiNote = '';

  function visitorData() {
    try {
      const cfg = window.ytcfg;
      const v = cfg && typeof cfg.get === 'function' ? cfg.get('VISITOR_DATA') : null;
      return typeof v === 'string' ? v : '';
    } catch (err) {
      return '';
    }
  }

  function apiContext(client) {
    const visitor = visitorData();
    const cfg = window.ytcfg;
    const pick = (name, fallback) => {
      try {
        const v = cfg && typeof cfg.get === 'function' ? cfg.get(name) : null;
        return typeof v === 'string' && v ? v : fallback;
      } catch (err) {
        return fallback;
      }
    };
    const base = {
      ...client,
      hl: pick('HL', 'en'),
      gl: pick('GL', 'US'),
    };
    delete base.__id;
    if (visitor) base.visitorData = visitor;
    return { client: base };
  }

  async function requestPlayer(videoId, client) {
    const ytcfg = window.ytcfg;
    const key = ytcfg && typeof ytcfg.get === 'function' ? ytcfg.get('INNERTUBE_API_KEY') : null;
    if (!key || !videoId) return null;
    const visitor = visitorData();
    const headers = { 'content-type': 'application/json' };
    if (client.__id) {
      headers['X-YouTube-Client-Name'] = String(client.__id);
      headers['X-YouTube-Client-Version'] = client.clientVersion;
    }
    if (visitor) headers['X-Goog-Visitor-Id'] = visitor;

    try {
      const res = await fetch(`/youtubei/v1/player?key=${encodeURIComponent(key)}&prettyPrint=false`, {
        method: 'POST',
        headers,
        cache: 'no-store',
        body: JSON.stringify({
          context: apiContext(client),
          videoId,
          contentCheckOk: true,
          racyCheckOk: true,
        }),
      });
      if (!res.ok) return null;
      return await res.json();
    } catch (err) {
      log(`client ${client.clientName} failed:`, err);
      return null;
    }
  }

  function countFormats(data) {
    if (!data || !data.streamingData) return 0;
    return (data.streamingData.formats || []).length
      + (data.streamingData.adaptiveFormats || []).length;
  }

  // Format identity. Itag alone is NOT enough: YouTube sends several
  // audio tracks with the same itag for videos that have automatic dubbing
  // (e.g. itag 140 original + itag 140 dubbed). If only the itag were used,
  // the dubbing track that appears first would overwrite the original track.
  function formatKey(raw) {
    const itag = Number(raw.itag) || 0;
    const at = raw.audioTrack || {};
    return `${itag}|${at.id || ''}|${at.isAutoDubbed === true ? 'dub' : 'orig'}`;
  }

  // Merge several player responses. Base = the most complete format list,
  // but each format's URL is replaced with the URL from the response that has
  // one (VISIONOS comes first because its URL is not limited to 16 MB).
  function mergePlayerResponses(responses) {
    if (!responses.length) return null;
    let base = responses[0];
    for (const r of responses) {
      if (countFormats(r) > countFormats(base)) base = r;
    }

    const urlByKey = new Map();
    for (const r of responses) {
      const all = [
        ...(r.streamingData.formats || []),
        ...(r.streamingData.adaptiveFormats || []),
      ];
      for (const f of all) {
        const key = formatKey(f);
        if (key !== '0||orig' && f.url && !urlByKey.has(key)) urlByKey.set(key, f.url);
      }
    }

    const withUrl = (raw) => {
      const url = urlByKey.get(formatKey(raw));
      return url ? { ...raw, url, signatureCipher: undefined } : raw;
    };

    const formats = (base.streamingData.formats || []).map(withUrl);
    const adaptive = (base.streamingData.adaptiveFormats || []).map(withUrl);

    // Add formats that only exist in other responses.
    const seen = new Set([...formats, ...adaptive].map(formatKey));
    for (const r of responses) {
      if (!r.streamingData) continue;
      for (const raw of [...(r.streamingData.formats || []), ...(r.streamingData.adaptiveFormats || [])]) {
        const key = formatKey(raw);
        if (key === '0||orig' || seen.has(key) || !raw.url) continue;
        seen.add(key);
        adaptive.push(raw);
      }
    }

    return {
      ...base,
      streamingData: { ...base.streamingData, formats, adaptiveFormats: adaptive },
    };
  }

  async function fetchFormatsFromApi(videoId) {
    if (!videoId) return null;
    lastApiNote = '';

    const responses = [];
    for (const client of API_CLIENTS) {
      const data = await requestPlayer(videoId, client);
      if (!data) continue;
      const ps = data.playabilityStatus;
      if (ps && ps.status && ps.status !== 'OK') {
        lastApiNote = `${ps.status}${ps.reason ? ` — ${ps.reason}` : ''}`;
        continue;
      }
      const sd = data.streamingData;
      if (!sd) continue;
      const hasUrl = [...(sd.formats || []), ...(sd.adaptiveFormats || [])].some((f) => f.url);
      if (!hasUrl) continue;
      responses.push(data);
      // Two sources are enough: VISIONOS (full URL) + ANDROID (most complete list).
      if (responses.length >= 2) break;
    }
    return mergePlayerResponses(responses);
  }

  // Fetch a fresh URL for a specific itag (used when the server rejects with 403).
  // Try every client; avoid returning the exact same URL.
  async function refreshUrlFor(itag, avoid) {
    const vid = currentVideoId();
    if (!vid) return null;
    let fallback = null;
    for (const client of API_CLIENTS) {
      const data = await requestPlayer(vid, client);
      if (!data || !data.streamingData) continue;
      const all = [
        ...(data.streamingData.formats || []),
        ...(data.streamingData.adaptiveFormats || []),
      ];
      const found = all.find((x) => Number(x.itag) === Number(itag) && x.url);
      if (!found) continue;
      if (!fallback) fallback = found.url;
      if (found.url !== avoid) return found.url;
    }
    return fallback;
  }

  /* ============================================================
   * FORMAT NORMALIZATION
   * ============================================================ */
  function containerOf(f) {
    const mime = f.mime || '';
    if (mime.startsWith('audio/mp4')) return 'M4A';
    if (mime.startsWith('audio/webm')) return 'WEBM';
    if (mime.startsWith('video/mp4')) return 'MP4';
    if (mime.startsWith('video/webm')) return 'WEBM';
    return 'FILE';
  }

  function codecOf(f) {
    const c = (f.codecs || '').toLowerCase();
    if (c.includes('avc1') || c.includes('avc3')) return 'H.264';
    if (c.includes('av01')) return 'AV1';
    if (c.includes('vp09') || c.includes('vp9')) return 'VP9';
    if (c.includes('mp4a')) return 'AAC';
    if (c.includes('opus')) return 'Opus';
    if (c.includes('ec-3')) return 'EAC3';
    return c ? c.split('.')[0].toUpperCase() : '—';
  }

  function normalizeFormat(raw, kind) {
    const mimeType = raw.mimeType || '';
    const mime = mimeType.split(';')[0].trim();
    const codecsMatch = /codecs="([^"]+)"/.exec(mimeType);
    const codecs = codecsMatch ? codecsMatch[1] : '';

    let url = raw.url || '';
    let locked = false;
    if (!url && raw.signatureCipher) {
      // This format needs signature decryption (cannot be downloaded directly from the browser).
      try {
        url = new URLSearchParams(raw.signatureCipher).get('url') || '';
      } catch (err) {
        url = '';
      }
      locked = true;
    }

    return {
      itag: Number(raw.itag) || 0,
      kind,
      url,
      locked,
      mime,
      codecs,
      qualityLabel: raw.qualityLabel || '',
      height: Number(raw.height) || 0,
      width: Number(raw.width) || 0,
      fps: Number(raw.fps) || 0,
      bitrate: Number(raw.bitrate || raw.averageBitrate) || 0,
      size: Number(raw.contentLength) || 0,
      audioQuality: raw.audioQuality || '',
      // Audio track metadata: YouTube can send several tracks with the
      // same itag (original + automatic dubbing). We keep it so we can pick
      // the original track and never use the dubbed result.
      audioTrackId: (raw.audioTrack && raw.audioTrack.id) || '',
      audioTrackName: (raw.audioTrack && raw.audioTrack.displayName) || '',
      audioDefault: Boolean(raw.audioTrack && raw.audioTrack.audioIsDefault === true),
      autoDubbed: Boolean(raw.audioTrack && raw.audioTrack.isAutoDubbed === true),
      hdr: (raw.colorInfo && raw.colorInfo.primaries === 'bt2020') || /HDR/.test(raw.qualityLabel || ''),
      hasAudio: kind === 'muxed',
    };
  }

  let loadToken = 0;

  async function loadFormats() {
    const token = ++loadToken;
    const vid = currentVideoId();
    state.videoId = vid;
    state.formats = [];

    let pr = null;
    let source = 'player';

    if (vid) {
      try {
        const api = await fetchFormatsFromApi(vid);
        if (token !== loadToken) return;
        if (api && api.streamingData) {
          pr = api;
          source = 'api';
        }
      } catch (err) {
        log('API source failed:', err);
      }
    }

    if (!pr) pr = getPlayerResponse();
    if (token !== loadToken) return;

    state.source = source;
    state.response = pr;
    state.apiNote = source === 'api' ? '' : lastApiNote;

    if (!pr || !pr.streamingData) {
      render();
      return;
    }

    // Collect all raw formats first. Automatically dubbed audio tracks are
    // only used if the video really has no original audio.
    const raws = [];
    (pr.streamingData.formats || []).forEach((f) => raws.push([f, 'muxed']));
    (pr.streamingData.adaptiveFormats || []).forEach((f) => {
      const mime = f.mimeType || '';
      raws.push([f, mime.startsWith('audio/') ? 'audio' : 'video']);
    });
    const isDubbed = (raw) => Boolean(raw.audioTrack && raw.audioTrack.isAutoDubbed === true);
    const hasOriginalAudio = raws.some(([raw, kind]) => kind === 'audio' && !isDubbed(raw));

    const seen = new Set();
    const add = (raw, kind) => {
      if (!raw) return;
      const itag = Number(raw.itag) || 0;
      if (!itag) return;
      // Skip automatic dubbing tracks while the original track is available.
      if (kind === 'audio' && hasOriginalAudio && isDubbed(raw)) return;
      const key = formatKey(raw);
      if (seen.has(key)) return;
      seen.add(key);
      state.formats.push(normalizeFormat(raw, kind));
    };

    for (const [raw, kind] of raws) add(raw, kind);

    state.formats.sort((a, b) => {
      if (a.kind === 'audio' && b.kind === 'audio') {
        return (Number(b.audioDefault) - Number(a.audioDefault)) || (b.bitrate - a.bitrate);
      }
      if (a.height !== b.height) return b.height - a.height;
      if (a.fps !== b.fps) return b.fps - a.fps;
      return b.bitrate - a.bitrate;
    });

    // Fill in URLs that streamingData did not provide using captured results.
    for (const f of state.formats) {
      if ((!f.url || f.locked) && captured.has(f.itag)) {
        f.url = captured.get(f.itag);
        f.locked = false;
        f.capturedUrl = true;
      }
    }

    addMergedFormats();

    log('formats found:', state.formats);
    render();
  }

  /* ============================================================
   * AUTOMATIC VIDEO + AUDIO MERGE
   * YouTube only provides one "muxed" stream (usually 360p).
   * For higher quality, video and audio are separate. We merge them
   * ourselves in the browser with mp4box (no re-encode).
   * ============================================================ */
  function bestMp4Audio() {
    const mp4Audio = state.formats.filter(
      (f) => f.kind === 'audio' && f.mime === 'audio/mp4' && f.url && !f.locked,
    );
    // Prefer the original audio track (not automatic dubbing). A track
    // flagged audioIsDefault by the ANDROID client may actually be dubbing,
    // so default is only used as an ordering tiebreaker after this filter.
    const original = mp4Audio.filter((f) => !f.autoDubbed);
    if (original.length) {
      original.sort((a, b) => (Number(b.audioDefault) - Number(a.audioDefault)) || (b.bitrate - a.bitrate));
      return original[0];
    }
    // No original audio in MP4 format (e.g. only Opus/WebM). Do not
    // silently use the dubbing track; let the user download separately.
    const anyOriginal = state.formats.some((f) => f.kind === 'audio' && !f.autoDubbed);
    if (anyOriginal) return null;
    mp4Audio.sort((a, b) => b.bitrate - a.bitrate);
    return mp4Audio[0] || null;
  }

  function addMergedFormats() {
    if (!bestMp4Audio()) return;
    const audio = bestMp4Audio();
    const videos = state.formats.filter(
      (f) => f.kind === 'video' && f.mime === 'video/mp4' && f.url && !f.locked,
    );

    for (const v of videos) {
      state.formats.push({
        ...v,
        kind: 'merged',
        merged: true,
        hasAudio: true,
        videoItag: v.itag,
        videoSize: v.size,
        audio,
        audioItag: audio.itag,
        audioSize: audio.size,
        size: (v.size || 0) + (audio.size || 0),
      });
    }
  }

  /* ============================================================
   * DOWNLOAD
   * ============================================================ */
  async function httpError(res) {
    const err = new Error(`HTTP ${res.status}`);
    err.status = res.status;
    try {
      const text = (await res.text()).trim();
      if (text && text.length < 300) err.reason = text;
    } catch (e) { /* ignore */ }
    return err;
  }

  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  // Adaptive downloads:
  // - Normal: 4 MB Range chunks (fast, many requests per URL).
  // - 403 in the middle of a download: fetch a new URL, then continue from the same offset.
  // - Two consecutive failures while resuming: retry from 0 with one large request.
  // - Connection dropped ("NetworkError"/"Failed to fetch") while reading the body:
  //   bytes already received are kept, the URL is re-fetched, and it continues from the offset.
  const CHUNK_SIZE = 4 * 1024 * 1024;

  function isAbort(err) {
    return Boolean(err && (err.name === 'AbortError' || err.code === 20));
  }

  async function fetchStream(url, total, onProgress, signal, mime, refresh) {
    const parts = [];
    let received = 0;
    let currentUrl = url;
    let refreshes = 0;
    let midFails = 0; // consecutive 403s while resuming from the middle
    let netFails = 0; // consecutive network glitches
    let totalNet = 0; // total network glitches for this download
    let empties = 0; // consecutive empty responses
    let restarts = 0; // server ignored Range (200) repeatedly
    let mode = total > 0 ? 'chunk' : 'whole';
    const totalKnown = total > 0;

    const freshUrl = async (current) => {
      if (typeof refresh !== 'function') return null;
      try {
        return await refresh(current);
      } catch (err) {
        log('failed to fetch a new URL:', err);
        return null;
      }
    };

    while (true) {
      const end = totalKnown
        ? Math.min(received + (mode === 'whole' ? total : CHUNK_SIZE), total) - 1
        : null;
      const range = end === null ? `bytes=${received}-` : `bytes=${received}-${end}`;

      let res = null;
      try {
        res = await fetch(currentUrl, {
          headers: { Range: range },
          credentials: 'omit',
          signal,
        });
      } catch (err) {
        if (isAbort(err)) throw err;
        netFails += 1;
        totalNet += 1;
        log('request failed, retrying:', err);
        if (netFails > 10 || totalNet > 20) throw err;
        await sleep(Math.min(2500, 400 * netFails));
        if (netFails >= 2) {
          const fresh = await freshUrl(currentUrl);
          if (fresh) currentUrl = fresh;
        }
        continue;
      }

      if (res.status === 403 || res.status === 410) {
        refreshes += 1;
        if (received > 0) midFails += 1;

        if (refreshes > 25) throw await httpError(res);

        await sleep(Math.min(2500, 300 * refreshes));

        const fresh = await freshUrl(currentUrl);
        if (!fresh) throw await httpError(res);
        currentUrl = fresh;

        // Stay on 4 MB chunks. A URL that rejects resuming from the middle
        // is tried once with a single full remaining range; if that is also
        // rejected, restart from 0 as a last resort.
        if (mode === 'chunk') {
          if (midFails >= 3) mode = 'whole';
        } else if (midFails >= 5) {
          parts.length = 0;
          received = 0;
          midFails = 0;
          mode = 'whole';
          onProgress(0, totalKnown ? total : 0);
        }
        continue;
      }

      if (!(res.ok || res.status === 206)) throw await httpError(res);

      // Server ignored Range: the whole body is sent from the start.
      if (res.status === 200) {
        if (received > 0) {
          restarts += 1;
          if (restarts > 3) throw new Error('Server ignored Range repeatedly');
        }
        parts.length = 0;
        received = 0;
        mode = 'whole';
      }

      const before = received;

      try {
        if (res.body && typeof res.body.getReader === 'function') {
          const reader = res.body.getReader();
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            if (value) {
              parts.push(value);
              received += value.length;
              onProgress(received, totalKnown ? total : 0);
            }
          }
        } else {
          const buf = await res.arrayBuffer();
          parts.push(new Uint8Array(buf));
          received += buf.byteLength;
          onProgress(received, totalKnown ? total : 0);
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        // Connection dropped in the middle of the body. Bytes already received
        // are still used; request a new URL, then continue from the last offset.
        netFails += 1;
        totalNet += 1;
        log('connection dropped while reading the stream:', err);
        if (netFails > 10 || totalNet > 20) throw err;
        await sleep(Math.min(2500, 400 * netFails));
        const fresh = await freshUrl(currentUrl);
        if (fresh) currentUrl = fresh;
        continue;
      }

      // Data flowing normally -> reset the failure counters.
      if (received > before) {
        netFails = 0;
        empties = 0;
        midFails = 0;
      }

      if (totalKnown && received >= total) break;

      // Unknown size: stream exhausted = done.
      if (!totalKnown) {
        if (received === before) break;
        const fresh = await freshUrl(currentUrl);
        if (!fresh) break;
        currentUrl = fresh;
        continue;
      }

      // Chunk finished; continue with the next chunk using the same URL.
      if (mode === 'chunk') continue;

      // Single-request mode stopped before finishing: continue with a new URL.
      if (received === before) {
        empties += 1;
        if (empties > 6) break;
        await sleep(300);
        continue;
      }
      const fresh = await freshUrl(currentUrl);
      if (fresh) currentUrl = fresh;
    }

    if (totalKnown && received < total) {
      throw new Error(`Download interrupted (${received}/${total} bytes)`);
    }

    return new Blob(parts, { type: mime || 'application/octet-stream' });
  }

  async function fetchBlob(url, total, onProgress, signal, mime, refresh) {
    return fetchStream(url, total, onProgress, signal, mime, refresh);
  }

  /* ============================================================
   * MP4 MUXER (mp4box, no re-encode)
   * ============================================================ */
  function getMP4Box() {
    if (typeof MP4Box !== 'undefined') return MP4Box;
    if (window.MP4Box) return window.MP4Box;
    return null;
  }

  function parseMp4(lib, arrayBuffer, label) {
    return new Promise((resolve, reject) => {
      const file = lib.createFile();
      const tracks = new Map();
      let info = null;

      file.onError = (e) => reject(new Error(`${label}: ${String(e)}`));
      file.onReady = (i) => {
        info = i;
        i.tracks.forEach((t) => {
          tracks.set(t.id, []);
          file.setExtractionOptions(t.id, null, { nbSamples: 1e9 });
        });
        file.start();
      };
      file.onSamples = (id, user, samples) => {
        const arr = tracks.get(id);
        if (!arr) return;
        for (let i = 0; i < samples.length; i += 1) arr.push(samples[i]);
      };

      arrayBuffer.fileStart = 0;
      file.appendBuffer(arrayBuffer);
      file.flush();

      const t0 = performance.now();
      const timer = setInterval(() => {
        const elapsed = performance.now() - t0;
        if ((!file.samplesProcessing && elapsed > 400) || elapsed > 30000) {
          clearInterval(timer);
          if (!info) return reject(new Error(`${label}: MP4 could not be read`));
          resolve({ info, file, tracks });
        }
      }, 120);
    });
  }

  // Writes a progressive (non-fragmented) MP4 like the output of "ffmpeg -c copy".
  // Important: mp4box.addSample() always writes one moof per sample, so the
  // result is a fragmented MP4. Many players (TVs, old Windows Media Player,
  // phone players) only play the first track or cannot find the audio track
  // in a fragmented file. Here the sample tables are built manually so the
  // result is a normal MP4: a complete moov + one mdat.
  function muxMp4(lib, v, a, onStatus) {
    const MOVIE_TS = 1000;
    const vTrack = v.info.tracks.find((t) => t.video) || v.info.tracks[0];
    const aTrack = a.info.tracks.find((t) => t.audio) || a.info.tracks[0];
    if (!vTrack || !aTrack) throw new Error('Video/audio track not found');

    const vSamples = v.tracks.get(vTrack.id) || [];
    const aSamples = a.tracks.get(aTrack.id) || [];
    if (!vSamples.length) throw new Error('Video track is empty');
    if (!aSamples.length) throw new Error('Audio track is empty (audio failed to download)');

    const vSrc = v.file.getTrackById(vTrack.id);
    const aSrc = a.file.getTrackById(aTrack.id);
    const vStsd = vSrc.mdia.minf.stbl.stsd.entries[0];
    const aStsd = aSrc.mdia.minf.stbl.stsd.entries[0];
    if (!vStsd || !aStsd) throw new Error('Video/audio codec configuration not found');

    let vMediaDur = 0;
    for (const s of vSamples) vMediaDur += s.duration;
    let aMediaDur = 0;
    for (const s of aSamples) aMediaDur += s.duration;
    const vSec = vMediaDur / vTrack.timescale;
    const aSec = aMediaDur / aTrack.timescale;
    if (vSec > 1 && aSec < vSec * 0.8) {
      throw new Error(`Audio incomplete (${aSec.toFixed(1)}s of ${vSec.toFixed(1)}s)`);
    }
    const movieDur = Math.round(Math.max(vSec, aSec) * MOVIE_TS);

    onStatus('Building moov…');
    const out = lib.createFile();
    out.add('ftyp')
      .set('major_brand', 'isom')
      .set('minor_version', 512)
      .set('compatible_brands', ['isom', 'iso2', 'avc1', 'mp41']);

    const moov = out.add('moov');
    moov.add('mvhd')
      .set('creation_time', 0).set('modification_time', 0)
      .set('timescale', MOVIE_TS).set('duration', movieDur)
      .set('rate', 1 << 16).set('volume', 1)
      .set('matrix', [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000])
      .set('next_track_id', 3);

    const buildTrack = (id, srcTrak, srcStsd, track, samples, kind, mediaDur) => {
      const isVideo = kind === 'video';
      const trak = moov.add('trak');
      const tkhd = trak.add('tkhd')
        .set('creation_time', 0).set('modification_time', 0)
        .set('track_id', id)
        .set('duration', Math.round((mediaDur / track.timescale) * MOVIE_TS))
        .set('layer', 0).set('alternate_group', 0)
        .set('volume', isVideo ? 0 : 1)
        .set('matrix', [1 << 16, 0, 0, 0, 1 << 16, 0, 0, 0, 0x40000000])
        .set('width', isVideo ? (srcTrak.tkhd.width || 0) : 0)
        .set('height', isVideo ? (srcTrak.tkhd.height || 0) : 0);
      tkhd.flags = 3; // enabled + in_movie

      const mdia = trak.add('mdia');
      mdia.add('mdhd')
        .set('creation_time', 0).set('modification_time', 0)
        .set('timescale', track.timescale)
        .set('duration', mediaDur)
        .set('language', 0x55c4); // 'und'
      mdia.add('hdlr')
        .set('handler', isVideo ? 'vide' : 'soun')
        .set('name', isVideo ? 'VideoHandler' : 'SoundHandler');

      const minf = mdia.add('minf');
      if (isVideo) {
        minf.add('vmhd').set('graphicsmode', 0).set('opcolor', [0, 0, 0]);
      } else {
        minf.add('smhd').set('balance', 0);
      }

      // dref/url: the media data is in the same file.
      const dinf = minf.add('dinf');
      const dref = dinf.add('dref');
      dref.entries = [{
        type: 'url ',
        size: 12,
        write(stream) {
          stream.writeUint32(12);
          stream.writeString('url ', null, 4);
          stream.writeUint8(0);
          stream.writeUint24(1); // flag 1 = self-contained
        },
      }];

      const stbl = minf.add('stbl');
      const stsd = stbl.add('stsd');
      // Use the original sample description (avcC/av01C/esds) so the decoder
      // knows the codec and its configuration.
      stsd.entries = [srcStsd];

      // stts: group equal durations.
      const sttsCounts = [];
      const sttsDeltas = [];
      for (const s of samples) {
        const d = s.duration;
        if (sttsDeltas.length && sttsDeltas[sttsDeltas.length - 1] === d) {
          sttsCounts[sttsCounts.length - 1] += 1;
        } else {
          sttsDeltas.push(d);
          sttsCounts.push(1);
        }
      }
      stbl.add('stts').set('sample_counts', sttsCounts).set('sample_deltas', sttsDeltas);

      // ctts: composition time offset (video with B-frames).
      const cttsCounts = [];
      const cttsOffsets = [];
      let hasCtts = false;
      for (const s of samples) {
        const off = (s.cts || 0) - (s.dts || 0);
        if (off < 0) throw new Error('Negative time offsets are not supported');
        if (off !== 0) hasCtts = true;
        if (cttsOffsets.length && cttsOffsets[cttsOffsets.length - 1] === off) {
          cttsCounts[cttsCounts.length - 1] += 1;
        } else {
          cttsOffsets.push(off);
          cttsCounts.push(1);
        }
      }
      if (hasCtts) {
        stbl.add('ctts').set('sample_counts', cttsCounts).set('sample_offsets', cttsOffsets);
      }

      // One sample = one chunk (offsets are filled in after the moov size is known).
      const n = samples.length;
      const firstChunk = new Array(n);
      const perChunk = new Array(n);
      const descIndex = new Array(n);
      const sizes = new Array(n);
      for (let i = 0; i < n; i += 1) {
        firstChunk[i] = i + 1;
        perChunk[i] = 1;
        descIndex[i] = 1;
        sizes[i] = samples[i].size;
      }
      stbl.add('stsc')
        .set('first_chunk', firstChunk)
        .set('samples_per_chunk', perChunk)
        .set('sample_description_index', descIndex);
      stbl.add('stsz').set('sample_size', 0).set('sample_sizes', sizes);
      const stco = stbl.add('stco');
      stco.chunk_offsets = new Array(n).fill(0);

      if (isVideo) {
        const sync = [];
        for (let i = 0; i < n; i += 1) if (samples[i].is_sync) sync.push(i + 1);
        if (sync.length && sync.length < n) {
          stbl.add('stss').set('sample_numbers', sync);
        }
      }
      return { stco };
    };

    const vp = buildTrack(1, vSrc, vStsd, vTrack, vSamples, 'video', vMediaDur);
    const ap = buildTrack(2, aSrc, aStsd, aTrack, aSamples, 'audio', aMediaDur);

    // Lay out the video & audio samples in time order so mdat does not
    // contain the entire video first and then the audio.
    const items = [];
    for (const s of vSamples) items.push({ kind: 0, sec: s.dts / vTrack.timescale, s });
    for (const s of aSamples) items.push({ kind: 1, sec: s.dts / aTrack.timescale, s });
    items.sort((x, y) => (x.sec - y.sec) || (x.kind - y.kind));

    onStatus('Computing offsets…');
    const mdat = out.add('mdat');
    mdat.data = null;
    const head = out.getBuffer(); // ftyp + moov (mdat not written yet)
    const payloadStart = (head.byteLength || head.length) + 8;
    const vOffsets = [];
    const aOffsets = [];
    let pos = payloadStart;
    for (const it of items) {
      (it.kind === 0 ? vOffsets : aOffsets).push(pos);
      pos += it.s.data.length;
    }
    if (pos > 0xFFFFFFFF) throw new Error('File is larger than 4 GB — 32-bit MP4 is not supported');
    vp.stco.chunk_offsets = vOffsets;
    ap.stco.chunk_offsets = aOffsets;

    onStatus('Writing data…');
    const data = new Uint8Array(pos - payloadStart);
    let p = 0;
    for (const it of items) {
      data.set(it.s.data, p);
      p += it.s.data.length;
    }
    mdat.data = data;

    onStatus('Saving MP4…');
    const merged = out.getBuffer();
    return new Blob([merged], { type: 'video/mp4' });
  }

  async function mergeVideoAudio(videoBlob, audioBlob, onStatus) {
    const lib = getMP4Box();
    if (!lib) throw new Error('MP4 muxer (mp4box) not loaded');

    onStatus('Reading video…');
    await sleep(50);
    const v = await parseMp4(lib, await videoBlob.arrayBuffer(), 'Video');

    onStatus('Reading audio…');
    await sleep(50);
    const a = await parseMp4(lib, await audioBlob.arrayBuffer(), 'Audio');

    onStatus('Merging…');
    await sleep(50);
    return muxMp4(lib, v, a, onStatus);
  }

  function saveBlob(blob, filename) {
    const url = URL.createObjectURL(blob);
    const a = h('a', { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 60_000);
  }

  function buildFilename(f) {
    const pr = state.response;
    const title = sanitize(pr && pr.videoDetails && pr.videoDetails.title);
    let quality;
    if (f.kind === 'audio') {
      quality = `${f.bitrate ? Math.round(f.bitrate / 1000) : 'audio'}kbps`;
    } else {
      quality = (f.qualityLabel || `${f.height}p`).replace(/\s+/g, '');
      if (f.merged) quality += ' (video+audio)';
    }
    const ext = f.merged ? 'mp4' : containerOf(f).toLowerCase();
    return `${title} [${quality}][${f.itag}].${ext}`;
  }

  async function startDownload(f, row) {
    const usable = f.merged
      ? Boolean(f.url && !f.locked && f.audio && f.audio.url)
      : Boolean(f.url && !f.locked);
    if (!usable) return;

    // Prevent the most common mistake: downloading a "Video only" row and
    // then assuming the result is broken because there is no audio.
    if (f.kind === 'video' && !f.merged) {
      const lanjut = window.confirm(
        'This row contains VIDEO only (no audio).\n\n' +
        'For a file with audio, choose the "Video + Audio · automatic merge" section.\n\n' +
        'Download video only anyway?',
      );
      if (!lanjut) return;
    }

    const vid = currentVideoId() || state.videoId || '';
    const key = dlKey(f, vid);
    const active = state.downloads.get(key);
    if (active && active.status === 'running') return; // this row is already running

    const ctrl = new AbortController();
    const entry = {
      key,
      videoId: vid,
      format: f,
      status: 'running',
      pct: 0,
      indet: false,
      text: 'Connecting to server…',
      startedAt: Date.now(),
      ctrl,
    };
    state.downloads.set(key, entry);
    state.lastResult = null;
    paintDownload(key);
    updateGlobal();

    let lastPaint = 0;
    const setProgress = (pct, text) => {
      entry.indet = pct === null;
      if (pct !== null) entry.pct = Math.max(0, Math.min(100, pct));
      entry.text = text;
      paintDownload(key);
      updateGlobal();
    };
    const report = (pct, text) => {
      entry.indet = pct === null;
      if (pct !== null) entry.pct = Math.max(0, Math.min(100, pct));
      entry.text = text;
      const now = performance.now();
      if (pct !== null && pct < 100 && now - lastPaint < 120) return;
      lastPaint = now;
      paintDownload(key);
      updateGlobal();
    };

    // Progress is stored in state.downloads, not in the DOM. So if the list
    // is re-rendered (panel closed/opened, ⟳, switch video and come back),
    // the row shows the latest progress again until it finishes/fails.
    const finish = (ok, text) => {
      entry.status = ok ? 'done' : 'error';
      entry.indet = false;
      entry.text = text;
      if (ok) entry.pct = 100;
      state.lastResult = { ok, text: ok ? '✓ done' : '✕ failed', at: Date.now() };
      paintDownload(key);
      updateGlobal();
      setTimeout(updateGlobal, 8300);
    };

    // Fallback URLs: the player capture first, then a fresh URL from the API.
    const makeRefresher = (itag, initialUrl) => {
      let usedCaptured = false;
      return async (current) => {
        const cap = captured.get(itag);
        if (!usedCaptured && cap && cap !== initialUrl && cap !== current) {
          usedCaptured = true;
          return cap;
        }
        return await refreshUrlFor(itag, current);
      };
    };

    try {
      let blob;

      if (f.merged) {
        const audio = f.audio;

        f.size = (f.videoSize || 0) + (audio.size || 0);

        const combined = f.size;
        const vTotal = f.videoSize || 0;
        const aTotal = audio.size || 0;

        setProgress(0, 'Downloading video…');
        const vBlob = await fetchBlob(
          f.url,
          vTotal,
          (done, total) => {
            const t = total || vTotal;
            if (combined && t) {
              const pct = (done / t) * 85;
              report(pct, `Video ${formatBytes(done)} / ${formatBytes(t)}  (${pct.toFixed(0)}%)`);
            } else {
              report(null, `Video ${formatBytes(done)}`);
            }
          },
          ctrl.signal,
          f.mime,
          makeRefresher(f.videoItag, f.url),
        );

        setProgress(85, 'Downloading audio…');
        const aBlob = await fetchBlob(
          audio.url,
          aTotal,
          (done, total) => {
            const t = total || aTotal;
            if (combined && t) {
              const pct = 85 + (done / t) * 15;
              report(pct, `Audio ${formatBytes(done)} / ${formatBytes(t)}  (${pct.toFixed(0)}%)`);
            } else {
              report(null, `Audio ${formatBytes(done)}`);
            }
          },
          ctrl.signal,
          audio.mime || 'audio/mp4',
          makeRefresher(f.audioItag, audio.url),
        );

        setProgress(95, 'Merging video + audio…');
        try {
          blob = await mergeVideoAudio(vBlob, aBlob, (text) => setProgress(97, text));
        } catch (muxErr) {
          console.warn('[YT-DL] merge failed:', muxErr);
          saveBlob(vBlob, buildFilename({ ...f, merged: false }));
          saveBlob(aBlob, buildFilename(audio));
          finish(false, 'Merge failed — video & audio saved separately');
          toast(`Merge failed (${muxErr.message}). Video and audio were saved separately.`);
          return;
        }

        setProgress(100, `Saving ${formatBytes(blob.size)}…`);
        saveBlob(blob, buildFilename(f));
        finish(true, `Done · ${formatBytes(blob.size)} · video+audio`);
        return;
      }

      blob = await fetchBlob(
        f.url,
        f.size || 0,
        (done, total) => {
          if (total) {
            const pct = (done / total) * 100;
            report(pct, `${formatBytes(done)} / ${formatBytes(total)}  (${pct.toFixed(0)}%)`);
          } else {
            report(null, `Downloading… ${formatBytes(done)}`);
          }
        },
        ctrl.signal,
        f.mime,
        makeRefresher(f.itag, f.url),
      );

      setProgress(100, `Saving ${formatBytes(blob.size)}…`);
      saveBlob(blob, buildFilename(f));
      finish(true, `Done · ${formatBytes(blob.size)}`);
    } catch (err) {
      if (isAbort(err)) {
        entry.status = 'error';
        entry.indet = false;
        entry.pct = 0;
        entry.text = 'Canceled';
        paintDownload(key);
        updateGlobal();
        return;
      }

      console.warn('[YT-DL] download failed:', err);
      const msg = String((err && err.message) || err);

      if (err && (err.status === 403 || err.status === 410)) {
        const detail = err.reason ? ` — ${String(err.reason).slice(0, 140)}` : '';
        finish(false, `URL rejected (${err.status})${detail}`);
        toast('The server rejected the stream URL. Click ⟳ to get a new URL, then try again.');
      } else if ((err && err.name === 'TypeError') || /network|fetch|interrupted/i.test(msg)) {
        finish(false, 'Failed: connection dropped — try again');
        toast('The connection dropped while downloading. Click Download again to resume.');
      } else {
        finish(false, `Failed (${msg})`);
        toast(`Failed: ${msg}`);
      }
    }
  }

  function copyUrl(f) {
    if (!f.url) return;
    const done = () => toast('URL copied. Paste it into IDM / aria2 / yt-dlp.');
    const legacy = () => {
      const ta = h('textarea', { style: 'position:fixed;left:-9999px;top:0' });
      ta.value = f.url;
      document.body.appendChild(ta);
      ta.select();
      try {
        document.execCommand('copy');
        done();
      } catch (err) {
        toast('Failed to copy URL.');
      }
      ta.remove();
    };
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(f.url).then(done, legacy);
    } else {
      legacy();
    }
  }

  /* ============================================================
   * UI
   * ============================================================ */
  function toast(message) {
    if (!state.panel) return;
    let box = state.panel.querySelector('.ytdl-toast');
    if (!box) {
      box = h('div', { class: 'ytdl-toast' });
      state.panel.appendChild(box);
    }
    box.textContent = message;
    box.classList.add('ytdl-show');
    clearTimeout(box.__timer);
    box.__timer = setTimeout(() => box.classList.remove('ytdl-show'), 2600);
  }

  /* ============================================================
   * PERSISTENT DOWNLOADS
   * Progress is stored in state.downloads (not just in the DOM), so it
   * stays visible even when the panel is closed/opened, the list is
   * re-rendered, or the user navigates around YouTube.
   * ============================================================ */
  function findRow(key) {
    if (!state.panel) return null;
    const rows = state.panel.querySelectorAll('.ytdl-row');
    for (const row of rows) {
      if (row.getAttribute('data-key') === key) return row;
    }
    return null;
  }

  function paintDownload(key) {
    const entry = state.downloads.get(key);
    if (!entry) return;
    const row = findRow(key);
    if (!row) return;

    row.classList.toggle('ytdl-busy', entry.status === 'running');
    row.classList.toggle('ytdl-done', entry.status === 'done');
    row.classList.toggle('ytdl-error', entry.status === 'error');

    const meta2 = row.querySelector('.ytdl-meta2');
    if (meta2 && entry.text) meta2.textContent = entry.text;

    const bar = row.querySelector('.ytdl-progress');
    const fill = bar && bar.querySelector('i');
    if (bar && fill) {
      const indet = entry.status === 'running' && entry.indet;
      bar.classList.toggle('ytdl-indet', indet);
      fill.style.width = indet
        ? ''
        : `${Math.max(0, Math.min(100, entry.pct || 0))}%`;
    }

    const blocked = row.getAttribute('data-unusable') === '1';
    const btn = row.querySelector('.ytdl-actions .ytdl-mini');
    if (btn) btn.disabled = blocked || entry.status === 'running';
  }

  function syncDownloadRows() {
    for (const key of state.downloads.keys()) paintDownload(key);
  }

  function updateGlobal() {
    if (!state.bar) return;
    const chip = state.bar.querySelector('.ytdl-global');
    if (!chip) return;

    chip.classList.remove('ytdl-show', 'ytdl-ok', 'ytdl-err');
    const running = runningDownloads();

    if (running.length) {
      const pct = Math.round(
        running.reduce((sum, d) => sum + (d.pct || 0), 0) / running.length,
      );
      chip.textContent = `⬇ ${running.length > 1 ? `${running.length} · ` : ''}${pct}%`;
      chip.classList.add('ytdl-show');
      return;
    }

    const last = state.lastResult;
    if (last && Date.now() - last.at < 8000) {
      chip.textContent = last.text;
      chip.classList.add('ytdl-show', last.ok ? 'ytdl-ok' : 'ytdl-err');
    }
  }

  function renderRow(f) {
    const key = dlKey(f, state.videoId || currentVideoId() || '');
    const entry = state.downloads.get(key);
    const blocked = f.merged
      ? !(f.url && f.audio && f.audio.url)
      : (!f.url || f.locked);
    const running = Boolean(entry && entry.status === 'running');
    const disabled = blocked || running;

    const quality = f.kind === 'audio'
      ? (f.bitrate ? `${Math.round(f.bitrate / 1000)} kbps` : 'Audio')
      : (f.qualityLabel || `${f.height}p`);

    const meta = [
      containerOf(f),
      codecOf(f),
      f.fps ? `${f.fps} fps` : null,
      f.hdr ? 'HDR' : null,
      f.kind !== 'audio' && f.height ? `${f.width}×${f.height}` : null,
      f.size ? formatBytes(f.size) : null,
    ].filter(Boolean).join(' · ');

    let note;
    if (entry && entry.text) {
      note = entry.text;
    } else if (f.merged) {
      const track = f.audio && f.audio.audioTrackName ? ` · audio: ${f.audio.audioTrackName}` : '';
      note = `itag ${f.videoItag}+${f.audioItag} · video+audio, merged automatically${track}`;
    } else if (f.kind === 'muxed') {
      note = f.hasAudio
        ? `itag ${f.itag} · video+audio (ready to use)`
        : `itag ${f.itag} · video+audio`;
    } else if (f.kind === 'audio' && f.audioTrackName) {
      note = `itag ${f.itag} · audio: ${f.audioTrackName}`;
    } else if (f.capturedUrl) {
      note = `itag ${f.itag} · URL captured from the player`;
    } else if (f.locked) {
      note = `itag ${f.itag} · signature encrypted — play the video, then ⟳`;
    } else if (!f.url) {
      note = `itag ${f.itag} · URL not available yet — play the video, then ⟳`;
    } else {
      note = `itag ${f.itag}${f.kind === 'video' ? ' · no audio' : ''}`;
    }

    let rowClass = 'ytdl-row';
    if (blocked) rowClass += ' ytdl-off';
    if (entry) {
      rowClass += entry.status === 'running' ? ' ytdl-busy' : ` ytdl-${entry.status}`;
    }

    const pct = entry ? Math.max(0, Math.min(100, entry.pct || 0)) : 0;
    const indet = Boolean(entry && entry.status === 'running' && entry.indet);

    return h(
      'div',
      {
        class: rowClass,
        'data-key': key,
        'data-unusable': blocked ? '1' : '0',
      },
      h('span', { class: 'ytdl-badge', text: quality }),
      h(
        'div',
        { class: 'ytdl-meta' },
        h('div', { class: 'ytdl-meta1', text: meta }),
        h('div', { class: 'ytdl-meta2', text: note }),
      ),
      h(
        'div',
        { class: 'ytdl-actions' },
        h('button', {
          class: 'ytdl-mini',
          type: 'button',
          text: f.kind === 'video' ? 'Download video' : 'Download',
          disabled: disabled || undefined,
          title: blocked
            ? 'This format cannot be downloaded directly'
            : (f.merged
              ? 'Download video+audio as a single MP4 file'
              : (f.kind === 'video' ? 'Video only — this file has no audio' : 'Download via the browser')),
          onclick: (e) => {
            e.stopPropagation();
            startDownload(f, e.currentTarget.closest('.ytdl-row'));
          },
        }),
        f.merged ? null : h('button', {
          class: 'ytdl-mini ytdl-ghost',
          type: 'button',
          text: 'Copy URL',
          disabled: !f.url || f.locked || undefined,
          title: 'Copy the stream URL (for IDM / yt-dlp)',
          onclick: (e) => {
            e.stopPropagation();
            copyUrl(f);
          },
        }),
      ),
      h('span', { class: `ytdl-progress${indet ? ' ytdl-indet' : ''}` },
        h('i', { style: `width:${pct}%` })),
    );
  }

  const SECTIONS = [
    { kind: 'merged', title: 'Video + Audio · automatic merge (MP4)' },
    { kind: 'muxed', title: 'Video + Audio · ready to use' },
    { kind: 'video', title: 'Video only · no audio' },
    { kind: 'audio', title: 'Audio only · M4A / Opus' },
  ];

  function updateStatus() {
    if (!state.panel) return;
    const el = state.panel.querySelector('.ytdl-status');
    if (!el) return;
    const player = document.getElementById('movie_player');
    const withUrl = state.formats.filter((f) => f.url && !f.locked).length;
    el.textContent =
      `v${VERSION} · ${player ? 'player ✓' : 'player ✗'} · source ${state.source === 'api' ? 'API' : 'player'} · ` +
      `${withUrl}/${state.formats.length} URL`;
  }

  function render() {
    if (!state.panel) return;
    const list = state.panel.querySelector('.ytdl-list');
    const sub = state.panel.querySelector('.ytdl-sub');
    if (!list) return;

    list.textContent = '';

    if (!state.response) {
      sub.textContent = 'Video data is not available yet.';
      list.append(
        h('div', { class: 'ytdl-empty' },
          'The player is not ready or this video has no stream data. ' +
          'Wait for the video to start playing, then click "Reload".'),
      );
      updateStatus();
      return;
    }

    const details = state.response.videoDetails || {};
    sub.textContent = `${details.title || 'Untitled'}${details.author ? ` • ${details.author}` : ''}`;
    sub.title = sub.textContent;

    const missing = state.formats.filter((f) => !f.url || f.locked).length;
    if (!state.formats.length && state.apiNote) {
      list.append(h('div', { class: 'ytdl-hint' },
        `YouTube rejected the API request: ${state.apiNote}. ` +
        'Make sure you are signed in at youtube.com (not an Incognito window), then click ⟳.'));
    }
    if (missing) {
      list.append(h('div', { class: 'ytdl-hint' },
        missing === state.formats.length
          ? 'The stream URL has not been captured yet. Play the video for ~3 seconds (so the player fetches the stream), then click ⟳.'
          : `${missing} formats have no URL yet. Play the video briefly, then click ⟳.`));
    }

    let total = 0;
    for (const section of SECTIONS) {
      const items = state.formats.filter((f) => f.kind === section.kind);
      if (!items.length) continue;
      total += items.length;
      list.append(h('div', { class: 'ytdl-sec', text: section.title }));
      if (section.kind === 'video') {
        list.append(h('div', { class: 'ytdl-hint' },
          'The rows below have NO audio. If you want sound, use the "Video + Audio" section above.'));
      }
      for (const f of items) list.append(renderRow(f));
    }

    if (!total) {
      list.append(h('div', { class: 'ytdl-empty' },
        'No formats available. The video may be DRM-protected / special (premiere, live, or rental).'));
    }

    // Restore in-progress download progress to its new row.
    syncDownloadRows();
    updateStatus();
    updateGlobal();
  }

  function buildPanel() {
    const panel = h(
      'div',
      { class: 'ytdl-panel' },
      h(
        'div',
        { class: 'ytdl-head' },
        h('div', { class: 'ytdl-headtext' },
          h('div', { class: 'ytdl-title' }, 'Download'),
          h('div', { class: 'ytdl-sub', text: 'Loading…' })),
        h('button', {
          class: 'ytdl-iconbtn',
          type: 'button',
          title: 'Reload the format list',
          text: '⟳',
          onclick: (e) => {
            e.stopPropagation();
            loadFormats();
          },
        }),
        h('button', {
          class: 'ytdl-iconbtn',
          type: 'button',
          title: 'Close',
          text: '✕',
          onclick: (e) => {
            e.stopPropagation();
            closePanel();
          },
        }),
      ),
      h('div', { class: 'ytdl-list' }),
      h('div', { class: 'ytdl-foot' },
        h('div', { text:
          'The "automatic merge" row downloads video+audio and joins them into a single MP4 ' +
          'without re-encoding. If it fails, download "Video only" + "Audio only", then merge with ' +
          'ffmpeg -i video -i audio -c copy output.mp4.' }),
        h('div', { class: 'ytdl-status', text: 'Checking…' })),
    );

    panel.addEventListener('click', (e) => e.stopPropagation());
    panel.addEventListener('mousedown', (e) => e.stopPropagation());
    panel.addEventListener('dblclick', (e) => e.stopPropagation());
    return panel;
  }

  function openPanel() {
    if (!state.panel) state.panel = buildPanel();

    placePanel();

    state.panel.classList.add('ytdl-open');
    if (state.btn) state.btn.classList.add('ytdl-on');
    loadFormats();
    updateStatus();
  }

  function closePanel() {
    if (state.panel) state.panel.classList.remove('ytdl-open');
    if (state.btn) state.btn.classList.remove('ytdl-on');
  }

  function togglePanel() {
    if (state.panel && state.panel.classList.contains('ytdl-open')) closePanel();
    else openPanel();
  }

  /* ============================================================
   * BUTTON MOUNTING
   * Default: chip in the top-right masthead (above the video, outside the frame).
   * Fullscreen: the chip sticks to the player's top-right corner.
   * ============================================================ */
  // Stored in memory, not sessionStorage. If the button is hidden and then
  // the page is reloaded, the button automatically comes back (it cannot get
  // "stuck" hidden).
  let hidden = false;

  function isHidden() {
    return hidden;
  }

  function setHidden(value) {
    hidden = Boolean(value);
  }

  function makeButton() {
    const btn = h('button', {
      class: 'ytdl-btn',
      type: 'button',
      title: 'Download video — choose a format (Alt+D / Alt+Shift+D)',
    }, svgIcon(), h('span', { text: 'Download' }));
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      togglePanel();
    });
    btn.addEventListener('mousedown', (e) => e.stopPropagation());
    return btn;
  }

  function buildBar() {
    const chip = h('span', {
      class: 'ytdl-global',
      title: 'Download progress — click to open the list',
    });
    chip.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      openPanel();
    });

    const btn = makeButton();
    const hide = h('button', {
      class: 'ytdl-hide',
      type: 'button',
      title: 'Hide the button (show it again: Alt+Shift+D or the ⬇ icon in the bottom-right)',
      text: '✕',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        hideWidget();
      },
    });
    hide.addEventListener('mousedown', (e) => e.stopPropagation());

    const bar = h('div', { class: 'ytdl-bar' }, chip, btn, hide);
    bar.addEventListener('click', (e) => e.stopPropagation());
    state.btn = btn;
    return bar;
  }

  function hideWidget() {
    setHidden(true);
    closePanel();
    if (state.bar) state.bar.remove();
    if (state.slot) state.slot.remove();
    if (state.panel) state.panel.remove();
    state.bar = null;
    state.slot = null;
    state.btn = null;
    ensureRestore(true);
  }

  function showWidget() {
    setHidden(false);
    removeRestore();
    state.bar = null;
    state.slot = null;
    state.btn = null;
    mount();
    if (state.bar) openPanel();
  }

  // Small icon in the bottom-right while the button is hidden, so there is
  // always a way to show it again even if the browser takes over Alt+D.
  function buildRestore() {
    const pill = h('button', {
      class: 'ytdl-restore',
      type: 'button',
      title: 'Show the Download button (Alt+Shift+D)',
      text: '⬇',
      onclick: (e) => {
        e.preventDefault();
        e.stopPropagation();
        showWidget();
      },
    });
    pill.addEventListener('mousedown', (e) => e.stopPropagation());
    return pill;
  }

  function ensureRestore(showHint) {
    if (!document.body) return;
    if (!state.restore || !state.restore.isConnected) {
      state.restore = buildRestore();
      document.body.appendChild(state.restore);
    }
    if (showHint) {
      state.restore.classList.add('ytdl-hint');
      clearTimeout(state.restore.__timer);
      state.restore.__timer = setTimeout(() => {
        if (state.restore) state.restore.classList.remove('ytdl-hint');
      }, 5000);
    }
  }

  function removeRestore() {
    if (state.restore) state.restore.remove();
    state.restore = null;
  }

  // Wrapper element inserted RIGHT ABOVE the player (outside the video
  // frame), not in YouTube's masthead/header.
  function ensureSlot() {
    if (!state.slot || !state.slot.isConnected) {
      state.slot = h('div', { class: 'ytdl-slot' });
    }
    return state.slot;
  }

  function isUsable(el) {
    if (!el || !el.isConnected) return false;
    const cs = getComputedStyle(el);
    if (cs.display === 'none' || cs.visibility === 'hidden') return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  }

  // Insert the bar OUTSIDE the player subtree. Inserting elements into #player
  // (before #player-container-outer) can make YouTube fail to create
  // #movie_player, so the video does not appear at all.
  //
  // There are two layouts:
  // - Normal: the video is inside #player (which has a size).
  // - Theater / narrow window: #player is hidden (0×0) and the video is
  //   moved to #full-bleed-container. The bar must follow into that
  //   container, otherwise the bar appears below the video.
  function findPlayerAnchor() {
    const movie = document.querySelector('#movie_player');
    const player = document.querySelector('#player');
    const bleed = document.querySelector('#full-bleed-container');

    if (player && isUsable(player) && (!movie || player.contains(movie))) return player;
    if (bleed && isUsable(bleed) && (!movie || bleed.contains(movie))) return bleed;

    // Fallback: pick a sized element that still contains the video.
    const selectors = ['#player', 'ytd-player', '#player-container-outer', '#movie_player'];
    for (const sel of selectors) {
      const el = document.querySelector(sel);
      if (isUsable(el) && el.parentElement) return el;
    }
    return null;
  }

  function placePanel() {
    if (!state.panel) return;
    const wasOpen = state.panel.classList.contains('ytdl-open');
    state.panel.classList.remove('ytdl-attached', 'ytdl-inline', 'ytdl-fixed');

    if (state.mode === 'inline') {
      state.panel.classList.add('ytdl-inline');
      const host = document.fullscreenElement || document.getElementById('movie_player') || document.body;
      if (state.panel.parentNode !== host) host.appendChild(state.panel);
    } else if (state.mode === 'fixed') {
      state.panel.classList.add('ytdl-fixed');
      if (state.panel.parentNode !== document.body) document.body.appendChild(state.panel);
    } else {
      state.panel.classList.add('ytdl-attached');
      const slot = ensureSlot();
      if (state.panel.parentNode !== slot) slot.appendChild(state.panel);
    }

    if (wasOpen) state.panel.classList.add('ytdl-open');
  }

  function mount() {
    if (!document.body) return;

    if (isHidden()) {
      if (state.slot) state.slot.remove();
      if (state.bar) state.bar.remove();
      ensureRestore(false);
      return;
    }

    removeRestore();
    const slot = ensureSlot();

    if (!state.bar || !state.bar.isConnected) {
      state.bar = buildBar();
      updateGlobal();
    }
    state.bar.classList.remove('ytdl-inline', 'ytdl-fixed');

    const fsEl = document.fullscreenElement;
    const inFullscreen = Boolean(
      fsEl && (fsEl.id === 'movie_player' || fsEl.classList.contains('html5-video-player')),
    );

    if (inFullscreen) {
      state.mode = 'inline';
      state.bar.classList.add('ytdl-inline');
      if (state.bar.parentNode !== fsEl) fsEl.appendChild(state.bar);
      placePanel();
      return;
    }

    // Without a video (e.g. the home page) the button is not shown.
    if (!currentVideoId()) {
      slot.remove();
      state.bar.remove();
      return;
    }

    const anchor = findPlayerAnchor();
    if (anchor) {
      // Insert the bar right above the video; the content below shifts
      // slightly so the button does not cover the video frame.
      state.mode = 'attached';
      const parent = anchor.parentElement;
      if (slot.parentNode !== parent || slot.nextElementSibling !== anchor) {
        parent.insertBefore(slot, anchor);
      }
      if (state.bar.parentNode !== slot) slot.appendChild(state.bar);
      placePanel();
      return;
    }

    // Fallback (e.g. mobile layout without #player-container-outer).
    state.mode = 'fixed';
    state.bar.classList.add('ytdl-fixed');
    if (state.bar.parentNode !== document.body) document.body.appendChild(state.bar);
    placePanel();
  }

  /* ============================================================
   * STYLES
   * ============================================================ */
  function injectStyle() {
    if (document.getElementById('ytdl-style')) return;
    const css = `
      .ytdl-slot { position: relative; z-index: 60; display: flex; align-items: center;
                   justify-content: flex-end; width: 100%; height: 34px; overflow: visible; }
      .ytdl-bar { display: inline-flex; align-items: center; gap: 4px; }
      .ytdl-bar.ytdl-inline { position: absolute; top: 12px; right: 12px; z-index: 70; margin: 0; }
      .ytdl-bar.ytdl-fixed { position: fixed; top: 66px; right: 12px; z-index: 3000; margin: 0; }

      .ytdl-restore {
        position: fixed; right: 14px; bottom: 14px; z-index: 2147483000;
        display: inline-flex; align-items: center; justify-content: center;
        width: 34px; height: 34px; padding: 0;
        border: 1px solid rgba(255,255,255,.22); border-radius: 50%;
        background: rgba(20,20,20,.62); color: #fff;
        font-size: 15px; line-height: 1; cursor: pointer;
        opacity: .45; transition: opacity .15s, background .15s, transform .15s;
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .ytdl-restore:hover, .ytdl-restore.ytdl-hint {
        opacity: 1; background: #f00; border-color: #f00;
      }
      .ytdl-restore:hover { transform: scale(1.06); }
      .ytdl-restore.ytdl-hint::before {
        content: 'Button hidden · Alt+Shift+D to show';
        position: absolute; right: 42px; top: 50%; transform: translateY(-50%);
        padding: 6px 9px; border-radius: 6px; white-space: nowrap;
        background: rgba(22,22,22,.96); border: 1px solid rgba(255,255,255,.14);
        color: #eaeaea; font: 500 11px/1.2 "Roboto","Arial",sans-serif;
        pointer-events: none;
      }

      .ytdl-btn {
        display: inline-flex; align-items: center; gap: 6px;
        height: 30px; padding: 0 10px;
        border: 1px solid rgba(127,127,127,.35); border-radius: 4px;
        background: rgba(127,127,127,.14); color: inherit; cursor: pointer;
        font: 500 12px/1 "Roboto","Arial",sans-serif; letter-spacing: .2px;
        white-space: nowrap;
      }
      .ytdl-btn:hover, .ytdl-btn.ytdl-on { background: #f00; border-color: #f00; color: #fff; }
      .ytdl-bar.ytdl-inline .ytdl-btn,
      .ytdl-bar.ytdl-fixed .ytdl-btn {
        background: rgba(20,20,20,.78); color: #fff; border-color: rgba(255,255,255,.2);
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .ytdl-bar.ytdl-inline .ytdl-btn:hover,
      .ytdl-bar.ytdl-fixed .ytdl-btn:hover { background: #f00; border-color: #f00; }

      .ytdl-hide {
        width: 22px; height: 30px; padding: 0;
        border: 1px solid transparent; border-radius: 4px;
        background: transparent; color: #9a9a9a; font-size: 11px; line-height: 1; cursor: pointer;
      }
      .ytdl-hide:hover { background: rgba(127,127,127,.22); color: #f44; }

      .ytdl-global {
        display: none; align-items: center; height: 30px; padding: 0 9px;
        border-radius: 999px; background: rgba(20,20,20,.78); color: #eaeaea;
        border: 1px solid rgba(255,255,255,.14);
        font: 600 11px/1 "Roboto","Arial",sans-serif; white-space: nowrap; cursor: pointer;
        -webkit-backdrop-filter: blur(6px); backdrop-filter: blur(6px);
      }
      .ytdl-global.ytdl-show { display: inline-flex; }
      .ytdl-global.ytdl-ok { color: #7bd88f; }
      .ytdl-global.ytdl-err { color: #ff8a80; }

      .ytdl-panel {
        position: absolute; top: 36px; right: 0; z-index: 3000;
        display: none; flex-direction: column; overflow: hidden;
        width: min(440px, calc(100vw - 24px)); max-height: min(72vh, 560px);
        border: 1px solid rgba(255,255,255,.14); border-radius: 10px;
        background: rgba(22,22,22,.97); color: #eaeaea;
        box-shadow: 0 14px 38px rgba(0,0,0,.6);
        font: 12px/1.45 "Roboto","Arial",sans-serif; text-align: left; direction: ltr;
      }
      .ytdl-panel.ytdl-open { display: flex; }
      .ytdl-panel.ytdl-inline { position: absolute; top: 52px; right: 12px; z-index: 71; }
      .ytdl-panel.ytdl-fixed { position: fixed; top: 102px; right: 12px; }
      .ytdl-panel *, .ytdl-bar * { box-sizing: border-box; }

      .ytdl-head { display: flex; align-items: flex-start; gap: 6px; padding: 10px 10px 9px 12px;
                   border-bottom: 1px solid rgba(255,255,255,.1); background: rgba(255,255,255,.02); }
      .ytdl-headtext { flex: 1 1 auto; min-width: 0; }
      .ytdl-title { font: 600 13px/1.3 "Roboto","Arial",sans-serif; color: #fff; }
      .ytdl-sub { margin-top: 2px; color: #a0a0a0; font-size: 11px;
                  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ytdl-iconbtn { flex: 0 0 auto; width: 26px; height: 26px; padding: 0;
                      border: 1px solid transparent; border-radius: 4px; background: transparent;
                      color: #cfcfcf; font-size: 13px; line-height: 1; cursor: pointer; }
      .ytdl-iconbtn:hover { background: rgba(255,255,255,.12); color: #fff; }

      .ytdl-list { overflow-y: auto; overscroll-behavior: contain; padding-bottom: 6px; }
      .ytdl-list::-webkit-scrollbar { width: 10px; }
      .ytdl-list::-webkit-scrollbar-thumb { background: rgba(255,255,255,.18); border-radius: 6px;
                                            border: 3px solid transparent; background-clip: content-box; }

      .ytdl-sec { padding: 11px 12px 5px; font-size: 10px; letter-spacing: .9px;
                  text-transform: uppercase; color: #8f8f8f; }
      .ytdl-row { position: relative; display: flex; align-items: center; gap: 10px; padding: 7px 12px 8px; }
      .ytdl-row:hover { background: rgba(255,255,255,.055); }
      .ytdl-row.ytdl-off { opacity: .45; }
      .ytdl-badge { flex: 0 0 auto; min-width: 56px; padding: 3px 6px; border-radius: 4px;
                    background: rgba(255,255,255,.1); font-weight: 600; font-size: 11.5px; text-align: center; }
      .ytdl-meta { flex: 1 1 auto; min-width: 0; }
      .ytdl-meta1 { color: #dcdcdc; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ytdl-meta2 { margin-top: 2px; color: #8b8b8b; font-size: 10.5px;
                    white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
      .ytdl-actions { display: flex; flex: 0 0 auto; gap: 6px; }
      .ytdl-mini { padding: 5px 9px; border: 1px solid rgba(255,255,255,.16); border-radius: 4px;
                   background: rgba(255,255,255,.08); color: #fff; cursor: pointer;
                   font: 600 11px/1 "Roboto","Arial",sans-serif; }
      .ytdl-mini:hover:not([disabled]) { background: #f00; border-color: #f00; }
      .ytdl-mini[disabled] { opacity: .35; cursor: not-allowed; }
      .ytdl-ghost { background: transparent; }
      .ytdl-progress { position: absolute; left: 12px; right: 12px; bottom: 2px; height: 3px;
                       border-radius: 2px; background: rgba(255,255,255,.08); overflow: hidden; opacity: 0; }
      .ytdl-row.ytdl-busy .ytdl-progress,
      .ytdl-row.ytdl-done .ytdl-progress,
      .ytdl-row.ytdl-error .ytdl-progress { opacity: 1; }
      .ytdl-row.ytdl-done .ytdl-progress > i { background: #2e9e4f; }
      .ytdl-row.ytdl-error .ytdl-progress > i { background: #c62828; }
      .ytdl-row.ytdl-done .ytdl-meta2 { color: #7bd88f; }
      .ytdl-row.ytdl-error .ytdl-meta2 { color: #ff8a80; }
      .ytdl-progress > i { display: block; height: 100%; width: 0; background: #f00; transition: width .2s linear; }
      .ytdl-progress.ytdl-indet > i { width: 35%; transition: none;
                                      animation: ytdl-slide 1.1s linear infinite; }
      @keyframes ytdl-slide { from { transform: translateX(-100%); } to { transform: translateX(320%); } }
      .ytdl-empty { padding: 14px 14px 18px; color: #9c9c9c; }
      .ytdl-hint { margin: 8px 12px 4px; padding: 7px 9px; border-radius: 6px;
                   background: rgba(255,183,0,.1); border: 1px solid rgba(255,183,0,.28);
                   color: #ffcf70; font-size: 10.5px; }
      .ytdl-foot { padding: 8px 12px 9px; border-top: 1px solid rgba(255,255,255,.1);
                   color: #868686; font-size: 10.5px; background: rgba(255,255,255,.02); }
      .ytdl-status { margin-top: 6px; padding-top: 6px; border-top: 1px dashed rgba(255,255,255,.08);
                     color: #6f6f6f; font-size: 10px; }
      .ytdl-toast { position: absolute; left: 12px; right: 12px; bottom: 12px; padding: 7px 10px;
                    border-radius: 6px; background: rgba(0,0,0,.88); color: #fff; font-size: 11.5px;
                    opacity: 0; transform: translateY(6px); transition: .16s ease; pointer-events: none; }
      .ytdl-toast.ytdl-show { opacity: 1; transform: none; }
    `;
    if (!document.head) return false;
    document.head.append(h('style', { id: 'ytdl-style', text: css }));
    return true;
  }

  /* ============================================================
   * LOOP / EVENTS
   * ============================================================ */
  let lastVideoId = null;

  function tick() {
    const vid = currentVideoId();
    if (vid !== lastVideoId) {
      lastVideoId = vid;
      state.formats = [];
      state.response = null;
      closePanel();
    }
    if (state.panel && state.panel.classList.contains('ytdl-open') && state.videoId && vid !== state.videoId) {
      closePanel();
    }
    mount();
  }

  document.addEventListener('click', (e) => {
    if (!state.panel || !state.panel.classList.contains('ytdl-open')) return;
    if (state.panel.contains(e.target) || (state.btn && state.btn.contains(e.target))) return;
    closePanel();
  });

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closePanel();
    // e.code is used so it is still detected even if Alt changes the character
    // (e.g. Alt+D produces "∂" on some keyboard layouts).
    const isD = e.code === 'KeyD' || e.key === 'd' || e.key === 'D'
      || e.key === '∂' || e.key === 'ð';
    if (e.altKey && isD) {
      e.preventDefault();
      if (isHidden()) showWidget();
      else togglePanel();
    }
  });

  document.addEventListener('fullscreenchange', () => {
    closePanel();
    mount();
  });

  window.addEventListener('yt-navigate-finish', () => {
    closePanel();
    setTimeout(() => safeTick(), 300);
  });

  const safeTick = () => {
    injectStyle();
    try {
      tick();
    } catch (err) {
      console.warn('[YT-DL] error while mounting the UI:', err);
    }
  };

  // Quick diagnostics: open the console and type __ytdl
  window.__ytdl = {
    version: VERSION,
    state,
    captured,
    get itags() { return [...captured.keys()]; },
  };

  hookNetwork();
  safeTick();
  setInterval(safeTick, 1000);
  document.addEventListener('DOMContentLoaded', safeTick, { once: true });
})();
