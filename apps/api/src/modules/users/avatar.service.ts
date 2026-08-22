import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppException } from '../../common/errors/app.exception';
import { PrismaService } from '../../common/prisma/prisma.service';
import { TenantContextService } from '../../common/tenancy/tenant-context.service';
import { detectMimeType } from '../omnichannel/message-attachment';

/**
 * Profile pictures.
 *
 * Small enough to keep in the database, and deliberately kept there: no object
 * storage is configured, and standing one up for a few hundred kilobytes of
 * avatars would be more moving parts than the feature is worth. The bytes live
 * in their own table so no ordinary user query ever loads them.
 *
 * Two rules do the security work:
 *
 *   1. The image type is DETECTED from the bytes, never taken from the
 *      browser's Content-Type or the filename. Both are attacker-controlled
 *      and are the usual way an upload filter is bypassed — an .exe renamed to
 *      .jpg is the canonical example.
 *
 *   2. Reading someone's picture requires SHARING AN ORGANIZATION with them.
 *      A User is global here — one person can belong to several tenants — so
 *      user ids are not tenant-scoped and an unguarded endpoint would let any
 *      signed-in account enumerate faces across every customer on the
 *      deployment.
 */

/** Deliberately small. A 256px avatar has no business being larger. */
export const MAX_AVATAR_BYTES = 2 * 1024 * 1024;

/**
 * What a profile picture may be.
 *
 * JPEG and PNG only. Both are raster formats the byte sniffer recognises with
 * confidence. SVG is excluded on purpose: it is a document that can carry
 * script, and serving one from our own origin would be a stored-XSS vector
 * dressed as a photograph.
 */
const ALLOWED_TYPES = new Set(['image/jpeg', 'image/png']);

export interface UploadedAvatar {
  buffer: Buffer;
  size: number;
  mimetype?: string;
  originalname?: string;
}

@Injectable()
export class AvatarService {
  private readonly logger = new Logger(AvatarService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly tenantContext: TenantContextService,
  ) {}

  /**
   * Stores the signed-in user's picture.
   *
   * Only ever the CALLER's own. There is no endpoint for setting somebody
   * else's face, which removes a whole class of "admin changed my photo"
   * question before it can be asked.
   */
  async upload(userId: string, file: UploadedAvatar | undefined) {
    if (!file || file.size === 0) {
      throw AppException.validation('Choose an image to upload.', {
        file: ['is required'],
      });
    }

    if (file.size > MAX_AVATAR_BYTES) {
      throw AppException.validation(
        `Images must be ${Math.round(MAX_AVATAR_BYTES / 1024 / 1024)}MB or smaller.`,
        { file: ['is too large'] },
      );
    }

    // From the BYTES. The declared type and the filename are both supplied by
    // the client and neither decides what this file is.
    const detected = detectMimeType(file.buffer);

    if (!detected || !ALLOWED_TYPES.has(detected)) {
      throw AppException.validation('Profile pictures must be a JPEG or PNG image.', {
        file: ['must be a JPEG or PNG image'],
      });
    }

    // Prisma 7 takes a Uint8Array for a Bytes column, not a Node Buffer.
    const data = new Uint8Array(file.buffer);

    const avatar = await this.prisma.client.userAvatar.upsert({
      where: { userId },
      create: { userId, data, mimeType: detected, sizeBytes: file.size },
      update: { data, mimeType: detected, sizeBytes: file.size },
    });

    /*
     * The URL carries a version.
     *
     * The path is stable, so without it a replaced picture would sit behind
     * the browser's cached copy of the old one and look like the upload had
     * silently failed.
     */
    const url = this.urlFor(userId, avatar.updatedAt);
    await this.prisma.client.user.update({ where: { id: userId }, data: { avatarUrl: url } });

    return { avatarUrl: url };
  }

  /** Removes it, falling the UI back to initials. */
  async remove(userId: string): Promise<void> {
    await this.prisma.client.userAvatar.deleteMany({ where: { userId } });
    await this.prisma.client.user.update({ where: { id: userId }, data: { avatarUrl: null } });
  }

  /**
   * The bytes, for someone entitled to see them.
   *
   * The caller must share an organization with the owner. Without that check a
   * signed-in user could walk user ids and pull photographs of people at other
   * companies on the same deployment — the ids are not secret, and a User is
   * not tenant-scoped.
   */
  async read(userId: string) {
    const organizationId = this.tenantContext.requireOrganizationId();

    /*
     * Read through the UNSCOPED client on purpose, then check membership
     * explicitly.
     *
     * `UserAvatar` has no organization_id — a person has one face across every
     * tenant they belong to — so the tenant extension has nothing to filter on
     * and the check has to be a real query rather than an implied one.
     */
    const shared = await this.prisma.client.organizationUser.findFirst({
      where: { organizationId, userId, status: { in: ['ACTIVE', 'INVITED'] } },
      select: { id: true },
    });

    if (!shared) {
      // 404, not 403. Confirming that a user id exists would make this an
      // enumeration oracle across the whole deployment.
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Profile picture not found.');
    }

    const avatar = await this.prisma.client.userAvatar.findUnique({ where: { userId } });

    if (!avatar) {
      throw AppException.notFound(ERROR_CODES.NOT_FOUND, 'Profile picture not found.');
    }

    return avatar;
  }

  private urlFor(userId: string, updatedAt: Date): string {
    return `/api/v1/users/${userId}/avatar?v=${updatedAt.getTime()}`;
  }
}
