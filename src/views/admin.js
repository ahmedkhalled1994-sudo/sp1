import { getSession } from '../lib/session.js';
import { fetchAllPages, setPageActive } from '../lib/pages-api.js';
import { friendlyError } from '../lib/messages.js';
import { showToast } from '../lib/feedback.js';
import { el, messageBlock } from '../lib/dom.js';

const HEAD_CELLS = ['اسم النشاط', 'إيميل المشترك', 'الهاتف', 'الرابط', 'الزيارات / الاتصالات', 'الحالة', 'التحكم'];

function cell(content, className = 'p-3') {
  const td = el('td', className);
  td.append(content);
  return td;
}

function buildRow(page, onToggle) {
  const tr = el('tr', 'hover:bg-slate-900/60');

  const link = el('a', 'text-emerald-400 underline font-mono', `?p=${page.slug}`);
  link.href = `${window.location.origin}${window.location.pathname}?p=${encodeURIComponent(page.slug)}`;
  link.target = '_blank';
  link.rel = 'noopener noreferrer';

  const status = el(
    'span',
    `px-2 py-0.5 rounded-full text-[10px] font-bold ${page.is_active ? 'bg-emerald-500/10 text-emerald-400' : 'bg-rose-500/10 text-rose-400'}`,
    page.is_active ? 'مفعلة' : 'معطلة',
  );

  const toggle = el(
    'button',
    'bg-slate-800 hover:bg-slate-700 text-slate-100 px-3 py-1 rounded text-[11px] cursor-pointer disabled:opacity-60',
    page.is_active ? 'إيقاف' : 'تفعيل',
  );
  toggle.addEventListener('click', () => onToggle(page, toggle));

  tr.append(
    cell(el('span', 'font-bold text-white', page.title)),
    cell(el('span', 'text-slate-300 font-mono text-[11px] break-all', page.user_email)),
    cell(el('span', 'font-mono text-emerald-400', page.phone)),
    cell(link),
    cell(el('span', 'text-slate-200 font-bold', `${page.views_count} زيارة / ${page.calls_count} اتصال`)),
    cell(status),
    cell(toggle, 'p-3 text-center'),
  );
  return tr;
}

export async function renderAdmin(container) {
  if (!getSession().isAdmin) {
    container.replaceChildren(messageBlock('هذه الصفحة مخصصة لإدارة المنصة فقط.', 'error'));
    return;
  }

  container.innerHTML = `
    <div class="max-w-6xl mx-auto p-4 md:p-8 space-y-6 animate-fade-in">
      <div class="bg-linear-to-r from-emerald-950/40 to-slate-900 border border-emerald-500/30 p-6 rounded-3xl flex flex-wrap items-center justify-between gap-4">
        <div>
          <span class="bg-emerald-500 text-slate-950 text-[10px] font-black px-2.5 py-0.5 rounded-full">حساب الإدارة</span>
          <h1 class="text-xl font-black text-white mt-1">إدارة الصفحات المسجلة</h1>
          <p class="text-xs text-slate-300">متابعة صفحات المشتركين وتفعيلها أو إيقافها</p>
        </div>
        <button id="refresh-admin" type="button" class="bg-slate-800 hover:bg-slate-700 text-xs px-3.5 py-2 rounded-xl text-slate-100 font-bold cursor-pointer">تحديث الجدول</button>
      </div>

      <div class="glass-card rounded-3xl overflow-hidden border border-slate-800">
        <div class="p-4 border-b border-slate-800 font-bold text-xs text-slate-200 flex items-center justify-between">
          <span>قائمة الصفحات</span>
          <span id="admin-count" class="text-emerald-400 font-mono">0 صفحات</span>
        </div>
        <div class="overflow-x-auto">
          <table class="w-full text-right text-xs">
            <thead class="bg-slate-900/80 text-slate-300 border-b border-slate-800">
              <tr>${HEAD_CELLS.map((label) => `<th class="p-3 whitespace-nowrap">${label}</th>`).join('')}</tr>
            </thead>
            <tbody id="admin-rows" class="divide-y divide-slate-800 text-slate-100"></tbody>
          </table>
        </div>
      </div>
    </div>
  `;

  const tbody = container.querySelector('#admin-rows');
  const count = container.querySelector('#admin-count');

  function renderMessageRow(text, tone = 'info') {
    const tr = el('tr');
    const td = el('td', `p-4 text-center ${tone === 'error' ? 'text-rose-400' : 'text-slate-300'}`, text);
    td.colSpan = HEAD_CELLS.length;
    tr.append(td);
    tbody.replaceChildren(tr);
  }

  async function handleToggle(page, button) {
    button.disabled = true;
    const { error } = await setPageActive(page.id, !page.is_active);
    if (error) {
      button.disabled = false;
      showToast(friendlyError(error, 'تعذر تحديث حالة الصفحة'), 'error');
      return;
    }
    showToast(page.is_active ? 'تم إيقاف الصفحة' : 'تم تفعيل الصفحة', 'success');
    loadRows();
  }

  async function loadRows() {
    renderMessageRow('جاري جلب الصفحات...');
    const { data, error } = await fetchAllPages();
    if (error) {
      count.textContent = '0 صفحات';
      renderMessageRow(friendlyError(error, 'تعذر تحميل الصفحات'), 'error');
      return;
    }

    count.textContent = `${data.length} صفحات`;
    if (data.length === 0) {
      renderMessageRow('لا توجد صفحات مسجلة حتى الآن');
      return;
    }
    tbody.replaceChildren(...data.map((page) => buildRow(page, handleToggle)));
  }

  container.querySelector('#refresh-admin').addEventListener('click', loadRows);
  loadRows();
}
