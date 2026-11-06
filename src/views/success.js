import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { fetchMyPage, publicPageUrl } from '../lib/pages-api.js';
import { copyText, showToast } from '../lib/feedback.js';
import { friendlyError } from '../lib/messages.js';
import { el, messageBlock } from '../lib/dom.js';

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

  const link = publicPageUrl(page.slug);

  let daysLeft = '';
  if (page.expires_at) {
    const diff = Math.ceil((new Date(page.expires_at) - new Date()) / (1000 * 60 * 60 * 24));
    if (diff > 0) {
      daysLeft = `${diff} ${diff === 1 ? 'يوم' : diff === 2 ? 'يومان' : diff <= 10 ? 'أيام' : 'يوماً'}`;
    }
  }

  const isTrial = page.is_trial === true;

  container.innerHTML = `
    <div class="py-16 px-4 max-w-xl mx-auto text-center space-y-6 animate-fade-in">
      <div class="glass-card p-8 rounded-3xl space-y-6 shadow-2xl border border-emerald-500/40 glow-effect">
        <div class="w-20 h-20 bg-emerald-500/10 border border-emerald-500/40 rounded-3xl mx-auto flex items-center justify-center text-4xl">
          🎉
        </div>

        <div class="space-y-2">
          <h1 class="text-2xl font-black text-white">تهانينا! صفحتك جاهزة</h1>
          <p class="text-xs text-slate-300">استخدم هذا الرابط في خانة الرابط النهائي لإعلاناتك في Google Ads:</p>
        </div>

        ${isTrial && daysLeft ? `
          <div class="bg-amber-500/10 border border-amber-500/30 rounded-2xl p-4 text-center">
            <p class="text-amber-300 text-sm font-bold">
              <i class="fa-solid fa-gift ml-1"></i>
              هذه صفحة تجريبية مجانية
            </p>
            <p class="text-amber-200/80 text-xs mt-1">
              متبقٍ <span class="font-black text-amber-300">${daysLeft}</span> قبل انتهاء التجربة
            </p>
            <p class="text-slate-400 text-[11px] mt-2">
              بعد انتهاء التجربة، اختر باقة مناسبة لمواصلة استقبال الاتصالات
            </p>
          </div>
        ` : ''}

        <div class="bg-slate-950 border border-slate-800 p-4 rounded-2xl space-y-2 text-right">
          <label for="ad-link" class="text-[11px] text-slate-300 font-bold block">رابط إعلانات جوجل المباشر</label>
          <div class="flex items-center gap-2">
            <input id="ad-link" type="text" readonly dir="ltr" class="w-full bg-slate-900 border border-slate-800 rounded-xl p-2.5 text-xs text-emerald-400 font-mono outline-none" />
            <button id="copy-link" type="button" class="bg-emerald-500 hover:bg-emerald-400 text-slate-950 font-black px-4 py-2.5 rounded-xl text-xs transition cursor-pointer whitespace-nowrap">
              نسخ
            </button>
          </div>
        </div>

        <div class="flex flex-col sm:flex-row gap-3 pt-2">
          <button id="edit-page" type="button" class="w-full bg-slate-900 border border-slate-700 hover:bg-slate-800 text-white font-bold py-3 rounded-xl text-xs transition cursor-pointer">
            تعديل البيانات
          </button>
          <a id="open-page" href="${link}" target="_blank" rel="noopener noreferrer" class="w-full text-center bg-linear-to-r from-emerald-500 to-teal-400 text-slate-950 font-black py-3 rounded-xl text-xs transition cursor-pointer shadow-lg">
            معاينة الصفحة الحية
          </a>
        </div>

        ${isTrial ? `
          <div class="pt-4 border-t border-slate-800">
            <p class="text-xs text-slate-400 mb-3">هل أعجبتك النتيجة؟ اختر باقتك الآن:</p>
            <button id="go-pricing" class="w-full bg-linear-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-slate-950 font-black py-3 rounded-xl text-xs transition cursor-pointer">
              <i class="fa-solid fa-tags ml-1"></i>
              عرض الباقات والأسعار
            </button>
          </div>
        ` : ''}
      </div>
    </div>
  `;

  container.querySelector('#ad-link').value = link;

  container.querySelector('#copy-link').addEventListener('click', async () => {
    const copied = await copyText(link);
    showToast(copied ? 'تم نسخ الرابط' : 'تعذر النسخ، انسخ الرابط يدوياً', copied ? 'success' : 'error');
  });

  container.querySelector('#edit-page').addEventListener('click', () => navigate('dashboard'));

  const goPricingBtn = container.querySelector('#go-pricing');
  if (goPricingBtn) {
    goPricingBtn.addEventListener('click', () => navigate('pricing'));
  }
}