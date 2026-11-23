const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);
const num = (v, d = 0) => (v == null || Number.isNaN(Number(v)) ? '—' : Number(v).toLocaleString('fa-IR', { maximumFractionDigits: d, minimumFractionDigits: d }));
const LABELS = { tcp: 'TCP', tcpmux: 'TCP MUX', ws: 'WS', wss: 'WSS', udp: 'UDP' };
const PROFILES = { balanced: 'متعادل', ultraspeed: 'حداکثر سرعت', gaming: 'بازی' };

const ICONS = {
  grid: '<rect x="3" y="3" width="7" height="7" rx="1.5"/><rect x="14" y="3" width="7" height="7" rx="1.5"/><rect x="3" y="14" width="7" height="7" rx="1.5"/><rect x="14" y="14" width="7" height="7" rx="1.5"/>',
  server: '<rect x="3" y="4" width="18" height="7" rx="2"/><rect x="3" y="13" width="18" height="7" rx="2"/><circle cx="7" cy="7.5" r="1"/><circle cx="7" cy="16.5" r="1"/>',
  tunnel: '<path d="M3 19c4-9 6-2 9-8s6-5 9-7"/><path d="M3 23c5-6 7-1 11-6s6-4 7-5" opacity=".5"/>',
  gauge: '<path d="M4 18a8 8 0 1 1 16 0"/><path d="M12 14l4-5"/><circle cx="12" cy="14" r="1.5"/>',
  log: '<path d="M5 3h14v18H5z"/><path d="M8 8h8M8 12h8M8 16h5"/>',
  settings: '<circle cx="12" cy="12" r="3"/><path d="M12 2v3m0 14v3M2 12h3m14 0h3M4.9 4.9l2.1 2.1m10 10l2.1 2.1m0-14.2L17 7M7 17l-2.1 2.1"/>',
  book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M8 7h7M8 11h6"/>',
  globe: '<circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c3 3 3 15 0 18M12 3c-3 3-3 15 0 18"/>',
  bolt: '<path d="M13 2 4 14h7l-1 8 9-12h-7z"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  play: '<path d="M7 4l12 8-12 8z"/>',
  stop: '<rect x="6" y="6" width="12" height="12" rx="2"/>',
  trash: '<path d="M4 7h16M9 7V4h6v3m-9 0 1 14h10l1-14"/>',
  edit: '<path d="m4 20 4-1 11-11-3-3L5 16zM14 6l3 3"/>',
};

const icon = (name, size = 18) => `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${ICONS[name] || ICONS.grid}</svg>`;

const S = { route: 'overview', state: null, servers: [], tunnels: [], bench: null, logs: [], logFilter: '', benchPair: null, stream: null };

async function api(path, options = {}) {
  const res = await fetch(`/api${path}`, {
    ...options,
    headers: { 'content-type': 'application/json', ...(options.headers || {}) },
  });
  let data;
  try {
    data = await res.json();
  } catch {
    throw new Error(`پاسخ نامعتبر (${res.status})`);
  }
  if (!res.ok || data.error) throw new Error(data.error || `خطای ${res.status}`);
  return data;
}
const post = (path, body = {}) => api(path, { method: 'POST', body: JSON.stringify(body) });

function toast(message, type = 'ok') {
  const root = $('#toast-root');
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = message;
  root.append(el);
  setTimeout(() => el.remove(), 3800);
}

function openModal({ title, sub = '', content, onMount }) {
  const root = $('#modal-root');
  root.innerHTML = `<div class="modal-backdrop"><div class="modal" role="dialog" aria-modal="true">
    <div class="row" style="align-items:flex-start"><div><h3>${esc(title)}</h3><div class="sub">${esc(sub)}</div></div><span class="grow"></span><button class="icon-btn" data-action="close-modal" aria-label="بستن">×</button></div>
    ${content}
  </div></div>`;
  $('.modal-backdrop', root).addEventListener('click', (e) => {
    if (e.target.classList.contains('modal-backdrop')) closeModal();
  });
  onMount?.($('.modal', root));
}
function closeModal() {
  $('#modal-root').innerHTML = '';
}

function setRoute(route) {
  S.route = route;
  $$('.nav-item[data-route]').forEach((b) => b.classList.toggle('active', b.dataset.route === route));
  const titles = { overview: 'نمای کلی', servers: 'سرورها', tunnels: 'تانل‌ها', bench: 'محک', logs: 'گزارشات', settings: 'تنظیمات' };
  $('#crumb-title').textContent = titles[route] || route;
  render();
}

async function loadAll() {
  try {
    const [stateRes, serversRes, tunnelsRes, logsRes] = await Promise.all([
      api('/state'),
      api('/servers'),
      api('/tunnels'),
      api('/logs?limit=100'),
    ]);
    S.state = stateRes.state;
    S.bench = stateRes.bench;
    S.servers = serversRes.servers;
    S.tunnels = tunnelsRes.tunnels;
    S.logs = logsRes.logs;
    $('#count-servers').textContent = S.servers.length;
    $('#count-tunnels').textContent = S.tunnels.length;
    const online = S.servers.filter((s) => s.online).length;
    $('#health-dot').className = `dot ${online ? 'on' : 'off'}`;
    $('#health-text').textContent = `${online}/${S.servers.length} سرور آنلاین`;
    $('#demo-pill').textContent = S.state.demo?.running ? 'دمو فعال' : 'دمو خاموش';
    $('#demo-pill').classList.toggle('on', !!S.state.demo?.running);
    if (S.state.settings?.theme) applyTheme(S.state.settings.theme, false);
    render();
  } catch (err) {
    $('#view').innerHTML = `<div class="card empty"><div class="big">⚠</div><p>ارتباط با پنل برقرار نشد: ${esc(err.message)}</p><button class="btn" data-action="reload">تلاش مجدد</button></div>`;
  }
}

function applyTheme(theme, persist = true) {
  document.documentElement.dataset.theme = theme;
  if (persist) post('/settings', { theme }).catch(() => {});
}

function render() {
  const view = $('#view');
  if (!S.state) return;
  const views = { overview: viewOverview, servers: viewServers, tunnels: viewTunnels, bench: viewBench, logs: viewLogs, settings: viewSettings };
  view.innerHTML = (views[S.route] || viewOverview)();
}

function stats() {
  const active = S.tunnels.filter((t) => t.status?.running).length;
  const bytes = S.tunnels.reduce((n, t) => n + (t.status?.up || 0) + (t.status?.down || 0), 0);
  const score = S.bench?.recommended?.score;
  return { online: S.servers.filter((s) => s.online).length, active, bytes, score };
}

function viewOverview() {
  const s = stats();
  const cards = [
    ['سرورهای آنلاین', num(s.online), `${S.servers.length} سرور ثبت شده`, 'server'],
    ['تانل‌های فعال', num(s.active), `${S.tunnels.length} تانل تعریف شده`, 'tunnel'],
    ['ترافیک جاری', fmtBytes(s.bytes), 'مجموع رفت و آمد', 'grid'],
    ['بهترین امتیاز محک', s.score == null ? '—' : num(s.score), s.bench?.recommended ? `${LABELS[s.bench.recommended.transport]} · ${s.bench.recommended.mode}` : ' هنوز محکی اجرا نشده', 'gauge'],
  ];
  return `
    <div class="section-title"><div><h2>نمای کلی</h2><p> وضعیت شبکهٔ تونل‌های شما در یک نگاه </p></div><span class="grow"></span>
      <button class="btn btn-sm" data-action="demo-toggle">${S.state.demo?.running ? 'متوقف کردن دمو' : 'راه اندازی دمو'}</button>
      <button class="btn btn-primary btn-sm" data-action="goto-bench">${icon('gauge', 15)} اجرای محک</button>
    </div>
    <div class="grid cols-4" style="margin-bottom:16px">
      ${cards.map(([label, value, sub, ico]) => `<div class="card stat"><div class="label">${label}</div><div class="value">${value}</div><div class="sub">${sub}</div><span class="glyph">${icon(ico, 34)}</span></div>`).join('')}
    </div>
    <div class="grid" style="grid-template-columns:minmax(0,1.6fr) minmax(0,1fr)">
      <div class="card"><div class="card-head"><h3>نقشهٔ جریان</h3><span class="small muted">ورودی → تونل → خروجی</span></div>${mapHtml()}</div>
      <div class="card"><div class="card-head"><h3>آخرین رویدادها</h3><button class="btn btn-ghost btn-sm" data-action="goto-logs">همه</button></div>${recentLogsHtml()}</div>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>شروع سریع</h3></div>
      <div class="grid cols-3">
        <div><b>۱٫ سرور اضافه کنید</b><p class="small muted">روی هر سرور ایجنت نهر را اجرا کنید و آدرس آن وارد پنل شود.</p><button class="btn btn-sm" data-action="add-server">افزودن سرور</button></div>
        <div><b>۲٫ تانل بسازید</b><p class="small muted">دو سرور و ترنسپورت را انتخاب کنید. رمزنگاری و میکسینگ خودکار است.</p><button class="btn btn-sm" data-action="add-tunnel">ساخت تانل</button></div>
        <div><b>۳٫ محک بزنید</b><p class="small muted">همهٔ ترنسپورت‌ها آزمایش و رتبهبندی میشوند؛ بهترین را اعمال کنید.</p><button class="btn btn-sm" data-action="goto-bench">رفتن به محک</button></div>
      </div>
    </div>`;
}

function mapHtml() {
  if (!S.servers.length) return '<div class="map-wrap"><div class="map-empty">سروری برای نمایش وجود ندارد</div></div>';
  const n = S.servers.length;
  const pts = S.servers.map((s, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2;
    return { ...s, x: 400 + Math.cos(a) * 235, y: 150 + Math.sin(a) * 95 };
  });
  const byId = Object.fromEntries(pts.map((p) => [p.id, p]));
  const links = S.tunnels.map((t) => {
    const a = byId[t.entryId];
    const b = byId[t.exitId];
    if (!a || !b) return '';
    return `<path class="map-link" d="M${a.x} ${a.y} Q400 150 ${b.x} ${b.y}" />`;
  }).join('');
  const nodes = pts.map((p) => `<g class="map-node"><circle class="ring" cx="${p.x}" cy="${p.y}" r="13"/><circle class="core" cx="${p.x}" cy="${p.y}" r="5" opacity="${p.online ? 1 : .3}"/><text x="${p.x}" y="${p.y + 27}" text-anchor="middle">${esc(p.name)}</text></g>`).join('');
  return `<div class="map-wrap"><svg viewBox="0 0 800 300" preserveAspectRatio="xMidYMid meet">${links}${nodes}</svg><div class="map-legend"><span>● آنلاین</span><span>┄ تانل</span></div></div>`;
}

function recentLogsHtml() {
  return S.logs.length
    ? `<div class="logs">${S.logs.slice(0, 9).map((l) => `<div class="log-line"><span class="t">${new Date(l.at).toLocaleTimeString('fa-IR')}</span><span class="lvl ${l.level}">${l.level}</span><span class="sc">${esc(l.scope)}</span><span>${esc(l.message)}</span></div>`).join('')}</div>`
    : '<div class="empty">گزارشیک نیست</div>';
}

function fmtBytes(n) {
  if (!n) return '—';
  const u = ['B', 'KB', 'MB', 'GB'];
  let i = 0;
  while (n >= 1024 && i < 3) {
    n /= 1024;
    i++;
  }
  return `${n.toFixed(1)} ${u[i]}`;
}

function viewServers() {
  return `
    <div class="section-title"><div><h2>سرورها</h2><p>هر سرور یک ایجنت نهر اجرا میکند</p></div><span class="grow"></span>
      <button class="btn btn-sm" data-action="demo-toggle">${S.state.demo?.running ? 'توقف دمو' : 'دمو محلی'}</button>
      <button class="btn btn-primary btn-sm" data-action="add-server">${icon('plus', 15)} افزودن سرور</button></div>
    <div class="card">${S.servers.length ? `<table><thead><tr><th>نام</th><th>آدرس ایجنت</th><th>وضعیت</th><th>منطقه</th><th>آپتایم</th><th></th></tr></thead><tbody>
      ${S.servers.map((s) => `<tr>
        <td><b>${esc(s.name)}</b>${s.demo ? ' <span class="badge">دمو</span>' : ''}<div class="small faint mono">${esc(s.id)}</div></td>
        <td class="mono small">${esc(s.host)}:${s.agentPort}</td>
        <td><span class="badge ${s.online ? 'good' : 'bad'}">${s.online ? 'آنلاین' : 'آفلاین'}</span></td>
        <td>${esc(s.region || '—')}</td>
        <td class="mono small">${s.uptimeSec ? `${num(s.uptimeSec)} ثانیه` : '—'}</td>
        <td><button class="btn btn-ghost btn-sm" data-action="delete-server" data-id="${s.id}">${icon('trash', 14)}</button></td>
      </tr>`).join('')}
    </tbody></table>` : `<div class="empty"><div class="big">🖥</div><p>هنوز سروری وجود ندارد</p><p class="small">برای آزمایش سریع، دمو محلی را روشن کنید.</p></div>`}</div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>نصب ایجنت روی سرور واقعی</h3></div>
      <p class="small muted">روی سرور مورد نظر Node.js 20 یا بالاتر داشته باشید، سپس:</p>
      <div class="code">git clone &lt;این-مخزن&gt; nahr &amp;&amp; cd nahr &amp;&amp; npm install
node bin/nahr.js agent --port 7700 --id SERVER-1</div>
      <p class="small faint">توکن پیشفرض ایجنت همان کلید پنل است؛ میتوانید با <span class="mono">--token</span> جداگانه تعیین کنید.</p>
    </div>`;
}

function viewTunnels() {
  return `
    <div class="section-title"><div><h2>تانلها</h2><p>هر تانل دو سرور را با ترنسپورت انتخابی به هم وصل میکند</p></div><span class="grow"></span>
      <button class="btn btn-primary btn-sm" data-action="add-tunnel">${icon('plus', 15)} تانل جدید</button></div>
    ${S.tunnels.length ? `<div class="grid cols-3">${S.tunnels.map(tunnelCard).join('')}</div>` : `<div class="card empty"><div class="big">⇄</div><p>تانلی تعریف نشده است</p></div>`}`;
}

function tunnelCard(t) {
  const running = !!t.status?.running;
  const entry = S.servers.find((s) => s.id === t.entryId);
  const exit = S.servers.find((s) => s.id === t.exitId);
  const bars = Array.from({ length: 22 }, (_, i) => `<i style="height:${8 + ((i * 17 + t.name.length * 7) % 27)}px"></i>`).join('');
  return `<div class="card tunnel-card">
    <div class="tunnel-top"><div><h4>${esc(t.name)}</h4><div class="tunnel-meta"><span class="badge accent">${LABELS[t.transport] || t.transport}</span><span class="badge">${t.mode === 'reverse' ? 'معکوس' : 'مستقیم'}</span><span class="badge">${PROFILES[t.profile] || t.profile}</span></div></div><span class="grow"></span><span class="badge ${running ? 'good' : ''}">${running ? 'فعال' : 'خاموش'}</span></div>
    <div class="small muted">${esc(entry?.name || '?')} <span style="color:var(--accent)">⇄</span> ${esc(exit?.name || '?')}</div>
    <div class="row small"><span class="muted">SOCKS:</span><b class="mono">${t.socksPort ? `127.0.0.1:${t.socksPort}` : '—'}</b><span class="grow"></span><span class="muted">اتصالات:</span><b class="mono">${t.status?.channels ?? 0}</b></div>
    ${t.forwards?.length ? `<div class="small faint" style="margin-top:6px">پورت فوروارد: ${t.forwards.map((f) => `<span class="mono" dir="ltr">${f.listenPort}→${f.targetHost}:${f.targetPort}</span>`).join(' · ')}</div>` : ''}
    <div class="mini-graph">${bars}</div>
    <div class="tunnel-actions">
      <button class="btn btn-sm ${running ? '' : 'btn-primary'}" data-action="toggle-tunnel" data-id="${t.id}">${icon(running ? 'stop' : 'play', 14)} ${running ? 'توقف' : 'راه اندازی'}</button>
      <button class="btn btn-ghost btn-sm" data-action="bench-pair" data-entry="${t.entryId}" data-exit="${t.exitId}">${icon('gauge', 14)} محک</button>
      <button class="btn btn-ghost btn-sm" data-action="edit-tunnel" data-id="${t.id}">${icon('edit', 14)}</button>
      <button class="btn btn-ghost btn-sm" data-action="delete-tunnel" data-id="${t.id}">${icon('trash', 14)}</button>
    </div>
  </div>`;
}

function viewBench() {
  const b = S.bench;
  const sel = (id, list, value) => `<select id="${id}">${list.map((o) => `<option value="${o.v}" ${o.v === value ? 'selected' : ''}>${esc(o.t)}</option>`).join('')}</select>`;
  const serverOpts = S.servers.map((s) => ({ v: s.id, t: s.name }));
  const pair = S.benchPair || { entry: S.servers[0]?.id, exit: S.servers[1]?.id };
  const running = b && (b.state === 'probe' || b.state === 'speed');
  const ranked = b?.candidates?.filter((c) => c.score != null).sort((x, y) => y.score - x.score) || [];
  const best = ranked[0];
  const active = b?.candidates?.filter((c) => c.state === 'probe' || c.state === 'speed').length || 0;
  const finished = b?.candidates?.filter((c) => c.state === 'ok' || c.state === 'fail').length || 0;
  const progress = running ? (b.state === 'probe' ? 8 + (finished / Math.max(1, b.candidates.length)) * 32 : 40 + (finished / Math.max(1, ranked.length || 3)) * 60) : b?.state === 'done' ? 100 : 0;
  return `
    <div class="section-title"><div><h2>محک</h2><p>همهٔ ترنسپورت‌ها را در هر دو جهت امتحان میکند و بهترین را معرفی میکند</p></div></div>
    <div class="card"><div class="bench-setup">
      <label class="field"><span>سرور ورودی</span>${sel('bench-entry', serverOpts, pair.entry)}</label>
      <label class="field"><span>سرور خروجی</span>${sel('bench-exit', serverOpts, pair.exit)}</label>
      <label class="field" style="max-width:150px"><span>پروفایل</span>${sel('bench-profile', Object.entries(PROFILES).map(([v, t]) => ({ v, t })), S.state.settings?.benchProfile || 'balanced')}</label>
      <label class="field" style="max-width:120px"><span>ثانیه</span><input id="bench-seconds" type="number" min="1" max="20" value="${S.state.settings?.benchSeconds || 3}"></label>
      <label class="field" style="max-width:120px"><span>جریانها</span><input id="bench-streams" type="number" min="1" max="16" value="${S.state.settings?.benchStreams || 4}"></label>
      <button class="btn btn-primary" data-action="bench-start" ${running || S.servers.length < 2 ? 'disabled' : ''}>${icon('bolt', 16)} ${running ? 'در حال اجرا…' : 'شروع محک'}</button>
      ${running ? '<button class="btn btn-danger" data-action="bench-stop">توقف</button>' : ''}
    </div>
    ${S.servers.length < 2 ? '<p class="err small">حداقل دو سرور لازم است. از تب سرورها دمو محلی را روشن کنید.</p>' : ''}
    ${running ? `<div class="bench-stage"><div class="row small"><b>${b.state === 'probe' ? 'مرحلهٔ کاوش: بررسی عبور ترنسپورت و تأخیر' : 'مرحلهٔ سرعت: اندازهگیری دانلود و آپلود'}</b><span class="grow"></span><span class="mono">${finished} / ${b.candidates.length}</span></div>
      <div class="bench-bar"><i style="width:${Math.round(progress)}%"></i></div>
      <div class="bench-live">${b.candidates.map((c) => `<div class="chip ${c.state === 'ok' ? 'ok' : c.state === 'fail' ? 'fail' : c.state === 'probe' || c.state === 'speed' ? 'run' : ''}">${c.state === 'probe' || c.state === 'speed' ? '<span class="spinner"></span>' : c.state === 'ok' ? '✓' : c.state === 'fail' ? '✕' : '·'} ${LABELS[c.transport]} <span class="small">${c.mode === 'reverse' ? 'معکوس' : 'مستقیم'}</span></div>`).join('')}</div>
      <p class="small faint">${active} ترنسپورت در حال حاضر تست میشوند. ترافیک واقعی مصرف میشود.</p></div>` : ''}
    </div>
    ${b && !running && b.state !== 'failed' ? resultHtml(b, ranked, best) : ''}
    ${b?.state === 'failed' ? `<div class="card" style="margin-top:16px"><p class="err">خطا: ${esc(b.error)}</p></div>` : ''}`;
}

function resultHtml(b, ranked, best) {
  if (!ranked.length) return `<div class="card empty" style="margin-top:16px"><div class="big">⚠</div><p>هیچ ترنسپورتی نتوانست وصل شود</p><p class="small">فایروال، پورت ایجنت و توکن مشترک را بررسی کنید.</p></div>`;
  const m = best.metrics || {};
  return `
    <div class="card" style="margin-top:16px">
      <div class="best">
        <div class="score-ring"><svg viewBox="0 0 84 84"><circle class="track" cx="42" cy="42" r="36"/><circle class="fill" cx="42" cy="42" r="36" stroke-dasharray="${best.score * 2.26} 226"/></svg><b>${num(best.score)}</b></div>
        <div class="best-main"><div class="kicker">✔ پیشنهاد محک</div><h3>${LABELS[best.transport]} <span class="badge">${best.mode === 'reverse' ? 'معکوس' : 'مستقیم'}</span></h3>
          <p>امتیاز ترکیبی سرعت، تأخیر و پایداری بر اساس پروفایل ${PROFILES[b.profile] || b.profile}</p>
          <div class="parts"><span>سرعت <b>${best.parts?.speed ?? '—'}</b></span><span>تأخیر <b>${best.parts?.latency ?? '—'}</b></span><span>پایداری <b>${best.parts?.stability ?? '—'}</b></span></div>
        </div>
        <button class="btn btn-primary" data-action="bench-apply" data-key="${best.key}">اعمال بهترین</button>
      </div>
      <dl class="metrics" style="margin-top:18px">
        <div><dt>دانلود</dt><dd>${num(m.download_mbps, 1)} <small>Mbps</small></dd></div>
        <div><dt>آپلود</dt><dd>${num(m.upload_mbps, 1)} <small>Mbps</small></dd></div>
        <div><dt>تأخیر میانه</dt><dd>${num(m.latency?.median_ms, 1)} <small>ms</small></dd></div>
        <div><dt>پراکندگی</dt><dd>${num(m.latency?.jitter_ms, 1)} <small>ms</small></dd></div>
        <div><dt>اتلاف</dt><dd>${num(m.latency?.loss_pct, 1)} <small>%</small></dd></div>
      </dl>
    </div>
    <div class="card" style="margin-top:16px"><div class="card-head"><h3>رتبهبندی کامل</h3><span class="small muted">${b.candidates.length} حالت آزمایش شد</span></div>
      <ol class="rank">${ranked.map((c, i) => `<li>
        <span class="pos">${i + 1}</span><span class="name">${LABELS[c.transport]}</span><span class="badge">${c.mode === 'reverse' ? 'معکوس' : 'مستقیم'}</span>
        <span class="bars"><span style="width:${(c.score / Math.max(1, best.score)) * 110}px"></span></span>
        <span class="val">↓ ${num(c.metrics?.download_mbps, 1)} · ↑ ${num(c.metrics?.upload_mbps, 1)}</span>
        <span class="s" style="color:${i === 0 ? 'var(--accent)' : 'var(--muted)'}">${num(c.score)}</span>
        <button class="btn btn-ghost btn-sm" data-action="bench-apply" data-key="${c.key}">اعمال</button>
      </li>`).join('')}</ol>
      ${b.candidates.filter((c) => c.state === 'fail').length ? `<details style="margin-top:12px"><summary class="small muted">ناموفقها: ${b.candidates.filter((c) => c.state === 'fail').length}</summary><div class="small err" style="margin-top:8px">${b.candidates.filter((c) => c.state === 'fail').map((c) => `${LABELS[c.transport]} ${c.mode}: ${esc(c.error)}`).join('<br>')}</div></details>` : ''}
    </div>`;
}

function viewLogs() {
  return `<div class="section-title"><div><h2>گزارشات</h2><p>رویدادهای زندهٔ پنل، ایجنتها و تانلها</p></div><span class="grow"></span>
    <input id="log-filter" placeholder="فیلتر…" value="${esc(S.logFilter)}" style="max-width:220px"></div>
  <div class="card"><div class="logs">${logsHtml()}</div></div>`;
}
function logsHtml() {
  const q = S.logFilter.toLowerCase();
  const list = S.logs.filter((l) => !q || `${l.scope} ${l.message} ${l.level}`.toLowerCase().includes(q));
  return list.length ? list.map((l) => `<div class="log-line"><span class="t">${new Date(l.at).toLocaleTimeString('fa-IR')}</span><span class="lvl ${l.level}">${l.level}</span><span class="sc">${esc(l.scope)}</span><span>${esc(l.message)}</span></div>`).join('') : '<div class="empty">گزارش مطابق نیست</div>';
}

function viewSettings() {
  const st = S.state.settings || {};
  return `<div class="grid cols-2">
    <div class="card"><div class="card-head"><h3>ظاهر و محک</h3></div>
      <label class="field"><span>تم</span><select id="set-theme"><option value="dark" ${st.theme === 'dark' ? 'selected' : ''}>تاریک</option><option value="light" ${st.theme === 'light' ? 'selected' : ''}>روشن</option></select></label>
      <label class="field"><span>مدت تست سرعت (ثانیه)</span><input id="set-seconds" type="number" min="1" max="20" value="${st.benchSeconds || 3}"></label>
      <label class="field"><span>تعداد جریانها</span><input id="set-streams" type="number" min="1" max="16" value="${st.benchStreams || 4}"></label>
      <button class="btn btn-primary btn-sm" data-action="save-settings">ذخیره</button>
    </div>
    <div class="card"><div class="card-head"><h3>محیط آزمایشی</h3></div>
      <p class="small muted">دمو دو ایجنت محلی و پنج تانل (TCP, TCP MUX, WS, WSS, UDP) میسازد تا بتوانید محک را بدون سرور واقعی امتحان کنید.</p>
      <button class="btn ${S.state.demo?.running ? 'btn-danger' : 'btn-primary'}" data-action="demo-toggle">${S.state.demo?.running ? 'توقف دمو' : 'راه اندازی دمو'}</button>
      <div class="card" style="margin-top:14px;background:var(--panel-2)"><b class="small">کلید مشترک</b><div class="code" style="margin-top:6px">${esc(S.state.secret)}</div><p class="small faint">همین کلید باید روی ایجنتها تنظیم شود.</p></div>
    </div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h3>اتصال سرور جدید با یک کد</h3></div>
    <p class="small muted">آدرس عمومی ایجنت روی سرور پنل را بدهید تا کدی بسازد که با آن، سرور خارج تنها با یک دستور وصل میشود. پنل روی 127.0.0.1 باقی میماند و نیازی به باز کردن پورت آن نیست.</p>
    <label class="field"><span>آدرس عمومی ایجنت (مثال http://IP:7700)</span><input id="connect-agent" dir="ltr" placeholder="http://87.107.81.145:7700"></label>
    <label class="field"><span>نام سرور جدید</span><input id="connect-name" dir="ltr" placeholder="outside"></label>
    <button class="btn btn-primary btn-sm" data-action="make-connect-code">ساخت کد اتصال</button>
    <div id="connect-result" class="code" style="margin-top:10px;display:none;word-break:break-all"></div>
  </div>
  <div class="card" style="margin-top:16px"><div class="card-head"><h3>دربارهٔ نهر</h3></div>
    <p class="small muted">نهر یک پیادهسازی مستقل است: تونل رمزنگاری شده با X25519 + AES-GCM، مالتیپلکسر جریانها، پنل وب و محک داخلی. پنج ترنسپورت دارد و هیچ کدی از پروژهٔ دیگری کپی نشده است.</p>
    <a class="btn btn-ghost btn-sm" href="/docs" target="_blank">مطالعهٔ مستندات</a>
  </div>`;
}

/* ---------- port forwards ---------- */
function forwardsText(rules) {
  return (Array.isArray(rules) ? rules : [])
    .map((r) => `${r.listenHost && r.listenHost !== '127.0.0.1' ? `${r.listenHost}:` : ''}${r.listenPort}  ${r.targetHost || '127.0.0.1'}:${r.targetPort}`)
    .join('\n');
}

function parseForwards(text) {
  return String(text || '')
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('#'))
    .map((line, i) => {
      const parts = line.split(/\s+/);
      if (parts.length !== 2) throw new Error(`خطای خط ${i + 1}: ${line}`);
      const l = parts[0].split(':');
      const listenPort = Number(l.pop());
      const listenHost = l.join(':') || '127.0.0.1';
      const r = parts[1].split(':');
      const targetPort = Number(r.pop());
      const targetHost = r.join(':') || '127.0.0.1';
      if (!Number.isInteger(listenPort) || listenPort < 1 || listenPort > 65535) throw new Error(`پورت محلی نامعتبر در خط ${i + 1}`);
      if (!Number.isInteger(targetPort) || targetPort < 1 || targetPort > 65535) throw new Error(`پورت مقصد نامعتبر در خط ${i + 1}`);
      return { listenHost, listenPort, targetHost, targetPort };
    });
}

/* ---------- modals ---------- */
function addServerModal() {
  openModal({
    title: 'افزودن سرور',
    sub: 'ایجنت نهر باید روی آن سرور در حال اجرا باشد',
    content: `<label class="field"><span>نام</span><input id="f-name" placeholder="سرور فرانکفورت"></label>
      <label class="field"><span>آدرس IP یا دامنه</span><input id="f-host" dir="ltr" placeholder="203.0.113.5"></label>
      <div class="grid cols-2"><label class="field"><span>پورت ایجنت</span><input id="f-port" type="number" value="7700"></label>
      <label class="field"><span>منطقه (اختیاری)</span><input id="f-region" placeholder="EU"></label></div>
      <label class="field"><span>توکن (خالی = کلید پنل)</span><input id="f-token" dir="ltr" placeholder="${esc(S.state.secret)}"></label>
      <div class="modal-foot"><button class="btn" data-action="close-modal">لغو</button><button class="btn btn-primary" data-action="save-server">افزودن</button></div>`,
  });
}

function tunnelModal(existing) {
  const t = existing || { name: '', entryId: S.servers[0]?.id, exitId: S.servers[1]?.id, transport: 'tcpmux', mode: 'direct', profile: 'balanced', listenPort: 0, socksPort: 1080, forwards: [] };
  const opts = (list, selected) => list.map((o) => `<option value="${o.v}" ${o.v === selected ? 'selected' : ''}>${esc(o.t)}</option>`).join('');
  openModal({
    title: existing ? 'ویرایش تانل' : 'تانل جدید',
    sub: 'پس از ساخت، میتوانید با محک بهترین ترنسپورت را پیدا کنید',
    content: `<label class="field"><span>نام</span><input id="f-name" value="${esc(t.name)}" placeholder="تانل اصلی"></label>
      <div class="grid cols-2">
        <label class="field"><span>ورودی</span><select id="f-entry">${opts(S.servers.map((s) => ({ v: s.id, t: s.name })), t.entryId)}</select></label>
        <label class="field"><span>خروجی</span><select id="f-exit">${opts(S.servers.map((s) => ({ v: s.id, t: s.name })), t.exitId)}</select></label>
      </div>
      <div class="grid cols-3">
        <label class="field"><span>ترنسپورت</span><select id="f-transport">${opts(Object.entries(LABELS).map(([v, l]) => ({ v, t: l })), t.transport)}</select></label>
        <label class="field"><span>حالت</span><select id="f-mode"><option value="direct" ${t.mode === 'direct' ? 'selected' : ''}>مستقیم</option><option value="reverse" ${t.mode === 'reverse' ? 'selected' : ''}>معکوس</option></select></label>
        <label class="field"><span>پروفایل</span><select id="f-profile">${opts(Object.entries(PROFILES).map(([v, l]) => ({ v, t: l })), t.profile)}</select></label>
      </div>
      <div class="grid cols-2">
        <label class="field"><span>پورت ارتباطی بین دو سرور</span><input id="f-listen" type="number" value="${t.listenPort}">
          <small class="faint">فقط مخصوص ارتباط نهر بین دو سرور است (۰ = خودکار)</small></label>
        <label class="field"><span>پورت SOCKS5 محلی</span><input id="f-socks" type="number" value="${t.socksPort}">
          <small class="faint">پروکسی عمومی؛ اختیاری است</small></label>
      </div>
      <label class="field"><span>پورتهایی که تانل میشوند (پورت فوروارد)</span>
        <textarea id="f-forwards" rows="4" dir="ltr" placeholder="1081 127.0.0.1:10000&#10;1082 127.0.0.1:8443">${esc(forwardsText(t.forwards))}</textarea>
        <small class="faint">هر خط: <span dir="ltr">پورت_محلی ␣ آدرس:پورت_مقصد</span> روی سرور خروجی. مثال: <span dir="ltr">1081 127.0.0.1:10000</span> یعنی اتصال به پورت ۱۰۸۱ ورودی به پورت ۱۰۰۰۰ خروجی میرود. خالی بماند یعنی فقط SOCKS5.</small>
      </label>
      <div class="modal-foot"><button class="btn" data-action="close-modal">لغو</button><button class="btn btn-primary" data-action="save-tunnel" data-id="${existing?.id || ''}">${existing ? 'ذخیره' : 'ساخت'}</button></div>`,
  });
}

/* ---------- events ---------- */
document.addEventListener('click', async (e) => {
  const nav = e.target.closest('.nav-item[data-route]');
  if (nav) {
    e.preventDefault();
    setRoute(nav.dataset.route);
    $('#sidebar').classList.remove('open');
    return;
  }
  const btn = e.target.closest('[data-action]');
  if (!btn) return;
  const a = btn.dataset.action;
  const id = btn.dataset.id;
  try {
    if (a === 'reload') return loadAll();
    if (a === 'close-modal') return closeModal();
    if (a === 'goto-bench') return setRoute('bench');
    if (a === 'goto-logs') return setRoute('logs');
    if (a === 'add-server') return addServerModal();
    if (a === 'add-tunnel') {
      if (S.servers.length < 2) return toast('حداقل دو سرور لازم است', 'err');
      return tunnelModal();
    }
    if (a === 'save-server') {
      await post('/servers', {
        name: $('#f-name').value,
        host: $('#f-host').value.trim(),
        agentPort: +$('#f-port').value,
        region: $('#f-region').value,
        token: $('#f-token').value,
      });
      closeModal();
      toast('سرور اضافه شد');
      return loadAll();
    }
    if (a === 'delete-server') {
      if (!confirm('این سرور و تانلهای مربوط به آن حذف شوند؟')) return;
      await api(`/servers/${id}`, { method: 'DELETE' });
      toast('حذف شد');
      return loadAll();
    }
    if (a === 'save-tunnel') {
      const data = {
        name: $('#f-name').value,
        entryId: $('#f-entry').value,
        exitId: $('#f-exit').value,
        transport: $('#f-transport').value,
        mode: $('#f-mode').value,
        profile: $('#f-profile').value,
        listenPort: +$('#f-listen').value,
        socksPort: +$('#f-socks').value,
        forwards: parseForwards($('#f-forwards').value),
      };
      if (id) await post(`/tunnels/${id}/update`, data);
      else await post('/tunnels', data);
      closeModal();
      toast(id ? 'تانل بهروز شد' : 'تانل ساخته شد');
      return loadAll();
    }
    if (a === 'edit-tunnel') return tunnelModal(S.tunnels.find((t) => t.id === id));
    if (a === 'delete-tunnel') {
      if (!confirm('تانل حذف شود؟')) return;
      await api(`/tunnels/${id}`, { method: 'DELETE' });
      toast('تانل حذف شد');
      return loadAll();
    }
    if (a === 'toggle-tunnel') {
      const t = S.tunnels.find((x) => x.id === id);
      btn.disabled = true;
      await post(`/tunnels/${id}/${t.status?.running ? 'stop' : 'start'}`);
      toast(t.status?.running ? 'تانل متوقف شد' : 'تانل راه اندازی شد');
      return loadAll();
    }
    if (a === 'bench-pair') {
      S.benchPair = { entry: btn.dataset.entry, exit: btn.dataset.exit };
      return setRoute('bench');
    }
    if (a === 'demo-toggle') {
      btn.disabled = true;
      await post(`/demo/${S.state.demo?.running ? 'stop' : 'start'}`);
      toast(S.state.demo?.running ? 'دمو متوقف شد' : 'دمو آغاز به کار کرد');
      return loadAll();
    }
    if (a === 'bench-start') {
      const b = await post('/bench/start', {
        entryId: $('#bench-entry').value,
        exitId: $('#bench-exit').value,
        profile: $('#bench-profile').value,
        seconds: +$('#bench-seconds').value,
        streams: +$('#bench-streams').value,
      });
      S.benchPair = { entry: $('#bench-entry').value, exit: $('#bench-exit').value };
      toast(`محک آغاز شد (${b.id})`);
      return setTimeout(loadAll, 400);
    }
    if (a === 'bench-stop') {
      await post('/bench/stop');
      return loadAll();
    }
    if (a === 'bench-apply') {
      const r = await post('/bench/apply', { id: S.bench.id, key: btn.dataset.key });
      toast(`اعمال شد: ${LABELS[r.tunnel.transport]}`);
      return loadAll();
    }
    if (a === 'make-connect-code') {
      const agent = $('#connect-agent').value.trim();
      const name = $('#connect-name').value.trim();
      const params = new URLSearchParams({ ttl: '24' });
      if (agent) params.set('agent', agent);
      if (name) params.set('name', name);
      const r = await api(`/connect-code?${params}`);
      const box = $('#connect-result');
      box.style.display = 'block';
      box.innerHTML = `<div>${esc(r.code)}</div><div style="margin-top:8px">${esc(r.command)}</div>`;
      try {
        await navigator.clipboard.writeText(r.command);
        toast('دستور تکخطی کپی شد');
      } catch {
        toast('کد ساخته شد');
      }
      return;
    }
    if (a === 'save-settings') {
      await post('/settings', {
        theme: $('#set-theme').value,
        benchSeconds: +$('#set-seconds').value,
        benchStreams: +$('#set-streams').value,
      });
      applyTheme($('#set-theme').value, false);
      toast('تنظیمات ذخیره شد');
      return loadAll();
    }
  } catch (err) {
    toast(err.message, 'err');
    btn.disabled = false;
  }
});

document.addEventListener('change', (e) => {
  if (e.target.id === 'set-theme') applyTheme(e.target.value);
  if (e.target.id === 'log-filter') {
    S.logFilter = e.target.value;
    const el = $('.logs');
    if (el) el.innerHTML = logsHtml();
  }
});

$('#theme-btn').addEventListener('click', () => applyTheme(document.documentElement.dataset.theme === 'light' ? 'dark' : 'light'));
$('#menu-btn').addEventListener('click', () => $('#sidebar').classList.toggle('open'));
$('#quick-bench').addEventListener('click', () => setRoute('bench'));

/* live updates via server-sent events */
function connectStream() {
  try {
    S.stream = new EventSource('/api/logs/stream');
    S.stream.onmessage = (e) => {
      const event = JSON.parse(e.data);
      if (event.type === 'log') {
        S.logs.unshift(event.entry);
        S.logs = S.logs.slice(0, 300);
        if (S.route === 'logs') {
          const el = $('.logs');
          if (el) el.innerHTML = logsHtml();
        }
      }
      if (event.type === 'bench') {
        S.bench = event.bench;
        if (S.route === 'bench') render();
      }
    };
    S.stream.onerror = () => {};
  } catch {
    /* SSE unavailable */
  }
}

$$('.nav-ico').forEach((el) => {
  const name = el.dataset.icon;
  if (name) el.innerHTML = icon(name, 18);
});
applyTheme(localStorage.getItem('nahr-theme') || 'dark', false);
const originalApply = applyTheme;
applyTheme = function (theme, persist = true) {
  originalApply(theme, persist);
  localStorage.setItem('nahr-theme', theme);
};
setRoute('overview');
loadAll();
connectStream();
