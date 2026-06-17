// Placeholder database types.
//
// Regenerate from the live schema after migrations are applied:
//   supabase gen types typescript --linked > lib/types/db.ts
//
// Kept minimal in PR0 so the app typechecks before generated types exist.
export type Database = Record<string, never>
