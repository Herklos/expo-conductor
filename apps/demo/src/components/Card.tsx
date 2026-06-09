import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import type { Theme } from '../theme';

interface Props {
  children: React.ReactNode;
  theme: Theme;
  style?: ViewStyle;
  accentColor?: string;
}

export function Card({ children, theme, style, accentColor }: Props) {
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.card, borderColor: theme.border },
        accentColor && { borderLeftColor: accentColor, borderLeftWidth: 3 },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 8,
    padding: 14,
    borderWidth: 1,
    marginBottom: 8,
  },
});
