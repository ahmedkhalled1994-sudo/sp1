import { supabase } from '../lib/supabase.js';
import { navigate } from '../lib/router.js';

export function renderLogin(container) {
  let isSignUpMode = true;

  function render() {
    container.innerHTML = `
      <div class="min-h-[85vh] flex items-center justify-center p-4 py-10">
        <div class="w-full max-w-lg bg-slate-900 border border-slate-800 rounded-3xl p-6 sm:p-8 shadow-2xl backdrop-blur-xl animate-fade-in">
          <div class="text-center mb-6">
            <div class="w-14 h-14 mx-auto mb-3 rounded-2xl bg-linear-to-tr from-emerald-500 to-teal-400 flex items-center justify-center text-slate-950 font-black text-xl shadow-lg shadow-emerald-500/20">
              PA
            </div>
            <h1 class="text-2xl font-black text-white">صفحة <span class="text-emerald-400">إعلان</span> <span class="text-xs font-mono text-slate-400 font-normal">PAG ADS</span></h1>
            <p class="text-xs text-slate-400 mt-1">
              ${isSignUpMode ? 'أنشئ حسابك الجديد وانطلق في إعلانات جوجل الاحترافية' : 'مرحباً بعودتك! سجّل دخولك لإدارة صفحات إعلاناتك'}
            </p>
          </div>

          <div class="flex items-center bg-slate-950 p-1 rounded-2xl border border-slate-800 mb-6">
            <button id="toggleSignUp" class="flex-1 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              isSignUpMode ? 'bg-emerald-500 text-slate-950 shadow-sm' : 'text-slate-400 hover:text-white'
            }">
              إنشاء حساب جديد
            </button>
            <button id="toggleSignIn" class="flex-1 py-2.5 rounded-xl text-xs font-bold transition-all cursor-pointer ${
              !isSignUpMode ? 'bg-emerald-500 text-slate-950 shadow-sm' : 'text-slate-400 hover:text-white'
            }">
              تسجيل الدخول
            </button>
          </div>

          <form id="authForm" class="space-y-4" novalidate>
            <div id="errorAlert" class="hidden p-3 rounded-xl bg-rose-500/10 border border-rose-500/20 text-rose-400 text-xs font-bold text-center"></div>

            ${isSignUpMode ? `
              <div>
                <label class="block text-xs font-bold text-slate-300 mb-1">الاسم الكامل / اسم النشاط</label>
                <div class="flex items-center gap-2.5 bg-slate-950 border border-slate-800 rounded-xl px-3.5 focus-within:border-emerald-500 transition">
                  <i class="fa-solid fa-user text-slate-500 text-xs"></i>
                  <input type="text" id="fullNameInput" placeholder="مثال: أحمد الشمري / مؤسسة الإتقان" class="w-full bg-transparent text-xs text-slate-100 outline-none py-3" required />
                </div>
              </div>
              <div class="grid grid-cols-1 sm:grid-cols-2 gap-3">
                <div>
                  <label class="block text-xs font-bold text-slate-300 mb-1">رقم الجوال / واتساب</label>
                  <div class="flex items-center gap-2.5 bg-slate-950 border border-slate-800 rounded-xl px-3.5 focus-within:border-emerald-500 transition">
                    <i class="fa-solid fa-phone text-slate-500 text-xs"></i>
                    <input type="tel" id="phoneInput" dir="ltr" placeholder="+966 5x xxx xxxx" class="w-full bg-transparent text-xs text-slate-100 outline-none py-3" required />
                  </div>
                </div>
                <div>
                  <label class="block text-xs font-bold text-slate-300 mb-1">المدينة / الدولة</label>
                  <div class="flex items-center gap-2.5 bg-slate-950 border border-slate-800 rounded-xl px-3.5 focus-within:border-emerald-500 transition">
                    <i class="fa-solid fa-location-dot text-slate-500 text-xs"></i>
                    <input type="text" id="addressInput" placeholder="مثال: الرياض، السعودية" class="w-full bg-transparent text-xs text-slate-100 outline-none py-3" required />
                  </div>
                </div>
              </div>
            ` : ''}

            <div>
              <label class="block text-xs font-bold text-slate-300 mb-1">البريد الإلكتروني الرسمي</label>
              <div class="flex items-center gap-2.5 bg-slate-950 border border-slate-800 rounded-xl px-3.5 focus-within:border-emerald-500 transition">
                <i class="fa-solid fa-envelope text-slate-500 text-xs"></i>
                <input type="email" id="emailInput" dir="ltr" placeholder="name@domain.com" class="w-full bg-transparent text-xs text-slate-100 outline-none py-3" required />
              </div>
            </div>

            <div>
              <label class="block text-xs font-bold text-slate-300 mb-1">كلمة المرور</label>
              <div class="flex items-center gap-2.5 bg-slate-950 border border-slate-800 rounded-xl px-3.5 focus-within:border-emerald-500 transition">
                <i class="fa-solid fa-lock text-slate-500 text-xs"></i>
                <input type="password" id="passwordInput" placeholder="••••••••" class="w-full bg-transparent text-xs text-slate-100 outline-none py-3" minlength="6" required />
              </div>
              ${isSignUpMode ? '<p class="text-[10px] text-slate-500 mt-1">يجب أن لا تقل عن 6 خانات للحماية.</p>' : ''}
            </div>

            <button type="submit" id="submitBtn" class="w-full mt-4 py-3.5 px-4 rounded-xl bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-sm shadow-lg shadow-emerald-500/20 active:scale-98 transition cursor-pointer flex items-center justify-center gap-2">
              <span>${isSignUpMode ? 'إنشاء الحساب ومتابعة التصميم' : 'تسجيل الدخول'}</span>
              <i class="fa-solid fa-arrow-left text-xs"></i>
            </button>
          </form>

          <div class="mt-6 pt-4 text-center border-t border-slate-800/80 text-[11px] text-slate-400">
            <span>بياناتك ومعلوماتك محمية ومشفرة عبر منصة </span>
            <span class="text-emerald-400 font-bold">صفحة إعلان | PAG ADS</span>
          </div>
        </div>
      </div>
    `;

    container.querySelector('#toggleSignUp').addEventListener('click', () => {
      isSignUpMode = true;
      render();
    });

    container.querySelector('#toggleSignIn').addEventListener('click', () => {
      isSignUpMode = false;
      render();
    });

    const form = container.querySelector('#authForm');
    const errorAlert = container.querySelector('#errorAlert');
    const submitBtn = container.querySelector('#submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      errorAlert.classList.add('hidden');
      errorAlert.textContent = '';

      const email = container.querySelector('#emailInput').value.trim();
      const password = container.querySelector('#passwordInput').value;

      if (!email || !password) {
        errorAlert.textContent = 'يرجى كتابة البريد الإلكتروني وكلمة المرور';
        errorAlert.classList.remove('hidden');
        return;
      }

      submitBtn.disabled = true;
      submitBtn.innerHTML = `<i class="fa-solid fa-circle-notch fa-spin"></i> <span>جاري المعالجة...</span>`;

      try {
        if (isSignUpMode) {
          const fullName = container.querySelector('#fullNameInput')?.value.trim() || '';
          const phone = container.querySelector('#phoneInput')?.value.trim() || '';
          const address = container.querySelector('#addressInput')?.value.trim() || '';

          if (!fullName || !phone) {
            throw new Error('يرجى ملء الاسم ورقم الجوال');
          }

          const { data, error } = await supabase.auth.signUp({
            email,
            password,
            options: {
              data: {
                full_name: fullName,
                phone: phone,
                address: address,
              },
            },
          });

          if (error) throw error;

          navigate('dashboard');
        } else {
          const { data, error } = await supabase.auth.signInWithPassword({
            email,
            password,
          });

          if (error) throw error;

          navigate('dashboard');
        }
      } catch (err) {
        let msg = err.message || 'حدث خطأ أثناء المحاولة';
        if (msg.includes('Invalid login credentials')) msg = 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
        if (msg.includes('User already registered')) msg = 'هذا البريد مسجل مسبقاً، يرجى تسجيل الدخول';
        errorAlert.textContent = msg;
        errorAlert.classList.remove('hidden');
      } finally {
        submitBtn.disabled = false;
        submitBtn.innerHTML = `<span>${isSignUpMode ? 'إنشاء الحساب ومتابعة التصميم' : 'تسجيل الدخول'}</span> <i class="fa-solid fa-arrow-left text-xs"></i>`;
      }
    });
  }

  render();
}