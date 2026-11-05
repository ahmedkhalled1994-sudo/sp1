export function el(tag, className = '', text = '') {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text) node.textContent = text;
  return node;
}

export function escapeHtml(value = '') {
  return String(value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

export function messageBlock(text, tone = 'info') {
  const toneClass = {
    info: 'text-slate-300',
    error: 'text-rose-400',
    success: 'text-emerald-400',
  }[tone];

  return el(
    'div',
    `glass-card rounded-3xl p-8 text-center text-sm font-bold ${toneClass} animate-fade-in`,
    text,
  );
}