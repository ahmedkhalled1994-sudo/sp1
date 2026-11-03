import { createPageCard } from '../components/page-card.js';
import { trackConversion, setPageSeo } from '../lib/analytics.js';
import { fetchPublicPage, recordCallClick, recordPageView } from '../lib/pages-api.js';
import { el, messageBlock } from '../lib/dom.js';

function showState(container, text, tone = 'info') {
  const wrapper = el('div', 'min-h-screen flex items-center justify-center p-4');
  wrapper.append(messageBlock(text, tone));
  container.replaceChildren(wrapper);
}

export async function renderLive(container, slug) {
  showState(container, 'جاري تحميل الصفحة...');

  const { data: page, error } = await fetchPublicPage(slug);
  if (error) {
    showState(container, 'تعذر تحميل الصفحة، حاول مرة أخرى بعد قليل.', 'error');
    return;
  }
  if (!page) {
    showState(container, 'عذراً، هذه الصفحة غير موجودة.', 'error');
    return;
  }
  if (!page.is_active) {
    showState(container, 'عذراً، هذه الصفحة متوقفة مؤقتاً.', 'error');
    return;
  }

  const card = createPageCard(page, {
    interactive: true,
    onCall: () => {
      recordCallClick(page.slug);
      trackConversion(page.conversion_label);
    },
  });

  const layout = el('div', 'min-h-screen flex flex-col items-center justify-center p-4 gap-6 animate-fade-in');
  layout.append(card, el('p', 'text-center text-[11px] text-slate-400', 'صفحة مدعومة بواسطة سبيد لاندنج'));
  container.replaceChildren(layout);

  setPageSeo(page);
  recordPageView(page.slug);
}
