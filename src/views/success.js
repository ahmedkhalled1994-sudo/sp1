import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { fetchMyPage } from '../lib/pages-api.js';
import { copyText, showToast } from '../lib/feedback.js';
import { friendlyError } from '../lib/messages.js';
import { el, messageBlock } from '../lib/dom.js';

function adLink(slug) {
  return `${window.location.origin}${window.location.pathname}?p=${encodeURIComponent(slug)}`;
}

export async function renderSuccess(container) {
  const { user } = getSession();
  if (!user) {
    showToast('سجّل الدخول لعرض رابط صفحتك', 'error');
    navigate('login');
    return;
  }

  container.replaceChildren(messageBlock('جاري تحميل رابط صفحتك...'));

  const { data: page, error } = await fetchMyPage(user.id);
  if (error) {
    container.replaceChildren(messageBlock(friendlyError(error, 'تعذر تحميل صفحتك، حاول مرة أخرى'), 'error'));
    return;
  }
  if (!page) {
    showToast('احفظ تصميم صفحتك أولاً', 'error');
    navigate('dashboard');
    return;
  }

  const link = adLink(page.slug);
  container.innerHTML = `
    <div class="py-16 px-4 max-w-xl mx-auto text-center space-y-6 animate-fade-in">
      <div class="glass-card p-8 rounded-3xl space-y-6 shadow-2xl border border-emerald-500/40 glow-effect">
        <div class="w-20 h-20 bg-emerald-500/10 border border-emerald-500/40 rounded-3xl mx-auto flex items-center justify-center text-4xl">🎉</div>
        <div class="space-y-2">
          <h1 class="text-2xl font-black text-white">تهانينا! صفحتك جاهزة</h1>
          <p class="text-xs text-slate-300">استخدم هذا الرابط في خانة الرابط النهائي لإعلاناتك في Google Ads:</p>
        </div>
        <div class="bg-slate-950 border border-slate-800 p-4 rounded-2xl space-y-2 text-right">
          <label for="ad-link" class="text-[11px] text-slate-300 font-bold block">رابط إعلانات جوجل المباشر</label>
          <div class="flex items-center gap-2">
            <input id="ad-link" type="text" readonly dir="ltr" class="w-full bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-emerald-400 font-mono outline-none" />
            <button id="copy-link" type="button" class="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black px-4 py-2.5 rounded-xl text-xs transition cursor-pointer whitespace-nowrap">نسخ</button>
          </div>
        </div>
        <div class="flex flex-col sm:flex-row gap-3 pt-2">
          <button id="edit-page" type="button" class="w-full bg-slate-900 border border-slate-700 hover:bg-slate-800 text-white font-bold py-3 rounded-xl text-xs transition cursor-pointer">تعديل البيانات</button>
          <a id="open-page" href="${link}" target="_blank" rel="noopener noreferrer" class="w-full text-center bg-linear-to-r from-emerald-500 to-teal-400 text-slate-950 font-black py-3 rounded-xl text-xs transition cursor-pointer shadow-lg">معاينة الصفحة الحية</a>
        </div>
      </div>
    </div>
  `;

  container.querySelector('#ad-link').value = link;
  container.querySelector('#copy-link').addEventListener('click', async () => {
    const copied = await copyText(link);
    showToast(copied ? 'تم نسخ الرابط' : 'تعذر النسخ، انسخ الرابط يدوياً', copied ? 'success' : 'error');
  });
  container.querySelector('#edit-page').addEventListener('click', () => navigate('dashboard'));
}
