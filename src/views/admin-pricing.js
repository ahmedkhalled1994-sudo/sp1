import { supabase } from '../lib/supabase.js';
import { showToast } from '../lib/feedback.js';
import { escapeHtml } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { formatMinorUnits } from '../lib/payment-config.js';

const PLAN_NUMBERS = [1, 2, 3];
const PLAN_TITLES = {
  1: 'الباقة الشهرية',
  2: 'باقة الـ 3 أشهر',
  3: 'الباقة السنوية',
};

const CONNECTION_STATUS_LABELS = {
  disabled: 'غير مفعّل',
  awaiting_credentials: 'بانتظار بيانات الربط',
  test_mode: 'الوضع الاختباري',
  ready_after_test: 'جاهز للتفعيل بعد الاختبار',
  live_connected: 'متصل بالوضع المباشر',
};

const CONNECTION_STATUS_BADGES = {
  disabled: 'bg-slate-800 text-slate-300 border-slate-700',
  awaiting_credentials: 'bg-amber-500/10 text-amber-300 border-amber-500/30',
  test_mode: 'bg-sky-500/10 text-sky-300 border-sky-500/30',
  ready_after_test: 'bg-purple-500/10 text-purple-300 border-purple-500/30',
  live_connected: 'bg-emerald-500/10 text-emerald-300 border-emerald-500/30',
};

const MODE_LABELS = {
  disabled: 'غير مفعّل',
  test: 'اختباري',
  live: 'مباشر',
};

const WEBHOOK_STATUS_LABELS = {
  disabled: 'غير مفعّل (لا يتم استقبال إشعارات الدفع)',
  pending_secret: 'بانتظار بيانات الربط (يلزم ضبط LEMONSQUEEZY_WEBHOOK_SECRET في الخادم)',
  test_ready: 'مجهز للوضع الاختباري (HMAC-SHA256 مفعل لطلبات Test Mode فقط)',
  ready_after_test: 'جاهز للتفعيل بعد الاختبار',
  verified_live: 'متصل بالوضع المباشر (HMAC-SHA256 مفعل ومؤمن)',
};

const GENERAL_FIELDS = [
  { name: 'whatsapp_number', label: 'رقم الواتساب لاستقبال الاشتراكات', required: true, ltr: true },
  { name: 'headline', label: 'عنوان صفحة الأسعار', required: true },
  { name: 'subheadline', label: 'الوصف تحت العنوان', required: true, textarea: true },
  { name: 'trial_days', label: 'مدة التجربة المجانية (بالأيام)', required: true, type: 'number', min: 1, max: 30 },
];

const PLAN_FIELDS = [
  { suffix: 'name', label: 'اسم الباقة' },
  { suffix: 'duration', label: 'المدة' },
  { suffix: 'old_price', label: 'السعر القديم', required: true },
  { suffix: 'new_price', label: 'سعر العرض', required: true },
  { suffix: 'days', label: 'عدد الأيام التي تُضاف للصفحة بعد الدفع', required: true, type: 'number', min: 1, max: 366 },
  {
    suffix: 'test_variant_id',
    label: 'معرف المنتج للوضع الاختباري (Test Variant ID) - خاص ببيئة الاختبار فقط',
    ltr: true,
    placeholder: 'اتركه فارغاً لحين توفر معرف المنتج الاختباري',
  },
  {
    suffix: 'variant_id',
    label: 'معرف المنتج للوضع المباشر (Live Variant ID) - خاص بالمتجر المفعّل فقط',
    ltr: true,
    placeholder: 'اتركه فارغاً لحين تفعيل المتجر المباشر',
  },
];

const INPUT_CLASS =
  'w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none transition';

function resolveDisplayStatus(row, verifiedStatusResponse = null) {
  const mode = String(row.payment_mode || row.payment_provider_mode || 'disabled').trim().toLowerCase();
  const enabled = Boolean(row.payment_provider_enabled) && mode !== 'disabled';

  if (!enabled || mode === 'disabled') {
    return 'disabled';
  }

  // Never show a connected status ('live_connected' or 'test_mode') unless a real server check succeeded
  const checkStatus = verifiedStatusResponse?.status || row.last_config_check_status || '';
  const hasRealCheckTimestamp = Boolean(
    verifiedStatusResponse?.checked_at || row.last_config_check_at || row.last_verified_at,
  );

  if (!hasRealCheckTimestamp) {
    return 'awaiting_credentials';
  }

  if (mode === 'live') {
    return checkStatus === 'live_connected' && verifiedStatusResponse?.status === 'live_connected'
      ? 'live_connected'
      : 'awaiting_credentials';
  }

  if (mode === 'test') {
    if (checkStatus === 'ready_after_test') return 'ready_after_test';
    if (checkStatus === 'test_mode') return 'test_mode';
    return 'awaiting_credentials';
  }

  return 'awaiting_credentials';
}

function formatArabicTimestamp(isoString) {
  if (!isoString) return 'لم يتم التحقق بعد';
  const date = new Date(isoString);
  if (Number.isNaN(date.getTime())) return 'لم يتم التحقق بعد';
  try {
    return new Intl.DateTimeFormat('ar-KW', {
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(date);
  } catch {
    return date.toISOString();
  }
}

function fieldHtml({ name, label, required, type = 'text', textarea, min, max, ltr, placeholder }, value) {
  const attrs = `id="f-${name}" name="${name}" class="${INPUT_CLASS}${ltr ? ' font-mono' : ''}"${required ? ' required' : ''}${placeholder ? ` placeholder="${escapeHtml(placeholder)}"` : ''}${ltr ? ' dir="ltr"' : ''}`;
  const control = textarea
    ? `<textarea ${attrs} rows="3">${escapeHtml(value)}</textarea>`
    : `<input type="${type}" ${attrs}${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''} value="${escapeHtml(value)}" />`;
  return `
    <label class="block space-y-1.5">
      <span class="text-xs font-bold text-slate-400">${escapeHtml(label)}</span>
      ${control}
    </label>`;
}

function planCardHtml(number, row) {
  const fields = PLAN_FIELDS.map((field) =>
    fieldHtml({ ...field, name: `plan${number}_${field.suffix}` }, row[`plan${number}_${field.suffix}`] ?? ''),
  ).join('');

  return `
    <section class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
      <h2 class="text-sm font-black text-emerald-400">${number}. ${PLAN_TITLES[number]}</h2>
      ${fields}
    </section>`;
}

function paymentProviderSettingsHtml(row, verifiedStatus = null) {
  const rawMode = row.payment_mode || row.payment_provider_mode || 'disabled';
  const mode = ['disabled', 'test', 'live'].includes(rawMode) ? rawMode : 'disabled';
  const enabled = Boolean(row.payment_provider_enabled) && mode !== 'disabled';
  const statusKey = resolveDisplayStatus(row, verifiedStatus);
  const statusLabel = CONNECTION_STATUS_LABELS[statusKey] || CONNECTION_STATUS_LABELS.disabled;
  const statusBadgeClass = CONNECTION_STATUS_BADGES[statusKey] || CONNECTION_STATUS_BADGES.disabled;

  const webhookKey = enabled
    ? (verifiedStatus?.webhook_status || row.webhook_status || 'pending_secret')
    : 'disabled';
  const webhookLabel = WEBHOOK_STATUS_LABELS[webhookKey] || WEBHOOK_STATUS_LABELS.disabled;
  const lastCheckLabel = formatArabicTimestamp(
    verifiedStatus?.checked_at || row.last_config_check_at || row.last_verified_at,
  );
  const effectiveStoreId = row.store_id || row.lemon_store_id || row.lemon_test_store_id || '';
  const storeIdDisplay = effectiveStoreId ? escapeHtml(effectiveStoreId) : 'غير محدد بعد';

  const summaryRows = PLAN_NUMBERS.map((n) => {
    const testVar = row[`plan${n}_test_variant_id`] ? escapeHtml(row[`plan${n}_test_variant_id`]) : 'غير مضبوط';
    const liveVar = row[`plan${n}_variant_id`] ? escapeHtml(row[`plan${n}_variant_id`]) : 'غير مضبوط';
    const days = Number(row[`plan${n}_days`] || (n === 1 ? 30 : n === 2 ? 90 : 365));
    return `
      <tr class="border-t border-slate-800/80 text-xs">
        <td class="py-2.5 px-3 font-bold text-slate-200">${escapeHtml(PLAN_TITLES[n])}</td>
        <td class="py-2.5 px-3 font-mono text-sky-300" dir="ltr">${testVar}</td>
        <td class="py-2.5 px-3 font-mono text-emerald-300" dir="ltr">${liveVar}</td>
        <td class="py-2.5 px-3 text-slate-300">${days} يوم</td>
      </tr>`;
  }).join('');

  return `
    <section class="bg-slate-900/70 border border-slate-800 rounded-2xl p-6 space-y-6">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 border-b border-slate-800 pb-4">
        <div>
          <h2 class="text-base font-black text-emerald-400 flex items-center gap-2">
            <i class="fa-solid fa-credit-card"></i>
            <span>إعدادات بوابة الدفع الإلكتروني</span>
          </h2>
          <p class="text-xs text-slate-400 mt-1">
            إدارة وضع التشغيل ومعرفات الباقات الاختبارية والمباشرة دون كشف المفاتيح السرية في المتصفح.
          </p>
        </div>

        <div class="flex flex-wrap items-center gap-2">
          <span id="provider-status-badge" class="px-3 py-1.5 rounded-full border text-xs font-bold ${statusBadgeClass}">
            حالة الربط: ${escapeHtml(statusLabel)}
          </span>
          <button
            id="verify-provider-btn"
            type="button"
            class="py-2 px-3.5 rounded-xl bg-slate-800 hover:bg-slate-700 border border-slate-700 text-slate-200 font-bold text-xs transition cursor-pointer flex items-center gap-1.5"
          >
            <i class="fa-solid fa-shield-halved text-emerald-400"></i>
            <span>فحص جاهزية الربط الآن</span>
          </button>
        </div>
      </div>

      <div class="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4 text-xs">
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-1">
          <div class="text-slate-400 font-bold">مزود الدفع</div>
          <div class="text-slate-100 font-black text-sm">Lemon Squeezy</div>
        </div>

        <div class="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-1">
          <div class="text-slate-400 font-bold">وضع التشغيل الحالي</div>
          <div class="text-slate-100 font-black text-sm">${escapeHtml(MODE_LABELS[mode] || 'غير مفعّل')}</div>
        </div>

        <div class="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-1">
          <div class="text-slate-400 font-bold">معرف المتجر (Store ID)</div>
          <div class="text-slate-100 font-mono text-sm" dir="ltr">${storeIdDisplay}</div>
        </div>

        <div class="bg-slate-950 border border-slate-800 rounded-xl p-3.5 space-y-1">
          <div class="text-slate-400 font-bold">آخر عملية تحقق</div>
          <div id="last-check-display" class="text-slate-200 font-bold">${escapeHtml(lastCheckLabel)}</div>
        </div>
      </div>

      <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 space-y-2 text-xs">
        <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2">
          <div>
            <span class="text-slate-400 font-bold">حالة Webhook: </span>
            <span id="webhook-status-display" class="text-slate-200 font-bold">${escapeHtml(webhookLabel)}</span>
          </div>
          <div class="text-slate-400 font-mono text-[11px]" dir="ltr">
            Endpoint: /functions/v1/lemon-webhook
          </div>
        </div>
      </div>

      <div class="grid grid-cols-1 md:grid-cols-2 gap-4">
        <label class="block space-y-1.5">
          <span class="text-xs font-bold text-slate-400">وضع التشغيل (غير مفعّل / اختباري / مباشر)</span>
          <select id="f-payment_mode" name="payment_mode" class="${INPUT_CLASS}">
            <option value="disabled" ${mode === 'disabled' ? 'selected' : ''}>غير مفعّل (إيقاف الدفع الإلكتروني مؤقتاً)</option>
            <option value="test" ${mode === 'test' ? 'selected' : ''}>اختباري (Test Mode - منتجات ومفاتيح اختبارية فقط)</option>
            <option value="live" ${mode === 'live' ? 'selected' : ''}>مباشر (Live Mode - بعد تفعيل المتجر رسمياً)</option>
          </select>
        </label>

        <label class="block space-y-1.5">
          <span class="text-xs font-bold text-slate-400">معرف المتجر (Store ID) - أرقام فقط</span>
          <input
            type="text"
            id="f-store_id"
            name="store_id"
            dir="ltr"
            placeholder="مثال: 123456 (اتركه فارغاً لحين تفعيل الحساب)"
            value="${escapeHtml(row.store_id ?? '')}"
            class="${INPUT_CLASS} font-mono"
          />
        </label>
      </div>

      <div class="overflow-x-auto border border-slate-800 rounded-xl bg-slate-950">
        <table class="w-full text-right border-collapse">
          <thead>
            <tr class="bg-slate-900/90 text-[11px] text-slate-400">
              <th class="py-2.5 px-3 font-bold">الباقة</th>
              <th class="py-2.5 px-3 font-bold">معرف المنتج (الوضع الاختباري)</th>
              <th class="py-2.5 px-3 font-bold">معرف المنتج (الوضع المباشر)</th>
              <th class="py-2.5 px-3 font-bold">مدة الباقة</th>
            </tr>
          </thead>
          <tbody>
            ${summaryRows}
          </tbody>
        </table>
      </div>

      <details class="bg-slate-950 border border-slate-800 rounded-xl p-4">
        <summary class="text-xs font-bold text-emerald-400 cursor-pointer">
          تعليمات استكمال الربط وقائمة البيانات المطلوبة عند تفعيل متجر Lemon Squeezy
        </summary>
        <div class="mt-4 space-y-4 text-xs text-slate-300 leading-relaxed">
          <div>
            <h3 class="font-bold text-white mb-2">أولاً: القائمة المرجعية للبيانات المطلوبة من حساب Lemon Squeezy (8 عناصر):</h3>
            <ol class="list-decimal list-inside space-y-1.5 text-slate-300">
              <li><b>مفتاح الواجهة البرمجية الاختباري (Test API Key)</b> — يُحفظ في أسرار الخادم فقط (<code class="font-mono text-emerald-300">LEMONSQUEEZY_API_KEY</code>).</li>
              <li><b>معرف المتجر الاختباري (Test Store ID)</b> — يُضاف في أسرار الخادم (<code class="font-mono text-emerald-300">LEMONSQUEEZY_STORE_ID</code>) وفي حقل معرف المتجر أعلاه.</li>
              <li><b>معرفات المنتجات للوضع الاختباري (Test Product Variant IDs)</b> — للباقات الثلاث (الشهرية، 3 أشهر، السنوية).</li>
              <li><b>مفتاح توقيع Webhook الاختباري (Test Webhook Signing Secret)</b> — يُحفظ في أسرار الخادم فقط (<code class="font-mono text-emerald-300">LEMONSQUEEZY_WEBHOOK_SECRET</code>).</li>
              <li><b>مفتاح الواجهة البرمجية المباشر بعد تفعيل المتجر (Live API Key)</b> — يُستبدل في أسرار الخادم عند الانتقال للوضع المباشر.</li>
              <li><b>معرف المتجر المباشر (Live Store ID)</b> — معرف المتجر المعتمد في الوضع المباشر.</li>
              <li><b>معرفات المنتجات للوضع المباشر (Live Product Variant IDs)</b> — منفصلة تماماً عن المعرفات الاختبارية.</li>
              <li><b>مفتاح توقيع Webhook المباشر (Live Webhook Signing Secret)</b> — مفتاح التوقيع الخاص ببيئة الإنتاج المباشرة.</li>
            </ol>
          </div>

          <div class="border-t border-slate-800 pt-3">
            <h3 class="font-bold text-amber-300 mb-1.5">ثانياً: خطوات نسخ المنتجات من الوضع الاختباري إلى الوضع المباشر (Copy to Live Mode):</h3>
            <ul class="list-disc list-inside space-y-1 text-slate-300">
              <li>بعد موافقة Lemon Squeezy على تفعيل المتجر، افتح لوحة تحكم Lemon Squeezy وهي في <b>Test Mode</b>.</li>
              <li>انتقل إلى <b>Products</b> واضغط على قائمة الخيارات بجانب كل باقة ثم اختر <b>Copy to Live Mode</b>.</li>
              <li>أوقف خيار <b>Test Mode</b> من أسفل القائمة الجانبية للانتقال إلى الوضع المباشر (Live Mode).</li>
              <li>افتح كل باقة في الوضع المباشر وانسخ رقم <b>Variant ID</b> الجديد (معرفات الوضع المباشر تختلف دائماً عن الاختباري ولا يجوز تكرار نفس الرقم بين الوضعين).</li>
              <li>أدخل المعرفات الجديدة في حقول <b>معرف المنتج للوضع المباشر (Live Variant ID)</b> أدناه، واضبط متغيرات الخادم على <code class="font-mono text-emerald-300">LEMONSQUEEZY_ENABLED=true</code> و<code class="font-mono text-emerald-300">LEMONSQUEEZY_MODE=live</code>.</li>
            </ul>
          </div>
        </div>
      </details>
    </section>`;
}

function reconciliationSectionHtml(issues) {
  if (!Array.isArray(issues) || issues.length === 0) {
    return `
      <section class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-2">
        <h2 class="text-sm font-black text-emerald-400 flex items-center gap-2">
          <i class="fa-solid fa-clipboard-check"></i>
          <span>سجل التسويات والمرتجعات المالية</span>
        </h2>
        <p class="text-xs text-slate-400">لا توجد أي عمليات دفع معلقة أو مرتجعات تحتاج إلى مراجعة إدارية حالياً.</p>
      </section>`;
  }

  const rows = issues
    .map((item) => {
      const amountText = typeof item.amount === 'number' ? escapeHtml(formatMinorUnits(item.amount, item.currency || 'KWD')) : '-';
      return `
        <div class="bg-slate-950 border border-slate-800 rounded-xl p-4 flex flex-col md:flex-row md:items-center justify-between gap-3 text-xs">
          <div class="space-y-1">
            <div class="flex items-center gap-2">
              <span class="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-bold">${escapeHtml(item.failure_reason)}</span>
              <span class="font-mono text-slate-300">${escapeHtml(item.event_key)}</span>
              <span class="text-slate-500">(${escapeHtml(item.event_name)})</span>
            </div>
            <div class="text-slate-400">
              المبلغ: <b class="text-slate-200 font-mono">${amountText}</b>
              • الباقة/المعرف: <b class="text-slate-200 font-mono">${escapeHtml(item.variant_id || '-')}</b>
              • التاريخ: <b class="text-slate-200">${escapeHtml(formatArabicTimestamp(item.created_at))}</b>
            </div>
          </div>
          <button
            type="button"
            data-resolve-id="${escapeHtml(String(item.id))}"
            class="resolve-issue-btn py-2 px-3.5 rounded-xl bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 font-bold text-xs cursor-pointer whitespace-nowrap"
          >
            تأكيد المراجعة والتسوية
          </button>
        </div>`;
    })
    .join('');

  return `
    <section class="bg-slate-900/60 border border-rose-500/30 rounded-2xl p-6 space-y-4">
      <div>
        <h2 class="text-sm font-black text-rose-400 flex items-center gap-2">
          <i class="fa-solid fa-triangle-exclamation"></i>
          <span>عمليات دفع ومرتجعات بانتظار المراجعة الإدارية (${issues.length})</span>
        </h2>
        <p class="text-xs text-slate-400 mt-1">
          يتم تسجيل الطلبات المستردة (Refunded) أو الإشعارات التي تتطلب تدخلاً يدوياً هنا لضمان عدم ضياع أي عملية مالية.
        </p>
      </div>
      <div class="space-y-3">${rows}</div>
    </section>`;
}

function formHtml(row, reconciliationIssues = [], verifiedStatus = null) {
  const providerSettings = paymentProviderSettingsHtml(row, verifiedStatus);
  const general = GENERAL_FIELDS.map((field) => fieldHtml(field, row[field.name] ?? '')).join('');
  const plans = PLAN_NUMBERS.map((number) => planCardHtml(number, row)).join('');
  const reconciliationHtml = reconciliationSectionHtml(reconciliationIssues);

  return `
    <form id="pricing-form" class="space-y-6">
      ${providerSettings}

      <section class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h2 class="text-sm font-black text-emerald-400">الإعدادات العامة</h2>
        ${general}
      </section>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">${plans}</div>

      <div class="flex justify-end">
        <button id="save-btn" type="submit" class="py-3 px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black text-sm transition active:scale-95 cursor-pointer">
          حفظ ونشر الأسعار وإعدادات الدفع
        </button>
      </div>
    </form>

    <div class="mt-6">
      ${reconciliationHtml}
    </div>`;
}

function shellHtml(content) {
  return `
    <div class="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 max-w-6xl mx-auto animate-fade-in">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-black">إدارة الأسعار وبوابة الدفع (Lemon Squeezy)</h1>
          <p class="text-slate-400 text-sm mt-1">تعديل محتوى صفحة الأسعار، ضبط وضع الدفع (غير مفعّل / اختباري / مباشر)، وإدارة الباقات.</p>
        </div>
        <button id="back-admin-btn" type="button" class="py-2.5 px-4 rounded-xl bg-slate-900 hover:bg-slate-800 border border-slate-800 text-slate-300 font-bold text-xs transition active:scale-95 cursor-pointer">
          رجوع إلى لوحة الإدارة
        </button>
      </div>
      ${content}
    </div>`;
}

function noticeHtml(message, tone) {
  const toneClass = tone === 'error'
    ? 'bg-rose-500/10 border-rose-500/30 text-rose-300'
    : 'bg-slate-900/60 border-slate-800 text-slate-300';
  return `<div class="border rounded-2xl p-6 text-sm ${toneClass}">${escapeHtml(message)}</div>`;
}

function readValues(form) {
  const raw = Object.fromEntries(new FormData(form));
  const values = {};
  for (const [key, value] of Object.entries(raw)) {
    values[key] = String(value).trim();
  }
  values.trial_days = Number(values.trial_days);
  for (const number of PLAN_NUMBERS) {
    values[`plan${number}_days`] = Number(values[`plan${number}_days`]);
  }
  const paymentMode = ['disabled', 'test', 'live'].includes(values.payment_mode)
    ? values.payment_mode
    : 'disabled';
  values.payment_mode = paymentMode;
  values.payment_provider_mode = paymentMode;
  values.payment_provider_enabled = paymentMode !== 'disabled';
  if (paymentMode === 'test' && values.store_id) {
    values.lemon_test_store_id = values.store_id;
  } else if (paymentMode === 'live' && values.store_id) {
    values.lemon_store_id = values.store_id;
  }
  return values;
}

export function validateValues(values) {
  if (!Number.isInteger(values.trial_days) || values.trial_days < 1 || values.trial_days > 30) {
    return 'مدة التجربة يجب أن تكون عدداً صحيحاً بين 1 و 30';
  }

  if (values.store_id && !/^\d{1,20}$/.test(values.store_id)) {
    return 'معرف المتجر (Store ID) في Lemon Squeezy يجب أن يتكون من أرقام فقط';
  }

  const testVariants = [];
  const liveVariants = [];

  for (const number of PLAN_NUMBERS) {
    const days = values[`plan${number}_days`];
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      return `عدد أيام ${PLAN_TITLES[number]} يجب أن يكون بين 1 و 366`;
    }

    const liveVar = values[`plan${number}_variant_id`] || '';
    const testVar = values[`plan${number}_test_variant_id`] || '';

    if (liveVar && !/^\d{1,20}$/.test(liveVar)) {
      return `معرف المنتج المباشر (Live Variant ID) لـ ${PLAN_TITLES[number]} يجب أن يكون أرقاماً فقط`;
    }
    if (testVar && !/^\d{1,20}$/.test(testVar)) {
      return `معرف المنتج الاختباري (Test Variant ID) لـ ${PLAN_TITLES[number]} يجب أن يكون أرقاماً فقط`;
    }

    if ((liveVar || testVar) && !/[0-9٠-٩]/.test(values[`plan${number}_new_price`])) {
      return `سعر العرض لـ ${PLAN_TITLES[number]} يجب أن يحتوي على رقم، لأنه المبلغ الذي سيُدفع أونلاين`;
    }

    if (liveVar) liveVariants.push(liveVar);
    if (testVar) testVariants.push(testVar);
  }

  // Prevent duplicate variant IDs within the same mode
  if (new Set(liveVariants).size !== liveVariants.length) {
    return 'لا يمكن تكرار نفس معرف المنتج المباشر (Live Variant ID) لأكثر من باقة واحدة';
  }
  if (new Set(testVariants).size !== testVariants.length) {
    return 'لا يمكن تكرار نفس معرف المنتج الاختباري (Test Variant ID) لأكثر من باقة واحدة';
  }

  // Strictly forbid reusing Test Mode variant IDs in Live Mode
  const liveSet = new Set(liveVariants);
  for (const tv of testVariants) {
    if (liveSet.has(tv)) {
      return 'لا يجوز استخدام نفس معرف المنتج (Variant ID) في الوضع الاختباري والوضع المباشر معاً؛ لكل وضع معرفات مستقلة في Lemon Squeezy';
    }
  }

  return null;
}

function bindEvents(container, form, initialRow, reconciliationIssues) {
  const verifyBtn = container.querySelector('#verify-provider-btn');
  if (verifyBtn) {
    verifyBtn.addEventListener('click', async () => {
      verifyBtn.disabled = true;
      const originalHtml = verifyBtn.innerHTML;
      verifyBtn.innerHTML = '<i class="fa-solid fa-circle-notch fa-spin"></i><span>جارٍ التحقق من الخادم...</span>';

      try {
        const { data, error } = await supabase.functions.invoke('lemon-checkout', {
          body: { action: 'status' },
        });

        verifyBtn.disabled = false;
        verifyBtn.innerHTML = originalHtml;

        if (error || !data || data.error) {
          showToast('تعذر التحقق من إعدادات الخادم حالياً؛ تأكد من نشر دالة lemon-checkout وضبط الأسرار', 'error');
          return;
        }

        const label = CONNECTION_STATUS_LABELS[data.status] || CONNECTION_STATUS_LABELS.awaiting_credentials;
        showToast(`نتيجة فحص الربط: ${label}`, data.status === 'live_connected' || data.status === 'test_mode' ? 'success' : 'info');

        // Re-render with verified status from server
        await renderAdminPricing(container, data);
      } catch {
        verifyBtn.disabled = false;
        verifyBtn.innerHTML = originalHtml;
        showToast('تعذر الاتصال بخدمة التحقق من الدفع', 'error');
      }
    });
  }

  container.querySelectorAll('.resolve-issue-btn').forEach((btn) => {
    btn.addEventListener('click', async () => {
      const issueId = Number(btn.dataset.resolveId);
      if (!Number.isInteger(issueId)) return;

      btn.disabled = true;
      btn.textContent = 'جارٍ التأكيد...';

      const { error } = await supabase.rpc('admin_resolve_payment_reconciliation_issue', {
        p_issue_id: issueId,
        p_resolution_notes: 'تمت المراجعة والتسوية من لوحة إدارة الأسعار والمدفوعات',
      });

      if (error) {
        btn.disabled = false;
        btn.textContent = 'تأكيد المراجعة والتسوية';
        showToast('تعذر تحديث حالة التسوية، حاول مرة أخرى', 'error');
        return;
      }

      showToast('تمت تسوية السجل وتوثيقه في سجل الرقابة الإدارية', 'success');
      await renderAdminPricing(container);
    });
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    const values = readValues(form);
    const validationError = validateValues(values);
    if (validationError) {
      showToast(validationError, 'error');
      return;
    }

    const saveBtn = container.querySelector('#save-btn');
    saveBtn.disabled = true;
    saveBtn.textContent = 'جارٍ الحفظ...';

    const fullPayload = {
      id: 'global',
      ...values,
      updated_at: new Date().toISOString(),
    };

    let { error } = await supabase.from('pricing_settings').upsert(fullPayload);

    // Graceful fallback if the extended payment columns migration has not yet been applied to the remote DB
    if (error && (error.code === '42703' || String(error.message || '').includes('column'))) {
      const legacyPayload = { ...fullPayload };
      delete legacyPayload.payment_mode;
      delete legacyPayload.payment_provider_enabled;
      delete legacyPayload.store_id;
      delete legacyPayload.plan1_test_variant_id;
      delete legacyPayload.plan2_test_variant_id;
      delete legacyPayload.plan3_test_variant_id;
      const retry = await supabase.from('pricing_settings').upsert(legacyPayload);
      error = retry.error;
      if (!error) {
        showToast('تم حفظ الأسعار الأساسية (ملاحظة: طبّق ترحيل قاعدة البيانات الجديد لتفعيل حقول الوضع الاختباري الإضافية)', 'success');
        saveBtn.disabled = false;
        saveBtn.textContent = 'حفظ ونشر الأسعار وإعدادات الدفع';
        return;
      }
    }

    saveBtn.disabled = false;
    saveBtn.textContent = 'حفظ ونشر الأسعار وإعدادات الدفع';

    if (error) {
      console.error(error);
      showToast('فشل حفظ الأسعار وإعدادات الدفع، حاول مرة أخرى', 'error');
      return;
    }

    showToast('تم حفظ الأسعار وإعدادات الدفع الجديدة بنجاح', 'success');
    await renderAdminPricing(container);
  });
}

export async function renderAdminPricing(container, verifiedStatus = null) {
  const { isAdmin } = getSession();

  if (!isAdmin) {
    container.innerHTML = shellHtml(noticeHtml('هذه الصفحة متاحة لمدير المنصة فقط.', 'error'));
    container.querySelector('#back-admin-btn').addEventListener('click', () => navigate('home'));
    return;
  }

  container.innerHTML = shellHtml('<div class="text-slate-400 text-sm">جاري تحميل إعدادات الأسعار وبوابة الدفع...</div>');

  const [pricingRes, reconciliationRes] = await Promise.all([
    supabase
      .from('pricing_settings')
      .select('*')
      .eq('id', 'global')
      .maybeSingle(),
    supabase
      .from('payment_reconciliation_issues')
      .select('*')
      .eq('resolved', false)
      .order('created_at', { ascending: false })
      .limit(20),
  ]);

  if (pricingRes.error) {
    console.error(pricingRes.error);
    container.innerHTML = shellHtml(noticeHtml('تعذر تحميل إعدادات الأسعار، أعد تحميل الصفحة بعد قليل.', 'error'));
    container.querySelector('#back-admin-btn').addEventListener('click', () => navigate('admin'));
    return;
  }

  const row = pricingRes.data ?? {};
  const unresolvedIssues = Array.isArray(reconciliationRes.data) ? reconciliationRes.data : [];

  container.innerHTML = shellHtml(formHtml(row, unresolvedIssues, verifiedStatus));
  container.querySelector('#back-admin-btn').addEventListener('click', () => navigate('admin'));
  bindEvents(container, container.querySelector('#pricing-form'), row, unresolvedIssues);
}
