import { fetchPublicPage } from '../lib/pages-api.js';
import { createContactTracker, setupGoogleAdsTracking } from '../lib/conversion-tracking.js';
import { escapeHtml } from '../lib/dom.js';
import { copyText, showToast } from '../lib/feedback.js';
import { DEFAULT_AD_CURRENCY } from '../lib/constants.js';
import { landingPageMarkup, parseServices, safeTel } from '../components/landing-markup.js';

function setMeta(attr, key, content) {
  let tag = document.querySelector(`meta[${attr}="${key}"]`);
  if (!tag) {
    tag = document.createElement('meta');
    tag.setAttribute(attr, key);
    document.head.appendChild(tag);
  }
  tag.content = content;
}

function updateSEO(page) {
  const pageTitle = page.title || page.company_name || 'خدمة سريعة';
  const area = String(page.service_area || '').trim();
  document.title = area ? `${pageTitle} | ${area}` : pageTitle;

  const description =
    page.description || [pageTitle, parseServices(page.services).join('، '), area].filter(Boolean).join(' - ');

  setMeta('name', 'description', description.slice(0, 160));
  setMeta('property', 'og:title', document.title);
  setMeta('property', 'og:description', description.slice(0, 160));
}

function unavailableMarkup(page, isExpired, isSuspended, returnTo) {
  let titleMessage = 'الصفحة غير متوفرة';
  let descriptionMessage = 'قد يكون الرابط غير صحيح أو تم حذف الصفحة.';

  if (page && isExpired) {
    titleMessage = 'انتهت فترة اشتراك هذه الصفحة';
    descriptionMessage =
      'تم تعليق الصفحة لانتهاء فترة الباقة، يرجى التواصل مع إدارة صفحة إعلان (PAG ADS) لتجديد الاشتراك.';
  } else if (page && isSuspended) {
    titleMessage = 'هذه الصفحة موقوفة مؤقتًا';
    descriptionMessage = 'تم إيقاف هذه الصفحة مؤقتًا من إدارة المنصة. يرجى التواصل مع الإدارة لإعادة التفعيل.';
  }

  return `
    <div class="min-h-screen bg-slate-950 flex flex-col items-center justify-center p-6 text-center">
      <div class="w-16 h-16 rounded-2xl bg-amber-500/10 text-amber-400 flex items-center justify-center text-2xl mb-4">
        <i class="fa-solid fa-hourglass-end"></i>
      </div>
      <h1 class="text-2xl font-bold text-slate-100 mb-2">${escapeHtml(titleMessage)}</h1>
      <p class="text-slate-400 mb-6 text-sm max-w-sm leading-relaxed">${escapeHtml(descriptionMessage)}</p>
      <a
        href="${escapeHtml(returnTo ? `${window.location.pathname}#${returnTo}` : '/')}"
        class="px-6 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-200 text-sm font-bold transition"
      >
        ${returnTo ? 'رجوع' : 'العودة للرئيسية'}
      </a>
    </div>
  `;
}

function previewBarMarkup(returnTo) {
  const isAdminPreview = returnTo === 'admin';
  return `
    <div class="sticky top-0 z-50 w-full bg-slate-900/95 backdrop-blur border-b border-slate-800">
      <div class="max-w-md mx-auto px-4 py-2.5 flex items-center justify-between gap-3">
        <span class="text-[11px] text-slate-300 font-bold">
          <i class="fa-regular fa-eye ml-1 text-emerald-400"></i>
          ${isAdminPreview ? 'معاينة صفحة العميل كما يراها الزوار' : 'معاينة صفحتك كما يراها الزوار'}
        </span>
        <a href="${escapeHtml(`${window.location.pathname}#${returnTo}`)}" class="text-[11px] font-black px-3 py-1.5 rounded-lg bg-emerald-500 hover:bg-emerald-400 text-slate-950 transition whitespace-nowrap">
          <i class="fa-solid fa-arrow-right ml-1"></i>
          ${isAdminPreview ? 'رجوع للوحة المدير' : 'رجوع للوحة التحكم'}
        </a>
      </div>
    </div>
  `;
}

export async function renderLive(container, slug, { returnTo = null } = {}) {
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
    container.innerHTML = unavailableMarkup(page, isExpired, isSuspended, returnTo);
    return;
  }

  const gtagLabel = page.gtag_label || page.conversion_label || '';
  const currency = page.currency || DEFAULT_AD_CURRENCY;
  const telHref = safeTel(page.phone);

  updateSEO(page);
  setupGoogleAdsTracking(gtagLabel);

  const tracker = createContactTracker({ slug: cleanSlug, gtagLabel, currency, isPreview: Boolean(returnTo) });
  tracker.trackView();

  container.innerHTML = `
    ${returnTo ? previewBarMarkup(returnTo) : ''}
    ${landingPageMarkup(page, { showTrialNote: Boolean(returnTo) })}
  `;

  const singleCallBtn = container.querySelector('#singleCallBtn');
  if (singleCallBtn && telHref) {
    singleCallBtn.addEventListener('click', async () => {
      if (singleCallBtn.disabled) return;
      singleCallBtn.disabled = true;
      await tracker.trackCall(telHref);
      singleCallBtn.disabled = false;
    });
  }

  container.querySelector('[data-contact="whatsapp"]')?.addEventListener('click', () => {
    tracker.trackWhatsapp();
  });

  container.querySelector('#copyPhoneBtn')?.addEventListener('click', async () => {
    const copied = await copyText(page.phone);
    showToast(copied ? 'تم نسخ رقم الهاتف' : 'تعذر نسخ الرقم، حاول مرة أخرى', copied ? 'success' : 'error');
  });
}
