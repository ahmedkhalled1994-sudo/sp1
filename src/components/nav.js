import { navigate } from '../lib/router.js';
import { getSession, signOut } from '../lib/session.js';
import { el } from '../lib/dom.js';

const PUBLIC_LINKS = [
  { route: 'home', label: 'الرئيسية' },
  { route: 'pricing', label: 'الأسعار' },
  { route: 'dashboard', label: 'تصميم الصفحة' },
];

function linkButton(route, label, extraClass = '') {
  const button = el('button', `hover:text-emerald-400 transition cursor-pointer whitespace-nowrap ${extraClass}`, label);
  button.dataset.route = route;
  return button;
}

export function renderNav(nav) {
  const { user, isAdmin } = getSession();

  const inner = el('div', 'max-w-6xl mx-auto px-4 py-3.5 flex items-center justify-between gap-4');

  const brand = el('button', 'flex items-center gap-2.5 cursor-pointer shrink-0');
  brand.dataset.route = 'home';
  brand.innerHTML = `<span class="w-9 h-9 bg-linear-to-tr from-emerald-500 to-teal-400 rounded-xl flex items-center justify-center text-slate-950 font-black text-lg shadow-lg shadow-emerald-500/20">⚡</span><span class="font-black text-lg text-white tracking-tight">سبيد <span class="text-emerald-400">لاندنج</span></span>`;

  const links = el('div', 'flex items-center gap-4 md:gap-8 text-xs md:text-sm font-semibold text-slate-300 overflow-x-auto');
  PUBLIC_LINKS.forEach(({ route, label }) => links.append(linkButton(route, label)));
  if (isAdmin) links.append(linkButton('admin', 'لوحة الإدارة', 'text-amber-400 hover:text-amber-300 font-bold'));

  const auth = el('div', 'flex items-center gap-3 shrink-0');
  if (user) {
    const badge = el('span', 'hidden sm:inline text-xs bg-slate-900 border border-slate-800 text-emerald-400 px-3 py-1.5 rounded-xl font-bold');
    badge.textContent = `${isAdmin ? 'المدير: ' : ''}${user.email.split('@')[0]}`;
    const logout = el('button', 'text-xs bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-400 font-bold px-3 py-1.5 rounded-xl transition cursor-pointer', 'خروج');
    logout.dataset.action = 'logout';
    auth.append(badge, logout);
  } else {
    const login = el('button', 'text-xs md:text-sm text-slate-300 hover:text-white font-bold px-3 py-2 rounded-xl transition cursor-pointer', 'دخول');
    login.dataset.route = 'login';
    const cta = el('button', 'bg-linear-to-r from-emerald-500 to-teal-400 hover:from-emerald-400 hover:to-teal-300 text-slate-950 font-black text-xs md:text-sm px-4 py-2.5 rounded-xl shadow-lg shadow-emerald-500/20 transition active:scale-95 cursor-pointer whitespace-nowrap', 'جرب الآن مجاناً');
    cta.dataset.route = 'dashboard';
    auth.append(login, cta);
  }

  inner.append(brand, links, auth);
  nav.replaceChildren(inner);

  nav.onclick = async (event) => {
    const routeButton = event.target.closest('[data-route]');
    if (routeButton) {
      navigate(routeButton.dataset.route);
      return;
    }
    const logoutButton = event.target.closest('[data-action="logout"]');
    if (logoutButton) {
      await signOut();
      navigate('home');
    }
  };
}
