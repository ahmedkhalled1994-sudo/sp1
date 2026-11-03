import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { createPageCard } from '../components/page-card.js';
import { createPage, fetchMyPage, updatePage } from '../lib/pages-api.js';
import { validatePageInput } from '../lib/page-validation.js';
import { friendlyError } from '../lib/messages.js';
import { showToast } from '../lib/feedback.js';
import { el } from '../lib/dom.js';
import {
  clearFieldError,
  fillForm,
  formFieldsMarkup,
  readDraft,
  showFieldErrors,
  syncHoursBox,
} from './dashboard-form.js';

function statRow(label, value) {
  const row = el('div', 'bg-slate-950/60 border border-slate-800/80 p-4 rounded-2xl flex items-center justify-between');
  row.append(el('span', 'text-xs text-slate-300 font-bold', label), el('span', 'text-2xl font-black text-emerald-400', String(value)));
  return row;
}

function renderStats(statsEl, page) {
  const title = el('h2', 'font-black text-sm text-white', 'إحصائيات الصفحة');
  if (!page) {
    statsEl.replaceChildren(title, el('p', 'text-xs text-slate-300', 'ستظهر الإحصائيات بعد حفظ صفحتك وتفعيلها.'));
    return;
  }
  statsEl.replaceChildren(
    title,
    statRow('زيارات الصفحة', page.views_count),
    statRow('ضغطات زر الاتصال', page.calls_count),
  );
}

function setStatus(statusEl, page) {
  if (!page) {
    statusEl.textContent = 'لم تُحفظ بعد';
    statusEl.className = 'text-[11px] px-3 py-1 rounded-full font-bold border border-slate-700 text-slate-300 whitespace-nowrap';
    return;
  }
  statusEl.textContent = page.is_active ? 'مفعلة' : 'متوقفة من الإدارة';
  statusEl.className = page.is_active
    ? 'text-[11px] px-3 py-1 rounded-full font-bold border border-emerald-500/40 text-emerald-400 bg-emerald-500/10 whitespace-nowrap'
    : 'text-[11px] px-3 py-1 rounded-full font-bold border border-rose-500/40 text-rose-400 bg-rose-500/10 whitespace-nowrap';
}

function noticeBlock(text, tone) {
  const box = el('div', `rounded-2xl border p-3 text-xs font-bold ${tone === 'error' ? 'border-rose-500/40 text-rose-300 bg-rose-500/10' : 'border-amber-500/40 text-amber-300 bg-amber-500/10'}`);
  box.append(el('span', '', text));
  return box;
}

export async function renderDashboard(container) {
  const { user } = getSession();

  container.innerHTML = `
    <div class="max-w-6xl mx-auto p-4 md:p-8 grid lg:grid-cols-12 gap-8 items-start animate-fade-in">
      <section class="lg:col-span-7 glass-card rounded-3xl p-6 space-y-5 shadow-2xl">
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
          <button id="save-btn" type="submit" class="w-full bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black py-4 rounded-2xl text-sm shadow-xl shadow-emerald-500/20 transition active:scale-95 cursor-pointer">
            حفظ الصفحة والمتابعة
          </button>
        </form>
      </section>

      <aside class="lg:col-span-5 space-y-6">
        <div class="bg-slate-950 border-4 border-slate-800 rounded-[45px] p-4">
          <div id="preview"></div>
        </div>
        <div id="stats" class="glass-card rounded-3xl p-6 space-y-4"></div>
      </aside>
    </div>
  `;

  const form = container.querySelector('#page-form');
  const saveButton = container.querySelector('#save-btn');
  const notice = container.querySelector('#notice');
  const statusEl = container.querySelector('#page-status');
  const previewEl = container.querySelector('#preview');
  const statsEl = container.querySelector('#stats');

  let currentPage = null;
  let canSave = true;

  function updatePreview() {
    const draft = readDraft(form);
    previewEl.replaceChildren(
      createPageCard({
        ...draft,
        icon: draft.icon || '🎓',
        title: draft.title.trim() || 'اسم النشاط',
        is_active: true,
      }),
    );
  }

  if (!user) {
    const loginLink = el('button', 'underline text-amber-200 font-black cursor-pointer', 'سجّل الدخول');
    loginLink.addEventListener('click', () => navigate('login'));
    const box = noticeBlock('يمكنك تجربة التصميم الآن. لحفظ صفحتك يجب ', 'warning');
    box.append(loginLink, el('span', '', ' أولاً.'));
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
    if (!currentPage.is_active) {
      notice.append(noticeBlock('صفحتك متوقفة حالياً من إدارة المنصة. الرابط لن يعمل للزوار حتى يتم تفعيلها.', 'warning'));
    }
  }
  setStatus(statusEl, currentPage);
  renderStats(statsEl, currentPage);
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
      showToast('سجّل الدخول أولاً لحفظ صفحتك', 'error');
      navigate('login');
      return;
    }
    if (!canSave) {
      showToast('تعذر تحميل صفحتك، أعد تحميل الصفحة', 'error');
      return;
    }

    const isNew = !currentPage;
    const { values, errors } = validatePageInput(readDraft(form), { isNew });
    showFieldErrors(form, errors);
    if (Object.keys(errors).length > 0) {
      showToast('راجع الحقول المحددة باللون الأحمر', 'error');
      return;
    }

    saveButton.disabled = true;
    saveButton.textContent = 'جاري الحفظ...';
    const { error } = isNew ? await createPage(values) : await updatePage(user.id, values);
    saveButton.disabled = false;
    saveButton.textContent = 'حفظ الصفحة والمتابعة';

    if (error) {
      showToast(friendlyError(error, 'تعذر حفظ الصفحة، حاول مرة أخرى'), 'error');
      return;
    }

    showToast('تم حفظ صفحتك بنجاح', 'success');
    navigate('pricing');
  });
}
