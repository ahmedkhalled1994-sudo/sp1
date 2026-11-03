import { HOURS_OPTIONS, ICON_OPTIONS } from '../lib/constants.js';

export const FORM_FIELD_NAMES = [
  'slug',
  'title',
  'icon',
  'description',
  'phone',
  'hours_mode',
  'hours_from',
  'hours_to',
  'conversion_label',
  'whatsapp',
  'instagram',
  'snapchat',
  'tiktok',
];

const INPUT_CLASS = 'w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-100 outline-none focus:border-emerald-500 transition disabled:opacity-60 disabled:cursor-not-allowed';

function field(name, label, control, hint = '') {
  return `
    <div class="space-y-1">
      <label for="f-${name}" class="text-xs text-slate-200 font-bold block">${label}</label>
      ${control}
      ${hint ? `<p class="text-[11px] text-slate-400">${hint}</p>` : ''}
      <p data-error-for="${name}" class="hidden text-[11px] text-rose-400 font-bold"></p>
    </div>
  `;
}

function iconInput(name, placeholder, iconClass) {
  return `
    <div class="flex items-center gap-2 bg-slate-950 border border-slate-800 rounded-xl px-3 focus-within:border-emerald-500 transition">
      <i class="${iconClass} text-sm text-slate-300"></i>
      <input id="f-${name}" name="${name}" type="text" dir="ltr" placeholder="${placeholder}" class="w-full bg-transparent text-xs text-slate-100 outline-none py-3" />
    </div>
  `;
}

export function formFieldsMarkup() {
  const iconOptions = ICON_OPTIONS.map((option) => `<option value="${option.value}">${option.value} ${option.label}</option>`).join('');
  const hoursOptions = HOURS_OPTIONS.map((option) => `<option value="${option.value}">${option.label}</option>`).join('');

  return `
    ${field('slug', 'اسم الرابط المخصص',
      `<div dir="ltr" class="flex items-center bg-slate-950 border border-slate-800 rounded-xl px-3 focus-within:border-emerald-500 transition disabled:opacity-60">
        <span class="text-[11px] text-slate-400 font-mono whitespace-nowrap">?p=</span>
        <input id="f-slug" name="slug" type="text" placeholder="math-teacher" class="w-full bg-transparent text-xs text-emerald-400 font-mono outline-none py-3 pl-1" />
      </div>`,
      'يظهر في رابط إعلانات جوجل. يُحدد عند إنشاء الصفحة ولا يمكن تغييره بعد ذلك.')}

    ${field('title', 'اسم النشاط أو المعلم',
      `<input id="f-title" name="title" type="text" placeholder="مثال: أستاذ أحمد - مدرس رياضيات" class="${INPUT_CLASS}" />`)}

    <div class="grid md:grid-cols-2 gap-3">
      ${field('icon', 'مجال النشاط',
        `<select id="f-icon" name="icon" class="${INPUT_CLASS}">${iconOptions}</select>`)}
      ${field('hours_mode', 'أوقات العمل',
        `<select id="f-hours_mode" name="hours_mode" class="${INPUT_CLASS}">${hoursOptions}</select>`)}
    </div>

    <div id="hours-custom" class="hidden grid grid-cols-2 gap-3">
      ${field('hours_from', 'من الساعة',
        `<input id="f-hours_from" name="hours_from" type="text" placeholder="4:00 عصراً" class="${INPUT_CLASS}" />`)}
      ${field('hours_to', 'إلى الساعة',
        `<input id="f-hours_to" name="hours_to" type="text" placeholder="10:00 مساءً" class="${INPUT_CLASS}" />`)}
    </div>

    ${field('description', 'وصف مختصر لنشاطك',
      `<textarea id="f-description" name="description" rows="3" class="${INPUT_CLASS} resize-none" placeholder="اكتب نبذة قصيرة عن خدماتك"></textarea>`)}

    ${field('phone', 'رقم الاتصال المباشر',
      `<input id="f-phone" name="phone" type="tel" dir="ltr" placeholder="+96599999999" class="${INPUT_CLASS}" />`,
      'يُكتب مع رمز الدولة، مثال: 96599999999')}

    ${field('conversion_label', 'كود تحويل Google Ads (اختياري)',
      `<input id="f-conversion_label" name="conversion_label" type="text" dir="ltr" placeholder="AW-123456789/AbC_DeF" class="${INPUT_CLASS} font-mono" />`,
      'يُرسل عند ضغط زر الاتصال ليُحتسب كتحويل في حسابك الإعلاني.')}

    <div class="space-y-3 pt-2 border-t border-slate-800">
      <p class="text-xs text-slate-200 font-bold">حسابات التواصل الاجتماعي (اختياري)</p>
      <div class="grid md:grid-cols-2 gap-3">
        ${field('whatsapp', 'واتساب', iconInput('whatsapp', '96599999999', 'fa-brands fa-whatsapp text-teal-400'))}
        ${field('instagram', 'انستجرام', iconInput('instagram', 'username', 'fa-brands fa-instagram text-pink-400'))}
        ${field('snapchat', 'سناب شات', iconInput('snapchat', 'username', 'fa-brands fa-snapchat text-yellow-300'))}
        ${field('tiktok', 'تيك توك', iconInput('tiktok', 'username', 'fa-brands fa-tiktok text-slate-100'))}
      </div>
    </div>
  `;
}

export function readDraft(form) {
  const draft = {};
  FORM_FIELD_NAMES.forEach((name) => {
    draft[name] = form.elements[name]?.value ?? '';
  });
  return draft;
}

export function fillForm(form, page) {
  FORM_FIELD_NAMES.forEach((name) => {
    if (page[name] != null) form.elements[name].value = page[name];
  });
  form.elements.slug.disabled = true;
  syncHoursBox(form);
}

export function syncHoursBox(form) {
  const box = form.querySelector('#hours-custom');
  box.classList.toggle('hidden', form.elements.hours_mode.value !== 'custom');
}

export function showFieldErrors(form, errors) {
  form.querySelectorAll('[data-error-for]').forEach((node) => {
    node.textContent = '';
    node.classList.add('hidden');
  });
  Object.entries(errors).forEach(([name, message]) => {
    const node = form.querySelector(`[data-error-for="${name}"]`);
    if (node) {
      node.textContent = message;
      node.classList.remove('hidden');
    }
  });
}

export function clearFieldError(form, name) {
  const node = form.querySelector(`[data-error-for="${name}"]`);
  if (node) node.classList.add('hidden');
}
