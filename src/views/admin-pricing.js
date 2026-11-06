import { supabase } from '../lib/supabase.js';
import { showToast } from '../lib/feedback.js';
import { escapeHtml } from '../lib/dom.js';
import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';

const PLAN_NUMBERS = [1, 2, 3];
const PLAN_TITLES = {
  1: 'الباقة الشهرية',
  2: 'باقة الـ 3 أشهر',
  3: 'الباقة السنوية',
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
  { suffix: 'variant_id', label: 'رقم الباقة في Lemon Squeezy (Variant ID) - اتركه فارغاً للدفع عبر واتساب', ltr: true },
];

const INPUT_CLASS =
  'w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-slate-100 text-sm focus:border-emerald-500 outline-none transition';

function fieldHtml({ name, label, required, type = 'text', textarea, min, max, ltr }, value) {
  const attrs = `id="f-${name}" name="${name}" class="${INPUT_CLASS}${ltr ? ' font-mono' : ''}"${required ? ' required' : ''}`;
  const control = textarea
    ? `<textarea ${attrs} rows="3">${escapeHtml(value)}</textarea>`
    : `<input type="${type}" ${attrs}${min !== undefined ? ` min="${min}"` : ''}${max !== undefined ? ` max="${max}"` : ''} value="${escapeHtml(value)}" />`;
  return `
    <label class="block space-y-1.5">
      <span class="text-xs font-bold text-slate-400">${label}</span>
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

function formHtml(row) {
  const general = GENERAL_FIELDS.map((field) => fieldHtml(field, row[field.name] ?? '')).join('');
  const plans = PLAN_NUMBERS.map((number) => planCardHtml(number, row)).join('');

  return `
    <form id="pricing-form" class="space-y-6">
      <section class="bg-slate-900/60 border border-slate-800 rounded-2xl p-6 space-y-4">
        <h2 class="text-sm font-black text-emerald-400">الإعدادات العامة</h2>
        ${general}
      </section>

      <div class="grid grid-cols-1 md:grid-cols-3 gap-6">${plans}</div>

      <div class="flex justify-end">
        <button id="save-btn" type="submit" class="py-3 px-6 rounded-xl bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black text-sm transition active:scale-95 cursor-pointer">
          حفظ ونشر الأسعار
        </button>
      </div>
    </form>`;
}

function shellHtml(content) {
  return `
    <div class="min-h-screen bg-slate-950 text-slate-100 p-4 md:p-8 max-w-6xl mx-auto animate-fade-in">
      <div class="flex flex-col md:flex-row md:items-center justify-between gap-4 mb-8">
        <div>
          <h1 class="text-3xl font-black">إدارة الأسعار والباقات</h1>
          <p class="text-slate-400 text-sm mt-1">تعديل محتوى صفحة الأسعار ورقم الواتساب وأسعار الباقات.</p>
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
  return values;
}

function validateValues(values) {
  if (!Number.isInteger(values.trial_days) || values.trial_days < 1 || values.trial_days > 30) {
    return 'مدة التجربة يجب أن تكون عدداً صحيحاً بين 1 و 30';
  }
  for (const number of PLAN_NUMBERS) {
    const days = values[`plan${number}_days`];
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      return `عدد أيام ${PLAN_TITLES[number]} يجب أن يكون بين 1 و 366`;
    }
    if (values[`plan${number}_variant_id`] && !/^\d{1,12}$/.test(values[`plan${number}_variant_id`])) {
      return `رقم الباقة في Lemon Squeezy لـ ${PLAN_TITLES[number]} يجب أن يكون أرقاماً فقط`;
    }
  }
  return null;
}

function bindForm(container, form) {
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

    const { error } = await supabase.from('pricing_settings').upsert({
      id: 'global',
      ...values,
      updated_at: new Date().toISOString(),
    });

    saveBtn.disabled = false;
    saveBtn.textContent = 'حفظ ونشر الأسعار';

    if (error) {
      console.error(error);
      showToast('فشل حفظ الأسعار، حاول مرة أخرى', 'error');
      return;
    }

    showToast('تم حفظ الأسعار الجديدة ونشرها بنجاح', 'success');
  });
}

export async function renderAdminPricing(container) {
  const { isAdmin } = getSession();

  if (!isAdmin) {
    container.innerHTML = shellHtml(noticeHtml('هذه الصفحة متاحة لمدير المنصة فقط.', 'error'));
    container.querySelector('#back-admin-btn').addEventListener('click', () => navigate('home'));
    return;
  }

  container.innerHTML = shellHtml('<div class="text-slate-400 text-sm">جاري تحميل الأسعار...</div>');

  const { data, error } = await supabase
    .from('pricing_settings')
    .select('*')
    .eq('id', 'global')
    .maybeSingle();

  if (error) {
    console.error(error);
    container.innerHTML = shellHtml(noticeHtml('تعذر تحميل إعدادات الأسعار، أعد تحميل الصفحة بعد قليل.', 'error'));
    container.querySelector('#back-admin-btn').addEventListener('click', () => navigate('admin'));
    return;
  }

  container.innerHTML = shellHtml(formHtml(data ?? {}));
  container.querySelector('#back-admin-btn').addEventListener('click', () => navigate('admin'));
  bindForm(container, container.querySelector('#pricing-form'));
}
