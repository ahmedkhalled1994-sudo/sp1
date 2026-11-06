import { HOURS_OPTIONS, ICON_OPTIONS } from './constants.js';

const PHONE_RE = /^\+?[0-9]{6,20}$/;
const SLUG_RE = /^[a-z0-9\u0600-\u06FF-]{3,40}$/;
const INSTAGRAM_RE = /^[A-Za-z0-9._]{1,30}$/;
const SNAPCHAT_RE = /^[A-Za-z0-9._-]{1,30}$/;
const TIKTOK_RE = /^[A-Za-z0-9._]{1,30}$/;
const CONVERSION_LABEL_RE = /^AW-\d{6,}\/[A-Za-z0-9_-]{4,}$/;

export function slugify(value) {
  return value
    .trim()
    .toLowerCase()
    .replace(/\s+/g, '-')
    .replace(/[^a-z0-9\u0600-\u06FF-]/g, '')
    .replace(/-+/g, '-')
    .replace(/^-|-$/g, '');
}

function cleanPhone(value) {
  return String(value || '').replace(/[\s-]/g, '');
}

function cleanHandle(value) {
  return String(value || '').trim().replace(/^@/, '');
}

export function isValidConversionLabel(value) {
  return CONVERSION_LABEL_RE.test(value);
}

export function validatePageInput(raw, { isNew }) {
  const errors = {};
  const values = {};

  const title = String(raw.title || '').trim();
  if (title.length < 2 || title.length > 120) {
    errors.title = 'أدخل اسم النشاط (من حرفين إلى 120 حرفاً)';
  }
  values.title = title;

  const description = String(raw.description || '').trim();
  if (description.length > 500) errors.description = 'الوصف يجب ألا يتجاوز 500 حرف';
  values.description = description;

  const phone = cleanPhone(raw.phone);
  if (!PHONE_RE.test(phone)) errors.phone = 'أدخل رقم اتصال صحيحاً مع رمز الدولة، مثال: 96599999999';
  values.phone = phone;

  if (!ICON_OPTIONS.some((option) => option.value === raw.icon)) errors.icon = 'اختر مجال النشاط';
  values.icon = raw.icon;

  const hoursMode = raw.hours_mode;
  if (!HOURS_OPTIONS.some((option) => option.value === hoursMode)) errors.hours_mode = 'اختر نظام أوقات العمل';
  values.hours_mode = hoursMode;

  values.hours_from = '';
  values.hours_to = '';

  if (hoursMode === 'custom') {
    const from = String(raw.hours_from || '').trim();
    const to = String(raw.hours_to || '').trim();
    if (!from || from.length > 30) errors.hours_from = 'أدخل وقت البداية';
    if (!to || to.length > 30) errors.hours_to = 'أدخل وقت النهاية';
    values.hours_from = from;
    values.hours_to = to;
  }

  const whatsapp = cleanPhone(raw.whatsapp);
  if (whatsapp && !PHONE_RE.test(whatsapp)) errors.whatsapp = 'رقم الواتساب غير صحيح';
  values.whatsapp = whatsapp;

  const instagram = cleanHandle(raw.instagram);
  if (instagram && !INSTAGRAM_RE.test(instagram)) errors.instagram = 'اسم المستخدم غير صحيح';
  values.instagram = instagram;

  const snapchat = cleanHandle(raw.snapchat);
  if (snapchat && !SNAPCHAT_RE.test(snapchat)) errors.snapchat = 'اسم المستخدم غير صحيح';
  values.snapchat = snapchat;

  const tiktok = cleanHandle(raw.tiktok);
  if (tiktok && !TIKTOK_RE.test(tiktok)) errors.tiktok = 'اسم المستخدم غير صحيح';
  values.tiktok = tiktok;

  const conversionLabel = String(raw.conversion_label || '').trim();
  if (conversionLabel && !isValidConversionLabel(conversionLabel)) {
    errors.conversion_label = 'الكود ناقص أو غير صحيح. يجب أن يحتوي على رقم الحساب ورمز التحويل معاً، مثال: AW-123456789/AbC_DeF';
  }
  values.conversion_label = conversionLabel;

  const services = String(raw.services || '')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean);
  if (services.length > 10) errors.services = 'أضف 10 خدمات كحد أقصى';
  else if (services.some((line) => line.length > 80)) errors.services = 'كل خدمة يجب ألا تتجاوز 80 حرفاً';
  values.services = services.join('\n');

  const serviceArea = String(raw.service_area || '').trim();
  if (serviceArea.length > 150) errors.service_area = 'منطقة الخدمة يجب ألا تتجاوز 150 حرفاً';
  values.service_area = serviceArea;

  if (isNew) {
    const slug = slugify(raw.slug || title);
    if (!SLUG_RE.test(slug)) {
      errors.slug = 'الرابط يجب أن يكون من 3 إلى 40 حرفاً (إنجليزية أو عربية أو أرقام أو -)';
    }
    values.slug = slug;
  }

  return { values, errors };
}