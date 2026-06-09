import { Platform, useColorScheme } from 'react-native';

export const Colors = {
  dark: {
    bg:           '#070a0e',
    surface:      '#0c1018',
    card:         '#101620',
    cardAlt:      '#0c1018',
    text:         '#e2e8f0',
    muted:        '#64748b',
    subtle:       '#1e2d3d',
    border:       '#1a2535',
    accent:       '#f59e0b',
    accentMuted:  '#1c1500',
    success:      '#4ade80',
    successBg:    '#032912',
    warning:      '#fb923c',
    warningBg:    '#1c0a00',
    danger:       '#f87171',
    dangerBg:     '#1e0606',
    unexpected:   '#c084fc',
    unexpectedBg: '#14082e',
    disabled:     '#2a3a4a',
    tabBar:       '#0a0d12',
    tabBarBorder: '#161f2c',
    tabActive:    '#f59e0b',
    tabInactive:  '#3d5166',
    rust:         '#fb923c',
    rustBg:       '#1c0a00',
  },
  light: {
    bg:           '#f8f7f4',
    surface:      '#f0eeea',
    card:         '#ffffff',
    cardAlt:      '#f8f7f4',
    text:         '#0f172a',
    muted:        '#64748b',
    subtle:       '#dde3ea',
    border:       '#e2e4e8',
    accent:       '#b86e00',
    accentMuted:  '#fef3c7',
    success:      '#15803d',
    successBg:    '#f0fdf4',
    warning:      '#c2410c',
    warningBg:    '#fff7ed',
    danger:       '#b91c1c',
    dangerBg:     '#fef2f2',
    unexpected:   '#7c3aed',
    unexpectedBg: '#faf5ff',
    disabled:     '#c8cfd8',
    tabBar:       '#ffffff',
    tabBarBorder: '#e2e4e8',
    tabActive:    '#b86e00',
    tabInactive:  '#94a3b8',
    rust:         '#c2410c',
    rustBg:       '#fff7ed',
  },
} as const;

export type Theme = { readonly [K in keyof typeof Colors.dark]: string };

export function useTheme(): Theme {
  const scheme = useColorScheme();
  return (scheme === 'dark' ? Colors.dark : Colors.light) as Theme;
}

export const Fonts = {
  display: Platform.select({
    ios:     'AvenirNext-Heavy',
    android: 'sans-serif-condensed',
    default: 'sans-serif',
  }) as string,
  medium: Platform.select({
    ios:     'AvenirNext-DemiBold',
    android: 'sans-serif-medium',
    default: 'sans-serif',
  }) as string,
  mono: Platform.select({
    ios:     'Menlo',
    android: 'monospace',
    default: 'monospace',
  }) as string,
};
