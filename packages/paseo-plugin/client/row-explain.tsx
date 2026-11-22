/** The expanded part of a decision row: why the decider answered as it did. */
import { useRpc } from '@getpaseo/plugin/client';
import { useQuery } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { Text, View } from 'react-native';

import { HOOK_POLICIES } from '../shared/constants.ts';
import { rowExplain, type DecisionRow } from '../shared/row.ts';
import { policyThresholdsRpc } from '../shared/rpc.ts';
import { hostQueryKey, useHostId } from './host-scope.ts';

type HookPolicy = (typeof HOOK_POLICIES)[number];

function hookPolicy(policy: string): HookPolicy | null {
  return HOOK_POLICIES.find((p) => p === policy) ?? null;
}

/**
 * Mounted on first expand, so the thresholds RPC runs only then. Only hook policies have
 * thresholds (the RPC's input enum); other rows explain without that line.
 */
export function RowExplain({
  row,
  detailStyle,
}: {
  row: DecisionRow;
  detailStyle: object;
}): ReactNode {
  const list = useRpc(policyThresholdsRpc);
  const hostId = useHostId();
  const policy = hookPolicy(row.policy);
  const thresholds = useQuery({
    queryKey: hostQueryKey(hostId, 'policy-thresholds', policy ?? '', 'row-explain'),
    queryFn: async () => list({ policy: policy ?? 'permission' }),
    enabled: policy !== null,
    retry: false,
    staleTime: 10_000,
  });
  const data = thresholds.data;
  const lines = rowExplain(row, data?.ok === true ? data.thresholds : null);
  return (
    <View accessibilityLabel={`Why: ${lines.join('. ')}`} style={{ gap: 1 }}>
      {lines.map((line) => (
        <Text key={line} style={detailStyle}>
          {line}
        </Text>
      ))}
    </View>
  );
}
