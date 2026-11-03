import { navigate } from '../lib/router.js';
import { getSession } from '../lib/session.js';
import { fetchMyPage } from '../lib/pages-api.js';
import { friendlyError } from '../lib/messages.js';
import { showToast } from '../lib/feedback.js';
import { PLAN_PRICES } from '../lib/constants.js';
import { el } from '../lib/dom.js';

function planCard(planKey, { highlighted }) {
  const plan = PLAN_PRICES[planKey];
  const card = el(
    'div',
    `glass-card p-8 rounded-3xl space-y-6 relative ${highlighted ? 'border-2 border-emerald-500 glow-effect' : 'border border-slate-800'}`,
  );
  card.innerHTML = `
    ${highlighted ? '<span class="absolute -top-3.5 right-6 bg-linear-to-r from-emerald-500 to-teal-400 text-slate-950 text-[10px] font-black px-3.5 py-1 rounded-full shadow-lg">الأكثر توفيراً</span>' : ''}
    <div>
      <h2 class="font-bold text-lg text-white">${plan.name}</h2>
      <p class="text-xs text-slate-300">${planKey === 'monthly' ? 'مثالية للأنشطة والخدمات السريعة' : 'توفير شهرين مع أولوية الدعم'}</p>
    </div>
    <div class="flex items-baseline gap-1">
      <span class="text-4xl font-black ${highlighted ? 'text-emerald-400' : 'text-white'}">${plan.price}</span>
      <span class="text-slate-300 text-sm font-bold">${plan.period}</span>
    </div>
    <button data-plan="${planKey}" class="w-full py-3.5 rounded-2xl text-xs font-black transition cursor-pointer ${highlighted ? 'bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 shadow-lg' : 'bg-slate-900 border border-slate-700 hover:bg-slate-800 text-white'}">
      تفعيل الصفحة مجاناً (تجريبي)
    </button>
  `;
  return card;
}

async function activateTrial() {
  const { user } = getSession();
  if (!user) {
    showToast('سجّل الدخول لتفعيل صفحتك', 'error');
    navigate('login');
    return;
  }

  const { data, error } = await fetchMyPage(user.id);
  if (error) {
    showToast(friendlyError(error, 'تعذر التحقق من صفحتك، حاول مرة أخرى'), 'error');
    return;
  }
  if (!data) {
    showToast('احفظ تصميم صفحتك أولاً', 'error');
    navigate('dashboard');
    return;
  }
  navigate('success');
}

export function renderPricing(container) {
  container.innerHTML = `
    <div class="py-12 px-4 max-w-5xl mx-auto space-y-10 animate-fade-in">
      <div class="text-center space-y-3">
        <div class="inline-flex items-center gap-2 bg-amber-500/10 border border-amber-500/30 text-amber-300 text-xs px-3.5 py-1 rounded-full font-bold">
          وضع تجريبي: لا يتم خصم أي مبلغ حالياً
        </div>
        <h1 class="text-2xl md:text-4xl font-black text-white">اختر باقتك لتفعيل الصفحة</h1>
        <p class="text-slate-300 text-xs md:text-sm">بعد التفعيل تحصل على رابط صفحتك لإعلانات جوجل</p>
      </div>
      <div id="plans" class="grid md:grid-cols-2 gap-8 max-w-3xl mx-auto"></div>
    </div>
  `;

  const plans = container.querySelector('#plans');
  plans.append(planCard('monthly', { highlighted: false }), planCard('annual', { highlighted: true }));
  plans.addEventListener('click', (event) => {
    if (event.target.closest('[data-plan]')) activateTrial();
  });
}
