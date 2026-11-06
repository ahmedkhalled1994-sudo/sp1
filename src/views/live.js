import { fetchPublicPage, recordPageView, recordCallClick } from '../lib/pages-api.js';
import { escapeHtml } from '../lib/dom.js';
import { copyText, showToast } from '../lib/feedback.js';
import { DEFAULT_AD_CURRENCY } from '../lib/constants.js';

const THEMES = {
  emerald: {
    bg: 'bg-slate-950',
    text: 'text-slate-100',
    iconBg: 'bg-gradient-to-tr from-emerald-500 to-teal-400 text-slate-950 shadow-emerald-500/20',
    badge: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    callBtn: 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/30',
    badgeIcon: 'text-emerald-400',
    tagColor: 'text-emerald-400',
  },
  blue: {
    bg: 'bg-slate-950',
    text: 'text-slate-100',
    iconBg: 'bg-gradient-to-tr from-blue-600 to-cyan-500 text-white shadow-blue-500/25',
    badge: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    callBtn: 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/35',
    badgeIcon: 'text-blue-400',
    tagColor: 'text-blue-400',
  },
  gold: {
    bg: 'bg-neutral-950',
    text: 'text-amber-50',
    iconBg: 'bg-gradient-to-tr from-amber-500 to-yellow-400 text-neutral-950 shadow-amber-500/25',
    badge: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    callBtn:
      'bg-gradient-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-neutral-950 shadow-amber-500/30',
    badgeIcon: 'text-amber-400',
    tagColor: 'text-amber-400',
  },
};

function safeUrl(url) {
  try {
    const parsed = new URL(url, window.location.origin);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:' ? parsed.href : null;
  } catch {
    return null;
  }
}

function safeTel(phone) {
  const cleaned = String(phone || '').replace(/[^\d+]/g, '');
  return cleaned ? `tel:${cleaned}` : null;
}

function safeIconClass(value) {
  return String(value || '')
    .replace(/[^a-zA-Z0-9\s_-]/g, '')
    .trim();
}

function resolveWorkingHours(page) {
  const explicit = String(page?.working_hours || '').trim();
  if (explicit) return explicit;

  const mode = page?.hours_mode;

  if (mode === 'custom') {
    const from = String(page?.hours_from || '').trim();
    const to = String(page?.hours_to || '').trim();
    if (from && to) return `من ${from} إلى ${to}`;
    if (from) return `من ${from}`;
    if (to) return `إلى ${to}`;
    return '';
  }

  if (mode === '24/7') {
    return 'متوفرون الآن - خدمة 24/7';
  }

  if (mode === 'appointment') {
    return 'حسب الموعد المسبق';
  }

  return '';
}

function setupGoogleAdsTracking(gtagLabel) {
  if (!gtagLabel) return;

  const accountId = gtagLabel.includes('/') ? gtagLabel.split('/')[0] : gtagLabel;
  if (!accountId) return;

  if (!document.getElementById('google-ads-tag')) {
    const script = document.createElement('script');
    script.id = 'google-ads-tag';
    script.async = true;
    script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(accountId)}`;
    document.head.appendChild(script);

    window.dataLayer = window.dataLayer || [];

    function gtag() {
      window.dataLayer.push(arguments);
    }

    window.gtag = gtag;
    gtag('js', new Date());
    gtag('config', accountId);
  }
}

const AntiBotSystem = {
  clickCooldown: false,

  isAutomatedBot() {
    if (navigator.webdriver) return true;
    const botPattern = /bot|spider|crawl|scraper|headless|selenium/i;
    return botPattern.test(navigator.userAgent);
  },

  async handleCallClick(slug, phone, gtagLabel, event, currency = DEFAULT_AD_CURRENCY) {
    if (event) event.preventDefault();

    const telHref = safeTel(phone);
    if (!telHref) return;

    if (this.isAutomatedBot() || this.clickCooldown) return;

    this.clickCooldown = true;
    setTimeout(() => {
      this.clickCooldown = false;
    }, 2500);

    if (typeof window.gtag === 'function' && gtagLabel) {
      try {
        window.gtag('event', 'conversion', {
          send_to: gtagLabel,
          value: 1.0,
          currency,
          event_callback: () => {
            console.log('[PAG ADS] تم تسجيل إحالة ناجحة');
          },
        });
      } catch (err) {
        console.warn('[PAG ADS] خطأ في تتبع الإحالة:', err);
      }
    }

    try {
      await recordCallClick(slug);
    } catch (_) {}

    window.location.href = telHref;
  },
};

function renderHeroIcon(icon) {
  const raw = String(icon || '').trim();
  const defaultIcon = `<i class="fa-solid fa-phone-volume text-slate-950"></i>`;

  if (!raw || raw === 'default') {
    return defaultIcon;
  }

  if (/^https?:\/\//i.test(raw)) {
    const url = safeUrl(raw);
    if (url) {
      return `<img src="${escapeHtml(url)}" alt="Logo" class="w-16 h-16 object-contain rounded-2xl" />`;
    }
    return defaultIcon;
  }

  const safeClass = safeIconClass(raw);

  if (safeClass.includes('fa-')) {
    return `<i class="${escapeHtml(safeClass)} text-slate-950"></i>`;
  }

  const iconMap = {
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

  const key = raw.toLowerCase();

  if (iconMap[key]) {
    return `<i class="${iconMap[key]} text-slate-950"></i>`;
  }

  if (!/^[a-zA-Z0-9_-]+$/.test(raw)) {
    return `<span class="text-4xl leading-none select-none">${escapeHtml(raw)}</span>`;
  }

  return `<i class="fa-solid fa-${escapeHtml(safeClass)} text-slate-950"></i>`;
}

function formatSocialUrl(type, value) {
  if (!value) return null;

  const val = String(value).trim();
  if (!val) return null;

  if (/^https?:\/\//i.test(val)) {
    return safeUrl(val);
  }

  switch (type) {
    case 'whatsapp': {
      const digits = val.replace(/\D/g, '');
      return digits ? safeUrl(`https://wa.me/${digits}`) : null;
    }

    case 'snapchat': {
      const handle = val.replace(/^@/, '').trim();
      return handle ? safeUrl(`https://www.snapchat.com/add/${encodeURIComponent(handle)}`) : null;
    }

    case 'instagram': {
      const handle = val.replace(/^@/, '').trim();
      return handle ? safeUrl(`https://instagram.com/${encodeURIComponent(handle)}`) : null;
    }

    case 'tiktok': {
      const handle = val.replace(/^@/, '').trim();
      return handle ? safeUrl(`https://tiktok.com/@${encodeURIComponent(handle)}`) : null;
    }

    case 'twitter':
    case 'x': {
      const handle = val.replace(/^@/, '').trim();
      return handle ? safeUrl(`https://x.com/${encodeURIComponent(handle)}`) : null;
    }

    default:
      return null;
  }
}

function updateSEO(page) {
  const pageTitle = page.title || page.company_name || 'خدمة سريعة';
  document.title = `${pageTitle} | إحالة ناجحة واتصال مباشر`;

  const metaDesc = document.querySelector('meta[name="description"]');
  if (metaDesc) {
    metaDesc.content = page.description || pageTitle;
  }
}

export async function renderLive(container, slug) {
  const cleanSlug = String(slug).trim();

  container.innerHTML = `
    <div class="min-h-screen bg-slate-950 flex items-center justify-center p-6 text-slate-400">
      <div class="animate-pulse flex items-center gap-3">
        <i class="fa-solid fa-circle-notch fa-spin text-emerald-500 text-2xl"></i>
        <span class="text-slate-300 font-medium">جاري تجهيز صفحة الإعلان...</span>
      </div>
    </div>
  `;

  const { data: page, error } = await fetchPublicPage(cleanSlug);

  const isExpired = page?.expires_at && new Date(page.expires_at) < new Date();
  const isSuspended = page?.is_active === false;

  if (error || !page || isExpired || isSuspended) {
    let titleMessage = 'الصفحة غير متوفرة';
    let descriptionMessage = 'قد يكون الرابط غير صحيح أو تم حذف الصفحة.';

    if (page) {
      if (isExpired) {
        titleMessage = 'انتهت فترة اشتراك هذه الصفحة';
        descriptionMessage =
          'تم تعليق الصفحة لانتهاء فترة الباقة، يرجى التواصل مع إدارة صفحة إعلان (PAG ADS) لتجديد الاشتراك.';
      } else if (isSuspended) {
        titleMessage = 'هذه الصفحة موقوفة مؤقتًا';
        descriptionMessage =
          'تم إيقاف هذه الصفحة مؤقتًا من إدارة المنصة. يرجى التواصل مع الإدارة لإعادة التفعيل.';
      }
    }

    container.innerHTML = `
      <div class="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center">
        <div class="w-16 h-16 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center text-2xl mb-4">
          <i class="fa-solid fa-hourglass-end"></i>
        </div>

        <h1 class="text-2xl font-bold text-slate-100 mb-2">
          ${escapeHtml(titleMessage)}
        </h1>

        <p class="text-slate-400 mb-6 text-sm max-w-sm leading-relaxed">
          ${escapeHtml(descriptionMessage)}
        </p>

        <a
          href="/"
          class="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition"
        >
          العودة للرئيسية
        </a>
      </div>
    `;

    return;
  }

  const currentTheme = THEMES[page.theme] || THEMES.emerald;

  const gtagLabel = page.gtag_label || page.conversion_label || '';
  const currency = page.currency || DEFAULT_AD_CURRENCY;

  updateSEO(page);
  setupGoogleAdsTracking(gtagLabel);

  if (!AntiBotSystem.isAutomatedBot()) {
    try {
      await recordPageView(cleanSlug);
    } catch (_) {}
  }

  const title = page.title || page.company_name || 'خدمة سريعة';
  const workingHours = resolveWorkingHours(page);
  const telHref = safeTel(page.phone);
  const isTrial = page.is_trial === true;

  const social = page.social_links || {};
  const getSocial = (key) => social[key] || page[key] || '';

  const whatsappUrl = formatSocialUrl('whatsapp', getSocial('whatsapp'));
  const snapchatUrl = formatSocialUrl('snapchat', getSocial('snapchat'));
  const instagramUrl = formatSocialUrl('instagram', getSocial('instagram'));
  const tiktokUrl = formatSocialUrl('tiktok', getSocial('tiktok'));
  const twitterUrl = formatSocialUrl('twitter', getSocial('twitter') || getSocial('x'));

  const socialItems = [];

  if (whatsappUrl) {
    socialItems.push({
      url: whatsappUrl,
      icon: 'fa-brands fa-whatsapp',
      color: 'text-teal-400',
    });
  }

  if (snapchatUrl) {
    socialItems.push({
      url: snapchatUrl,
      icon: 'fa-brands fa-snapchat',
      color: 'text-yellow-400',
    });
  }

  if (instagramUrl) {
    socialItems.push({
      url: instagramUrl,
      icon: 'fa-brands fa-instagram',
      color: 'text-pink-400',
    });
  }

  if (tiktokUrl) {
    socialItems.push({
      url: tiktokUrl,
      icon: 'fa-brands fa-tiktok',
      color: 'text-slate-100',
    });
  }

  if (twitterUrl) {
    socialItems.push({
      url: twitterUrl,
      icon: 'fa-brands fa-x-twitter',
      color: 'text-sky-400',
    });
  }

  const socialLinksHtml = socialItems.length
    ? `
      <div class="flex flex-wrap items-center justify-center gap-3 mt-6">
        ${socialItems
          .map(
            (item) => `
              <a
                href="${escapeHtml(item.url)}"
                target="_blank"
                rel="noopener noreferrer"
                class="w-11 h-11 rounded-2xl bg-slate-900 border border-slate-800 flex items-center justify-center ${item.color} text-lg hover:bg-slate-800 transition"
              >
                <i class="${item.icon}"></i>
              </a>
            `,
          )
          .join('')}
      </div>
    `
    : '';

  const trialBanner = isTrial
    ? `
      <div class="w-full mb-4 px-4 py-2 rounded-xl bg-amber-500/10 border border-amber-500/20 text-amber-300 text-xs font-bold text-center">
        <i class="fa-solid fa-flask ml-1"></i>
        صفحة تجريبية مجانية
      </div>
    `
    : '';

  const callBlockHtml = telHref
    ? `
      <div class="w-full my-3">
        <button
          id="singleCallBtn"
          class="w-full py-5 px-6 rounded-2xl font-black text-2xl flex items-center justify-center gap-4 shadow-xl active:scale-95 transition-all cursor-pointer ${currentTheme.callBtn}"
        >
          <i class="fa-solid fa-phone-volume text-2xl animate-bounce"></i>
          <span>اتصل بنا الآن</span>
        </button>

        <button
          id="copyPhoneBtn"
          class="mt-2 text-[11px] text-slate-400 hover:text-emerald-300 transition flex items-center justify-center gap-1 mx-auto cursor-pointer"
        >
          <i class="fa-regular fa-copy"></i>
          <span>نسخ رقم الهاتف</span>
        </button>

        <div class="flex items-center justify-center gap-3 text-xs mt-3 text-slate-400">
          <span class="inline-flex items-center gap-1 font-bold ${currentTheme.tagColor}">
            <i class="fa-solid fa-circle-check text-xs"></i>
            إحالة ناجحة معتمدة
          </span>

          <span>•</span>

          <span class="inline-flex items-center gap-1">
            <i class="fa-solid fa-bolt text-amber-400 text-xs"></i>
            اتصال فوري ومباشر
          </span>
        </div>
      </div>
    `
    : '';

  container.innerHTML = `
    <div class="min-h-screen ${currentTheme.bg} ${currentTheme.text} flex flex-col justify-between items-center px-4 py-8 max-w-md mx-auto transition-colors duration-300">
      ${trialBanner}

      <div class="w-full flex justify-center mb-6 animate-fade-in">
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full border text-xs font-semibold backdrop-blur-md ${currentTheme.badge}">
          <i class="fa-solid fa-shield-halved ${currentTheme.badgeIcon}"></i>
          <span>محمية ضد النقرات الوهمية | SpeedShield™</span>
        </div>
      </div>

      <div class="w-full text-center flex-1 flex flex-col justify-center items-center animate-fade-in">
        <div class="w-24 h-24 mb-5 rounded-3xl flex items-center justify-center shadow-xl text-4xl ${currentTheme.iconBg}">
          ${renderHeroIcon(page.icon)}
        </div>

        <h1 class="text-3xl font-black mb-3 leading-tight tracking-wide">
          ${escapeHtml(title)}
        </h1>

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
            ? `
              <p class="text-slate-300 text-base leading-relaxed mb-6 px-2 whitespace-pre-line text-center">
                ${escapeHtml(page.description)}
              </p>
            `
            : ''
        }

        ${callBlockHtml}

        ${socialLinksHtml}
      </div>

      <div class="w-full text-center pt-8 text-xs text-slate-500">
        <span>صفحة إعلانية سريعة ومحمية عبر </span>
        <a href="/" class="font-bold hover:underline text-slate-400 hover:text-white transition">
          صفحة إعلان | PAG ADS
        </a>
      </div>
    </div>
  `;

  const singleCallBtn = container.querySelector('#singleCallBtn');
  if (singleCallBtn && page.phone) {
    singleCallBtn.addEventListener('click', (e) => {
      AntiBotSystem.handleCallClick(cleanSlug, page.phone, gtagLabel, e, currency);
    });
  }

  const copyPhoneBtn = container.querySelector('#copyPhoneBtn');
  if (copyPhoneBtn && page.phone) {
    copyPhoneBtn.addEventListener('click', async () => {
      const copied = await copyText(page.phone);
      showToast(
        copied ? 'تم نسخ رقم الهاتف' : 'تعذر نسخ الرقم، حاول مرة أخرى',
        copied ? 'success' : 'error',
      );
    });
  }
}