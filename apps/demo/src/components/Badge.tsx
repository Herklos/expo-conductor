import React from 'react';
import { StyleSheet, Text, View } from 'react-native';

interface Props {
  label: string;
  color: string;
  bg: string;
  small?: boolean;
}

export function Badge({ label, color, bg, small }: Props) {
  return (
    <View style={[styles.badge, { backgroundColor: bg }, small && styles.small]}>
      <Text style={[styles.label, { color }, small && styles.labelSmall]}>{label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  badge: {
    paddingHorizontal: 8,
    paddingVertical: 3,
    borderRadius: 99,
    alignSelf: 'flex-start',
  },
  small: {
    paddingHorizontal: 6,
    paddingVertical: 2,
  },
  label: {
    fontSize: 12,
    fontWeight: '600',
  },
  labelSmall: {
    fontSize: 10,
  },
});
