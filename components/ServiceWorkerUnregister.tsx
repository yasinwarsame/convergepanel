"use client";

/**
 * Service Worker Unregister Component
 * 
 * Prevents service worker caching in development mode which can cause
 * ChunkLoadError when assets change between builds.
 * 
 * This component unregisters any existing service workers in development
 * to prevent stale cache issues.
 */

import { useEffect } from "react";

export function ServiceWorkerUnregister() {
  useEffect(() => {
    // Always unregister service workers in both dev and production
    // Service workers can cause RSC fetch failures during navigation
    // and can intercept /login, /signup, /api/* routes incorrectly
    if (typeof window !== "undefined" && "serviceWorker" in navigator) {
      navigator.serviceWorker.getRegistrations().then((registrations) => {
        for (const registration of registrations) {
          registration.unregister().then((success) => {
            if (success) {
              console.log("[ServiceWorker] Unregistered service worker");
            }
          }).catch((error) => {
            console.error("[ServiceWorker] Error unregistering:", error);
          });
        }
      }).catch((error) => {
        console.error("[ServiceWorker] Error getting registrations:", error);
      });
    }
  }, []);

  return null;
}

