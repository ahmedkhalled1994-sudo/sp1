import { logPageEvent } from './pages-api.js';

const BOT_PATTERN = /bot|spider|crawl|scraper|headless|selenium|phantom|puppeteer|playwright/i;
const MAX_WAIT_MS = 1000;

export function isAutomatedBot() {
  return Boolean(navigator.webdriver) || BOT_PATTERN.test(navigator.userAgent);
}

export function setupGoogleAdsTracking(gtagLabel) {
  const accountId = String(gtagLabel || '').split('/')[0];
  if (!/^AW-\d+$/.test(accountId) || document.getElementById('google-ads-tag')) return;

  const script = document.createElement('script');
  script.id = 'google-ads-tag';
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(accountId)}`;
  document.head.appendChild(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', accountId);
}

function withTimeout(promise, fallback) {
  return Promise.race([
    promise.catch(() => fallback),
    new Promise((resolve) => setTimeout(() => resolve(fallback), MAX_WAIT_MS)),
  ]);
}

function sendConversion(gtagLabel, currency, contactMethod) {
  if (typeof window.gtag !== 'function' || !String(gtagLabel || '').includes('/')) {
    return Promise.resolve();
  }

  return new Promise((resolve) => {
    setTimeout(resolve, MAX_WAIT_MS);
    try {
      window.gtag('event', 'conversion', {
        send_to: gtagLabel,
        value: 1.0,
        currency,
        contact_method: contactMethod,
        transport_type: 'beacon',
        event_callback: resolve,
      });
    } catch {
      resolve();
    }
  });
}

export function createContactTracker({ slug, gtagLabel, currency, isPreview }) {
  const cooldown = { call: false, whatsapp: false };

  async function track(eventType) {
    if (isPreview || isAutomatedBot() || cooldown[eventType]) return;

    cooldown[eventType] = true;
    setTimeout(() => {
      cooldown[eventType] = false;
    }, 2500);

    // A timeout counts as genuine so a slow network never costs the customer a real conversion.
    const counted = await withTimeout(logPageEvent(slug, eventType), true);
    if (counted) await sendConversion(gtagLabel, currency, eventType);
  }

  return {
    async trackCall(telHref) {
      await track('call');
      window.location.href = telHref;
    },
    trackWhatsapp() {
      track('whatsapp');
    },
    trackView() {
      if (isPreview || isAutomatedBot()) return;
      logPageEvent(slug, 'view').catch(() => {});
    },
  };
}
