import { useTheme } from '../theme';

/**
 * Shared themed options for the per-tab native Stack header.
 *
 * The header background is OPAQUE (`theme.surface`) so each screen can safely drop the
 * `insets.top` padding it used to add when there was no header — the header now owns the
 * status-bar / notch area. `contentStyle` paints the screen background so there is no flash
 * between the header and the screen body.
 */
export function useStackHeaderOptions() {
  const theme = useTheme();
  return {
    headerStyle: { backgroundColor: theme.surface },
    headerTintColor: theme.text,
    headerTitleStyle: { color: theme.text },
    headerShadowVisible: false,
    contentStyle: { backgroundColor: theme.bg },
  };
}
