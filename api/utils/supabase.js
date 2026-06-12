const { createClient } = require('@supabase/supabase-js');

// Estas variables deben configurarse en el panel de Vercel (Project Settings -> Environment Variables)
const supabaseUrl = process.env.SUPABASE_URL || '';
const supabaseKey = process.env.SUPABASE_SERVICE_ROLE_KEY || ''; // Usamos Service Role para saltar RLS desde el backend

let supabase = null;

if (supabaseUrl && supabaseKey) {
    supabase = createClient(supabaseUrl, supabaseKey);
}

module.exports = { supabase };
