import { supabase } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { showToast } from '../lib/feedback.js';
import { escapeHtml } from '../lib/dom.js';
import { DISABLED_PAYMENT_MESSAGE, evaluateCustomerPaymentAvailability } from '../lib/payment-config.js';

export { DISABLED_PAYMENT_MESSAGE, evaluateCustomerPaymentAvailability };

const DEFAULTS = {
  whatsapp: '96566217577',
  headline: 'اختر باقتك وانطلق في إعلانات جوجل بأعلى معدل اتصالات',
  subheadline: 'صفحات هبوط فائقة السرعة مجهزة بزر اتصال مباشر، حماية كاملة من النقرات الوهمية، وإحالة جوجل المعتمدة.',
  trial_days: 7,
  plan1: { name: 'الباقة الشهرية (شهر واحد)', old: '7 دنانير', new: '5 دنانير' },
  plan2: { name: 'باقة الـ 3 أشهر', old: '21 دينار', new: '13 دينار' },
  plan3: { name: 'الباقة السنوية (12 شهراً)', old: '60 دينار', new: '48 دينار' },
};

function getWhatsAppCheckoutLink(whatsappNumber, planName, oldPrice, newPrice) {
  const cleanPhone = String(whatsappNumber || DEFAULTS.whatsapp).replace(/\D/g, '');
  const msg = encodeURIComponent(
    `مرحباً إدارة صفحة إعلان (PAG ADS)،\nأود الاستفادة من العرض والاشتراك في "${planName}".\nسعر العرض: ${newPrice} (بدلاً من ${oldPrice}).\nيرجى تزويدي بوسائل الدفع للتأكيد فوراً.`,
  );
  return `https://wa.me/${cleanPhone}?text=${msg}`;
}

function ctaContent(isPlanOnlineValid, label) {
  if (isPlanOnlineValid) {
    return `<i class="fa-solid fa-credit-card text-base"></i><span>ادفع الآن - ${escapeHtml(label)}</span>`;
  }
  return `<i class="fa-solid fa-lock text-sm"></i><span>الدفع الإلكتروني قيد التجهيز - ${escapeHtml(label)}</span>`;
}

const UUID_REGEX = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const CHECKOUT_ERRORS = {
  no_page: 'أنشئ صفحتك واحفظها أولاً، ثم اختر الباقة',
  no_customer_page: 'أنشئ صفحتك واحفظها أولاً، ثم اختر الباقة',
  unauthorized: 'سجّل الدخول أولاً لإتمام الدفع',
  provider_disabled: DISABLED_PAYMENT_MESSAGE,
  missing_configuration: DISABLED_PAYMENT_MESSAGE,
  missing_api_key: DISABLED_PAYMENT_MESSAGE,
  missing_store_id: DISABLED_PAYMENT_MESSAGE,
  missing_variant_id: DISABLED_PAYMENT_MESSAGE,
  test_live_variant_collision: DISABLED_PAYMENT_MESSAGE,
  payments_disabled: DISABLED_PAYMENT_MESSAGE,
  payments_not_configured: DISABLED_PAYMENT_MESSAGE,
  mode_configuration_mismatch: DISABLED_PAYMENT_MESSAGE,
  payment_mode_mismatch: DISABLED_PAYMENT_MESSAGE,
  security_verification_failed: 'تعذر التحقق الأمني حالياً، يرجى المحاولة لاحقاً',
  user_banned: 'تم إيقاف الحساب من الإدارة',
  rate_limit_exceeded: 'تم تجاوز الحد المسموح به للمحاولات، يرجى الانتظار قليلاً',
  invalid_page_id: 'معرّف الصفحة المحددة غير صالح',
   invalid_plan: 'الباقة المختارة غير صالحة',
  forbidden_page: 'لا تملك صلاحية تجديد هذه الصفحة',
  ambiguous_page_selection: 'يرجى تحديد الصفحة المطلوب تجديدها أولاً',
  checkout_cancelled: 'تم إلغاء عملية الدفع قبل البدء',
};

export function filterOwnedPages(pages, userId) {
  if (!userId || !Array.isArray(pages)) return [];
  return pages.filter(
    (p) =>
      p &&
      typeof p === 'object' &&
      p.user_id === userId &&
      typeof p.id === 'string' &&
      UUID_REGEX.test(p.id.trim()),
  );
}

export function resolvePricingPageSelection({
  user,
  ownedPages = [],
  selectedPageId = '',
  plan,
  origin = '',
  cancelled = false,
} = {}) {
  if (cancelled) {
    return {
      ok: false,
      error: 'checkout_cancelled',
      message: CHECKOUT_ERRORS.checkout_cancelled,
    };
  }

  if (!user || !user.id) {
    return {
      ok: false,
      error: 'unauthorized',
      message: CHECKOUT_ERRORS.unauthorized,
    };
  }

  const numericPlan = Number(plan);
  if (![1, 2, 3].includes(numericPlan)) {
    return {
      ok: false,
      error: 'invalid_plan',
      message: CHECKOUT_ERRORS.invalid_plan,
    };
  }

  const validOwnedPages = filterOwnedPages(ownedPages, user.id);
  const rawSelected = typeof selectedPageId === 'string' ? selectedPageId.trim() : '';

  if (rawSelected !== '') {
    if (!UUID_REGEX.test(rawSelected)) {
      return {
        ok: false,
        error: 'invalid_page_id',
        message: CHECKOUT_ERRORS.invalid_page_id,
      };
    }

    const matchedPage = validOwnedPages.find((p) => p.id.trim() === rawSelected);
    if (!matchedPage) {
      return {
        ok: false,
        error: 'forbidden_page',
        message: CHECKOUT_ERRORS.forbidden_page,
      };
    }

    return {
      ok: true,
      targetPageId: matchedPage.id.trim(),
      payload: {
        plan: numericPlan,
        page_id: matchedPage.id.trim(),
        origin,
      },
    };
  }

  if (validOwnedPages.length === 0) {
    return {
      ok: false,
      error: 'no_page',
      message: CHECKOUT_ERRORS.no_page,
    };
  }

  if (validOwnedPages.length > 1) {
    return {
      ok: false,
      error: 'ambiguous_page_selection',
      message: CHECKOUT_ERRORS.ambiguous_page_selection,
    };
  }

  const singlePageId = validOwnedPages[0].id.trim();
  return {
    ok: true,
    targetPageId: singlePageId,
    payload: {
      plan: numericPlan,
      page_id: singlePageId,
      origin,
    },
  };
}

export async function startCheckout(
  plan,
  button,
  {
    ownedPages = [],
    selectedPageId = '',
    cancelled = false,
    supabaseClient = supabase,
    sessionGetter = getSession,
    toastFn = showToast,
    navigateFn = navigate,
  } = {},
) {
  const { user } = sessionGetter();
  if (!user) {
    toastFn('سجّل الدخول أولاً لإتمام الدفع', 'error');
    navigateFn('login');
    return { ok: false, error: 'unauthorized' };
  }

  const origin = typeof window !== 'undefined' && window.location ? window.location.origin : '';
  const resolution = resolvePricingPageSelection({
    user,
    ownedPages,
    selectedPageId,
    plan,
    origin,
    cancelled,
  });

  if (!resolution.ok) {
    toastFn(resolution.message, 'error');
    if (resolution.error === 'no_page' || resolution.error === 'no_customer_page') {
      navigateFn('dashboard');
    }
    return { ok: false, error: resolution.error };
  }

  if (button) {
    button.disabled = true;
    button.classList.add('opacity-60', 'pointer-events-none');
  }

  let data = null;
  let error = null;
  try {
    const invokeRes = await supabaseClient.functions.invoke('lemon-checkout', {
      body: resolution.payload,
    });
    data = invokeRes?.data ?? null;
    error = invokeRes?.error ?? null;
  } finally {
    if (button) {
      button.disabled = false;
      button.classList.remove('opacity-60', 'pointer-events-none');
    }
  }

  if (!error && typeof data?.url === 'string' && data.url.startsWith('https://')) {
    if (typeof window !== 'undefined' && window.location) {
      window.location.href = data.url;
    }
    return { ok: true, url: data.url, payload: resolution.payload };
  }

  let code = data?.error;
  if (!code && error?.context?.json) {
    code = (await error.context.json().catch(() => null))?.error;
  }

  toastFn(CHECKOUT_ERRORS[code] ?? DISABLED_PAYMENT_MESSAGE, 'error');
  if (code === 'no_page' || code === 'no_customer_page') navigateFn('dashboard');
  return { ok: false, error: code || 'checkout_failed' };
}

export async function renderPricing(container) {
  let settings = {
    ...DEFAULTS,
    providerEnabled: false,
    mode: 'disabled',
    online: { 1: false, 2: false, 3: false },
  };

  try {
    const { data } = await supabase
      .from('pricing_settings')
      .select('*')
      .eq('id', 'global')
      .maybeSingle();

    if (data) {
      const availability = evaluateCustomerPaymentAvailability(data);
      settings = {
        whatsapp: data.whatsapp_number || DEFAULTS.whatsapp,
        headline: data.headline || DEFAULTS.headline,
        subheadline: data.subheadline || DEFAULTS.subheadline,
        trial_days: data.trial_days || DEFAULTS.trial_days,
        providerEnabled: availability.providerEnabled,
        mode: availability.mode,
        online: availability.onlinePlans,
        plan1: {
          name: data.plan1_name || DEFAULTS.plan1.name,
          old: data.plan1_old_price || DEFAULTS.plan1.old,
          new: data.plan1_new_price || DEFAULTS.plan1.new,
        },
        plan2: {
          name: data.plan2_name || DEFAULTS.plan2.name,
          old: data.plan2_old_price || DEFAULTS.plan2.old,
          new: data.plan2_new_price || DEFAULTS.plan2.new,
        },
        plan3: {
          name: data.plan3_name || DEFAULTS.plan3.name,
          old: data.plan3_old_price || DEFAULTS.plan3.old,
          new: data.plan3_new_price || DEFAULTS.plan3.new,
        },
      };
    }
  } catch (_) {}

  const { user } = getSession();
  let ownedPages = [];

  if (user?.id) {
    try {
      const { data: pagesData } = await supabase
        .from('pages')
        .select('id, user_id, slug, title, company_name, is_active, is_trial, expires_at')
        .eq('user_id', user.id)
        .order('created_at', { ascending: false });
      ownedPages = filterOwnedPages(pagesData, user.id);
    } catch (_) {
      ownedPages = [];
    }
  }

  container.innerHTML = `
    <div class="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 max-w-6xl mx-auto animate-fade-in">
      <div class="text-center max-w-2xl mx-auto mb-12">
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold mb-4">
          <i class="fa-solid fa-tags text-emerald-400"></i>
          <span>عروض وخصومات حصرية لفترة محدودة</span>
        </div>

        <h1 class="text-3xl sm:text-4xl font-black text-white mb-4 leading-tight">
          ${escapeHtml(settings.headline)}
        </h1>

        <p class="text-slate-400 text-sm sm:text-base leading-relaxed">
          ${escapeHtml(settings.subheadline)}
        </p>

        ${!user ? `
          <div class="mt-6">
            <button id="trialBtn" class="bg-linear-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-black text-sm px-8 py-4 rounded-2xl shadow-xl shadow-amber-500/20 transition active:scale-95 cursor-pointer inline-flex items-center gap-2">
              <i class="fa-solid fa-gift"></i>
              <span>جرّب مجاناً لمدة ${Number(settings.trial_days)} أيام بدون دفع</span>
            </button>
            <p class="text-xs text-slate-500 mt-2">لا حاجة لبطاقة ائتمان - صفحة كاملة تعمل فوراً</p>
          </div>
        ` : ''}
      </div>

      ${!settings.providerEnabled ? `
        <div id="payment-disabled-banner" role="status" class="max-w-3xl mx-auto mb-10 bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 text-center">
          <p class="text-amber-300 text-sm font-bold flex items-center justify-center gap-2">
            <i class="fa-solid fa-clock text-amber-400"></i>
            <span>${escapeHtml(DISABLED_PAYMENT_MESSAGE)}</span>
          </p>
        </div>
      ` : ''}

      ${user && ownedPages.length > 1 ? `
        <div id="pricing-page-selector-box" class="max-w-2xl mx-auto mb-10 bg-slate-900/70 border border-slate-800 rounded-2xl p-4 sm:p-5 space-y-3">
          <label for="pricing-page-select" class="block text-xs sm:text-sm font-bold text-emerald-400">
            <i class="fa-solid fa-layer-group ml-1.5"></i>
            <span>اختر الصفحة الإعلانية المطلوب تفعيل أو تجديد اشتراكها:</span>
          </label>
          <div class="flex flex-col sm:flex-row gap-2.5">
            <select
              id="pricing-page-select"
              class="flex-1 bg-slate-950 border border-slate-700 focus:border-emerald-500 rounded-xl px-3.5 py-2.5 text-xs sm:text-sm text-white font-bold outline-none"
            >
              <option value="">-- اختر الصفحة المطلوب تجديدها --</option>
              ${ownedPages
                .map(
                  (p) =>
                    `<option value="${escapeHtml(p.id)}">${escapeHtml(p.title || p.company_name || p.slug || 'صفحة إعلانية')} (${escapeHtml(p.slug || '')})</option>`,
                )
                .join('')}
            </select>
            <button
              id="pricing-clear-page-btn"
              type="button"
              class="px-4 py-2.5 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-300 text-xs font-bold transition cursor-pointer"
            >
              إلغاء التحديد
            </button>
          </div>
        </div>
      ` : user && ownedPages.length === 1 ? `
        <div id="pricing-single-page-badge" class="max-w-xl mx-auto mb-8 bg-slate-900/50 border border-slate-800/80 rounded-2xl px-4 py-3 text-center">
          <p class="text-xs text-slate-300 font-bold">
            <i class="fa-solid fa-circle-check text-emerald-400 ml-1.5"></i>
            <span>الصفحة المستهدفة للتفعيل: <strong class="text-white">${escapeHtml(ownedPages[0].title || ownedPages[0].company_name || ownedPages[0].slug || 'صفحتك الإعلانية')}</strong></span>
          </p>
        </div>
      ` : ''}

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 items-stretch mb-16">
        <div class="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 flex flex-col justify-between hover:border-slate-700 transition relative">
          <div>
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-bold text-slate-400">باقة التجربة والانطلاق</span>
              <span class="px-2 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-bold">خصم خاص</span>
            </div>
            <h3 class="text-xl font-bold text-white mb-4">${escapeHtml(settings.plan1.name)}</h3>
            <div class="space-y-1 mb-6">
              <div class="flex items-center gap-2">
                <span class="line-through text-slate-500 text-base font-semibold">${escapeHtml(settings.plan1.old)}</span>
                <span class="text-xs text-slate-400">قبل الخصم</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-4xl font-black text-white">${escapeHtml(settings.plan1.new)}</span>
                <span class="text-xs text-emerald-400 font-bold">فقط</span>
              </div>
            </div>
            <ul class="space-y-3 text-xs text-slate-300 border-t border-slate-800/80 pt-6 mb-6">
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> صفحة إعلان سريعة مجهزة لإعلانات جوجل</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> زر اتصال مباشر فوري بنقرة واحدة</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> حماية ضد النقرات الوهمية SpeedShield™</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> اختيار أحد القوالب الـ 3</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> تفعيل فوري ومباشر على الرابط</li>
            </ul>
          </div>
          <button
            type="button"
            data-plan="1"
            ${settings.online[1] ? '' : 'disabled aria-disabled="true"'}
            class="w-full py-3.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed text-slate-100 font-bold text-sm flex items-center justify-center gap-2 transition active:scale-95 text-center cursor-pointer"
          >
            ${ctaContent(settings.online[1], `تفعيل العرض بـ ${settings.plan1.new}`)}
          </button>
        </div>

        <div class="bg-gradient-to-b from-slate-900 to-slate-950 border-2 border-emerald-500 rounded-3xl p-6 sm:p-8 flex flex-col justify-between shadow-2xl shadow-emerald-500/10 relative transform md:-translate-y-2">
          <div class="absolute -top-3.5 right-6 bg-gradient-to-r from-emerald-500 to-teal-400 text-slate-950 font-black text-[11px] px-3.5 py-1 rounded-full shadow-md">
            🔥 العرض الأقوى والأكثر طلباً
          </div>
          <div>
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-bold text-emerald-400">الخيار المثالي لحملات جوجل</span>
              <span class="px-2 py-0.5 rounded-md bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-[10px] font-bold">أعلى توفير</span>
            </div>
            <h3 class="text-xl font-bold text-white mb-4">${escapeHtml(settings.plan2.name)}</h3>
            <div class="space-y-1 mb-6">
              <div class="flex items-center gap-2">
                <span class="line-through text-slate-500 text-base font-semibold">${escapeHtml(settings.plan2.old)}</span>
                <span class="text-xs text-slate-400">قبل الخصم</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-4xl font-black text-white">${escapeHtml(settings.plan2.new)}</span>
                <span class="text-xs text-emerald-400 font-bold">فقط</span>
              </div>
            </div>
            <ul class="space-y-3 text-xs text-slate-200 border-t border-slate-800 pt-6 mb-6">
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> كل مميزات الباقة الشهرية بالكامل</li>
              <li class="flex items-center gap-2.5 font-bold text-emerald-300"><i class="fa-solid fa-circle-check text-emerald-400"></i> ربط كود الإحالة الناجحة Google Ads مجاناً</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> حماية متقدمة لمنع استنزاف ميزانية إعلاناتك</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> تعديل بيانات ورقم الصفحة في أي وقت</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> استقرار الإعلان لمدة 90 يوماً متواصلة</li>
            </ul>
          </div>
          <button
            type="button"
            data-plan="2"
            ${settings.online[2] ? '' : 'disabled aria-disabled="true"'}
            class="w-full py-4 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black text-sm flex items-center justify-center gap-2 transition active:scale-95 shadow-lg shadow-emerald-500/25 text-center cursor-pointer"
          >
            ${ctaContent(settings.online[2], `تفعيل عرض الـ ${settings.plan2.new}`)}
          </button>
        </div>

        <div class="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 flex flex-col justify-between hover:border-slate-700 transition relative">
          <div>
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-bold text-slate-400">أعلى توفير للشركات والمؤسسات</span>
              <span class="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold">باقة سنوية VIP</span>
            </div>
            <h3 class="text-xl font-bold text-white mb-4">${escapeHtml(settings.plan3.name)}</h3>
            <div class="space-y-1 mb-6">
              <div class="flex items-center gap-2">
                <span class="line-through text-slate-500 text-base font-semibold">${escapeHtml(settings.plan3.old)}</span>
                <span class="text-xs text-slate-400">قبل الخصم</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-4xl font-black text-white">${escapeHtml(settings.plan3.new)}</span>
                <span class="text-xs text-amber-400 font-bold">فقط</span>
              </div>
            </div>
            <ul class="space-y-3 text-xs text-slate-300 border-t border-slate-800/80 pt-6 mb-6">
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> صفحة إعلانية تعمل لمدة 365 يوماً دون توقف</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> شارة الحماية ومكافحة النقرات الوهمية VIP</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> تعديلات غير محدودة مجاناً طوال السنة</li>
              <li class="flex items-center gap-2.5"><i class="fa-solid fa-circle-check text-emerald-400"></i> أولوية قصوى ودعم فني مخصص على مدار الساعة</li>
            </ul>
          </div>
          <button
            type="button"
            data-plan="3"
            ${settings.online[3] ? '' : 'disabled aria-disabled="true"'}
            class="w-full py-3.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 disabled:opacity-60 disabled:cursor-not-allowed text-slate-100 font-bold text-sm flex items-center justify-center gap-2 transition active:scale-95 text-center cursor-pointer"
          >
            ${ctaContent(settings.online[3], `تفعيل العرض السنوي بـ ${settings.plan3.new}`)}
          </button>
        </div>
      </div>

      <div class="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 text-center max-w-3xl mx-auto space-y-3">
        <h4 class="text-xs font-bold text-slate-300">وسائل الدفع والتحويل المدعومة:</h4>
        <div class="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-400 font-medium">
          <span class="flex items-center gap-1.5"><i class="fa-solid fa-building-columns text-emerald-400"></i> تحويل بنكي مباشر (IBAN)</span>
          <span>•</span>
          <span class="flex items-center gap-1.5"><i class="fa-solid fa-credit-card text-emerald-400"></i> Knet (كي نت) / بطاقات الدفع</span>
          <span>•</span>
          <span class="flex items-center gap-1.5"><i class="fa-solid fa-link text-emerald-400"></i> روابط دفع فورية وسريعة</span>
        </div>
        <div class="pt-2">
          <a
            href="${escapeHtml(getWhatsAppCheckoutLink(settings.whatsapp, settings.plan2.name, settings.plan2.old, settings.plan2.new))}"
            target="_blank"
            rel="noopener noreferrer"
            class="inline-flex items-center gap-2 text-xs font-bold text-emerald-400 hover:underline"
          >
            <i class="fa-brands fa-whatsapp text-sm"></i>
            <span>للاستفسار أو المساعدة عبر واتساب الإدارة</span>
          </a>
        </div>
      </div>
    </div>
  `;

  const pageSelectEl = container.querySelector('#pricing-page-select');
  const clearPageBtn = container.querySelector('#pricing-clear-page-btn');

  if (clearPageBtn && pageSelectEl) {
    clearPageBtn.addEventListener('click', () => {
      pageSelectEl.value = '';
      showToast('تم إلغاء تحديد الصفحة', 'info');
    });
  }

  container.querySelectorAll('button[data-plan]').forEach((button) => {
    const plan = Number(button.dataset.plan);
    if (!settings.online[plan]) return;
    button.addEventListener('click', async (event) => {
      event.preventDefault();
      const selectedPageId = pageSelectEl ? pageSelectEl.value : '';
      const result = await startCheckout(plan, button, {
        ownedPages,
        selectedPageId,
      });
      if (!result.ok && result.error === 'ambiguous_page_selection' && pageSelectEl) {
        pageSelectEl.focus();
      }
    });
  });

  const trialBtn = container.querySelector('#trialBtn');
  if (trialBtn) {
    trialBtn.addEventListener('click', () => {
      navigate('dashboard');
    });
  }
}