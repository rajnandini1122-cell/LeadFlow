import { IsIn, IsOptional, IsUUID } from 'class-validator';

export class SwitchOrganizationDto {
  /**
   * Which organization to switch into.
   *
   * Named `targetOrganizationId`, not `organizationId`, for two reasons.
   *
   * First, honesty: this is a SELECTOR among organizations the caller already
   * belongs to, not an assertion of which tenant the request runs in. The
   * service re-reads live membership and requires ACTIVE, so an id for
   * anywhere else yields 403 and no session is minted.
   *
   * Second, StripTenantFieldsInterceptor deletes any field named
   * `organizationId` from every request. That global rule has no exemptions
   * on purpose — an exemption is a precedent, and the next route to claim one
   * might be asserting scope rather than selecting. A distinct name keeps the
   * rule absolute.
   */
  @IsUUID('7', { message: 'must be a valid organization id' })
  targetOrganizationId!: string;

  @IsOptional()
  @IsIn(['WEB', 'ANDROID', 'IOS'])
  platform?: 'WEB' | 'ANDROID' | 'IOS';
}
