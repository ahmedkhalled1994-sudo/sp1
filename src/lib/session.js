import { supabase } from './supabase.js';

const state = { user: null, isAdmin: false };
const listeners = new Set();

export function getSession() {
  return state;
}

export function onSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

async function refreshAdminFlag() {
  if (!state.user) {
    state.isAdmin = false;
    return;
  }
  const { data, error } = await supabase.rpc('is_admin');
  if (error) console.error(error);
  state.isAdmin = !error && data === true;
}

async function applyUser(user) {
  state.user = user ?? null;
  await refreshAdminFlag();
  listeners.forEach((listener) => listener(state));
}

export async function initSession() {
  const { data } = await supabase.auth.getSession();
  await applyUser(data?.session?.user ?? null);

  supabase.auth.onAuthStateChange((_event, session) => {
    (async () => {
      await applyUser(session?.user ?? null);
    })();
  });
}

export async function signIn(email, password) {
  const { error } = await supabase.auth.signInWithPassword({ email, password });
  return { error };
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  return { error, hasSession: Boolean(data?.session) };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error(error);
}
