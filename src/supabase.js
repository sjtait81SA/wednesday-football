import { createClient } from "@supabase/supabase-js";

const url = import.meta.env.VITE_SUPABASE_URL;
const anonKey = import.meta.env.VITE_SUPABASE_ANON_KEY;

/** Supabase throws if the URL is not http(s); placeholders like "your_project_url_here" crash the whole app on import. */
function isHttpUrl(s) {
  return typeof s === "string" && /^https?:\/\//i.test(s.trim());
}

export const supabase =
  isHttpUrl(url) && anonKey
    ? createClient(url.trim(), anonKey, {
        auth: {
          detectSessionInUrl: true,
          flowType: "pkce",
        },
      })
    : null;
