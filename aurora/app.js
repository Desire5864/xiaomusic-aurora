/* ==========================================================================
   XiaoMusic · aurora 主题
   原生 JS，无框架无构建。所有接口沿用 xiaomusic 现有 REST。
   ========================================================================== */
(() => {
  'use strict';

  const $ = (s, r = document) => r.querySelector(s);
  const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

  const SYS = ['所有歌曲', '所有电台', '收藏', '下载', '最近新增'];
  const HIDDEN = ['临时搜索列表', '全部', '其他'];
  const SYS_ICON = {
    所有歌曲: 'i-list', 所有电台: 'i-radio', 收藏: 'i-heart',
    下载: 'i-download', 最近新增: 'i-add',
  };
  const MODES = [
    { cmd: '顺序播放', icon: 'i-seq' },
    { cmd: '全部循环', icon: 'i-repeat' },
    { cmd: '单曲循环', icon: 'i-repeat1' },
    { cmd: '随机播放', icon: 'i-shuffle' },
  ];
  const PAGE_CAP = 800;
  const BATCH = 80;

  const S = {
    did: localStorage.getItem('xm_did') || 'web_device',
    devices: [],
    lists: {},
    cur: localStorage.getItem('xm_list') || '所有歌曲',
    songs: [],
    view: [],
    q: '',
    sortKey: '',
    sortDir: 1,
    tags: new Map(),
    curMusic: '',
    remoteList: '',
    isPlaying: false,
    mode: Number(localStorage.getItem('xm_mode') || 1),
    theme: localStorage.getItem('xm_theme') || 'auto',
    vol: 50,
    token: 0,
    loading: false,
    // 歌词
    lyric: null,        // [{t, text}]，t<0 表示无时间轴
    lyricIdx: -2,
    pos: 0,
    lyricHold: 0,       // 用户手动滚动后短暂暂停自动跟随
    lyricTried: null,   // Set，避免重复请求
    // 音箱模式的位置补偿：轮询 3 秒一次太粗，两次轮询之间本地按时间外推
    posBase: null,
    posAt: 0,
    playing: false,
    dur: 0,
  };

  let curSong = null;
  const rowEls = new Map();
  let toastTimer = null;
  let volTimer = null;
  let qTimer = null;
  let lyricFor = null;

  /* ------------------------------------------------------------- 工具 */
  const esc = (s) => String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');

  function pretty(name) {
    let n = String(name || '');
    const slash = n.lastIndexOf('/');
    if (slash >= 0) n = n.slice(slash + 1);
    return n.replace(/\.[a-z0-9]{2,5}$/i, '') || n;
  }

  function fmt(sec) {
    const s = Math.max(0, Math.round(Number(sec) || 0));
    const m = Math.floor(s / 60);
    return m + ':' + String(s % 60).padStart(2, '0');
  }

  function durOf(info) {
    if (!info) return 0;
    const t = info.tags || {};
    return Number(info.duration || t.duration || 0) || 0;
  }

  function toast(msg) {
    const t = $('#toast');
    t.textContent = msg;
    t.classList.add('show');
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => t.classList.remove('show'), 2000);
  }

  async function api(path, opts) {
    const r = await fetch(path, Object.assign({ credentials: 'same-origin' }, opts || {}));
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const ct = r.headers.get('content-type') || '';
    return ct.indexOf('json') >= 0 ? r.json() : r.text();
  }
  const post = (path, body) => api(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });

  function gradient(seed) {
    if (!seed) return 'linear-gradient(148deg,#2b1c3f,#141225)';
    let h = 0;
    for (let i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) % 360;
    return 'radial-gradient(circle at 28% 22%, hsla(' + ((h + 40) % 360) + ',85%,66%,.92), transparent 52%),' +
      'radial-gradient(circle at 74% 26%, hsla(' + ((h + 195) % 360) + ',80%,60%,.72), transparent 55%),' +
      'radial-gradient(circle at 52% 82%, hsla(' + ((h + 285) % 360) + ',85%,62%,.82), transparent 60%),' +
      'linear-gradient(148deg,#2b1c3f,#141225)';
  }

  /* ------------------------------------------------------------- 启动 */
  async function boot() {
    applyTheme();
    bind();
    await loadDevices();
    await loadLists();
    if (!Array.isArray(S.lists[S.cur])) S.cur = '所有歌曲';
    renderRail();
    await selectList(S.cur);
    setMode(S.mode, false);
    syncPlayBtns();
    updateNow();
    renderLyric(true);
    refreshVolume();
    poll();
    setInterval(poll, 3000);
    setInterval(tickPos, 400);
  }

  async function loadDevices() {
    let dids = [];
    try {
      const st = await api('/getsetting');
      dids = String(st.mi_did || '').split(',').map((x) => x.trim()).filter(Boolean);
    } catch (e) { /* 未配置小米账号时也能用 Web 播放器 */ }

    const list = [{ id: 'web_device', name: 'Web 播放器', sub: '本机浏览器', kind: 'web' }];
    dids.forEach((id, i) => {
      list.push({
        id,
        name: localStorage.getItem('xm_nick_' + id) || ('小爱音箱 ' + (i + 1)),
        sub: id.slice(0, 10),
        kind: 'speaker',
      });
    });
    S.devices = list;

    // 支持 ?did=xxx 深链，方便给每台设备存一个书签
    const want = new URLSearchParams(location.search).get('did');
    if (want && list.some((d) => d.id === want)) {
      S.did = want;
      localStorage.setItem('xm_did', want);
    } else if (!localStorage.getItem('xm_did')) {
      // 没存过偏好时优先选音箱：这个面板的意义就是推歌给音箱，
      // 默认落在 Web 播放器上会让人以为"点了没声音"
      const sp = list.find((d) => d.kind === 'speaker');
      if (sp) S.did = sp.id;
    }
    if (!list.some((d) => d.id === S.did)) S.did = 'web_device';
    syncDeviceLabel();
  }

  async function loadLists() {
    try {
      const d = await api('/musiclist');
      S.lists = d && typeof d === 'object' ? d : {};
    } catch (e) {
      S.lists = {};
      toast('读取列表失败');
    }
  }

  const countOf = (n) => (Array.isArray(S.lists[n]) ? S.lists[n].length : 0);

  /* ------------------------------------------------------------- 主题 */
  const THEMES = ['auto', 'light', 'dark'];
  const THEME_LABEL = { auto: '跟随系统', light: '浅色', dark: '深色' };
  const THEME_ICON = { auto: 'i-auto', light: 'i-sun', dark: 'i-moon' };
  const mqDark = window.matchMedia('(prefers-color-scheme: dark)');

  function isDarkNow() {
    return S.theme === 'dark' || (S.theme === 'auto' && mqDark.matches);
  }

  function applyTheme() {
    const dark = isDarkNow();
    document.documentElement.dataset.theme = dark ? 'dark' : 'light';
    const btn = $('#btnTheme');
    if (btn) {
      btn.title = '主题：' + THEME_LABEL[S.theme] + '（点击切换）';
      const use = btn.querySelector('use');
      if (use) use.setAttribute('href', '#' + THEME_ICON[S.theme]);
    }
    const lb = $('#themeLabel');
    if (lb) lb.textContent = THEME_LABEL[S.theme];
  }

  function cycleTheme() {
    S.theme = THEMES[(THEMES.indexOf(S.theme) + 1) % THEMES.length];
    localStorage.setItem('xm_theme', S.theme);
    applyTheme();
    toast('主题：' + THEME_LABEL[S.theme]);
  }

  function syncDeviceLabel() {
    const d = S.devices.find((x) => x.id === S.did);
    const el = $('#devName');
    if (el) el.textContent = d ? d.name : 'Web 播放器';
  }

  /* ------------------------------------------------------------- 左栏 / 胶囊 */
  function railRow(name, icon, cls) {
    return '<div class="rail-item' + (name === S.cur ? ' on' : '') + '" data-list="' + esc(name) + '">' +
      '<svg class="ic"><use href="#' + icon + '"/></svg>' +
      '<span class="rail-label">' + esc(name) + '</span>' +
      '<span class="rail-cnt">' + countOf(name) + '</span></div>';
  }

  function renderRail() {
    $('#deviceList').innerHTML = S.devices.map((d) =>
      '<div class="rail-item' + (d.id === S.did ? ' on' : '') + '" data-did="' + esc(d.id) + '">' +
      '<svg class="ic"><use href="#' + (d.kind === 'web' ? 'i-monitor' : 'i-speaker') + '"/></svg>' +
      '<span class="rail-label">' + esc(d.name) + '</span></div>').join('');

    $('#sysList').innerHTML = SYS.map((n) => railRow(n, SYS_ICON[n])).join('');

    const custom = Object.keys(S.lists).filter((n) => SYS.indexOf(n) < 0 && HIDDEN.indexOf(n) < 0);
    $('#cusList').innerHTML = custom.map((n) => railRow(n, 'i-list')).join('');

    $('#chips').innerHTML = SYS.concat(custom).map((n) =>
      '<button class="chip' + (n === S.cur ? ' on' : '') + '" data-list="' + esc(n) + '">' + esc(n) + '</button>').join('');
  }

  function highlightList() {
    $$('[data-list]').forEach((el) => {
      el.classList.toggle('on', el.getAttribute('data-list') === S.cur);
    });
  }

  function updateTitles() {
    const n = S.songs.length;
    $('#dTitle').textContent = S.cur;
    $('#mTitle').textContent = S.cur;
    $('#dMeta').textContent = n ? n + ' 首' : '空列表';
    $('#mCount').textContent = n ? n + ' 首' : '';
  }

  /* ------------------------------------------------------------- 列表 */
  function normalize(entry) {
    const id = typeof entry === 'string'
      ? entry
      : (entry && (entry.name || entry.title || entry.id)) || String(entry);
    const info = S.tags.get(id);
    const t = (info && info.tags) || {};
    return {
      id,
      title: t.title || pretty(id),
      artist: t.artist || '',
      album: t.album || '',
      duration: durOf(info) ? fmt(durOf(info)) : '',
      url: (info && info.url) || '',
      pic: t.picture || '',
      lyrics: t.lyrics || '',
      secs: durOf(info),
    };
  }

  async function selectList(name) {
    S.cur = name;
    localStorage.setItem('xm_list', name);

    // 换歌单时清掉搜索词，否则会看到「空列表」而不知为何
    if (S.q) {
      S.q = '';
      const dq = $('#dQ');
      const mq = $('#mQ');
      if (dq) dq.value = '';
      if (mq) mq.value = '';
    }

    const raw = Array.isArray(S.lists[name]) ? S.lists[name] : [];
    S.songs = raw.map(normalize);
    S.token += 1;
    const token = S.token;

    highlightList();
    updateTitles();
    applyView();
    renderRail();
    highlightList();

    await loadTags(S.songs.map((s) => s.id), token);
  }

  async function loadTags(ids, token) {
    const need = ids.filter((id) => !S.tags.has(id));
    if (!need.length) return;

    const bar = $('#loadbar');
    const fill = bar.querySelector('i');
    const txt = bar.querySelector('span');
    bar.hidden = false;
    S.loading = true;

    for (let i = 0; i < need.length; i += BATCH) {
      if (token !== S.token) break;
      const chunk = need.slice(i, i + BATCH);
      try {
        const res = await post('/musicinfos', { name: chunk, musictag: true });
        (Array.isArray(res) ? res : []).forEach((info) => {
          if (info && info.name) S.tags.set(info.name, info);
        });
        S.songs.forEach((s) => {
          if (chunk.indexOf(s.id) >= 0) {
            Object.assign(s, normalize(s.id));
            paintRow(s);
          }
        });
      } catch (e) { /* 单批失败不中断整表 */ }

      const done = Math.min(i + BATCH, need.length);
      fill.style.width = Math.round((done / need.length) * 100) + '%';
      txt.textContent = '读取曲目信息 ' + done + '/' + need.length;
      await new Promise((r) => setTimeout(r, 0));
    }

    bar.hidden = true;
    S.loading = false;
    if (token === S.token) {
      if (curSong) setCur(S.curMusic);
      speedFinalise();
    }
  }

  function speedFinalise() {
    // 标签补齐后重算排序（按时长排序时才有意义）
    if (S.sortKey) applyView();
  }

  function applyView() {
    const q = S.q.trim().toLowerCase();
    let v = S.songs;
    if (q) {
      v = v.filter((s) => (s.title + ' ' + s.artist + ' ' + s.album + ' ' + s.id).toLowerCase().indexOf(q) >= 0);
    }
    if (S.sortKey) {
      const k = S.sortKey;
      const dir = S.sortDir;
      v = v.slice().sort((a, b) => {
        if (k === 'duration') return (a.secs - b.secs) * dir;
        return String(a[k] || '').localeCompare(String(b[k] || ''), 'zh-Hans-CN') * dir;
      });
    }
    const total = v.length;
    S.view = v.slice(0, PAGE_CAP);
    renderRows(total);
  }

  function renderRows(total) {
    const wrap = $('#rows');
    const empty = $('#empty');
    rowEls.clear();

    if (!S.view.length) {
      wrap.replaceChildren();
      empty.hidden = false;
      empty.textContent = S.q.trim()
        ? '没有匹配「' + S.q.trim() + '」的歌曲'
        : '这个歌单还是空的';
      return;
    }
    empty.hidden = true;

    const frag = document.createDocumentFragment();
    S.view.forEach((s) => {
      const el = document.createElement('div');
      el.className = 'grid row';
      el.dataset.id = s.id;
      el.innerHTML =
        '<div class="c-cov"></div>' +
        '<div class="c-num"></div>' +
        '<div class="c-ttl"></div>' +
        '<div class="c-art"></div>' +
        '<div class="c-alb"></div>' +
        '<div class="c-dur"></div>' +
        '<div class="c-more"><button type="button" aria-label="更多操作">' +
        '<svg class="ic"><use href="#i-more"/></svg></button></div>';
      frag.appendChild(el);
      rowEls.set(s.id, {
        el,
        cov: el.querySelector('.c-cov'),
        num: el.querySelector('.c-num'),
        ttl: el.querySelector('.c-ttl'),
        art: el.querySelector('.c-art'),
        alb: el.querySelector('.c-alb'),
        dur: el.querySelector('.c-dur'),
      });
    });
    wrap.replaceChildren(frag);

    S.view.forEach((s) => paintRow(s));
    syncRowState();

    if (total > PAGE_CAP) {
      const hint = document.createElement('div');
      hint.className = 'rows-hint';
      hint.textContent = '共 ' + total + ' 首，先显示前 ' + PAGE_CAP + ' 首 —— 用搜索缩小范围';
      wrap.appendChild(hint);
    }
  }

  /* 行首封面：有内嵌图用真图，没有就按歌名生成渐变 */
  function paintCover(el, s) {
    if (!el) return;
    const src = s.pic ? picSrc(s.pic) : '';
    if (el.dataset.src === src) return;   // 同一张图不重复插，避免标签刷新时闪
    el.dataset.src = src;
    el.replaceChildren();
    el.style.background = gradient(s.id);
    if (!src) return;

    const img = new Image();
    img.alt = '';
    img.loading = 'lazy';
    img.addEventListener('error', () => img.remove());
    img.src = src;
    el.appendChild(img);
  }

  function paintRow(s) {
    const r = rowEls.get(s.id);
    if (!r) return;
    paintCover(r.cov, s);
    r.ttl.textContent = s.title || pretty(s.id);
    r.art.textContent = s.artist || '未知歌手';
    r.alb.textContent = s.album || '';
    r.dur.textContent = s.duration || '—';
  }

  function syncRowState() {
    S.view.forEach((s, i) => {
      const r = rowEls.get(s.id);
      if (!r) return;
      const on = s.id === S.curMusic;
      r.el.classList.toggle('on', on);
      r.el.classList.toggle('paused', on && !S.isPlaying);
      r.num.innerHTML = on
        ? '<div class="eq"><i></i><i></i><i></i></div>'
        : String(i + 1);
    });
  }

  /* ------------------------------------------------------------- 播放状态 */
  function songOf(id) {
    if (!id) return null;
    const hit = S.songs.find((x) => x.id === id);
    if (hit) return hit;
    return normalize(id);
  }

  function setCur(id) {
    S.curMusic = id || '';
    curSong = songOf(S.curMusic);
    updateNow();
    syncRowState();
    renderLyric();
    if (curSong && !S.tags.has(curSong.id)) fetchLyric(curSong.id);
  }

  /* 封面地址有三种形态，混杂出现：
       http(s)://host/picture/...   ← 实际接口返回的就是这个
       /picture/...                 ← 相对路径
       <base64>                     ← 老接口可能直接给 base64
     统一成"同源相对路径"，这样不管从 IP 还是域名访问都能加载。 */
  function picSrc(pic) {
    if (!pic || typeof pic !== 'string') return '';
    const s = pic.trim();
    if (!s) return '';
    if (/^data:/i.test(s)) return s;
    if (/^https?:\/\//i.test(s)) {
      try { const u = new URL(s); return u.pathname + u.search; } catch (e) { return s; }
    }
    if (s.charAt(0) === '/') return s;
    return 'data:image/jpeg;base64,' + s;
  }

  function paintArt(el, song, onReady, plain) {
    if (!el) return;
    el.innerHTML = '';
    // plain：播放页的大封面没图时用中性深色，别用彩色渐变（会在深色页面上很跳）
    el.style.background = plain
      ? 'linear-gradient(148deg, #2b3140, #191c25)'
      : gradient(song ? song.id : '');

    const src = song ? picSrc(song.pic) : '';
    if (!src) return;

    const img = new Image();
    img.alt = '';
    img.addEventListener('error', () => img.remove());
    if (onReady) img.addEventListener('load', () => onReady(img));
    img.src = src;
    el.appendChild(img);
  }

  /* 取封面主色：按色相分桶，取权重最高的两桶（避免被大面积白/天空拉成灰） */
  function coverColor(img) {
    const clamp = (out) => {
      const l = (out[0] * .3 + out[1] * .59 + out[2] * .11) / 255;
      if (l > .70) return out.map((v) => Math.round(v * (.70 / l)));
      if (l < .20) return out.map((v) => Math.round(Math.min(255, v * (.24 / Math.max(l, .04)))));
      return out.map((v) => Math.round(v));
    };
    try {
      const c = document.createElement('canvas');
      c.width = c.height = 24;
      const g = c.getContext('2d', { willReadFrequently: true });
      g.drawImage(img, 0, 0, 24, 24);
      const d = g.getImageData(0, 0, 24, 24).data;

      const bins = [];
      for (let i = 0; i < 12; i++) bins.push([0, 0, 0, 0]);
      let ar = 0, ag = 0, ab = 0, an = 0;

      for (let i = 0; i < d.length; i += 4) {
        const R = d[i], G = d[i + 1], B = d[i + 2];
        const mx = Math.max(R, G, B), mn = Math.min(R, G, B);
        const sat = mx === 0 ? 0 : (mx - mn) / mx;
        const lum = (R * .3 + G * .59 + B * .11) / 255;
        ar += R; ag += G; ab += B; an++;
        if (sat < .18 || lum < .10 || lum > .93) continue;   // 跳过灰/黑/白

        let h;
        if (mx === mn) h = 0;
        else if (mx === R) h = ((G - B) / (mx - mn) + 6) % 6;
        else if (mx === G) h = (B - R) / (mx - mn) + 2;
        else h = (R - G) / (mx - mn) + 4;
        const bi = Math.floor(h * 2) % 12;                   // 每 30° 一桶
        const w = sat * (0.4 + Math.min(lum, .85));
        bins[bi][0] += R * w; bins[bi][1] += G * w; bins[bi][2] += B * w; bins[bi][3] += w;
      }

      const order = bins.map((b, i) => i).sort((x, y) => bins[y][3] - bins[x][3]);
      const one = bins[order[0]], two = bins[order[1]];
      const avg = (b) => [b[0] / b[3], b[1] / b[3], b[2] / b[3]];

      if (one[3] < 0.5) {
        const fallback = clamp([ar / an, ag / an, ab / an]);
        return [fallback, fallback];
      }
      const c1 = clamp(avg(one));
      // 第二色太弱或跟第一色太像就复用
      const far = two[3] > one[3] * 0.35 &&
        (Math.abs(two[0] / two[3] - c1[0]) + Math.abs(two[1] / two[3] - c1[1]) +
         Math.abs(two[2] / two[3] - c1[2])) > 60;
      return [c1, far ? clamp(avg(two)) : c1];
    } catch (e) { return null; }
  }

  function applyCoverTint(img) {
    const cols = coverColor(img);
    if (!cols) return;
    const root = document.documentElement;
    root.style.setProperty('--cov', cols[0].join(', '));
    root.style.setProperty('--cov2', cols[1].join(', '));
  }

  function updateNow() {
    const title = curSong ? curSong.title : '未在播放';
    // 专辑名常常等于歌名（单曲），重复一遍只是噪音，去掉
    let meta = '选择一首歌开始';
    if (curSong) {
      const key = (s) => (s || '').toLowerCase().replace(/[\s\-_（）()【】\[\]]/g, '');
      const parts = [curSong.artist || '未知歌手'];
      if (curSong.album && key(curSong.album) !== key(curSong.title) &&
          key(curSong.album) !== key(curSong.artist)) {
        parts.push(curSong.album);
      }
      meta = parts.join(' · ');
    }

    $('#mTitle2').textContent = title;
    $('#mMeta2').textContent = meta;
    $('#stageTitle').textContent = title;
    $('#stageMeta').textContent = meta;

    // 背景大图 = 当前封面（CSS 里模糊后用）
    const root = document.documentElement;
    const cs = curSong ? picSrc(curSong.pic) : '';
    if (cs) root.style.setProperty('--cover-img', 'url("' + cs.replace(/["'\\]/g, '') + '")');
    else root.style.removeProperty('--cover-img');

    const sh = $('#sheet');
    if (sh && !sh.hidden) {
      $('#sheetTitle').textContent = title;
      $('#sheetMeta').textContent = meta;
    }

    paintArt($('#mArt'), curSong);
    paintArt($('#stageArt'), curSong, applyCoverTint, true);

    // 播放页的氛围底：有封面用封面本身，没有就用中性冷灰
    const bg = $('#stageBg');
    if (!curSong || !picSrc(curSong.pic)) {
      // 没有封面时把主色复位，否则会沿用上一首的颜色
      document.documentElement.style.removeProperty('--cov');
      document.documentElement.style.removeProperty('--cov2');
    }
    if (bg) {
      const src = curSong ? picSrc(curSong.pic) : '';
      bg.style.backgroundImage = src
        ? 'url("' + src.replace(/["'\\]/g, '') + '")'
        : 'linear-gradient(135deg, #dfe6f2, #eef1f7)';
    }

    $('#btnFav').classList.toggle('on', false);
    syncPlayBtns();
  }

  function syncPlayBtns() {
    if (S.did === 'web_device') {
      const a = $('#audio');
      S.isPlaying = !!a.currentSrc && !a.paused;
    }
    const useId = S.isPlaying ? '#i-pause' : '#i-play';
    $$('.play .ic use').forEach((u) => u.setAttribute('href', useId));
  }

  function setProgress(c, d) {
    const p = d > 0 ? Math.max(0, Math.min(1, c / d)) : 0;
    const tr = $('#track');
    tr.querySelector('i').style.width = (p * 100) + '%';
    tr.querySelector('b').style.left = (p * 100) + '%';
    $('#tCur').textContent = fmt(c);
    $('#tDur').textContent = fmt(d);
    $('#mProg').style.width = (p * 100) + '%';
    const st = $('#stTrack');
    if (st) {
      st.querySelector('i').style.width = (p * 100) + '%';
      st.querySelector('b').style.left = (p * 100) + '%';
      $('#stCur').textContent = fmt(c);
      $('#stDur').textContent = fmt(d);
    }
    const sp = $('#sheetProg');
    if (sp) sp.style.width = (p * 100) + '%';
    updateLyricTime(c);
  }

  /* ------------------------------------------------------------- 歌词 */
  // 歌词开头的版权信息行：词/曲/编曲/出品…，显示出来太吵
  const CREDIT_RE = new RegExp(
    '^(' +
    '作词|作曲|词|曲|编曲|混音|母带|出品|制作人|制作|监制|统筹|企划|发行|录音|和声|吉他|贝斯|鼓|键盘|弦乐|' +
    'OP|SP|ISRC|未经|' +
    'lyrics?(\\s*by)?|composed(\\s*by)?|composer|written\\s*by|produced\\s*by|arranged\\s*by|' +
    'mixed\\s*by|mastered\\s*by|music\\s*by|performed\\s*by|artist' +
    ')\\s*[:：]', 'i');
  const NOISE_RE = /未经著作权人许可|本作品经词曲作者|酷狗音乐|QQ音乐|网易云音乐/i;

  /** 只保留文字，用于比较（不含任何业务逻辑） */
  const lrcNorm = (s) => String(s || '').toLowerCase().replace(/[^\w\u4e00-\u9fff]+/g, '');

  function isNoise(text, title, at, artist) {
    if (CREDIT_RE.test(text) || NOISE_RE.test(text)) return true;
    // 只剩一个标记位（[Verse 1] / [Chorus] 之类）的行
    if (/^\[[^\]]*\]$/.test(text.trim())) return true;
    // 首行常是「歌名 - 歌手」，若以歌名开头且带分隔符则丢掉
    const t = lrcNorm(title);
    if (t && lrcNorm(text).indexOf(t) === 0 && /[-–—]/.test(text)) return true;
    // 开头 10 秒内、带分隔线、且以歌名前三个字开头 / 含歌手名的，基本是曲目信息行
    if (at !== undefined && at <= 10 && /[-–—]/.test(text)) {
      const n = lrcNorm(text);
      if ((t && n.indexOf(t.slice(0, 3)) === 0) ||
          (artist && n.indexOf(lrcNorm(artist)) >= 0)) return true;
    }
    return false;
  }

  function parseLrc(raw, title, artist) {
    if (!raw || !raw.trim()) return null;
    let offset = 0;
    const om = raw.match(/\[offset:\s*([+-]?\d+)\]/i);
    if (om) offset = parseInt(om[1], 10) / 1000;

    const timed = [];
    const re = /\[(\d{1,3}):(\d{1,2})(?:[.:](\d{1,3}))?\]/g;
    raw.split(/\r?\n/).forEach((line) => {
      re.lastIndex = 0;
      const stamps = [];
      let m;
      while ((m = re.exec(line))) {
        const mm = +m[1];
        const ss = +m[2];
        const frac = m[3] ? +('0.' + m[3]) : 0;
        stamps.push(mm * 60 + ss + frac);
      }
      if (!stamps.length) return;
      const text = line.replace(re, '').trim();
      // 一条歌词可能带多个时间戳（副歌重复），全部被判为噪声才丢
      if (!text || stamps.every((v) => isNoise(text, title, v + offset, artist))) return;
      stamps.forEach((t) => timed.push({ t: t + offset, text }));
    });

    if (timed.length) {
      timed.sort((a, b) => a.t - b.t);
      return timed;
    }
    // 没有时间轴：按行拆成纯文本，渲染但不做跟随
    const plain = raw.split(/\r?\n/)
      .map((s) => s.replace(/^\[[^\]]*\]/, '').trim())
      .filter((s) => s && !isNoise(s, title, undefined, artist));
    return plain.length ? plain.map((t) => ({ t: -1, text: t })) : null;
  }

  function renderLyric(force) {
    const id = curSong ? curSong.id : '';
    if (!force && id === lyricFor) return;
    lyricFor = id;

    const raw = (curSong && curSong.lyrics) || '';
    S.lyric = parseLrc(raw, curSong ? curSong.title : '', curSong ? curSong.artist : '');
    S.lyricIdx = -2;

    const hasTime = !!(S.lyric && S.lyric.length && S.lyric[0].t >= 0);
    const clickable = hasTime && S.did === 'web_device';

    [$('#lyric'), $('#stageLyric'), $('#sheetBody')].forEach((el) => {
      if (!el) return;
      el.innerHTML = '';
      if (!S.lyric) {
        el.innerHTML = '<div class="ly-empty">' +
          (curSong ? '这首歌还没有歌词' : '未在播放') + '</div>';
        return;
      }
      const frag = document.createDocumentFragment();
      S.lyric.forEach((ln, i) => {
        const d = document.createElement('div');
        d.className = 'ly-line' + (clickable ? ' clickable' : '');
        d.dataset.i = i;
        d.textContent = ln.text;
        frag.appendChild(d);
      });
      el.appendChild(frag);
      el.scrollTop = 0;
    });

    if (hasTime) updateLyricTime(S.pos);
  }

  function centerIn(box, line) {
    // 用 rect 差值算相对偏移：offsetTop 依赖定位祖先，容器没 position 时会算错
    const b = box.getBoundingClientRect();
    const l = line.getBoundingClientRect();
    const target = box.scrollTop + (l.top - b.top) - box.clientHeight / 2 + line.offsetHeight / 2;
    // 用 instant 而不是 smooth：smooth 每换一行都要动画几百毫秒，观感就是"延迟"
    box.scrollTo({ top: Math.max(0, target), behavior: 'auto' });
  }

  function markLyric(idx) {
    [$('#lyric'), $('#stageLyric'), $('#sheetBody')].forEach((el) => {
      if (!el) return;
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) kids[i].classList.toggle('on', i === idx);
    });
    if (Date.now() < S.lyricHold) return;

    const a = $('#lyric');
    if (a && !a.hidden && a.children[idx]) centerIn(a, a.children[idx]);
    const b = $('#sheetBody');
    if (b && $('#sheet').classList.contains('open') && b.children[idx]) {
      centerIn(b, b.children[idx]);
    }
    const c = $('#stageLyric');
    if (c && $('#stage').classList.contains('open') && c.children[idx]) {
      centerIn(c, c.children[idx]);
    }
  }

  function updateLyricTime(pos) {
    S.pos = Math.max(0, Number(pos) || 0);
    if (!S.lyric || !S.lyric.length || S.lyric[0].t < 0) return;
    let idx = -1;
    for (let i = 0; i < S.lyric.length; i++) {
      if (S.lyric[i].t <= S.pos + 0.2) idx = i;
      else break;
    }
    if (idx !== S.lyricIdx) {
      S.lyricIdx = idx;
      markLyric(idx);
    }
  }

  /** 曲目不在已加载列表里（例如音箱正在放别的歌单）时，按需拉一次标签 */
  async function fetchLyric(id) {
    if (!S.lyricTried) S.lyricTried = new Set();
    if (!id || S.lyricTried.has(id)) return;
    S.lyricTried.add(id);
    try {
      const info = await api('/musicinfo?name=' + encodeURIComponent(id) + '&musictag=true');
      if (info && info.name) {
        S.tags.set(info.name, info);
        if (curSong && curSong.id === id) {
          Object.assign(curSong, normalize(id));
          renderLyric(true);
        }
      }
    } catch (e) { /* 忽略 */ }
  }

  function seekToLyric(e) {
    const line = e.target.closest('.ly-line');
    if (!line || !line.classList.contains('clickable')) return;
    const ln = S.lyric && S.lyric[+line.dataset.i];
    if (!ln || ln.t < 0) return;
    if (S.did !== 'web_device') { toast('音箱模式无法跳转播放位置'); return; }
    const a = $('#audio');
    if (!a.duration) { toast('音频还没加载好'); return; }
    a.currentTime = ln.t;
    updateLyricTime(ln.t);
  }

  /* ------------------------------------------------------------- 全屏播放页 */
  function openStage() {
    const st = $('#stage');
    if (!st) return;
    const d = S.devices.find((x) => x.id === S.did);
    $('#stageDev').textContent = d ? d.name : 'Web 播放器';
    if (st.classList.contains('open')) return;

    st.hidden = false;
    renderLyric(true);
    if (!$('#stageQueue').hidden) renderStageQueue();
    // 布局完成后再定位高亮行，否则容器高度还是 0
    requestAnimationFrame(() => {
      st.classList.add('open');
      S.lyricIdx = -2;
      updateLyricTime(S.pos);
    });
  }

  function closeStage() {
    const st = $('#stage');
    if (!st || st.hidden) return;
    st.classList.remove('open');
    setTimeout(() => { st.hidden = true; }, 240);
  }

  function openSheet() {
    const s = $('#sheet');
    if (!s || s.classList.contains('open')) return;
    s.hidden = false;
    $('#sheetTitle').textContent = $('#mTitle2').textContent;
    $('#sheetMeta').textContent = $('#mMeta2').textContent;
    renderLyric(true);
    // .open 在下一帧才加，所以定位必须放进 rAF，否则 markLyric 会跳过滚动
    requestAnimationFrame(() => {
      s.classList.add('open');
      S.lyricIdx = -2;
      updateLyricTime(S.pos);
    });
  }

  function closeSheet() {
    const s = $('#sheet');
    if (!s || s.hidden) return;
    s.classList.remove('open');
    setTimeout(() => { s.hidden = true; }, 280);
  }

  function qRowHTML(s, idx) {
    const src = picSrc(s.pic);
    const thumb = src
      ? '<img alt="" src="' + esc(src) + '" onerror="this.remove()">'
      : '';
    return '<div class="q-row" data-play="' + esc(s.id) + '">' +
      '<span class="q-i">' + idx + '</span>' +
      '<span class="q-mini" style="background:' + gradient(s.id) + '">' + thumb + '</span>' +
      '<div class="q-mid"><span class="q-t">' + esc(s.title) + '</span>' +
      '<span class="q-a">' + esc(s.artist || '未知歌手') + '</span></div>' +
      '<span class="q-d">' + esc(s.duration || '') + '</span></div>';
  }

  /* 播放页里的队列：一次多渲染些，靠滚动看 */
  function renderStageQueue() {
    const box = $('#stageQueue');
    if (!box) return;
    const list = S.view.length ? S.view : S.songs;
    const i = list.findIndex((s) => s.id === S.curMusic);
    const from = i >= 0 ? i + 1 : 0;
    const rows = list.slice(from, from + 40);
    box.innerHTML = rows.length
      ? rows.map((s, k) => qRowHTML(s, k + 1)).join('')
      : '<div class="ly-empty">后面没有待播的歌了</div>';
  }

  function setStagePane(pane) {
    $$('#stageSeg button').forEach((b) => b.classList.toggle('on', b.dataset.stpane === pane));
    const isL = pane === 'lyric';
    $('#stageLyric').hidden = !isL;
    $('#stageQueue').hidden = isL;
    if (isL) {
      renderLyric(true);
      S.lyricIdx = -2;
      updateLyricTime(S.pos);
    } else {
      renderStageQueue();
    }
  }

  /* ------------------------------------------------------------- 播放控制 */
  async function playSong(id) {
    if (!id) return;
    const s = songOf(id);

    if (S.did === 'web_device') {
      let url = s.url;
      if (!url) {
        try {
          const info = await api('/musicinfo?name=' + encodeURIComponent(id) + '&musictag=true');
          url = info && info.url;
          if (info && info.name) S.tags.set(info.name, info);
        } catch (e) { /* ignore */ }
      }
      if (!url) { toast('这首歌没有可播放的地址'); return; }
      const a = $('#audio');
      a.src = url;
      try { await a.play(); } catch (e) { toast('浏览器拦截了播放，请再点一次'); }
      S.remoteList = S.cur;
    } else {
      try {
        const r = await post('/playmusiclist', { did: S.did, listname: S.cur, musicname: id });
        if (r && r.ret === 'OK') {
          S.isPlaying = true;
          S.remoteList = S.cur;
        } else {
          toast('设备没有接受这条播放指令');
        }
      } catch (e) {
        toast('下发失败：' + e.message);
      }
    }

    setCur(id);
    setTimeout(poll, 400);
  }

  async function togglePlay() {
    if (S.did === 'web_device') {
      const a = $('#audio');
      if (!a.currentSrc) {
        const first = S.view[0] || S.songs[0];
        if (first) playSong(first.id);
        return;
      }
      if (a.paused) { try { await a.play(); } catch (e) { toast('播放失败'); } } else a.pause();
      return;
    }

    try {
      if (S.isPlaying) {
        await post('/cmd', { did: S.did, cmd: '暂停播放' });
        S.isPlaying = false;
      } else if (S.curMusic) {
        const r = await post('/playmusiclist', {
          did: S.did,
          listname: S.remoteList || S.cur,
          musicname: S.curMusic,
        });
        if (r && r.ret === 'OK') S.isPlaying = true;
      } else {
        const first = S.view[0] || S.songs[0];
        if (first) return playSong(first.id);
      }
    } catch (e) { toast('操作失败'); }

    syncPlayBtns();
    syncRowState();
  }

  async function step(dir) {
    if (S.did !== 'web_device') {
      try { await post('/cmd', { did: S.did, cmd: dir > 0 ? '下一首' : '上一首' }); } catch (e) { }
      setTimeout(poll, 700);
      return;
    }
    const list = S.view.length ? S.view : S.songs;
    if (!list.length) return;
    let i = list.findIndex((s) => s.id === S.curMusic);
    i = i < 0 ? 0 : (i + dir + list.length) % list.length;
    playSong(list[i].id);
  }

  function setMode(i, notify) {
    S.mode = i;
    localStorage.setItem('xm_mode', String(i));
    const m = MODES[i % MODES.length];
    ['#btnMode', '#stMode'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      el.innerHTML = '<svg class="ic"><use href="#' + m.icon + '"/></svg>';
      el.title = m.cmd;
    });
    if (notify && S.did !== 'web_device') {
      post('/cmd', { did: S.did, cmd: m.cmd }).catch(() => { });
    }
  }

  async function addFav() {
    if (!S.curMusic) return toast('还没在播放');
    try {
      await post('/playlistaddmusic', { name: '收藏', music_list: [S.curMusic] });
      toast('已加入收藏');
      await loadLists();
      renderRail();
      highlightList();
    } catch (e) { toast('操作失败'); }
  }

  /* ------------------------------------------------------------- 音量 */
  function setVolumeUI(v) {
    S.vol = Math.round(v);
    ['#vol', '#vol2', '#stVol'].forEach((sel) => { const el = $(sel); if (el) el.value = S.vol; });
    $('#volNum').textContent = S.vol;
    $('#volNum2').textContent = S.vol;
    const sv = $('#stVolNum');
    if (sv) sv.textContent = S.vol;
  }

  async function refreshVolume() {
    if (S.did === 'web_device') { setVolumeUI(S.vol); return; }
    try {
      const r = await api('/getvolume?did=' + encodeURIComponent(S.did));
      if (r && typeof r.volume === 'number') setVolumeUI(r.volume);
    } catch (e) { /* ignore */ }
  }

  function onVolumeInput(e) {
    setVolumeUI(Number(e.target.value));
    if (S.did === 'web_device') {
      const a = $('#audio');
      if (a) a.volume = S.vol / 100;
      return;
    }
    clearTimeout(volTimer);
    volTimer = setTimeout(() => {
      post('/setvolume', { did: S.did, volume: S.vol }).catch(() => toast('设置音量失败'));
    }, 220);
  }

  /* ------------------------------------------------------------- 轮询 */
  function scaleTime(v) {
    const n = Number(v) || 0;
    return n > 100000 ? n / 1000 : n;
  }

  /** 音箱模式：两次轮询之间用本地时间外推播放位置，让歌词/进度条连续走动 */
  function tickPos() {
    if (S.did === 'web_device') return;
    if (!S.playing || S.posBase == null) return;
    let pos = S.posBase + (Date.now() - S.posAt) / 1000;
    if (S.dur && pos > S.dur) pos = S.dur;
    setProgress(pos, S.dur || 0);
  }

  async function poll() {
    if (S.did === 'web_device') return;
    try {
      const st = await api('/playingmusic?did=' + encodeURIComponent(S.did));
      if (!st || st.ret !== 'OK') return;
      S.remoteList = st.cur_playlist || S.remoteList;
      S.isPlaying = !!st.is_playing || st.is_playing === 'true';
      if (st.cur_music && st.cur_music !== S.curMusic) {
        setCur(st.cur_music);
      } else {
        syncPlayBtns();
        syncRowState();
      }
      if (st.cur_music) {
        // 设备未播放时 duration 可能是 0，回退用标签里的时长，免得显示 0:00
        const off = scaleTime(st.offset);
        const total = scaleTime(st.duration) || (curSong && curSong.secs) || 0;
        // 记下锚点，tickPos 在两次轮询之间本地外推，避免歌词最多滞后 3 秒
        S.posBase = off;
        S.posAt = Date.now();
        S.playing = S.isPlaying;
        S.dur = total;
        setProgress(off, total);
      }
    } catch (e) { /* 设备离线时静默 */ }
  }

  /* ------------------------------------------------------------- 弹层 */
  function closePops() {
    $('#devPop').hidden = true;
    $('#rowPop').hidden = true;
    $('#volPop').hidden = true;
  }

  function placePop(pop, rect, alignRight) {
    pop.hidden = false;
    pop.style.visibility = 'hidden';
    const w = pop.offsetWidth;
    const h = pop.offsetHeight;
    let left = alignRight ? rect.right - w : rect.left;
    left = Math.max(8, Math.min(left, window.innerWidth - w - 8));
    let top = rect.bottom + 6;
    if (top + h > window.innerHeight - 8) top = Math.max(8, rect.top - h - 6);
    pop.style.left = left + 'px';
    pop.style.top = top + 'px';
    pop.style.visibility = '';
  }

  function openDevices(anchor) {
    const pop = $('#devPop');
    pop.innerHTML = '<div class="pop-sec">播放到</div>' + S.devices.map((d) =>
      '<div class="pop-item" data-did="' + esc(d.id) + '">' +
      '<svg class="ic"><use href="#' + (d.kind === 'web' ? 'i-monitor' : 'i-speaker') + '"/></svg>' +
      '<span style="flex:1">' + esc(d.name) + '</span>' +
      (d.id === S.did ? '✓' : '') + '</div>').join('');
    placePop(pop, anchor.getBoundingClientRect(), true);
  }

  function openRowMenu(anchor, song) {
    const pop = $('#rowPop');
    const canRemove = S.cur === '收藏' || SYS.indexOf(S.cur) < 0;
    pop.innerHTML =
      '<div class="pop-item" data-act="play"><svg class="ic"><use href="#i-play"/></svg>播放</div>' +
      '<div class="pop-item" data-act="add"><svg class="ic"><use href="#i-add"/></svg>加入歌单…</div>' +
      (canRemove ? '<div class="pop-item" data-act="remove"><svg class="ic"><use href="#i-list"/></svg>从「' + esc(S.cur) + '」移除</div>' : '') +
      '<div class="pop-item danger" data-act="del"><svg class="ic"><use href="#i-more"/></svg>删除文件</div>';
    pop.dataset.id = song.id;
    placePop(pop, anchor.getBoundingClientRect(), true);
  }

  /* ------------------------------------------------------------- 对话框 */
  function openDlg(title, bodyHTML, okLabel) {
    const dlg = $('#dlg');
    $('#dlgTitle').textContent = title;
    $('#dlgBody').innerHTML = bodyHTML;
    $('#dlgOk').textContent = okLabel || '确定';
    dlg.returnValue = '';
    dlg.showModal();
    return new Promise((resolve) => {
      const done = () => {
        dlg.removeEventListener('close', done);
        resolve({ ok: dlg.returnValue === 'ok', body: $('#dlgBody') });
      };
      dlg.addEventListener('close', done);
    });
  }

  async function newPlaylist() {
    const r = await openDlg('新建歌单',
      '<input type="text" id="dlgInput" placeholder="歌单名称" autocomplete="off">');
    if (!r.ok) return;
    const name = ($('#dlgInput').value || '').trim();
    if (!name) { toast('名字不能为空'); return; }
    try {
      const res = await post('/playlistadd', { name });
      if (res && res.ret === 'OK') {
        toast('已创建「' + name + '」');
        await loadLists();
        renderRail();
        await selectList(name);
      } else {
        toast('创建失败：' + ((res && res.ret) || '未知错误'));
      }
    } catch (e) { toast('创建失败'); }
  }

  async function addToPlaylist(songId) {
    const custom = Object.keys(S.lists).filter((n) => SYS.indexOf(n) < 0 && HIDDEN.indexOf(n) < 0);
    const names = ['收藏'].concat(custom);
    const body = names.map((n) =>
      '<div class="pop-item" data-pick="' + esc(n) + '">' +
      '<svg class="ic"><use href="#' + (n === '收藏' ? 'i-heart' : 'i-list') + '"/></svg>' +
      '<span style="flex:1">' + esc(n) + '</span>' +
      '<span style="font-size:11px;color:#9aa0aa">' + countOf(n) + '</span></div>').join('') +
      '<div class="pop-item" data-pick="__new__">' +
      '<svg class="ic"><use href="#i-add"/></svg><span style="flex:1">新建歌单…</span></div>';

    const r = await openDlg('加入歌单', body, '加入');
    const picked = r.body.querySelector('[data-pick].picked');
    const name = picked ? picked.getAttribute('data-pick') : '';

    if (name === '__new__') return newPlaylist();
    if (!r.ok) return;
    if (!name) { toast('先选一个歌单'); return; }

    try {
      const res = await post('/playlistaddmusic', { name, music_list: [songId] });
      if (res && res.ret === 'OK') {
        toast('已加入「' + name + '」');
        await loadLists();
        renderRail();
        if (S.cur === name) await selectList(name);
      } else {
        toast('加入失败');
      }
    } catch (e) { toast('加入失败'); }
  }

  async function confirmDelete(songId) {
    const s = songOf(songId);
    const r = await openDlg('删除文件',
      '<div style="font-size:13px;color:#6b7280;line-height:1.9">' +
      '将从磁盘删除「' + esc(s ? s.title : songId) + '」，不可恢复。</div>', '删除');
    if (!r.ok) return;
    try {
      const res = await post('/delmusic', { name: songId });
      if (res && res.ret === 'OK') {
        toast('已删除');
        S.lists[S.cur] = (S.lists[S.cur] || []).filter((n) => n !== songId);
        S.songs = S.songs.filter((x) => x.id !== songId);
        S.tags.delete(songId);
        applyView();
        updateTitles();
      } else {
        toast('删除失败');
      }
    } catch (e) { toast('删除失败'); }
  }

  async function removeFromList(songId) {
    try {
      const res = await post('/playlistdelmusic', { name: S.cur, music_list: [songId] });
      if (res && res.ret === 'OK') {
        toast('已从「' + S.cur + '」移除');
        await loadLists();
        await selectList(S.cur);
      } else {
        toast('移除失败');
      }
    } catch (e) { toast('移除失败'); }
  }

  /* ------------------------------------------------------------- 事件 */
  function bind() {
    document.addEventListener('click', (e) => {
      if (!e.target.closest('.pop') && !e.target.closest('[data-keep-pop]')) closePops();
    });
    window.addEventListener('resize', closePops);
    $('#btnTheme').addEventListener('click', cycleTheme);
    // 系统主题变化时，只有"跟随系统"才需要重算
    mqDark.addEventListener('change', () => { if (S.theme === 'auto') applyTheme(); });
    // 窗口尺寸变了：歌词要按新高度重新居中
    let rzTimer = null;
    window.addEventListener('resize', () => {
      clearTimeout(rzTimer);
      rzTimer = setTimeout(() => {
        S.lyricIdx = -2;
        updateLyricTime(S.pos);
      }, 180);
    });
    $('#rows').addEventListener('scroll', closePops, { passive: true });

    // 左栏
    $('#deviceList').addEventListener('click', (e) => {
      const it = e.target.closest('[data-did]');
      if (!it) return;
      pickDevice(it.getAttribute('data-did'));
    });
    $('#devBtn').addEventListener('click', (e) => {
      e.stopPropagation();
      if ($('#devPop').hidden) openDevices(e.currentTarget); else closePops();
    });
    $('#devPop').addEventListener('click', (e) => {
      const it = e.target.closest('[data-did]');
      if (!it) return;
      pickDevice(it.getAttribute('data-did'));
      closePops();
    });

    ['#sysList', '#cusList', '#chips'].forEach((sel) => {
      $(sel).addEventListener('click', (e) => {
        const it = e.target.closest('[data-list]');
        if (it) selectList(it.getAttribute('data-list'));
      });
    });

    // 搜索
    const onSearch = (e) => {
      const v = e.target.value || '';
      clearTimeout(qTimer);
      qTimer = setTimeout(() => {
        S.q = v;
        $('#dQ').value = v;
        $('#mQ').value = v;
        applyView();
      }, 160);
    };
    $('#dQ').addEventListener('input', onSearch);
    $('#mQ').addEventListener('input', onSearch);

    // 排序
    $$('.th[data-sort]').forEach((th) => {
      th.addEventListener('click', () => {
        const k = th.getAttribute('data-sort');
        if (S.sortKey === k) {
          S.sortDir = -S.sortDir;
        } else {
          S.sortKey = k;
          S.sortDir = 1;
        }
        $$('.th[data-sort]').forEach((o) => {
          o.classList.toggle('sorted', o.getAttribute('data-sort') === S.sortKey);
          if (o.getAttribute('data-sort') === S.sortKey) o.setAttribute('data-dir', String(S.sortDir));
          else o.removeAttribute('data-dir');
        });
        applyView();
      });
    });

    // 行点击
    $('#rows').addEventListener('click', (e) => {
      const more = e.target.closest('.c-more button');
      const row = e.target.closest('.row');
      if (!row) return;
      const id = row.dataset.id;
      if (more) {
        e.stopPropagation();
        const song = songOf(id);
        if ($('#rowPop').hidden) openRowMenu(more, song); else closePops();
        return;
      }
      playSong(id);
    });

    $('#sheetBody').addEventListener('click', seekToLyric);

    // 底栏 → 打开全屏播放页
    $('#mini').addEventListener('click', (e) => {
      if (e.target.closest('button')) return;
      openStage();
    });
    ['#barOpen', '#barStage'].forEach((sel) => {
      const el = $(sel);
      if (el) el.addEventListener('click', openStage);
    });
    $('#stageBack').addEventListener('click', closeStage);
    $('#stCollapse').addEventListener('click', closeStage);
    $('#stageSeg').addEventListener('click', (e) => {
      const b = e.target.closest('[data-stpane]');
      if (b) setStagePane(b.dataset.stpane);
    });
    $('#stageQueue').addEventListener('click', (e) => {
      const r = e.target.closest('[data-play]');
      if (r) playSong(r.getAttribute('data-play'));
    });
    $('#stPlay').addEventListener('click', togglePlay);
    $('#stPrev').addEventListener('click', () => step(-1));
    $('#stNext').addEventListener('click', () => step(1));
    $('#stMode').addEventListener('click', () => setMode((S.mode + 1) % MODES.length, true));
    $('#stFav').addEventListener('click', addFav);
    $('#stVol').addEventListener('input', onVolumeInput);
    $('#stageLyric').addEventListener('click', seekToLyric);
    $('#sheetClose').addEventListener('click', closeSheet);

    // 用户手动滚动歌词时，暂停 4 秒自动跟随，避免"抢滚动"
    ['#lyric', '#sheetBody'].forEach((sel) => {
      const el = $(sel);
      if (!el) return;
      ['wheel', 'touchmove'].forEach((ev) =>
        el.addEventListener(ev, () => { S.lyricHold = Date.now() + 4000; }, { passive: true }));
    });

    $('#rowPop').addEventListener('click', (e) => {
      const it = e.target.closest('[data-act]');
      if (!it) return;
      const id = $('#rowPop').dataset.id;
      const act = it.getAttribute('data-act');
      closePops();
      if (act === 'play') playSong(id);
      if (act === 'add') addToPlaylist(id);
      if (act === 'remove') removeFromList(id);
      if (act === 'del') confirmDelete(id);
    });

    // 播放控制
    $('#btnPlay').addEventListener('click', togglePlay);
    $('#btnPrev').addEventListener('click', () => step(-1));
    $('#btnNext').addEventListener('click', () => step(1));
    $('#btnMode').addEventListener('click', () => setMode((S.mode + 1) % MODES.length, true));

    $('#btnFav').addEventListener('click', (e) => { e.stopPropagation(); addFav(); });

    // 音量
    $('#vol').addEventListener('input', onVolumeInput);
    $('#vol2').addEventListener('input', onVolumeInput);
    $('#mVol').addEventListener('click', (e) => {
      e.stopPropagation();
      const pop = $('#volPop');
      if (!pop.hidden) { closePops(); return; }
      placePop(pop, e.currentTarget.getBoundingClientRect(), true);
    });

    // 进度拖动
    let dragging = false;
    const seek = (e) => {
      if (S.did !== 'web_device') return;
      const a = $('#audio');
      if (!a.duration) return;
      const box = $('#track').getBoundingClientRect();
      const x = (e.touches ? e.touches[0].clientX : e.clientX) - box.left;
      const p = Math.max(0, Math.min(1, x / box.width));
      a.currentTime = p * a.duration;
      setProgress(a.currentTime, a.duration);
    };
    $('#track').addEventListener('mousedown', (e) => { dragging = true; seek(e); });
    window.addEventListener('mousemove', (e) => { if (dragging) seek(e); });
    window.addEventListener('mouseup', () => { dragging = false; });
    $('#track').addEventListener('touchstart', seek, { passive: true });
    $('#track').addEventListener('touchmove', seek, { passive: true });

    // 播放页里的进度条：点击跳转
    $('#stTrack').addEventListener('click', (e) => {
      if (S.did !== 'web_device') { toast('音箱模式无法跳转播放位置'); return; }
      const a = $('#audio');
      if (!a.duration) return;
      const box = e.currentTarget.getBoundingClientRect();
      const p = Math.max(0, Math.min(1, (e.clientX - box.left) / box.width));
      a.currentTime = p * a.duration;
      setProgress(a.currentTime, a.duration);
    });

    // 音频事件
    const a = $('#audio');
    a.addEventListener('timeupdate', () => {
      if (S.did === 'web_device') setProgress(a.currentTime, a.duration || 0);
    });
    a.addEventListener('play', () => { S.isPlaying = true; syncPlayBtns(); syncRowState(); });
    a.addEventListener('pause', () => { S.isPlaying = false; syncPlayBtns(); syncRowState(); });
    a.addEventListener('ended', () => {
      if (S.mode === 2) { a.currentTime = 0; a.play().catch(() => { }); }
      else step(1);
    });

    // 工具栏
    $('#btnRefresh').addEventListener('click', async (e) => {
      const btn = e.currentTarget;
      btn.classList.add('spin');
      try {
        await post('/api/music/refreshlist', {});
        await loadLists();
        await selectList(S.cur);
        toast('已重新扫描曲库');
      } catch (err) { toast('刷新失败'); }
      btn.classList.remove('spin');
    });
    $('#btnNewList').addEventListener('click', newPlaylist);

    // 对话框回车
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && $('#dlg').open) {
        const inp = $('#dlgBody input');
        if (inp && document.activeElement === inp) {
          e.preventDefault();
          $('#dlgOk').click();
        }
      }
      if (e.key === 'Escape') { closePops(); closeSheet(); closeStage(); }
    });

    // 对话框内选择
    $('#dlgBody').addEventListener('click', (e) => {
      const it = e.target.closest('[data-pick]');
      if (!it) return;
      $$('#dlgBody [data-pick]').forEach((o) => o.classList.remove('picked'));
      it.classList.add('picked');
    });
  }

  async function pickDevice(id) {
    if (id === S.did) return;
    S.did = id;
    localStorage.setItem('xm_did', id);
    syncDeviceLabel();
    renderRail();
    closePops();
    S.isPlaying = false;
    S.curMusic = '';
    S.posBase = null;
    S.playing = false;
    curSong = null;
    setProgress(0, 0);
    updateNow();
    syncRowState();
    await refreshVolume();
    poll();
  }

  document.addEventListener('DOMContentLoaded', boot);
})();
