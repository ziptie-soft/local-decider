/** Pieces shared by the settings tables: the muted uppercase column title and the header row. */
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import type { Theme } from './ui.tsx';

/** One column title. */
export function Head({ theme, text }: { theme: Theme; text: string }): ReactNode {
  return (
    <Text style={{ color: theme.colors.foregroundMuted, fontSize: 11, textTransform: 'uppercase' }}>
      {text}
    </Text>
  );
}

/** The row that holds the column titles. */
export function HeaderRow({ children }: { children: ReactNode }): ReactNode {
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: 10,
        paddingHorizontal: 16,
        paddingTop: 12,
        paddingBottom: 6,
      }}
    >
      {children}
    </View>
  );
}
