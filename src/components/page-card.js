import { copyText, showToast } from '../lib/feedback.js';
import { el } from '../lib/dom.js';

function formatHours(page) {
  if (page.hours_mode === '24/7') return 'متوفرون الآن - خدمة 24/7';
  if (page.hours_mode === 'custom') return `من ${page.hours_from} إلى ${page.hours_to}`;
  return 'حسب الموعد المسبق';
}

const SOCIAL_LINKS = [
  {
    key: 'whatsapp',
    name: 'واتساب',
    icon: 'fa-brands fa-whatsapp',
    color: 'text-teal-400',
    url: (value) => `https://wa.me/${value.replace(/\D/g, '')}`,
  },
  {
    key: 'instagram',
    name: 'انستجرام',
    icon: 'fa-brands fa-instagram',
    color: 'text-pink-400',
    url: (value) => `https://www.instagram.com/${encodeURIComponent(value)}`,
  },
  {
    key: 'snapchat',
    name: 'سناب شات',
    icon: 'fa-brands fa-snapchat',
    color: 'text-yellow-300',
    url: (value) => `https://www.snapchat.com/add/${encodeURIComponent(value)}`,
  },
  {
    key: 'tiktok',
    name: 'تيك توك',
    icon: 'fa-brands fa-tiktok',
    color: 'text-slate-100',
    url: (value) => `https://www.tiktok.com/@${encodeURIComponent(value)}`,
  },
];

function iconLabel(iconClass, text) {
  const fragment = document.createDocumentFragment();
  const icon = el('i', iconClass);
  const label = el('span', '', text);
  fragment.append(icon, label);
  return fragment;
}

function buildSocialItem(item, value, interactive) {
  const tag = interactive ? 'a' : 'div';
  const node = el(
    tag,
    `bg-slate-950 border border-slate-800 ${item.color} py-2 px-3 rounded-xl flex items-center justify-center gap-2 text-xs font-bold ${interactive ? 'hover:border-slate-600 transition' : ''}`,
  );
  if (interactive) {
    node.href = item.url(value);
    node.target = '_blank';
    node.rel = 'noopener noreferrer';
  }
  node.append(iconLabel(item.icon, item.name));
  return node;
}

// Shared by the owner's live preview and the public landing page.
export function createPageCard(page, { interactive = false, onCall } = {}) {
  const card = el('div', 'w-full max-w-sm mx-auto bg-slate-900 border border-slate-800 rounded-[35px] p-6 space-y-5 shadow-2xl');

  const header = el('div', 'text-center space-y-3');
  header.append(
    el('div', 'w-16 h-16 mx-auto rounded-2xl bg-slate-800 border border-slate-700 flex items-center justify-center text-3xl', page.icon),
    el('div', 'inline-block bg-emerald-500/10 text-emerald-400 text-xs px-3 py-1 rounded-full font-bold', formatHours(page)),
    el(interactive ? 'h1' : 'h2', 'text-xl font-black text-white leading-snug', page.title),
  );
  if (page.description) {
    header.append(el('p', 'text-xs text-slate-300 bg-slate-950 p-3 rounded-2xl border border-slate-800 leading-relaxed', page.description));
  }
  card.append(header);

  const actions = el('div', 'space-y-2.5');
  const callClass = 'w-full bg-emerald-500 text-slate-950 font-black py-3.5 rounded-2xl flex items-center justify-center gap-2 text-base shadow-lg transition';
  const callLabel = iconLabel('fa-solid fa-phone-volume', 'اتصل بنا الآن');
  if (interactive) {
    const callLink = el('a', `${callClass} hover:bg-emerald-400 active:scale-95`);
    callLink.href = `tel:${page.phone}`;
    callLink.append(callLabel);
    callLink.addEventListener('click', () => onCall?.());
    actions.append(callLink);

    const copyButton = el('button', 'w-full bg-slate-950 hover:bg-slate-900 border border-slate-800 text-slate-300 hover:text-white font-bold py-2.5 rounded-xl flex items-center justify-center gap-2 text-xs transition cursor-pointer');
    copyButton.append(iconLabel('fa-regular fa-copy', 'نسخ رقم الاتصال'));
    copyButton.addEventListener('click', async () => {
      const copied = await copyText(page.phone);
      showToast(copied ? `تم نسخ رقم الاتصال: ${page.phone}` : 'تعذر النسخ، انسخ الرقم يدوياً', copied ? 'success' : 'error');
    });
    actions.append(copyButton);
  } else {
    const callPreview = el('div', `${callClass} bg-emerald-500/90 opacity-90`);
    callPreview.append(callLabel);
    actions.append(callPreview);
  }
  card.append(actions);

  const socials = SOCIAL_LINKS.filter((item) => page[item.key]);
  if (socials.length) {
    const grid = el('div', 'grid grid-cols-2 gap-2 pt-3 border-t border-slate-800');
    socials.forEach((item) => grid.append(buildSocialItem(item, page[item.key], interactive)));
    card.append(grid);
  }

  return card;
}
