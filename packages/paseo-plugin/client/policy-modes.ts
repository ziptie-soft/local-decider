/** The gateway's run mode per hook policy, fetched once when a surface opens (no polling). */
import { useRpc } from '@getpaseo/plugin/client';
import { useQuery } from '@tanstack/react-query';

import type { HOOK_POLICIES } from '../shared/constants.ts';
import { policyModesRpc } from '../shared/rpc.ts';
import { hostQueryKey, useHostId } from './host-scope.ts';

export type GatewayModes = Partial<
  Record<(typeof HOOK_POLICIES)[number], 'off' | 'shadow' | 'act'>
>;

/** Empty until fetched, and when the gateway is down or too old to report modes. */
export function useGatewayModes(): GatewayModes {
  const modes = useRpc(policyModesRpc);
  const hostId = useHostId();
  const query = useQuery({
    queryKey: hostQueryKey(hostId, 'policy-modes'),
    queryFn: async () => modes({}),
    retry: false,
    staleTime: 10_000,
  });
  return query.data?.ok === true ? query.data.modes : {};
}
