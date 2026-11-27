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

/** The row that holds the column titles; `wrap` lets narrow screens stack the columns. */
export function HeaderRow({
  wrap = false,
  children,
}: {
  wrap?: boolean;
  children: ReactNode;
}): ReactNode {
  return (
    <View
      style={{
        flexDirection: 'row',
        flexWrap: wrap ? 'wrap' : 'nowrap',
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
