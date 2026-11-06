import { navigate } from '../lib/router.js';

const TERMS_SECTIONS = [
  { title: 'قبول الشروط', text: 'باستخدامك لمنصة سبيد لاندنج أو إنشائك لصفحة عبرها، فإنك توافق على هذه الشروط. إذا كنت لا توافق عليها فلا تستخدم المنصة.' },
  { title: 'الخدمة', text: 'تتيح المنصة إنشاء صفحات هبوط لنشاطك التجاري، مع رابط جاهز لإعلانات Google Ads وأزرار اتصال وتواصل. مدة التجربة المجانية والباقات المدفوعة تحددها المنصة وتظهر في صفحة الأسعار.' },
  { title: 'الحساب والمسؤولية', text: 'أنت مسؤول عن دقة المعلومات التي تنشرها في صفحتك، وعن صحة أرقام الاتصال وروابط التواصل، وعن امتثال إعلاناتك للأنظمة المعمول بها.' },
  { title: 'الاشتراك والتجديد', text: 'تنتهي صفحتك عند انتهاء فترة الاشتراك، ولن يتمكن الزوار من فتحها حتى يتم التجديد. يتم التجديد والتفعيل من قبل إدارة المنصة.' },
  { title: 'المحتوى المحظور', text: 'يُمنع نشر محتوى غير قانوني أو مضلل أو مسيء، أو محتوى ينتهك حقوق الآخرين. تحتفظ المنصة بحق إيقاف أي صفحة تخالف ذلك.' },
  { title: 'تعديل الشروط', text: 'قد نعدل هذه الشروط من وقت لآخر، وتصبح التعديلات سارية عند نشرها في هذه الصفحة.' },
];

const PRIVACY_SECTIONS = [
  { title: 'البيانات التي نجمعها', text: 'نجمع الاسم والبريد الإلكتروني ورقم الجوال والمدينة عند إنشاء حسابك، وبيانات الصفحة التي تنشئها مثل النشاط ووسائل التواصل.' },
  { title: 'كيف نستخدم البيانات', text: 'نستخدم البيانات لتشغيل صفحتك وإدارة اشتراكك والتواصل معك بخصوص الخدمة. لا نبيع بياناتك لأي طرف ثالث.' },
  { title: 'إحصاءات الزوار', text: 'نسجل عدد مرات فتح الصفحة وعدد نقرات زر الاتصال لعرضها لك في لوحة التحكم، ولا نعرض بيانات هوية الزوار.' },
  { title: 'حماية البيانات', text: 'نحمي بياناتك بضوابط وصول تمنع المستخدمين من رؤية بيانات غيرهم، ونقصر صلاحيات الإدارة على الحسابات المعتمدة.' },
  { title: 'حقوقك', text: 'يمكنك تعديل بيانات صفحتك في أي وقت من لوحة التحكم، ويمكنك طلب حذف حسابك وبياناته بالتواصل معنا.' },
  { title: 'التواصل معنا', text: 'لأي استفسار يتعلق بالخصوصية، تواصل معنا عبر الرقم المعلن في صفحة الأسعار.' },
];

function renderLegalPage(container, { heading, intro, sections }) {
  container.innerHTML = `
    <article class="max-w-3xl mx-auto px-4 py-16 space-y-10 animate-fade-in">
      <header class="space-y-4">
        <h1 class="text-3xl md:text-4xl font-black text-white">${heading}</h1>
        <p class="text-slate-300 leading-relaxed">${intro}</p>
      </header>
      <div class="space-y-8">
        ${sections
          .map(
            (section) => `
          <section class="glass-card rounded-3xl p-6 space-y-2">
            <h2 class="font-black text-lg text-emerald-400">${section.title}</h2>
            <p class="text-sm text-slate-300 leading-relaxed">${section.text}</p>
          </section>
        `,
          )
          .join('')}
      </div>
      <button data-route="home" type="button" class="text-sm font-bold text-slate-300 hover:text-white transition cursor-pointer">
        العودة إلى الرئيسية
      </button>
    </article>
  `;

  container.querySelector('[data-route]').addEventListener('click', () => navigate('home'));
}

export function renderTerms(container) {
  renderLegalPage(container, {
    heading: 'شروط الاستخدام',
    intro: 'يرجى قراءة هذه الشروط بعناية قبل استخدام منصة سبيد لاندنج.',
    sections: TERMS_SECTIONS,
  });
}

export function renderPrivacy(container) {
  renderLegalPage(container, {
    heading: 'سياسة الخصوصية',
    intro: 'توضح هذه الصفحة كيف نجمع بياناتك ونستخدمها ونحميها عند استخدام المنصة.',
    sections: PRIVACY_SECTIONS,
  });
}
