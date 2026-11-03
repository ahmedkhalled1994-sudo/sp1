import { navigate } from '../lib/router.js';

const FEATURES = [
  { icon: 'fa-solid fa-bolt', color: 'text-emerald-400 bg-emerald-500/10 border-emerald-500/30', title: 'صفحة خفيفة وسريعة', text: 'تصميم بسيط يفتح بسرعة على الجوال، لكي لا يغادر الزائر قبل أن يرى عرضك.' },
  { icon: 'fa-solid fa-link', color: 'text-teal-400 bg-teal-500/10 border-teal-500/30', title: 'رابط جاهز لإعلانات جوجل', text: 'تحصل على رابط ثابت تضعه في خانة الرابط النهائي لإعلاناتك مباشرة.' },
  { icon: 'fa-solid fa-address-book', color: 'text-amber-400 bg-amber-500/10 border-amber-500/30', title: 'اتصال وتواصل مباشر', text: 'زر اتصال واحد، ونسخ للرقم، وروابط واتساب وانستجرام وسناب وتيك توك.' },
];

export function renderHome(container) {
  container.innerHTML = `
    <div class="space-y-20 py-16 px-4 relative overflow-hidden animate-fade-in">
      <div class="absolute top-1/4 left-1/2 -translate-x-1/2 w-96 h-96 bg-emerald-500/10 rounded-full blur-3xl -z-10"></div>

      <section class="max-w-4xl mx-auto text-center space-y-6">
        <div class="inline-flex items-center gap-2 bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 text-xs px-4 py-1.5 rounded-full font-bold">
          <span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>
          <span>صفحات هبوط مخصصة لإعلانات Google Ads</span>
        </div>
        <h1 class="text-3xl md:text-6xl font-black text-white leading-tight tracking-tight">
          حوّل زوّارك إلى عملاء بصفحة هبوط <span class="bg-linear-to-r from-emerald-400 to-teal-300 bg-clip-text text-transparent">خفيفة وواضحة</span>
        </h1>
        <p class="text-slate-300 text-sm md:text-lg max-w-2xl mx-auto leading-relaxed">
          أنشئ صفحة لنشاطك، واحصل على رابط جاهز لإعلاناتك، مع زر اتصال مباشر وروابط تواصل مع عملائك.
        </p>
        <div class="flex flex-wrap items-center justify-center gap-4 pt-4">
          <button data-route="dashboard" class="bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-base px-8 py-4 rounded-2xl shadow-xl shadow-emerald-500/20 transition active:scale-95 cursor-pointer">
            صمّم صفحتك وشاهد المعاينة فوراً
          </button>
          <button data-route="pricing" class="glass-card hover:bg-slate-900 text-slate-100 font-bold text-base px-7 py-4 rounded-2xl transition cursor-pointer">
            عرض خطط الأسعار
          </button>
        </div>
      </section>

      <section class="max-w-6xl mx-auto grid md:grid-cols-3 gap-6">
        ${FEATURES.map((feature) => `
          <article class="glass-card p-7 rounded-3xl space-y-3 hover:border-emerald-500/40 transition duration-300">
            <div class="w-12 h-12 border rounded-2xl flex items-center justify-center text-xl ${feature.color}">
              <i class="${feature.icon}"></i>
            </div>
            <h2 class="font-black text-lg text-white">${feature.title}</h2>
            <p class="text-sm text-slate-300 leading-relaxed">${feature.text}</p>
          </article>
        `).join('')}
      </section>
    </div>
  `;

  container.querySelectorAll('[data-route]').forEach((button) => {
    button.addEventListener('click', () => navigate(button.dataset.route));
  });
}
