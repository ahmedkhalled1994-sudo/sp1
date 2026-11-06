import { supabase } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { showToast } from '../lib/feedback.js';

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

function ctaContent(online, iconClass, label) {
  return online
    ? `<i class="fa-solid fa-credit-card text-base"></i><span>ادفع الآن - ${label}</span>`
    : `<i class="fa-brands fa-whatsapp ${iconClass}"></i><span>${label}</span>`;
}

const CHECKOUT_ERRORS = {
  no_page: 'أنشئ صفحتك واحفظها أولاً، ثم اختر الباقة',
  unauthorized: 'سجّل الدخول أولاً لإتمام الدفع',
};

async function startCheckout(plan, fallbackHref, button) {
  const { user } = getSession();
  if (!user) {
    showToast('سجّل الدخول أولاً لإتمام الدفع', 'error');
    navigate('login');
    return;
  }

  button.classList.add('opacity-60', 'pointer-events-none');
  const { data, error } = await supabase.functions.invoke('lemon-checkout', {
    body: { plan, return_url: `${window.location.origin}${window.location.pathname}` },
  });
  button.classList.remove('opacity-60', 'pointer-events-none');

  if (!error && typeof data?.url === 'string' && data.url.startsWith('https://')) {
    window.location.href = data.url;
    return;
  }

  let code = data?.error;
  if (!code && error?.context?.json) {
    code = (await error.context.json().catch(() => null))?.error;
  }

  if (code === 'payments_not_configured') {
    window.open(fallbackHref, '_blank', 'noopener');
    return;
  }
  showToast(CHECKOUT_ERRORS[code] ?? 'تعذر فتح صفحة الدفع، حاول مرة أخرى', 'error');
  if (code === 'no_page') navigate('dashboard');
}

export async function renderPricing(container) {
  let settings = { ...DEFAULTS, online: {} };

  try {
    const { data } = await supabase
      .from('pricing_settings')
      .select('*')
      .eq('id', 'global')
      .maybeSingle();

    if (data) {
      settings = {
        whatsapp: data.whatsapp_number || DEFAULTS.whatsapp,
        headline: data.headline || DEFAULTS.headline,
        subheadline: data.subheadline || DEFAULTS.subheadline,
        trial_days: data.trial_days || DEFAULTS.trial_days,
        online: {
          1: Boolean(data.plan1_variant_id),
          2: Boolean(data.plan2_variant_id),
          3: Boolean(data.plan3_variant_id),
        },
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

  container.innerHTML = `
    <div class="min-h-screen bg-slate-950 text-slate-100 py-12 px-4 max-w-6xl mx-auto animate-fade-in">
      <div class="text-center max-w-2xl mx-auto mb-16">
        <div class="inline-flex items-center gap-2 px-3.5 py-1.5 rounded-full bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold mb-4">
          <i class="fa-solid fa-tags text-emerald-400"></i>
          <span>عروض وخصومات حصرية لفترة محدودة</span>
        </div>

        <h1 class="text-3xl sm:text-4xl font-black text-white mb-4 leading-tight">
          ${settings.headline}
        </h1>

        <p class="text-slate-400 text-sm sm:text-base leading-relaxed">
          ${settings.subheadline}
        </p>

        ${!user ? `
          <div class="mt-6">
            <button id="trialBtn" class="bg-linear-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-black text-sm px-8 py-4 rounded-2xl shadow-xl shadow-amber-500/20 transition active:scale-95 cursor-pointer inline-flex items-center gap-2">
              <i class="fa-solid fa-gift"></i>
              <span>جرّب مجاناً لمدة ${settings.trial_days} أيام بدون دفع</span>
            </button>
            <p class="text-xs text-slate-500 mt-2">لا حاجة لبطاقة ائتمان - صفحة كاملة تعمل فوراً</p>
          </div>
        ` : ''}
      </div>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 items-stretch mb-16">
        <div class="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 flex flex-col justify-between hover:border-slate-700 transition relative">
          <div>
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-bold text-slate-400">باقة التجربة والانطلاق</span>
              <span class="px-2 py-0.5 rounded-md bg-rose-500/10 border border-rose-500/20 text-rose-400 text-[10px] font-bold">خصم خاص</span>
            </div>
            <h3 class="text-xl font-bold text-white mb-4">${settings.plan1.name}</h3>
            <div class="space-y-1 mb-6">
              <div class="flex items-center gap-2">
                <span class="line-through text-slate-500 text-base font-semibold">${settings.plan1.old}</span>
                <span class="text-xs text-slate-400">قبل الخصم</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-4xl font-black text-white">${settings.plan1.new}</span>
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
          <a href="${getWhatsAppCheckoutLink(settings.whatsapp, settings.plan1.name, settings.plan1.old, settings.plan1.new)}" data-plan="1" target="_blank" rel="noopener" class="w-full py-3.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-sm flex items-center justify-center gap-2 transition active:scale-95 text-center">
            ${ctaContent(settings.online[1], 'text-emerald-400 text-base', `تفعيل العرض بـ ${settings.plan1.new}`)}
          </a>
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
            <h3 class="text-xl font-bold text-white mb-4">${settings.plan2.name}</h3>
            <div class="space-y-1 mb-6">
              <div class="flex items-center gap-2">
                <span class="line-through text-slate-500 text-base font-semibold">${settings.plan2.old}</span>
                <span class="text-xs text-slate-400">قبل الخصم</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-4xl font-black text-white">${settings.plan2.new}</span>
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
          <a href="${getWhatsAppCheckoutLink(settings.whatsapp, settings.plan2.name, settings.plan2.old, settings.plan2.new)}" data-plan="2" target="_blank" rel="noopener" class="w-full py-4 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black text-sm flex items-center justify-center gap-2 transition active:scale-95 shadow-lg shadow-emerald-500/25 text-center">
            ${ctaContent(settings.online[2], 'text-lg', settings.online[2] ? `تفعيل عرض الـ ${settings.plan2.new}` : `تفعيل عرض الـ ${settings.plan2.new} عبر واتساب`)}
          </a>
        </div>

        <div class="bg-slate-900/60 border border-slate-800 rounded-3xl p-6 sm:p-8 flex flex-col justify-between hover:border-slate-700 transition relative">
          <div>
            <div class="flex items-center justify-between mb-3">
              <span class="text-xs font-bold text-slate-400">أعلى توفير للشركات والمؤسسات</span>
              <span class="px-2 py-0.5 rounded-md bg-amber-500/10 border border-amber-500/20 text-amber-400 text-[10px] font-bold">باقة سنوية VIP</span>
            </div>
            <h3 class="text-xl font-bold text-white mb-4">${settings.plan3.name}</h3>
            <div class="space-y-1 mb-6">
              <div class="flex items-center gap-2">
                <span class="line-through text-slate-500 text-base font-semibold">${settings.plan3.old}</span>
                <span class="text-xs text-slate-400">قبل الخصم</span>
              </div>
              <div class="flex items-baseline gap-1.5">
                <span class="text-4xl font-black text-white">${settings.plan3.new}</span>
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
          <a href="${getWhatsAppCheckoutLink(settings.whatsapp, settings.plan3.name, settings.plan3.old, settings.plan3.new)}" data-plan="3" target="_blank" rel="noopener" class="w-full py-3.5 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-slate-100 font-bold text-sm flex items-center justify-center gap-2 transition active:scale-95 text-center">
            ${ctaContent(settings.online[3], 'text-emerald-400 text-base', `تفعيل العرض السنوي بـ ${settings.plan3.new}`)}
          </a>
        </div>
      </div>

      <div class="bg-slate-900/40 border border-slate-800/80 rounded-2xl p-6 text-center max-w-3xl mx-auto">
        <h4 class="text-xs font-bold text-slate-300 mb-3">وسائل الدفع والتحويل المدعومة:</h4>
        <div class="flex flex-wrap items-center justify-center gap-4 text-xs text-slate-400 font-medium">
          <span class="flex items-center gap-1.5"><i class="fa-solid fa-building-columns text-emerald-400"></i> تحويل بنكي مباشر (IBAN)</span>
          <span>•</span>
          <span class="flex items-center gap-1.5"><i class="fa-solid fa-credit-card text-emerald-400"></i> Knet (كي نت) / بطاقات الدفع</span>
          <span>•</span>
          <span class="flex items-center gap-1.5"><i class="fa-solid fa-link text-emerald-400"></i> روابط دفع فورية وسريعة</span>
        </div>
      </div>
    </div>
  `;

  container.querySelectorAll('a[data-plan]').forEach((link) => {
    const plan = Number(link.dataset.plan);
    if (!settings.online[plan]) return;
    link.addEventListener('click', (event) => {
      event.preventDefault();
      startCheckout(plan, link.href, link);
    });
  });

  const trialBtn = container.querySelector('#trialBtn');
  if (trialBtn) {
    trialBtn.addEventListener('click', () => {
      navigate('dashboard');
    });
  }
}