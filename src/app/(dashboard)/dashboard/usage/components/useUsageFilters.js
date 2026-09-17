"use client";

import { useCallback, useMemo } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";

// Global usage filters. Kept in the URL so Overview, Details and drill-downs
// all share the same view, and the state survives reloads.
export const USAGE_FILTER_KEYS = ["provider", "model", "connectionId", "status", "apiKeyId", "endpoint", "q"];

export function useUsageFilters() {
  const searchParams = useSearchParams();
  const router = useRouter();
  const pathname = usePathname();

  const filters = useMemo(() => {
    const next = {};
    for (const key of USAGE_FILTER_KEYS) {
      const value = searchParams.get(key);
      if (value) next[key] = value;
    }
    return next;
  }, [searchParams]);

  const queryString = useMemo(() => {
    const params = new URLSearchParams();
    for (const [key, value] of Object.entries(filters)) {
      params.set(key, value);
    }
    return params.toString();
  }, [filters]);

  const patchFilters = useCallback(
    (patch) => {
      const params = new URLSearchParams(searchParams.toString());
      for (const [key, value] of Object.entries(patch || {})) {
        if (value === null || value === undefined || value === "") {
          params.delete(key);
        } else {
          params.set(key, String(value));
        }
      }
      // A different provider invalidates the dependent connection/model choice.
      if ("provider" in (patch || {}) && !("connectionId" in (patch || {}))) {
        params.delete("connectionId");
      }
      router.replace(`${pathname}?${params.toString()}`, { scroll: false });
    },
    [searchParams, router, pathname]
  );

  const clearFilters = useCallback(() => {
    const params = new URLSearchParams(searchParams.toString());
    for (const key of USAGE_FILTER_KEYS) {
      params.delete(key);
    }
    router.replace(`${pathname}?${params.toString()}`, { scroll: false });
  }, [searchParams, router, pathname]);

  return {
    filters,
    queryString,
    patchFilters,
    clearFilters,
    activeCount: Object.keys(filters).length,
  };
}
