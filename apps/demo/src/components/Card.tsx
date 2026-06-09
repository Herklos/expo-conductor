import React from 'react';
import { StyleSheet, View, type ViewStyle } from 'react-native';
import type { Theme } from '../theme';

interface Props {
  children: React.ReactNode;
  theme: Theme;
  style?: ViewStyle;
}

export function Card({ children, theme, style }: Props) {
  return (
    <View
      style={[
        styles.card,
        { backgroundColor: theme.card, borderColor: theme.border },
        style,
      ]}
    >
      {children}
    </View>
  );
}

const styles = StyleSheet.create({
  card: {
    borderRadius: 12,
    padding: 14,
    borderWidth: StyleSheet.hairlineWidth,
    marginBottom: 10,
  },
});
