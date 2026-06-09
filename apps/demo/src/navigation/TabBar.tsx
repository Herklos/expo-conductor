import React from 'react';
import { Platform, Pressable, StyleSheet, Text, View } from 'react-native';
import type { Theme } from '../theme';

export type Tab = 'lab' | 'logs' | 'reconcile' | 'lifecycle';

const TABS: { id: Tab; label: string; icon: string }[] = [
  { id: 'lab', label: 'Lab', icon: '⚗️' },
  { id: 'logs', label: 'Logs', icon: '📋' },
  { id: 'reconcile', label: 'Reconcile', icon: '🔍' },
  { id: 'lifecycle', label: 'System', icon: '⚙️' },
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
          // On web/Android the bottom safe area is 0; on iOS we add padding
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
            <Text style={[styles.icon, { opacity: isActive ? 1 : 0.5 }]}>{tab.icon}</Text>
            <Text
              style={[
                styles.label,
                { color: isActive ? theme.tabActive : theme.tabInactive },
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
    borderTopWidth: StyleSheet.hairlineWidth,
    paddingTop: 8,
  },
  tab: {
    flex: 1,
    alignItems: 'center',
    gap: 2,
  },
  icon: {
    fontSize: 20,
  },
  label: {
    fontSize: 11,
    fontWeight: '500',
  },
});
