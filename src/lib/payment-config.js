export const DISABLED_PAYMENT_MESSAGE =
  'الدفع الإلكتروني غير متاح حالياً، نعمل على تجهيز خدمة الدفع وسيتم تفعيلها قريباً.';

export const PLAN_NUMBERS = [1, 2, 3];

export const PLAN_TITLES = {
  1: 'الباقة الشهرية',
  2: 'باقة الـ 3 أشهر',
  3: 'الباقة السنوية',
};

export const CONNECTION_STATUS_LABELS = {
  disabled: 'غير مفعّل',
  awaiting_credentials: 'بانتظار بيانات الربط',
  test_mode: 'الوضع الاختباري',
  ready_after_test: 'جاهز للتفعيل بعد الاختبار',
  live_connected: 'متصل بالوضع المباشر',
};

export const MODE_LABELS = {
  disabled: 'غير مفعّل',
  test: 'اختباري',
  live: 'مباشر',
};

export const WEBHOOK_STATUS_LABELS = {
  disabled: 'غير مفعّل (لا يتم استقبال إشعارات الدفع)',
  pending_secret: 'بانتظار بيانات الربط (يلزم ضبط مفاتيح توقيع Webhook في الخادم)',
  test_ready: 'مجهز للوضع الاختباري (HMAC-SHA256 مفعل لطلبات Test Mode فقط)',
  ready_after_test: 'جاهز للتفعيل بعد الاختبار',
  verified_live: 'متصل بالوضع المباشر (HMAC-SHA256 مفعل ومؤمن)',
};

const ZERO_DECIMAL_CURRENCIES = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'ISK', 'JPY', 'KMF', 'KRW',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

const THREE_DECIMAL_CURRENCIES = new Set([
  'BHD', 'IQD', 'JOD', 'KWD', 'LYD', 'OMR', 'TND',
]);

export function getCurrencyExponent(currencyCode = 'KWD') {
  const code = String(currencyCode || 'KWD').trim().toUpperCase();
  if (ZERO_DECIMAL_CURRENCIES.has(code)) return 0;
  if (THREE_DECIMAL_CURRENCIES.has(code)) return 3;
  return 2;
}

export function formatMinorUnits(amount, currencyCode = 'KWD') {
  if (typeof amount !== 'number' || !Number.isFinite(amount)) return '-';
  const code = String(currencyCode || 'KWD').trim().toUpperCase();
  const exponent = getCurrencyExponent(code);
  const divisor = 10 ** exponent;
  return `${(amount / divisor).toFixed(exponent)} ${code}`;
}

export function evaluateCustomerPaymentAvailability(data) {
  if (!data || typeof data !== 'object') {
    return {
      providerEnabled: false,
      mode: 'disabled',
      onlinePlans: { 1: false, 2: false, 3: false },
    };
  }

  const rawMode = data.payment_mode || data.payment_provider_mode || 'disabled';
  const mode = typeof rawMode === 'string' ? rawMode.trim().toLowerCase() : 'disabled';
  const enabled = data.payment_provider_enabled === true && (mode === 'test' || mode === 'live');

  if (!enabled) {
    return {
      providerEnabled: false,
      mode: 'disabled',
      onlinePlans: { 1: false, 2: false, 3: false },
    };
  }

  const liveVars = [
    String(data.plan1_variant_id ?? '').trim(),
    String(data.plan2_variant_id ?? '').trim(),
    String(data.plan3_variant_id ?? '').trim(),
  ];
  const testVars = [
    String(data.plan1_test_variant_id ?? '').trim(),
    String(data.plan2_test_variant_id ?? '').trim(),
    String(data.plan3_test_variant_id ?? '').trim(),
  ];

  // Strictly forbid collision between Test Mode and Live Mode variant IDs
  const liveSet = new Set(liveVars.filter((v) => v !== ''));
  for (const tv of testVars) {
    if (tv !== '' && liveSet.has(tv)) {
      return {
        providerEnabled: false,
        mode: 'disabled',
        onlinePlans: { 1: false, 2: false, 3: false },
      };
    }
  }

  const activeVars = mode === 'test' ? testVars : liveVars;
  const isValidVariant = (idx) => {
    const v = activeVars[idx];
    if (!/^\d{1,20}$/.test(v)) return false;
    return activeVars.filter((item) => item === v).length === 1;
  };

  const onlinePlans = {
    1: isValidVariant(0),
    2: isValidVariant(1),
    3: isValidVariant(2),
  };

  const anyValid = onlinePlans[1] || onlinePlans[2] || onlinePlans[3];

  return {
    providerEnabled: anyValid,
    mode: anyValid ? mode : 'disabled',
    onlinePlans,
  };
}

export function resolveDisplayStatus(row, verifiedStatusResponse = null) {
  const mode = String(row?.payment_mode || row?.payment_provider_mode || 'disabled').trim().toLowerCase();
  const enabled = Boolean(row?.payment_provider_enabled) && mode !== 'disabled';

  if (!enabled || mode === 'disabled') {
    return 'disabled';
  }

  // Never show a connected status unless a real server configuration check has succeeded
  const checkStatus = verifiedStatusResponse?.status || row?.last_config_check_status || '';
  const hasRealCheckTimestamp = Boolean(
    verifiedStatusResponse?.checked_at || row?.last_config_check_at || row?.last_verified_at,
  );

  if (!hasRealCheckTimestamp) {
    return 'awaiting_credentials';
  }

  if (mode === 'live') {
    return checkStatus === 'live_connected' && verifiedStatusResponse?.status === 'live_connected'
      ? 'live_connected'
      : 'awaiting_credentials';
  }

  if (mode === 'test') {
    if (checkStatus === 'ready_after_test') return 'ready_after_test';
    if (checkStatus === 'test_mode') return 'test_mode';
    return 'awaiting_credentials';
  }

  return 'awaiting_credentials';
}

export function validatePaymentSettingsValues(values) {
  if (!Number.isInteger(values.trial_days) || values.trial_days < 1 || values.trial_days > 30) {
    return 'مدة التجربة يجب أن تكون عدداً صحيحاً بين 1 و 30';
  }

  if (values.store_id && !/^\d{1,20}$/.test(values.store_id)) {
    return 'معرف المتجر (Store ID) في Lemon Squeezy يجب أن يتكون من أرقام فقط';
  }

  const testVariants = [];
  const liveVariants = [];

  for (const number of PLAN_NUMBERS) {
    const days = values[`plan${number}_days`];
    if (!Number.isInteger(days) || days < 1 || days > 366) {
      return `عدد أيام ${PLAN_TITLES[number]} يجب أن يكون بين 1 و 366`;
    }

    const liveVar = values[`plan${number}_variant_id`] || '';
    const testVar = values[`plan${number}_test_variant_id`] || '';

    if (liveVar && !/^\d{1,20}$/.test(liveVar)) {
      return `معرف المنتج المباشر (Live Variant ID) لـ ${PLAN_TITLES[number]} يجب أن يكون أرقاماً فقط`;
    }
    if (testVar && !/^\d{1,20}$/.test(testVar)) {
      return `معرف المنتج الاختباري (Test Variant ID) لـ ${PLAN_TITLES[number]} يجب أن يكون أرقاماً فقط`;
    }

    if ((liveVar || testVar) && !/[0-9٠-٩]/.test(values[`plan${number}_new_price`])) {
      return `سعر العرض لـ ${PLAN_TITLES[number]} يجب أن يحتوي على رقم، لأنه المبلغ الذي سيُدفع أونلاين`;
    }

    if (liveVar) liveVariants.push(liveVar);
    if (testVar) testVariants.push(testVar);
  }

  if (new Set(liveVariants).size !== liveVariants.length) {
    return 'لا يمكن تكرار نفس معرف المنتج المباشر (Live Variant ID) لأكثر من باقة واحدة';
  }
  if (new Set(testVariants).size !== testVariants.length) {
    return 'لا يمكن تكرار نفس معرف المنتج الاختباري (Test Variant ID) لأكثر من باقة واحدة';
  }

  const liveSet = new Set(liveVariants);
  for (const tv of testVariants) {
    if (liveSet.has(tv)) {
      return 'لا يجوز استخدام نفس معرف المنتج (Variant ID) في الوضع الاختباري والوضع المباشر معاً؛ لكل وضع معرفات مستقلة في Lemon Squeezy';
    }
  }

  return null;
}
