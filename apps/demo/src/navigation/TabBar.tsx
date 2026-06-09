import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Theme } from '../theme';

export type Tab = 'lab' | 'logs' | 'reconcile' | 'lifecycle';

const TABS: { id: Tab; label: string }[] = [
  { id: 'lab',       label: 'LAB' },
  { id: 'logs',      label: 'LOGS' },
  { id: 'reconcile', label: 'RECONCILE' },
  { id: 'lifecycle', label: 'SYSTEM' },
];

interface Props {
  active: Tab;
  onSelect: (tab: Tab) => void;
  theme: Theme;
}

export function TabBar({ active, onSelect, theme }: Props) {
  return (
    <View
      style={[
        styles.bar,
        {
          backgroundColor: theme.tabBar,
          borderTopColor: theme.tabBarBorder,
          paddingBottom: Platform.OS === 'ios' ? 24 : 8,
        },
      ]}
    >
      {TABS.map((tab) => {
        const isActive = tab.id === active;
        return (
          <Pressable
            key={tab.id}
            style={styles.tab}
            onPress={() => onSelect(tab.id)}
            accessibilityRole="tab"
            accessibilityState={{ selected: isActive }}
          >
            <View
              style={[
                styles.indicator,
                { backgroundColor: isActive ? theme.tabActive : 'transparent' },
              ]}
            />
            <Text
              style={[
                styles.label,
                {
                  color: isActive ? theme.tabActive : theme.tabInactive,
                  fontWeight: isActive ? '800' : '500',
                },
              ]}
            >
              {tab.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    flexDirection: 'row',
    borderTopWidth: 1,
    paddingTop: 0,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    paddingTop: 10,
    gap: 5,
  },
  indicator: {
    width: 24,
    height: 2,
    borderRadius: 1,
    marginBottom: 2,
  },
  label: {
    fontSize: 9,
    letterSpacing: 1.2,
  },
});
