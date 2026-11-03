const CONVERSION_SCRIPT_ID = 'google-ads-gtag';

function ensureGtag(adsId) {
  if (document.getElementById(CONVERSION_SCRIPT_ID)) return;

  const script = document.createElement('script');
  script.id = CONVERSION_SCRIPT_ID;
  script.async = true;
  script.src = `https://www.googletagmanager.com/gtag/js?id=${encodeURIComponent(adsId)}`;
  document.head.append(script);

  window.dataLayer = window.dataLayer || [];
  window.gtag = function gtag() {
    window.dataLayer.push(arguments);
  };
  window.gtag('js', new Date());
  window.gtag('config', adsId);
}

export function trackConversion(label) {
  if (!label) return;
  const adsId = label.split('/')[0];
  ensureGtag(adsId);
  window.gtag('event', 'conversion', { send_to: label });
}

export function setPageSeo(page) {
  document.title = `${page.title} | سبيد لاندنج`;

  let description = document.querySelector('meta[name="description"]');
  if (!description) {
    description = document.createElement('meta');
    description.name = 'description';
    document.head.append(description);
  }
  description.content = page.description || page.title;

  let schema = document.getElementById('page-schema');
  if (!schema) {
    schema = document.createElement('script');
    schema.id = 'page-schema';
    schema.type = 'application/ld+json';
    document.head.append(schema);
  }
  schema.textContent = JSON.stringify({
    '@context': 'https://schema.org',
    '@type': 'LocalBusiness',
    name: page.title,
    description: page.description,
    telephone: page.phone,
  });
}
