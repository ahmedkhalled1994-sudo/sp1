import { supabase } from './supabase.js';

export const AUTH_STATUS = {
  LOADING: 'loading',
  AUTHENTICATED: 'authenticated',
  UNAUTHENTICATED: 'unauthenticated',
  ERROR: 'error',
};

const state = {
  status: AUTH_STATUS.LOADING,
  user: null,
  isAdmin: false,
  error: null,
  lastEvent: null,
};

const listeners = new Set();
let authSubscription = null;

export function getSession() {
  return state;
}

export function onSessionChange(listener) {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

function notifyListeners() {
  listeners.forEach((listener) => {
    try {
      listener(state);
    } catch (err) {
      console.error('Session listener error:', err);
    }
  });
}

async function refreshAdminFlag() {
  if (!state.user) {
    state.isAdmin = false;
    return;
  }
  try {
    const { data, error } = await supabase.rpc('is_admin');
    if (error) {
      console.warn('Could not check admin flag:', error.message);
      state.isAdmin = false;
    } else {
      state.isAdmin = data === true;
    }
  } catch (err) {
    console.warn('Error during is_admin check:', err);
    state.isAdmin = false;
  }
}

async function applySession(session, eventName = null) {
  const user = session?.user ?? null;
  state.lastEvent = eventName;
  state.user = user;
  state.error = null;

  if (user) {
    state.status = AUTH_STATUS.AUTHENTICATED;
    await refreshAdminFlag();
  } else {
    state.status = AUTH_STATUS.UNAUTHENTICATED;
    state.isAdmin = false;
  }

  notifyListeners();
}

export async function initSession() {
  try {
    const { data, error } = await supabase.auth.getSession();
    if (error) {
      state.status = AUTH_STATUS.ERROR;
      state.error = error;
      state.user = null;
      state.isAdmin = false;
      notifyListeners();
    } else {
      await applySession(data?.session ?? null, 'INITIAL_SESSION');
    }
  } catch (err) {
    state.status = AUTH_STATUS.ERROR;
    state.error = err;
    notifyListeners();
  }

  if (!authSubscription) {
    const { data: sub } = supabase.auth.onAuthStateChange(async (event, session) => {
      switch (event) {
        case 'SIGNED_IN':
        case 'TOKEN_REFRESHED':
        case 'INITIAL_SESSION':
          await applySession(session, event);
          break;
        case 'PASSWORD_RECOVERY':
          await applySession(session, event);
          break;
        case 'SIGNED_OUT':
        case 'USER_DELETED':
          state.user = null;
          state.isAdmin = false;
          state.status = AUTH_STATUS.UNAUTHENTICATED;
          state.lastEvent = event;
          notifyListeners();
          break;
        default:
          await applySession(session, event);
          break;
      }
    });
    authSubscription = sub.subscription;
  }

  return state;
}

export function unsubscribeAuth() {
  if (authSubscription) {
    authSubscription.unsubscribe();
    authSubscription = null;
  }
}

export async function signIn(email, password) {
  state.status = AUTH_STATUS.LOADING;
  const { data, error } = await supabase.auth.signInWithPassword({ email, password });
  if (error) {
    state.status = AUTH_STATUS.ERROR;
    state.error = error;
    notifyListeners();
    return { error };
  }
  await applySession(data?.session ?? null, 'SIGNED_IN');
  return { error: null };
}

export async function signUp(email, password) {
  const { data, error } = await supabase.auth.signUp({ email, password });
  return { error, hasSession: Boolean(data?.session) };
}

export async function signOut() {
  const { error } = await supabase.auth.signOut();
  if (error) console.error('SignOut error:', error);
  state.user = null;
  state.isAdmin = false;
  state.status = AUTH_STATUS.UNAUTHENTICATED;
  notifyListeners();
}
