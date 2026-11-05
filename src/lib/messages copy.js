export function friendlyError(error, fallback = 'حدث خطأ غير متوقع، حاول مرة أخرى') {
  if (error) console.error(error);
  if (error?.code === '23505') return 'هذا الرابط مستخدم بالفعل، اختر رابطاً آخر';
  if (error?.code === '42501') return 'ليست لديك صلاحية لتنفيذ هذا الإجراء';
  return fallback;
}

export function authErrorMessage(error) {
  console.error(error);
  const message = (error?.message || '').toLowerCase();
  if (message.includes('invalid login credentials')) return 'البريد الإلكتروني أو كلمة المرور غير صحيحة';
  if (message.includes('already registered') || message.includes('already exists')) {
    return 'تعذر إنشاء الحساب بهذا البريد. إذا كان لديك حساب فسجّل الدخول.';
  }
  if (message.includes('email not confirmed')) return 'يرجى تأكيد بريدك الإلكتروني أولاً';
  if (message.includes('rate limit') || message.includes('too many')) return 'تم تجاوز عدد المحاولات، حاول بعد قليل';
  if (message.includes('password')) return 'كلمة المرور يجب أن تكون 6 أحرف على الأقل';
  if (message.includes('email')) return 'البريد الإلكتروني غير صالح';
  return 'تعذر إكمال العملية، حاول مرة أخرى';
}
