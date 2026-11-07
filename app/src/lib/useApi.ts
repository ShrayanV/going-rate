"use client";
import { useEffect, useState } from "react";

export type ApiState<T> = { data: T | null; loading: boolean; error: string | null; available: boolean };

type Result<T> = { path: string; data: T | null; error: string | null };

/**
 * Fetch `/api/mb${path}` (or any app route when `path` starts with "/api/").
 * Each caller loads independently so sections can show their own skeletons.
 * State is keyed by path, so "loading" is derived rather than set in the effect.
 */
export function useApi<T>(path: string | null): ApiState<T> {
  const [result, setResult] = useState<Result<T> | null>(null);

  useEffect(() => {
    if (!path) return;
    let alive = true;
    const url = path.startsWith("/api/") ? path : `/api/mb${path}`;
    fetch(url)
      .then(async (r) => {
        const j = (await r.json().catch(() => ({}))) as { data?: T; detail?: string; message?: string };
        if (!alive) return;
        if (!r.ok) setResult({ path, data: null, error: j.detail || j.message || `HTTP ${r.status}` });
        else setResult({ path, data: (j.data ?? null) as T | null, error: null });
      })
      .catch((e) => alive && setResult({ path, data: null, error: String(e) }));
    return () => {
      alive = false;
    };
  }, [path]);

  if (!path) return { data: null, loading: false, error: null, available: false };
  if (!result || result.path !== path) return { data: null, loading: true, error: null, available: false };
  return { data: result.data, loading: false, error: result.error, available: result.data !== null };
}
