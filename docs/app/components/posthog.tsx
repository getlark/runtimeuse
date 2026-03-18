import posthog from 'posthog-js';
import { useEffect } from 'react';
import { useLocation } from 'react-router';

const POSTHOG_KEY = import.meta.env.VITE_POSTHOG_PUBLIC_KEY;
const POSTHOG_HOST = import.meta.env.VITE_POSTHOG_HOST;

export function PostHogInit() {
  const location = useLocation();

  useEffect(() => {
    if (!POSTHOG_KEY || typeof window === 'undefined') return;

    posthog.init(POSTHOG_KEY, {
      api_host: POSTHOG_HOST,
      capture_pageview: false,
      capture_pageleave: true,
    });
  }, []);

  useEffect(() => {
    if (!POSTHOG_KEY) return;
    posthog.capture('$pageview');
  }, [location.pathname]);

  return null;
}
