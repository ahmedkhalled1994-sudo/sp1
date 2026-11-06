import { el } from '../lib/dom.js';
import { copyText, showToast } from '../lib/feedback.js';
import { fetchRecentEvents } from '../lib/pages-api.js';

const DAYS = 7;

function metric(label, value, tone = 'text-emerald-400') {
  const box = el('div', 'bg-slate-950/60 border border-slate-800/80 p-3 rounded-2xl');
  box.append(el('p', 'text-[11px] text-slate-400 font-bold', label), el('p', `text-xl font-black ${tone}`, String(value)));
  return box;
}

function summarize(events) {
  const genuine = events.filter((event) => !event.is_suspicious);
  const suspicious = events.filter((event) => event.is_suspicious);
  const byIp = new Map();

  suspicious.forEach((event) => {
    if (!event.ip) return;
    const entry = byIp.get(event.ip) || { ip: event.ip, count: 0, reason: event.suspicious_reason };
    entry.count += 1;
    byIp.set(event.ip, entry);
  });

  return {
    views: genuine.filter((event) => event.event_type === 'view').length,
    adViews: genuine.filter((event) => event.event_type === 'view' && event.from_ad).length,
    calls: genuine.filter((event) => event.event_type === 'call').length,
    whatsapp: genuine.filter((event) => event.event_type === 'whatsapp').length,
    suspiciousCount: suspicious.length,
    suspiciousIps: [...byIp.values()].sort((a, b) => b.count - a.count),
  };
}

function suspiciousList(ips) {
  const wrap = el('div', 'space-y-3');

  const header = el('div', 'flex items-center justify-between gap-2');
  header.append(el('h3', 'text-xs font-black text-amber-300', 'عناوين مشبوهة'));

  const copyBtn = el(
    'button',
    'text-[11px] font-bold px-3 py-1.5 rounded-lg bg-slate-900 border border-slate-700 hover:bg-slate-800 text-white transition cursor-pointer',
    'نسخ القائمة',
  );
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const copied = await copyText(ips.map((entry) => entry.ip).join('\n'));
    showToast(copied ? 'تم نسخ العناوين' : 'تعذر النسخ', copied ? 'success' : 'error');
  });
  header.append(copyBtn);

  const list = el('ul', 'space-y-1.5 max-h-48 overflow-y-auto');
  ips.slice(0, 50).forEach((entry) => {
    const item = el('li', 'flex items-center justify-between gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 py-2');
    const info = el('div', 'min-w-0');
    const ip = el('p', 'text-xs font-mono text-slate-100', entry.ip);
    ip.dir = 'ltr';
    info.append(ip, el('p', 'text-[10px] text-slate-400 truncate', entry.reason));
    item.append(info, el('span', 'text-[11px] font-black text-amber-300 whitespace-nowrap', `${entry.count} مرة`));
    list.append(item);
  });

  wrap.append(
    header,
    list,
    el(
      'p',
      'text-[11px] text-slate-400 leading-relaxed',
      'لمنع ظهور إعلانك لهذه العناوين: انسخ القائمة، ثم في جوجل للإعلانات افتح الحملة ← الإعدادات ← استثناءات عناوين IP، والصقها هناك.',
    ),
  );
  return wrap;
}

export async function renderTrafficReport(reportEl, page) {
  const title = el('h2', 'font-black text-sm text-white', `تقرير الزيارات (آخر ${DAYS} أيام)`);

  if (!page) {
    reportEl.replaceChildren(title, el('p', 'text-xs text-slate-300', 'سيظهر التقرير بعد حفظ صفحتك.'));
    return;
  }

  reportEl.replaceChildren(title, el('p', 'text-xs text-slate-400', 'جاري تحميل التقرير...'));

  const since = new Date(Date.now() - DAYS * 24 * 60 * 60 * 1000).toISOString();
  const { data, error } = await fetchRecentEvents(page.id, since);

  if (error || !Array.isArray(data)) {
    reportEl.replaceChildren(title, el('p', 'text-xs text-rose-400 font-bold', 'تعذر تحميل التقرير، أعد تحميل الصفحة لاحقاً.'));
    return;
  }

  const stats = summarize(data);

  const grid = el('div', 'grid grid-cols-2 gap-2');
  grid.append(
    metric('زيارات حقيقية', stats.views),
    metric('منها من إعلانات جوجل', stats.adViews, 'text-sky-400'),
    metric('ضغطات الاتصال', stats.calls),
    metric('ضغطات الواتساب', stats.whatsapp, 'text-teal-400'),
  );

  const suspiciousNote = el(
    'div',
    `rounded-2xl border p-3 text-xs font-bold ${
      stats.suspiciousCount
        ? 'border-amber-500/40 text-amber-300 bg-amber-500/10'
        : 'border-emerald-500/30 text-emerald-300 bg-emerald-500/10'
    }`,
    stats.suspiciousCount
      ? `تم رصد ${stats.suspiciousCount} زيارة أو ضغطة مشبوهة ولم تُحتسب في الإحصائيات ولا في جوجل.`
      : 'لم يتم رصد أي نشاط مشبوه. جميع الزيارات تبدو حقيقية.',
  );

  const children = [title, grid, suspiciousNote];
  if (stats.suspiciousIps.length) children.push(suspiciousList(stats.suspiciousIps));

  reportEl.replaceChildren(...children);
}
