export function showToast(message, tone = 'info') {
  const toneClass = {
    info: 'border-slate-700 text-slate-200',
    error: 'border-rose-500/40 text-rose-300',
    success: 'border-emerald-500/40 text-emerald-300',
  }[tone];

  const toast = document.createElement('div');
  toast.setAttribute('role', 'status');
  toast.className = `fixed bottom-6 left-1/2 -translate-x-1/2 z-[100] max-w-[90vw] bg-slate-900 border ${toneClass} px-5 py-3 rounded-2xl text-xs font-bold shadow-2xl transition-all duration-300 opacity-0 translate-y-2`;
  toast.textContent = message;
  document.body.append(toast);

  requestAnimationFrame(() => toast.classList.remove('opacity-0', 'translate-y-2'));
  setTimeout(() => {
    toast.classList.add('opacity-0');
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    const field = document.createElement('textarea');
    field.value = text;
    field.setAttribute('readonly', '');
    field.style.position = 'fixed';
    field.style.opacity = '0';
    document.body.append(field);
    field.select();
    const copied = document.execCommand('copy');
    field.remove();
    return copied;
  }
}
