import { navigate } from '../lib/router.js';
import { signIn, signUp, getSession } from '../lib/session.js';
import { authErrorMessage } from '../lib/messages.js';
import { showToast } from '../lib/feedback.js';

const COPY = {
  login: {
    title: 'تسجيل الدخول إلى حسابك',
    subtitle: 'أدخل بريدك الإلكتروني لإدارة صفحتك',
    submit: 'دخول لوحة التحكم',
    prompt: 'ليس لديك حساب بعد؟',
    toggle: 'إنشاء حساب جديد',
  },
  signup: {
    title: 'إنشاء حساب جديد',
    subtitle: 'سجّل بريدك للبدء في إطلاق صفحتك',
    submit: 'تأكيد وإنشاء الحساب',
    prompt: 'لديك حساب بالفعل؟',
    toggle: 'تسجيل الدخول',
  },
};

function loginMarkup() {
  return `
    <div class="glass-card p-8 rounded-3xl space-y-6 shadow-2xl">
      <div class="text-center space-y-1">
        <h1 id="auth-title" class="font-black text-xl text-white"></h1>
        <p id="auth-subtitle" class="text-xs text-slate-300"></p>
      </div>
      <form id="auth-form" class="space-y-4" novalidate>
        <div>
          <label for="auth-email" class="text-xs text-slate-200 block mb-1 font-bold">البريد الإلكتروني</label>
          <input id="auth-email" name="email" type="email" autocomplete="email" placeholder="name@example.com" required class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-100 outline-none focus:border-emerald-500 transition" />
        </div>
        <div>
          <label for="auth-password" class="text-xs text-slate-200 block mb-1 font-bold">كلمة المرور</label>
          <input id="auth-password" name="password" type="password" minlength="6" autocomplete="current-password" placeholder="6 أحرف على الأقل" required class="w-full bg-slate-950 border border-slate-800 rounded-xl p-3 text-xs text-slate-100 outline-none focus:border-emerald-500 transition" />
        </div>
        <p id="auth-error" class="hidden text-xs text-rose-400 font-bold"></p>
        <button id="auth-submit" type="submit" class="w-full bg-emerald-500 hover:bg-emerald-400 disabled:opacity-60 disabled:cursor-not-allowed text-slate-950 font-black py-3 rounded-xl text-xs transition cursor-pointer"></button>
      </form>
      <div class="text-center text-xs text-slate-300 border-t border-slate-800 pt-3">
        <span id="auth-prompt"></span>
        <button id="auth-toggle" type="button" class="text-emerald-400 font-bold mr-1 underline cursor-pointer"></button>
      </div>
    </div>
  `;
}

export function renderLogin(container) {
  if (getSession().user) {
    navigate('dashboard');
    return;
  }

  let mode = 'login';
  container.innerHTML = `<div class="py-16 px-4 max-w-md mx-auto animate-fade-in">${loginMarkup()}</div>`;

  const form = container.querySelector('#auth-form');
  const errorText = container.querySelector('#auth-error');
  const submit = container.querySelector('#auth-submit');

  function applyMode() {
    const copy = COPY[mode];
    container.querySelector('#auth-title').textContent = copy.title;
    container.querySelector('#auth-subtitle').textContent = copy.subtitle;
    container.querySelector('#auth-prompt').textContent = copy.prompt;
    container.querySelector('#auth-toggle').textContent = copy.toggle;
    submit.textContent = copy.submit;
    form.elements.password.autocomplete = mode === 'login' ? 'current-password' : 'new-password';
    errorText.classList.add('hidden');
  }

  function showError(message) {
    errorText.textContent = message;
    errorText.classList.remove('hidden');
  }

  container.querySelector('#auth-toggle').addEventListener('click', () => {
    mode = mode === 'login' ? 'signup' : 'login';
    applyMode();
  });

  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const email = form.elements.email.value.trim();
    const password = form.elements.password.value;
    if (!email || password.length < 6) {
      showError('أدخل بريداً صحيحاً وكلمة مرور من 6 أحرف على الأقل');
      return;
    }

    submit.disabled = true;
    submit.textContent = 'جاري المعالجة...';

    if (mode === 'login') {
      const { error } = await signIn(email, password);
      if (error) {
        showError(authErrorMessage(error));
        submit.disabled = false;
        submit.textContent = COPY.login.submit;
        return;
      }
      showToast('تم تسجيل الدخول بنجاح', 'success');
      navigate('dashboard');
      return;
    }

    const { error, hasSession } = await signUp(email, password);
    if (error) {
      showError(authErrorMessage(error));
      submit.disabled = false;
      submit.textContent = COPY.signup.submit;
      return;
    }
    if (hasSession) {
      showToast('تم إنشاء الحساب بنجاح', 'success');
      navigate('dashboard');
      return;
    }

    const signInResult = await signIn(email, password);
    if (signInResult.error) {
      mode = 'login';
      applyMode();
      showToast('تم إنشاء الحساب، سجّل الدخول للمتابعة', 'success');
      return;
    }
    showToast('تم إنشاء الحساب بنجاح', 'success');
    navigate('dashboard');
  });

  applyMode();
}
