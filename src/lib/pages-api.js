import { supabase } from './supabase.js';

export function publicPageUrl(slug, { returnTo } = {}) {
  const base = `${window.location.origin}${window.location.pathname}?p=${encodeURIComponent(slug)}`;
  return returnTo ? `${base}&back=${encodeURIComponent(returnTo)}` : base;
}

export function fetchMyPage(userId) {
  return supabase.from('pages').select('*').eq('user_id', userId).maybeSingle();
}

export function createPage(values) {
  return supabase.from('pages').insert(values).select().single();
}

export function updatePage(userId, values) {
  return supabase.from('pages').update(values).eq('user_id', userId);
}

export async function fetchPublicPage(slug) {
  try {
    const { data, error } = await supabase.rpc('get_public_page', { p_slug: slug });
    if (error) return { data: null, error };
    return { data: data?.[0] ?? null, error: null };
  } catch (error) {
    return { data: null, error };
  }
}

export function recordPageView(slug) {
  return supabase.rpc('record_page_view', { p_slug: slug });
}

export function recordCallClick(slug) {
  return supabase.rpc('record_call_click', { p_slug: slug });
}

export function fetchAllPages() {
  return supabase
    .from('pages')
    .select('*')
    .order('created_at', { ascending: false });
}

export function setPageActive(id, active) {
  return supabase.rpc('admin_set_page_active', { p_id: id, p_active: active });
}

export function adminUpdatePage(id, values) {
  return supabase.rpc('admin_update_page', {
    p_id: id,
    p_title: values.title,
    p_phone: values.phone,
    p_description: values.description,
    p_theme: values.theme,
    p_working_hours: values.working_hours,
    p_gtag_label: values.gtag_label,
    p_whatsapp: values.whatsapp,
    p_instagram: values.instagram,
    p_snapchat: values.snapchat,
    p_tiktok: values.tiktok,
    p_is_active: values.is_active,
    p_is_trial: values.is_trial,
    p_expires_at: values.expires_at,
  });
}

export function adminExtendSubscription(id, days) {
  return supabase.rpc('admin_extend_subscription', { p_id: id, p_days: days });
}

export function adminDeletePage(id) {
  return supabase.rpc('admin_delete_page', { p_id: id });
}

export function adminBanUser(pageId) {
  return supabase.rpc('admin_ban_user', { p_page_id: pageId });
}

export function adminUnbanUser(userId) {
  return supabase.rpc('admin_unban_user', { p_user_id: userId });
}