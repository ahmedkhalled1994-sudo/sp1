import './styles.css';
import '@fortawesome/fontawesome-free/css/all.min.css';

import { renderNav } from './components/nav.js';
import { renderAdmin } from './views/admin.js';
import { renderAdminPricing } from './views/admin-pricing.js';
import { renderDashboard } from './views/dashboard.js';
import { renderHome } from './views/home.js';
import { renderLive } from './views/live.js';
import { renderLogin } from './views/login.js';
import { renderPrivacy, renderTerms } from './views/legal.js';
import { renderPricing } from './views/pricing.js';
import { renderSuccess } from './views/success.js';

import { initSession, onSessionChange } from './lib/session.js';
import { startRouter } from './lib/router.js';

const ROUTES = {
  home: renderHome,
  pricing: renderPricing,
  dashboard: renderDashboard,
  success: renderSuccess,
  login: renderLogin,
  admin: renderAdmin,
  'admin-pricing': renderAdminPricing,
  terms: renderTerms,
  privacy: renderPrivacy,
};

async function boot() {
  const nav = document.getElementById('nav');
  const app = document.getElementById('app');

  const liveSlug = new URLSearchParams(window.location.search).get('p');

  if (liveSlug) {
    nav.hidden = true;
    await renderLive(app, liveSlug);
    return;
  }

  onSessionChange(() => renderNav(nav));

  const SESSION_TIMEOUT_MS = 4000;

  try {
    await Promise.race([
      initSession(),
      new Promise((resolve) => setTimeout(resolve, SESSION_TIMEOUT_MS)),
    ]);
  } catch (error) {
    console.error(error);
  }

  renderNav(nav);
  startRouter(app, ROUTES);
}

boot();