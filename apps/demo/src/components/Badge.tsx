import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  label: string;
  color: string;
  bg: string;
  small?: boolean;
  outlined?: boolean;
}

export function Badge({ label, color, bg, small, outlined }: Props) {
  return (
    <View
      style={[
        styles.badge,
        { backgroundColor: outlined ? 'transparent' : bg, borderColor: color },
        outlined && styles.outlined,
        small && styles.small,
      ]}
    >
      <Text style={[styles.label, { color }, small && styles.labelSmall]}>
        {label.toUpperCase()}
      </Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 7,
    paddingVertical: 3,
    borderRadius: 4,
    alignSelf: 'flex-start',
    borderWidth: 0,
  },
  outlined: {
    borderWidth: 1,
  },
  small: {
    paddingHorizontal: 5,
    paddingVertical: 2,
  },
  label: {
    fontSize: 10,
    fontWeight: '700',
    letterSpacing: 0.6,
  },
  labelSmall: {
    fontSize: 9,
    letterSpacing: 0.5,
  },
});
