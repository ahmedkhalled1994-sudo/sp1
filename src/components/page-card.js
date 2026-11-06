import { el } from '../lib/dom.js';
import { getTheme } from '../lib/themes.js';

function formatHours(page) {
  if (page.hours_mode === '24/7') return 'متوفرون الآن - خدمة 24/7';
  if (page.hours_mode === 'custom') return `من ${page.hours_from} إلى ${page.hours_to}`;
  return 'حسب الموعد المسبق';
}

const SOCIAL_LINKS = [
  { key: 'whatsapp', name: 'واتساب', icon: 'fa-brands fa-whatsapp', color: 'text-teal-400' },
  { key: 'instagram', name: 'انستجرام', icon: 'fa-brands fa-instagram', color: 'text-pink-400' },
  { key: 'snapchat', name: 'سناب شات', icon: 'fa-brands fa-snapchat', color: 'text-yellow-300' },
  { key: 'tiktok', name: 'تيك توك', icon: 'fa-brands fa-tiktok', color: 'text-slate-100' },
];

function iconLabel(iconClass, text) {
  const fragment = document.createDocumentFragment();
  fragment.append(el('i', iconClass), el('span', '', text));
  return fragment;
}

export function createPageCard(page) {
  const theme = getTheme(page.theme);
  const card = el(
    'div',
    `w-full max-w-sm mx-auto ${theme.bg} ${theme.text} border border-slate-800 rounded-[35px] p-6 space-y-5 shadow-2xl transition-colors duration-300`,
  );

  const header = el('div', 'text-center space-y-3');
  header.append(
    el('div', `w-16 h-16 mx-auto rounded-2xl flex items-center justify-center text-3xl shadow-xl ${theme.iconBg}`, page.icon),
    el('div', `inline-block border text-xs px-3 py-1 rounded-full font-bold ${theme.badge}`, formatHours(page)),
    el('h2', 'text-xl font-black leading-snug', page.title),
  );
  if (page.description) {
    header.append(el('p', 'text-xs text-slate-300 bg-slate-900/80 p-3 rounded-2xl border border-slate-800 leading-relaxed', page.description));
  }
  const area = String(page.service_area || '').trim();
  if (area) {
    const areaTag = el('div', 'inline-flex items-center gap-1.5 text-[11px] text-slate-300 font-bold');
    areaTag.append(el('i', `fa-solid fa-location-dot ${theme.badgeIcon}`), el('span', '', `نخدم منطقة: ${area}`));
    header.append(areaTag);
  }
  card.append(header);

  const callPreview = el(
    'div',
    `w-full font-black py-3.5 rounded-2xl flex items-center justify-center gap-2 text-base shadow-lg ${theme.callBtn}`,
  );
  callPreview.append(iconLabel('fa-solid fa-phone-volume', 'اتصل بنا الآن'));
  card.append(callPreview);

  const services = String(page.services || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
  if (services.length) {
    const list = el('ul', 'space-y-1.5');
    services.forEach((service) => {
      const item = el('li', 'flex items-center gap-2 bg-slate-900/80 border border-slate-800 rounded-xl px-3 py-2 text-xs text-slate-200');
      item.append(el('i', `fa-solid fa-circle-check ${theme.tagColor}`), el('span', '', service));
      list.append(item);
    });
    card.append(list);
  }

  const socials = SOCIAL_LINKS.filter((item) => page[item.key]);
  if (socials.length) {
    const grid = el('div', 'grid grid-cols-2 gap-2 pt-3 border-t border-slate-800');
    socials.forEach((item) => {
      const node = el(
        'div',
        `bg-slate-900/80 border border-slate-800 ${item.color} py-2 px-3 rounded-xl flex items-center justify-center gap-2 text-xs font-bold`,
      );
      node.append(iconLabel(item.icon, item.name));
      grid.append(node);
    });
    card.append(grid);
  }

  return card;
}
