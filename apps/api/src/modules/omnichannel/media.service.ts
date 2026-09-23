import { Injectable, Logger } from '@nestjs/common';
import { ERROR_CODES } from '@leadflow/api-types';
import { AppConfig } from '../../common/config/config.module';
import { AppException } from '../../common/errors/app.exception';
import { openSecret, parseEncryptionKey } from '../../common/crypto/secret-box';
import type { TenantPrincipal } from '../../common/tenancy/tenant-context.service';
import { OmnichannelRepository } from './omnichannel.repository';
import { conversationScope } from './conversation-visibility';
import { parseAttachments, type MessageAttachment } from './message-attachment';

/**
 * Fetching a customer's media back from the provider.
 *
 * Nothing is downloaded at ingestion time, so this is where the bytes actually
 * come from. Two reasons that is the right shape:
 *
 *   * WhatsApp gives a media id, not a link. The URL has to be requested
 *     separately and expires within minutes, so there was never a durable link
 *     to store — only a reference that stays valid.
 *   * Most customer media is never opened by anybody. Downloading all of it
 *     would mean operating storage for files nobody asked for.
 *
 * The consequence is that this endpoint is the ONLY route to a customer's
 * media, which makes its authorization the whole security model. It is checked
 * in four steps, and each one exists because skipping it would open a door:
 * authentication, conversation visibility, message-belongs-to-conversation, and
 * attachment-belongs-to-message.
 */
@Injectable()
export class MediaService {
  private readonly logger = new Logger(MediaService.name);

  /** Nothing larger is streamed back. Matches the outbound ceiling. */
  private static readonly MAX_FETCH_BYTES = 16 * 1024 * 1024;

  constructor(
    private readonly config: AppConfig,
    private readonly repository: OmnichannelRepository,
  ) {}

  /**
   * The bytes of one attachment, if this caller may have them.
   *
   * @param index the attachment's position within its message. Message-scoped
   *   by design: a global attachment id could be walked, whereas an index is
   *   meaningless without a message the caller already proved access to.
   */
  async fetch(
    conversationId: string,
    messageId: string,
    index: number,
    principal: TenantPrincipal,
  ): Promise<{ body: Buffer; contentType: string; filename: string | null }> {
    /*
     * STEP 1 — may this caller see the conversation at all?
     *
     * The same policy the inbox uses, deliberately not a second copy. Someone
     * who cannot open a conversation must not be able to read its media by
     * knowing an id.
     */
    const conversation = await this.repository.findConversationForSend(conversationId);
    if (!conversation) throw this.notFound();
    if (!(await this.mayView(conversation, principal))) throw this.notFound();

    /*
     * STEP 2 — does this message belong to THAT conversation?
     *
     * Both ids come from the URL. Without this check a caller who can see one
     * conversation could pair its id with any message id in the tenant and
     * read media from a conversation they cannot open.
     */
    const message = await this.repository.findMessageInConversation(conversationId, messageId);
    if (!message) throw this.notFound();

    // STEP 3 — does the attachment exist on that message?
    const attachments = parseAttachments(message.attachments);
    const attachment = attachments[index];
    if (!attachment) throw this.notFound();

    // STEP 4 — fetch it, using credentials that never leave this process.
    return this.download(conversation.channel, attachment);
  }

  /**
   * Whether this caller may view this conversation.
   *
   * Mirrors OutboundMessagingService.mayReply, which mirrors the inbox. Three
   * call sites, one rule — a divergence here would be a way to read what the
   * inbox hides.
   */
  private async mayView(
    conversation: { ownerId: string | null; leadId: string | null },
    principal: TenantPrincipal,
  ): Promise<boolean> {
    const scope = conversationScope(principal, await this.repository.sharedUnassignedQueue());
    if (scope.kind === 'ALL') return true;

    if (conversation.ownerId === scope.userId) return true;

    if (conversation.leadId) {
      const lead = await this.repository.findLeadById(conversation.leadId);
      return lead?.assignedToId === scope.userId;
    }

    return scope.includeUnassigned && conversation.ownerId === null;
  }

  /**
   * Retrieves the bytes from the provider.
   *
   * WhatsApp and the Messenger channels differ here in a way that matters:
   * WhatsApp needs two authenticated calls (id → URL → bytes) with our access
   * token, while Messenger and Instagram hand out a signed CDN link that is
   * fetched without credentials. Both are done server-side, and neither link
   * is ever given to the browser.
   */
  private async download(
    channel: string,
    attachment: MessageAttachment,
  ): Promise<{ body: Buffer; contentType: string; filename: string | null }> {
    if (channel === 'WHATSAPP') {
      if (!attachment.providerMediaId) throw this.gone();
      return this.downloadFromWhatsApp(attachment);
    }

    if (!attachment.providerUrl) throw this.gone();
    return this.readResponse(await this.get(attachment.providerUrl), attachment);
  }

  private async downloadFromWhatsApp(attachment: MessageAttachment) {
    const token = await this.accessTokenFor('WHATSAPP');
    const version = this.config.get('WHATSAPP_API_VERSION');

    // Step one: the id becomes a short-lived URL.
    const lookup = await this.get(
      `https://graph.facebook.com/${version}/${encodeURIComponent(attachment.providerMediaId as string)}`,
      token,
    );

    const meta = (await lookup.json().catch(() => null)) as { url?: string } | null;
    if (!meta?.url) {
      this.logger.warn('WhatsApp returned no media URL for a stored media id.');
      throw this.gone();
    }

    // Step two: the URL itself needs the token too, unlike a CDN link.
    return this.readResponse(await this.get(meta.url, token), attachment);
  }

  private async accessTokenFor(channel: 'WHATSAPP'): Promise<string> {
    const integration = await this.repository.findIntegrationForChannel(channel);

    if (!integration?.encryptedAccessToken) {
      // A disconnect clears the credential but keeps the history, so this is a
      // reachable state rather than a broken one.
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'This channel is not connected, so its media cannot be opened.',
        409,
      );
    }

    try {
      const key = parseEncryptionKey(this.config.get('CREDENTIAL_ENCRYPTION_KEY'));
      return openSecret(integration.encryptedAccessToken, key);
    } catch {
      this.logger.error('Stored credential could not be decrypted while fetching media.');
      throw new AppException(
        ERROR_CODES.CONFLICT,
        'Credentials could not be read. Reconnect the channel in settings.',
        409,
      );
    }
  }

  private async get(url: string, token?: string): Promise<Response> {
    try {
      const response = await fetch(url, {
        ...(token ? { headers: { Authorization: `Bearer ${token}` } } : {}),
        signal: AbortSignal.timeout(20_000),
      });

      if (!response.ok) {
        // Status only. Meta's bodies echo request parameters and can include
        // the token.
        this.logger.warn(`Media fetch failed: HTTP ${response.status}.`);
        throw this.gone();
      }

      return response;
    } catch (error) {
      if (error instanceof AppException) throw error;

      this.logger.warn(
        `Media fetch failed: ${error instanceof Error ? error.name : 'unknown error'}`,
      );
      throw this.gone();
    }
  }

  private async readResponse(response: Response, attachment: MessageAttachment) {
    const body = Buffer.from(await response.arrayBuffer());

    if (body.byteLength > MediaService.MAX_FETCH_BYTES) {
      this.logger.warn('Refusing to stream a provider media response over the size ceiling.');
      throw this.gone();
    }

    /*
     * The provider's declared type, then ours, then a neutral default.
     *
     * Never guessed from the filename: a caller controls nothing here, but the
     * Content-Type this returns is what a browser will act on, and
     * `application/octet-stream` is the safe answer when nobody actually knows.
     */
    const contentType =
      response.headers.get('content-type')?.split(';')[0]?.trim() ??
      attachment.mimeType ??
      'application/octet-stream';

    return { body, contentType, filename: attachment.filename };
  }

  private notFound(): AppException {
    // Identical to every other missing resource. A distinct error here would
    // confirm that a message or attachment exists in another tenant.
    return AppException.notFound(ERROR_CODES.NOT_FOUND, 'Attachment not found.');
  }

  private gone(): AppException {
    return new AppException(
      ERROR_CODES.CONFLICT,
      'This attachment is no longer available from the provider.',
      409,
    );
  }
}
