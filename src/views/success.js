import { supabase } from '../lib/supabase.js';
import { getSession } from '../lib/session.js';
import { publicPageUrl } from '../lib/pages-api.js';
import { navigate } from '../lib/router.js';
import { showToast } from '../lib/feedback.js';

function isPaidQueryFlagPresent() {
  const hash = window.location.hash || '';
  const queryIndex = hash.indexOf('?');
  if (queryIndex !== -1) {
    const params = new URLSearchParams(hash.slice(queryIndex + 1));
    if (params.get('paid') === '1') return true;
  }
  const searchParams = new URLSearchParams(window.location.search || '');
  return searchParams.get('paid') === '1';
}

export async function renderSuccess(container) {
  const { user, profile } = getSession();
  const hasPaidQueryFlag = isPaidQueryFlagPresent();

  if (profile?.role === 'admin') {
    container.innerHTML = `<div class="p-8 text-center">حساب المدير لا يملك صفحات هبوط، جاري تحويلك للوحة التحكم...</div>`;
    setTimeout(() => navigate('admin'), 1500);
    return;
  }

  container.innerHTML = `<div class="min-h-screen flex items-center justify-center"><div class="text-slate-400">جاري تحميل بيانات صفحتك...</div></div>`;

  // Fetch the user's latest page
  const { data: pages, error } = await supabase
    .from('pages')
    .select('*')
    .eq('user_id', user.id)
    .order('created_at', { ascending: false })
    .limit(1);

  if (error || !pages || pages.length === 0) {
    container.innerHTML = `
      <div class="min-h-screen flex flex-col items-center justify-center p-4 text-center">
        <p class="text-slate-400 mb-4">لم يتم العثور على صفحات خاصة بك بعد.</p>
        <button id="go-create" class="bg-emerald-500 text-slate-950 font-bold py-2 px-6 rounded-xl">إنشاء صفحة جديدة</button>
      </div>
    `;
    container.querySelector('#go-create').addEventListener('click', () => navigate('create'));
    return;
  }

  const page = pages[0];
  const fullUrl = publicPageUrl(page.slug);
  const expiresDate = new Date(page.expires_at).toLocaleDateString('ar-EG', {
    year: 'numeric',
    month: 'long',
    day: 'numeric',
  });

  // Never trust ?paid=1 alone: verify that a recent confirmed ('paid') payment record
  // exists in public.payments for this authenticated user AND this specific page.
  let verifiedPayment = null;
  if (hasPaidQueryFlag) {
    const recentCutoffIso = new Date(Date.now() - 24 * 60 * 60 * 1000).toISOString();
    const { data: recentPayments, error: paymentErr } = await supabase
      .from('payments')
      .select('id, days_added, plan_number, payment_status, created_at')
      .eq('user_id', user.id)
      .eq('page_id', page.id)
      .eq('payment_status', 'paid')
      .gte('created_at', recentCutoffIso)
      .order('created_at', { ascending: false })
      .limit(1);

    if (!paymentErr && Array.isArray(recentPayments) && recentPayments.length > 0) {
      verifiedPayment = recentPayments[0];
    }
  }

  const verifiedPaid = Boolean(verifiedPayment);
  const pendingWebhookConfirmation = hasPaidQueryFlag && !verifiedPaid;

  let paymentStatusBannerHtml = '';
  if (verifiedPaid) {
    paymentStatusBannerHtml = `
      <div id="payment-verified-banner" class="bg-emerald-500/15 border border-emerald-500/40 text-emerald-300 text-xs font-bold rounded-xl p-3">
        تم استلام دفعتك وتأكيدها من الخادم بنجاح — تم تمديد صلاحية صفحتك حتى ${expiresDate}
      </div>
    `;
  } else if (pendingWebhookConfirmation) {
    paymentStatusBannerHtml = `
      <div id="payment-pending-banner" class="bg-amber-500/15 border border-amber-500/40 text-amber-200 text-xs rounded-xl p-4 space-y-2.5 text-right">
        <div class="font-bold flex items-center gap-2 text-amber-300">
          <i class="fa-solid fa-clock-rotate-left"></i>
          <span>حالة الدفع: بانتظار تأكيد عملية الدفع من مزود الخدمة</span>
        </div>
        <p class="text-slate-300 leading-relaxed">
          تمت العودة من بوابة الدفع، ولكن لم يُسجّل إشعار التأكيد النهائي (Webhook) في قاعدة البيانات بعد. لا يتم تمديد الاشتراك إلا بعد التحقق الآمن من الخادم.
        </p>
        <div class="flex justify-end">
          <button
            id="refresh-payment-status-btn"
            type="button"
            class="py-1.5 px-3 rounded-lg bg-amber-500/20 hover:bg-amber-500/30 border border-amber-500/40 text-amber-200 font-bold text-xs transition cursor-pointer"
          >
            تحديث حالة الدفع الآن
          </button>
        </div>
      </div>
    `;
  }

  container.innerHTML = `
    <div class="min-h-screen flex items-center justify-center p-4 bg-gradient-to-b from-slate-950 via-slate-900 to-slate-950">
      <div class="w-full max-w-lg bg-slate-900/80 border border-slate-800 rounded-2xl p-6 md:p-8 shadow-2xl backdrop-blur-xl text-center space-y-6 animate-fade-in">
        <div class="w-20 h-20 rounded-2xl bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center mx-auto text-emerald-400 text-4xl">
          <i class="fa-solid ${pendingWebhookConfirmation ? 'fa-hourglass-half text-amber-400' : 'fa-circle-check'}"></i>
        </div>

        <div>
          <h1 class="text-2xl font-black text-white">
            ${
              verifiedPaid
                ? 'تم تفعيل اشتراكك بنجاح!'
                : pendingWebhookConfirmation
                  ? 'جاري التحقق من تأكيد الدفع...'
                  : 'تهانينا! صفحتك جاهزة ومباشرة'
            }
          </h1>
          <p class="text-slate-400 text-sm mt-1">يمكنك مشاركة الرابط التالي مع عملائك فوراً</p>
        </div>

        ${paymentStatusBannerHtml}

        <!-- الرابط -->
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 text-left font-mono text-sm text-emerald-400 break-all select-all flex items-center justify-between gap-2" dir="ltr">
          <span id="page-url-text">${fullUrl}</span>
        </div>

        <!-- أزرار التحكم بالرابط -->
        <div class="grid grid-cols-2 gap-3">
          <button id="copy-url-btn" class="py-3 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-bold text-sm transition flex items-center justify-center gap-2 cursor-pointer">
            <i class="fa-regular fa-copy"></i> نسخ الرابط
          </button>
          <a href="${fullUrl}" target="_blank" class="py-3 px-4 rounded-xl bg-slate-800 hover:bg-slate-700 text-white font-bold text-sm transition flex items-center justify-center gap-2">
            <i class="fa-solid fa-arrow-up-right-from-square"></i> معاينة الصفحة
          </a>
        </div>

        <!-- معلومات الصلاحية -->
        <div class="bg-amber-500/10 border border-amber-500/20 rounded-xl p-4 text-right space-y-2">
          <div class="flex items-center justify-between text-xs">
            <span class="text-amber-300 font-bold">حالة الصفحة:</span>
            <span class="px-2 py-0.5 rounded bg-emerald-500/20 text-emerald-300 font-bold">نشطة</span>
          </div>
          <div class="flex items-center justify-between text-xs">
            <span class="text-amber-300 font-bold">تاريخ انتهاء الصلاحية:</span>
            <span class="text-slate-300">${expiresDate}</span>
          </div>
          <p class="text-xs text-slate-400 pt-1 border-t border-amber-500/10">
            لضمان استمرار الصفحة بعد انتهاء الفترة التجريبية، يمكنك الترقية لأي باقة من صفحة الأسعار.
          </p>
        </div>

        <div class="pt-4 border-t border-slate-800 flex items-center justify-between">
          <button id="go-pricing" class="text-xs text-emerald-400 hover:underline font-bold cursor-pointer">عرض باقات الاشتراك</button>
          <button id="go-create-again" class="text-xs text-slate-400 hover:text-white cursor-pointer">تعديل البيانات</button>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#copy-url-btn').addEventListener('click', () => {
    navigator.clipboard.writeText(fullUrl);
    showToast('تم نسخ الرابط بنجاح!', 'success');
  });

  const refreshBtn = container.querySelector('#refresh-payment-status-btn');
  if (refreshBtn) {
    refreshBtn.addEventListener('click', () => {
      renderSuccess(container);
    });
  }

  container.querySelector('#go-pricing').addEventListener('click', () => navigate('pricing'));
  container.querySelector('#go-create-again').addEventListener('click', () => navigate('create'));
}