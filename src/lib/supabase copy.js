import { createClient } from '@supabase/supabase-js';

// مفاتيح مشروعك في Supabase مدمجة وجاهزة
const supabaseUrl = import.meta.env.VITE_SUPABASE_URL || 'https://mszascmznonamazckdqo.supabase.co';
const supabaseAnonKey = import.meta.env.VITE_SUPABASE_ANON_KEY || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1zemFzY216bm9uYW1hemNrZHFvIiwicm9sZSI6ImFub24iLCJpYXQiOjE3OTM1NTMwMzUsImV4cCI6MjEwOTEyOTAzNX0.F9xZQBApnfIRuYDU4VU4_63NtByGUdGKFJBqD0s2Pwg';

export const supabase = createClient(supabaseUrl, supabaseAnonKey, {
  auth: {
    persistSession: true,
    autoRefreshToken: true,
  },
});