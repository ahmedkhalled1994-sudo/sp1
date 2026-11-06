import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { landingPageMarkup } from '../components/landing-markup.js';
import { getTheme } from '../lib/themes.js';
import { createPage, fetchMyPage, publicPageUrl, updatePage } from '../lib/pages-api.js';
import { validatePageInput } from '../lib/page-validation.js';
import { friendlyError } from '../lib/messages.js';
import { copyText, showToast } from '../lib/feedback.js';
import { el } from '../lib/dom.js';
import {
  buildWorkingHours,
  clearFieldError,
  fillForm,
  formFieldsMarkup,
  readDraft,
  showFieldErrors,
  syncHoursBox,
} from './dashboard-form.js';
import { renderTrafficReport } from './dashboard-traffic.js';

function statRow(label, value) {
  const row = el(
    'div',
    'bg-slate-950/60 border border-slate-800/80 p-4 rounded-2xl flex items-center justify-between',
  );
  row.append(
    el('span', 'text-xs text-slate-300 font-bold', label),
    el('span', 'text-2xl font-black text-emerald-400', String(value)),
  );
  return row;
}

function renderStats(statsEl, page) {
  const title = el('h2', 'font-black text-sm text-white', 'إجمالي الإحصائيات');

  if (!page) {
    statsEl.replaceChildren(
      title,
      el('p', 'text-xs text-slate-300', 'ستظهر الإحصائيات بعد حفظ صفحتك وتفعيلها.'),
    );
    return;
  }

  statsEl.replaceChildren(
    title,
    statRow('زيارات الصفحة', page.views_count ?? 0),
    statRow('ضغطات زر الاتصال', page.calls_count ?? 0),
    statRow('ضغطات الواتساب', page.whatsapp_clicks ?? 0),
  );
}

function setStatus(statusEl, page) {
  if (!page) {
    statusEl.textContent = 'لم تُحفظ بعد';
    statusEl.className =
      'text-[11px] px-3 py-1 rounded-full font-bold border border-slate-700 text-slate-300 whitespace-nowrap';
    return;
  }

  const expired = page.expires_at && new Date(page.expires_at) < new Date();

  if (expired) {
    statusEl.textContent = 'منتهية';
    statusEl.className =
      'text-[11px] px-3 py-1 rounded-full font-bold border border-amber-500/40 text-amber-300 bg-amber-500/10 whitespace-nowrap';
    return;
  }

  if (page.is_active === false) {
    statusEl.textContent = 'متوقفة من الإدارة';
    statusEl.className =
      'text-[11px] px-3 py-1 rounded-full font-bold border border-rose-500/40 text-rose-400 bg-rose-500/10 whitespace-nowrap';
    return;
  }

  statusEl.textContent = 'مفعلة';
  statusEl.className =
    'text-[11px] px-3 py-1 rounded-full font-bold border border-emerald-500/40 text-emerald-400 bg-emerald-500/10 whitespace-nowrap';
}

function renderLinkBox(linkEl, page) {
  if (!page?.slug) {
    linkEl.hidden = true;
    return;
  }

  const url = publicPageUrl(page.slug);

  const header = el('div', 'flex items-center justify-between gap-2');
  header.append(
    el('h2', 'font-black text-sm text-white', 'رابط صفحتك'),
    el('span', 'text-[11px] text-slate-400', 'استخدمه في إعلانات جوجل'),
  );

  const input = el(
    'input',
    'w-full bg-slate-950 border border-slate-800 rounded-xl p-2.5 text-xs text-emerald-400 font-mono outline-none',
  );
  input.type = 'text';
  input.readOnly = true;
  input.dir = 'ltr';
  input.value = url;
  input.setAttribute('aria-label', 'رابط صفحتك');
  input.addEventListener('focus', () => input.select());

  const copyBtn = el(
    'button',
    'flex-1 bg-slate-900 border border-slate-700 hover:bg-slate-800 text-white font-bold py-2.5 rounded-xl text-xs transition cursor-pointer',
    'نسخ الرابط',
  );
  copyBtn.type = 'button';
  copyBtn.addEventListener('click', async () => {
    const copied = await copyText(url);
    showToast(copied ? 'تم نسخ الرابط' : 'تعذر النسخ، انسخ الرابط يدوياً', copied ? 'success' : 'error');
  });

  const openLink = el(
    'a',
    'flex-1 text-center bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black py-2.5 rounded-xl text-xs transition shadow-lg',
    'معاينة الصفحة الحية',
  );
  openLink.href = publicPageUrl(page.slug, { returnTo: 'dashboard' });

  const actions = el('div', 'flex gap-2');
  actions.append(copyBtn, openLink);

  linkEl.hidden = false;
  linkEl.replaceChildren(header, input, actions);
}

function noticeBlock(text, tone) {
  const box = el(
    'div',
    `rounded-2xl border p-3 text-xs font-bold ${
      tone === 'error'
        ? 'border-rose-500/40 text-rose-300 bg-rose-500/10'
        : 'border-amber-500/40 text-amber-300 bg-amber-500/10'
    }`,
  );

  box.append(el('span', '', text));
  return box;
}

export async function renderDashboard(container) {
  const { user } = getSession();

  container.innerHTML = `
    <div class="max-w-6xl mx-auto p-4 md:p-8 grid lg:grid-cols-12 gap-8 items-start animate-fade-in">
      <section class="lg:col-span-7 glass-card rounded-3xl p-4 sm:p-6 space-y-5 shadow-2xl">
        <header class="flex items-start justify-between gap-3 border-b border-slate-800 pb-4">
          <div>
            <h1 class="font-black text-lg text-white">تصميم صفحتك</h1>
            <p class="text-xs text-slate-300 mt-0.5">عدّل بيانات نشاطك وشاهد النتيجة مباشرة</p>
          </div>
          <span id="page-status"></span>
        </header>

        <div id="notice" class="space-y-3"></div>

        <form id="page-form" class="space-y-4" novalidate>
          ${formFieldsMarkup()}

          <button
            id="save-btn"
            type="submit"
            class="w-full bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black py-4 rounded-2xl text-sm shadow-xl shadow-emerald-500/20 transition active:scale-95 cursor-pointer"
          >
            حفظ الصفحة والمتابعة
          </button>
        </form>
      </section>

      <aside class="lg:col-span-5 space-y-6 lg:sticky lg:top-24">
        <div id="page-link" class="glass-card rounded-3xl p-5 space-y-3" hidden></div>

        <div class="flex flex-col items-center gap-3">
          <p class="text-[11px] text-slate-400 font-bold">
            <i class="fa-solid fa-mobile-screen-button ml-1 text-emerald-400"></i>
            معاينة مباشرة كما تظهر على الجوال
          </p>
          <div class="relative w-full max-w-[390px] rounded-[52px] bg-slate-900 p-3 shadow-2xl shadow-black/60 ring-1 ring-slate-700">
            <span class="absolute -left-[3px] top-28 h-12 w-[3px] rounded-l bg-slate-700" aria-hidden="true"></span>
            <span class="absolute -left-[3px] top-44 h-12 w-[3px] rounded-l bg-slate-700" aria-hidden="true"></span>
            <span class="absolute -right-[3px] top-36 h-16 w-[3px] rounded-r bg-slate-700" aria-hidden="true"></span>

            <div id="phone-screen" class="relative overflow-hidden rounded-[40px] bg-slate-950 transition-colors duration-300">
              <div class="relative z-10 flex items-center justify-between px-7 pt-3 pb-1 text-[11px] font-bold text-slate-100" dir="ltr">
                <span id="phone-clock"></span>
                <span class="absolute left-1/2 top-2 h-6 w-24 -translate-x-1/2 rounded-full bg-black" aria-hidden="true"></span>
                <span class="flex items-center gap-1.5 text-[10px]">
                  <i class="fa-solid fa-signal"></i>
                  <i class="fa-solid fa-wifi"></i>
                  <i class="fa-solid fa-battery-three-quarters"></i>
                </span>
              </div>

              <div id="preview" class="h-[680px] overflow-y-auto overscroll-contain [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"></div>

              <div class="pointer-events-none absolute bottom-2 left-1/2 h-1 w-28 -translate-x-1/2 rounded-full bg-slate-100/60" aria-hidden="true"></div>
            </div>
          </div>
        </div>

        <div id="stats" class="glass-card rounded-3xl p-6 space-y-4"></div>

        <div id="traffic" class="glass-card rounded-3xl p-6 space-y-4"></div>
      </aside>
    </div>
  `;

  const form = container.querySelector('#page-form');
  const saveButton = container.querySelector('#save-btn');
  const notice = container.querySelector('#notice');
  const statusEl = container.querySelector('#page-status');
  const previewEl = container.querySelector('#preview');
  const phoneScreen = container.querySelector('#phone-screen');
  container.querySelector('#phone-clock').textContent = new Date().toLocaleTimeString('en-GB', {
    hour: '2-digit',
    minute: '2-digit',
  });
  const statsEl = container.querySelector('#stats');
  const linkEl = container.querySelector('#page-link');

  let currentPage = null;
  let canSave = true;

  function updatePreview() {
    const draft = readDraft(form);
    const theme = draft.theme || 'emerald';

    phoneScreen.className = `relative overflow-hidden rounded-[40px] transition-colors duration-300 ${getTheme(theme).bg}`;
    previewEl.innerHTML = `<div class="pointer-events-none select-none min-h-full flex flex-col">${landingPageMarkup(
      {
        ...draft,
        theme,
        icon: draft.icon || '🎓',
        title: draft.title.trim() || 'اسم النشاط',
        working_hours: buildWorkingHours(draft),
      },
      { preview: true },
    )}</div>`;
  }

  if (!user) {
    const loginLink = el('button', 'underline text-amber-200 font-black cursor-pointer', 'سجّل الدخول');
    loginLink.addEventListener('click', () => navigate('login'));

    const box = noticeBlock('يمكنك تجربة التصميم الآن. لحفظ صفحتك يجب ', 'warning');
    box.append(loginLink, el('span', '', ' أولًا.'));
    notice.append(box);
  } else {
    const result = await fetchMyPage(user.id);

    if (result.error) {
      canSave = false;
      notice.append(noticeBlock('تعذر تحميل صفحتك الحالية، أعد تحميل الصفحة بعد قليل.', 'error'));
    } else {
      currentPage = result.data;
    }
  }

  if (currentPage) {
    fillForm(form, currentPage);

    const expired = currentPage.expires_at && new Date(currentPage.expires_at) < new Date();

    if (expired) {
      notice.append(
        noticeBlock(
          'انتهت فترة اشتراك صفحتك. الرابط لن يعمل للزوار حتى يتم التجديد من إدارة المنصة.',
          'warning',
        ),
      );
    } else if (currentPage.is_active === false) {
      notice.append(
        noticeBlock(
          'صفحتك متوقفة حاليًا من إدارة المنصة. الرابط لن يعمل للزوار حتى يتم تفعيلها.',
          'warning',
        ),
      );
    }
  }

  setStatus(statusEl, currentPage);
  renderLinkBox(linkEl, currentPage);
  renderStats(statsEl, currentPage);
  renderTrafficReport(container.querySelector('#traffic'), currentPage);
  syncHoursBox(form);
  updatePreview();

  form.addEventListener('input', (event) => {
    if (event.target.name) clearFieldError(form, event.target.name);
    updatePreview();
  });

  form.addEventListener('change', () => {
    syncHoursBox(form);
    updatePreview();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    if (!user) {
      showToast('سجّل الدخول أولًا لحفظ صفحتك', 'error');
      navigate('login');
      return;
    }

    if (!canSave) {
      showToast('تعذر تحميل صفحتك، أعد تحميل الصفحة', 'error');
      return;
    }

    const isNew = !currentPage;
    const rawDraft = readDraft(form);
    const { values, errors } = validatePageInput(rawDraft, { isNew });

    showFieldErrors(form, errors);

    if (Object.keys(errors).length > 0) {
      showToast('راجع الحقول المحددة باللون الأحمر', 'error');
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'جاري الحفظ...';

    const payload = { ...rawDraft, ...values };

    payload.theme = payload.theme || 'emerald';

    // توحيد اسم حقل Google Ads
    payload.gtag_label = payload.conversion_label || payload.gtag_label || '';
    delete payload.conversion_label;

    // توليد أوقات العمل
    payload.working_hours = buildWorkingHours(payload);

    // تنظيف روابط التواصل
    ['whatsapp', 'instagram', 'snapchat', 'tiktok'].forEach((key) => {
      payload[key] = String(payload[key] || '').trim();
    });

    if (!isNew) delete payload.slug;

    const { error } = isNew ? await createPage(payload) : await updatePage(user.id, payload);

    saveButton.disabled = false;
    saveButton.textContent = 'حفظ الصفحة والمتابعة';

    if (error) {
      showToast(friendlyError(error, 'تعذر حفظ الصفحة، حاول مرة أخرى'), 'error');
      return;
    }

    if (isNew) {
      showToast('تم إنشاء صفحتك التجريبية بنجاح!', 'success');
      navigate('success');
    } else {
      showToast('تم تحديث صفحتك بنجاح', 'success');
      await renderDashboard(container);
    }
  });
}