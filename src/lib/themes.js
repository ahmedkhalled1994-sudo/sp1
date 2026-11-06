const THEMES = {
  emerald: {
    bg: 'bg-slate-950',
    text: 'text-slate-100',
    iconBg: 'bg-linear-to-tr from-emerald-500 to-teal-400 text-slate-950 shadow-emerald-500/20',
    badge: 'bg-emerald-500/10 border-emerald-500/20 text-emerald-400',
    callBtn: 'bg-emerald-500 hover:bg-emerald-400 text-slate-950 shadow-emerald-500/30',
    badgeIcon: 'text-emerald-400',
    tagColor: 'text-emerald-400',
  },
  blue: {
    bg: 'bg-slate-950',
    text: 'text-slate-100',
    iconBg: 'bg-linear-to-tr from-blue-600 to-cyan-500 text-white shadow-blue-500/25',
    badge: 'bg-blue-500/10 border-blue-500/20 text-blue-400',
    callBtn: 'bg-blue-600 hover:bg-blue-500 text-white shadow-blue-600/35',
    badgeIcon: 'text-blue-400',
    tagColor: 'text-blue-400',
  },
  gold: {
    bg: 'bg-neutral-950',
    text: 'text-amber-50',
    iconBg: 'bg-linear-to-tr from-amber-500 to-yellow-400 text-neutral-950 shadow-amber-500/25',
    badge: 'bg-amber-500/10 border-amber-500/20 text-amber-400',
    callBtn:
      'bg-linear-to-r from-amber-500 to-yellow-400 hover:from-amber-400 hover:to-yellow-300 text-neutral-950 shadow-amber-500/30',
    badgeIcon: 'text-amber-400',
    tagColor: 'text-amber-400',
  },
};

export function getTheme(name) {
  return THEMES[name] || THEMES.emerald;
}
