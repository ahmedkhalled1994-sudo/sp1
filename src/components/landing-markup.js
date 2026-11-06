import { escapeHtml } from '../lib/dom.js';
import { getTheme } from '../lib/themes.js';

const ICON_MAP = {
  cleaning: 'fa-solid fa-broom',
  تنظيف: 'fa-solid fa-broom',
  moving: 'fa-solid fa-truck-moving',
  نقل: 'fa-solid fa-truck-moving',
  pest: 'fa-solid fa-bug',
  مكافحة: 'fa-solid fa-bug',
  plumbing: 'fa-solid fa-faucet-drip',
  سباكة: 'fa-solid fa-faucet-drip',
  ac: 'fa-solid fa-snowflake',
  تكييف: 'fa-solid fa-snowflake',
  electricity: 'fa-solid fa-bolt',
  كهرباء: 'fa-solid fa-bolt',
  car: 'fa-solid fa-car',
  سيارات: 'fa-solid fa-car',
  paint: 'fa-solid fa-paint-roller',
  دهان: 'fa-solid fa-paint-roller',
  leak: 'fa-solid fa-droplet',
  تسريب: 'fa-solid fa-droplet',
};

function safeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

export function safeTel(phone) {
  const cleaned = String(phone || '').replace(/[^\d+]/g, '');
  return cleaned ? `tel:${cleaned}` : null;
}

function safeIconClass(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9\s_-]/g, '')
    .trim();
}

export function parseServices(value) {
  return String(value || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .slice(0, 10);
}

function resolveWorkingHours(page) {
  const explicit = String(page?.working_hours || '').trim();
  if (explicit) return explicit;

  if (page?.hours_mode === 'custom') {
    const from = String(page?.hours_from || '').trim();
    const to = String(page?.hours_to || '').trim();
    if (from && to) return `من ${from} إلى ${to}`;
    if (from) return `من ${from}`;
    if (to) return `إلى ${to}`;
    return '';
  }

  if (page?.hours_mode === '24/7') return 'متوفرون الآن - خدمة 24/7';
  if (page?.hours_mode === 'appointment') return 'حسب الموعد المسبق';
  return '';
}

function renderHeroIcon(icon) {
  const raw = String(icon || '').trim();
  const defaultIcon = `<i class="fa-solid fa-phone-volume text-slate-950"></i>`;

  if (!raw || raw === 'default') return defaultIcon;

  if (/^https?:\/\//i.test(raw)) {
    const url = safeUrl(raw);
    return url ? `<img src="${escapeHtml(url)}" alt="Logo" class="w-16 h-16 object-contain rounded-2xl" />` : defaultIcon;
  }

  const safeClass = safeIconClass(raw);
  if (safeClass.includes('fa-')) return `<i class="${escapeHtml(safeClass)} text-slate-950"></i>`;

  const mapped = ICON_MAP[raw.toLowerCase()];
  if (mapped) return `<i class="${mapped} text-slate-950"></i>`;

  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    return `<span class="text-4xl leading-none select-none">${escapeHtml(raw)}</span>`;
  }

  return `<i class="fa-solid fa-${escapeHtml(safeClass)} text-slate-950"></i>`;
}

function formatSocialUrl(type, value) {
  const val = String(value || '').trim();
  if (!val) return null;
  if (/^https?:\/\//i.test(val)) return safeUrl(val);

  const handle = val.replace(/^@/, '').trim();
  if (!handle) return null;

  switch (type) {
    case 'whatsapp': {
      const digits = val.replace(/\D/g, '');
      return digits ? safeUrl(`https://wa.me/${digits}`) : null;
    }
    case 'snapchat':
      return safeUrl(`https://www.snapchat.com/add/${encodeURIComponent(handle)}`);
    case 'instagram':
      return safeUrl(`https://instagram.com/${encodeURIComponent(handle)}`);
    case 'tiktok':
      return safeUrl(`https://tiktok.com/@${encodeURIComponent(handle)}`);
    case 'twitter':
      return safeUrl(`https://x.com/${encodeURIComponent(handle)}`);
    default:
      return null;
  }
}

const SOCIALS = [
  { key: 'whatsapp', icon: 'fa-brands fa-whatsapp', color: 'text-teal-400', label: 'واتساب' },
  { key: 'snapchat', icon: 'fa-brands fa-snapchat', color: 'text-yellow-400', label: 'سناب شات' },
  { key: 'instagram', icon: 'fa-brands fa-instagram', color: 'text-pink-400', label: 'انستجرام' },
  { key: 'tiktok', icon: 'fa-brands fa-tiktok', color: 'text-slate-100', label: 'تيك توك' },
  { key: 'twitter', icon: 'fa-brands fa-x-twitter', color: 'text-sky-400', label: 'إكس' },
];

function socialLinksMarkup(page) {
  const social = page.social_links || {};
  const getSocial = (key) => social[key] || page[key] || (key === 'twitter' ? social.x || page.x : '') || '';

  const items = SOCIALS.map((item) => ({ ...item, url: formatSocialUrl(item.key, getSocial(item.key)) })).filter(
    (item) => item.url,
  );

  if (!items.length) return '';

  return `
    <div class="flex flex-wrap items-center justify-center gap-3 mt-6">
      ${items
        .map(
          (item) => `
            <a
              href="${escapeHtml(item.url)}"
              target="_blank"
              rel="noopener noreferrer"
              aria-label="${item.label}"
              ${item.key === 'whatsapp' ? 'data-contact="whatsapp"' : ''}
              class="w-11 h-11 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center ${item.color} text-lg hover:bg-slate-800 transition"
            >
              <i class="${item.icon}"></i>
            </a>
          `,
        )
        .join('')}
    </div>
  `;
}

// `preview` renders the dashboard copy: no entrance animation (it re-renders on every keystroke)
// and the call button is shown even before a phone number is typed.
export function landingPageMarkup(page, { preview = false, showTrialNote = false } = {}) {
  const theme = getTheme(page.theme);
  const title = page.title || page.company_name || 'خدمة سريعة';
  const workingHours = resolveWorkingHours(page);
  const services = parseServices(page.services);
  const serviceArea = String(page.service_area || '').trim();
  const fadeIn = preview ? '' : 'animate-fade-in';
  const showCall = preview || safeTel(page.phone);

  const trialBanner =
    showTrialNote && page.is_trial === true
      ? `
        <div class="w-full mb-4 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-bold text-center">
          <i class="fa-solid fa-flask ml-1"></i>
          صفحة تجريبية مجانية (يظهر هذا التنبيه لك فقط ولا يراه الزوار)
        </div>
      `
      : '';

  const callBlock = showCall
    ? `
      <div class="w-full my-3">
        <button
          id="singleCallBtn"
          type="button"
          class="w-full py-5 px-6 rounded-2xl font-black text-2xl flex items-center justify-center gap-4 shadow-xl active:scale-95 transition-all cursor-pointer ${theme.callBtn}"
        >
          <i class="fa-solid fa-phone-volume text-2xl animate-bounce"></i>
          <span>اتصل بنا الآن</span>
        </button>

        <button
          id="copyPhoneBtn"
          type="button"
          class="mt-2 text-[11px] text-slate-400 hover:text-emerald-300 transition flex items-center justify-center gap-1 mx-auto cursor-pointer"
        >
          <i class="fa-regular fa-copy"></i>
          <span>نسخ رقم الهاتف</span>
        </button>

        <div class="flex items-center justify-center gap-3 text-xs mt-3 text-slate-400">
          <span class="inline-flex items-center gap-1">
            <i class="fa-solid fa-bolt text-amber-400 text-xs"></i>
            اتصال فوري ومباشر
          </span>
        </div>
      </div>
    `
    : '';

  const areaBadge = serviceArea
    ? `
      <div class="w-full flex justify-center mb-6 ${fadeIn}">
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-semibold backdrop-blur-md ${theme.badge}">
          <i class="fa-solid fa-location-dot ${theme.badgeIcon}"></i>
          <span>نخدم منطقة: ${escapeHtml(serviceArea)}</span>
        </div>
      </div>
    `
    : '';

  const servicesBlock = services.length
    ? `
      <section class="w-full mt-6 text-right" aria-label="خدماتنا">
        <h2 class="text-sm font-black mb-3 text-center">خدماتنا</h2>
        <ul class="grid gap-2">
          ${services
            .map(
              (service) => `
                <li class="flex items-center gap-2 bg-slate-900/80 border border-slate-800 rounded-xl px-4 py-3 text-sm text-slate-200">
                  <i class="fa-solid fa-circle-check ${theme.tagColor}"></i>
                  <span>${escapeHtml(service)}</span>
                </li>
              `,
            )
            .join('')}
        </ul>
      </section>
    `
    : '';

  return `
    <div class="${preview ? 'flex-1 w-full' : 'min-h-screen'} ${theme.bg} ${theme.text} flex flex-col justify-between items-center px-4 py-8 max-w-md mx-auto transition-colors duration-300">
      ${trialBanner}
      ${areaBadge}

      <div class="w-full text-center flex-1 flex flex-col justify-center items-center ${fadeIn}">
        <div class="w-24 h-24 mb-5 rounded-3xl flex items-center justify-center shadow-xl text-4xl ${theme.iconBg}">
          ${renderHeroIcon(page.icon)}
        </div>

        <h1 class="text-3xl font-black mb-3 leading-tight tracking-wide">${escapeHtml(title)}</h1>

        ${
          workingHours
            ? `
              <div class="inline-flex items-center gap-1.5 px-3 py-1 mb-4 rounded-full bg-slate-900/80 border border-slate-800 text-slate-300 text-xs font-medium">
                <i class="fa-regular fa-clock"></i>
                <span>${escapeHtml(workingHours)}</span>
              </div>
            `
            : ''
        }

        ${
          page.description
            ? `<p class="text-slate-300 text-base leading-relaxed mb-6 px-2 whitespace-pre-line text-center">${escapeHtml(page.description)}</p>`
            : ''
        }

        ${callBlock}
        ${servicesBlock}
        ${socialLinksMarkup(page)}
      </div>

      <div class="w-full text-center pt-8 text-xs text-slate-500">
        <span>صفحة إعلانية سريعة ومحمية عبر </span>
        <a href="/" class="font-bold hover:underline text-slate-400 hover:text-white transition">صفحة إعلان | PAG ADS</a>
      </div>
    </div>
  `;
}
