import { Injectable } from '@nestjs/common';
import { PrismaService } from '../../common/prisma/prisma.service';

/**
 * Profile picture storage.
 *
 * A repository rather than direct Prisma in the service, matching the rule the
 * rest of the codebase follows: data access lives here so tenant scoping is
 * applied in one auditable place.
 *
 * `UserAvatar` is deliberately NOT tenant-scoped — a User is global and one
 * person has one face across every organization they belong to — so the
 * membership check the service performs is a real query rather than something
 * the extension does implicitly. That is why it is spelled out here.
 */
@Injectable()
export class AvatarRepository {
  constructor(private readonly prisma: PrismaService) {}

  async upsert(input: {
    userId: string;
    /*
     * `Uint8Array<ArrayBuffer>`, not the bare `Uint8Array`.
     *
     * The default parameter is `ArrayBufferLike`, which admits
     * SharedArrayBuffer — and Prisma's Bytes column will not take one. Naming
     * the backing buffer keeps the error at this boundary rather than at the
     * call site.
     */
    data: Uint8Array<ArrayBuffer>;
    mimeType: string;
    sizeBytes: number;
  }) {
    return this.prisma.client.userAvatar.upsert({
      where: { userId: input.userId },
      create: {
        userId: input.userId,
        data: input.data,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
      update: {
        data: input.data,
        mimeType: input.mimeType,
        sizeBytes: input.sizeBytes,
      },
    });
  }

  async remove(userId: string): Promise<void> {
    await this.prisma.client.userAvatar.deleteMany({ where: { userId } });
  }

  async find(userId: string) {
    return this.prisma.client.userAvatar.findUnique({ where: { userId } });
  }

  /** Points the user's avatarUrl at the served path, or clears it. */
  async setAvatarUrl(userId: string, avatarUrl: string | null): Promise<void> {
    await this.prisma.client.user.update({ where: { id: userId }, data: { avatarUrl } });
  }

  /**
   * Whether this user shares the given organization with the caller.
   *
   * The access rule for reading a picture. A User is global, so its id is not
   * tenant-scoped and an unguarded read would let any signed-in account walk
   * ids and collect photographs of staff at every other company.
   */
  async sharesOrganization(organizationId: string, userId: string): Promise<boolean> {
    const membership = await this.prisma.client.organizationUser.findFirst({
      where: { organizationId, userId, status: { in: ['ACTIVE', 'INVITED'] } },
      select: { id: true },
    });

    return membership !== null;
  }
}
