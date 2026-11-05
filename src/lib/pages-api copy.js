import { supabase } from './supabase.js';

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
  const { data, error } = await supabase.rpc('get_public_page', { p_slug: slug });
  if (error) return { data: null, error };
  return { data: data?.[0] ?? null, error: null };
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