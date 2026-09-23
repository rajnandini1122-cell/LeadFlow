import { useQuery } from '@tanstack/react-query';
import type { OrganizationDetail } from '@leadflow/api-types';
import { apiGet } from '../../lib/api-client';

/**
 * Whether this organization has switched omnichannel capture on.
 *
 * Read from the organization the user is signed into rather than a build-time
 * constant, because the flag is per tenant: one organization on this
 * deployment can be using channels while another has never connected one.
 *
 * Defaults to false while loading and on error. Hiding a feature that should
 * be visible is a moment's confusion; showing a queue for channels an
 * organization has not connected is a permanently empty screen advertising
 * something they cannot use.
 */
export function useOmnichannelEnabled(): boolean {
  const organization = useQuery({
    queryKey: ['organization'],
    queryFn: () => apiGet<OrganizationDetail>('/organizations/current'),
    staleTime: 5 * 60 * 1000,
  });

  return organization.data?.settings.omnichannelEnabled ?? false;
}
