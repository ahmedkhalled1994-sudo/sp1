export const ICON_OPTIONS = [
  { value: '🎓', label: 'تدريس وتأسيس منزلي' },
  { value: '📚', label: 'معلمون ودورات' },
  { value: '❄️', label: 'تكييف وتبريد' },
  { value: '🛠️', label: 'صيانة وسباكة' },
  { value: '🚚', label: 'نقل عفش وسطحة' },
  { value: '🏢', label: 'مقاولات وديكور' },
  { value: '⚖️', label: 'محاماة واستشارات' },
  { value: '⚕️', label: 'عيادات وخدمات طبية' },
];

export const HOURS_OPTIONS = [
  { value: '24/7', label: 'متوفرون الآن - 24/7' },
  { value: 'custom', label: 'تحديد وقت مخصص (من... إلى...)' },
  { value: 'appointment', label: 'حسب الموعد المسبق' },
];

export const PLAN_PRICES = {
  monthly: { name: 'الباقة الشهرية', price: '15', period: 'د.ك / شهريًا' },
  annual: { name: 'الباقة السنوية', price: '120', period: 'د.ك / سنويًا' },
};

// عملة التحويل في Google Ads
export const DEFAULT_AD_CURRENCY = 'KWD';