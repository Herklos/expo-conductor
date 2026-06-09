import { useColorScheme } from 'react-native';

export const Colors = {
  light: {
    bg: '#f8f9fa',
    card: '#ffffff',
    text: '#111827',
    muted: '#6b7280',
    border: '#e5e7eb',
    accent: '#2563eb',
    accentMuted: '#dbeafe',
    success: '#16a34a',
    successBg: '#dcfce7',
    warning: '#d97706',
    warningBg: '#fef3c7',
    danger: '#dc2626',
    dangerBg: '#fee2e2',
    unexpected: '#7c3aed',
    unexpectedBg: '#ede9fe',
    disabled: '#9ca3af',
    tabBar: '#ffffff',
    tabBarBorder: '#e5e7eb',
    tabActive: '#2563eb',
    tabInactive: '#9ca3af',
    rust: '#b45309',
    rustBg: '#fef3c7',
  },
  dark: {
    bg: '#0f1117',
    card: '#1c1f26',
    text: '#f3f4f6',
    muted: '#9ca3af',
    border: '#374151',
    accent: '#3b82f6',
    accentMuted: '#1e3a5f',
    success: '#4ade80',
    successBg: '#14532d',
    warning: '#fbbf24',
    warningBg: '#451a03',
    danger: '#f87171',
    dangerBg: '#450a0a',
    unexpected: '#a78bfa',
    unexpectedBg: '#2e1065',
    disabled: '#6b7280',
    tabBar: '#1c1f26',
    tabBarBorder: '#374151',
    tabActive: '#3b82f6',
    tabInactive: '#6b7280',
    rust: '#fbbf24',
    rustBg: '#451a03',
  },
} as const;

/** Widened to `string` per-key so light and dark themes are both assignable. */
export type Theme = { readonly [K in keyof typeof Colors.light]: string };

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return (scheme === 'dark' ? Colors.dark : Colors.light) as Theme;
}
