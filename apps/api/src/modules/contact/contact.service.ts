import { Injectable, Logger } from '@nestjs/common';
import { EmailService } from '../../common/email/email.service';
import { PlatformService } from '../../common/platform/platform.service';
import { ContactRepository } from './contact.repository';
import type { SubmitEnquiryDto } from './dto/contact.dto';

export interface EnquiryReceipt {
  /** Short reference the visitor can quote when following up. */
  reference: string;
  /** Where a reply will come from, so the page can show one address. */
  salesEmail: string;
}

/**
 * The public contact form.
 *
 * Three things make this unlike every other write in the application, and each
 * one shapes the code below:
 *
 *   1. There is no tenant. The sender is a stranger who belongs to no
 *      organization, so the repository writes under an explicit system scope.
 *
 *   2. There is no authentication, so it is reachable by anything on the
 *      internet. A honeypot and a strict per-IP rate limit are the cost.
 *
 *   3. It is STORED as well as emailed, in that order. Email is best-effort —
 *      the provider is configurable and is the console one in development — and
 *      a sales enquiry lost to a misconfigured SMTP host is a customer nobody
 *      knows they missed. The row is the record; the email is the notification.
 */
@Injectable()
export class ContactService {
  private readonly logger = new Logger(ContactService.name);

  constructor(
    private readonly repository: ContactRepository,
    private readonly email: EmailService,
    private readonly platform: PlatformService,
  ) {}

  async submit(
    dto: SubmitEnquiryDto,
    meta: { ipAddress?: string | undefined; userAgent?: string | undefined },
  ): Promise<EnquiryReceipt> {
    // Honeypot: a field hidden from people and irresistible to form-filling
    // bots. Answering as though it succeeded is deliberate — telling a bot it
    // was caught only teaches whoever wrote it to stop filling that field.
    if (dto.website !== undefined && dto.website !== '') {
      this.logger.warn({ ipAddress: meta.ipAddress }, 'Contact form honeypot triggered');
      return { reference: decoyReference(), salesEmail: this.email.salesEmail };
    }

    const enquiry = await this.repository.create({
      name: dto.name,
      email: dto.email,
      company: dto.company,
      phone: dto.phone,
      country: dto.country,
      message: dto.message,
      source: dto.source,
      ipAddress: meta.ipAddress,
      userAgent: meta.userAgent,
    });

    const reference = enquiry.id.slice(0, 8).toUpperCase();

    // Sent only once the row exists, so a provider failure loses the
    // notification and never the enquiry.
    const delivery = await this.email.sendContactEnquiry({
      name: dto.name,
      email: dto.email,
      company: dto.company,
      phone: dto.phone,
      country: dto.country,
      message: dto.message,
      source: dto.source,
      reference,
    });

    if (delivery.accepted) {
      await this.markNotified(enquiry.id);
    } else {
      // An enquiry sitting in the database that nobody was told about is an
      // operational problem, not a visitor-facing one — so it goes to the
      // operator rather than failing their submission.
      this.platform.criticalAlert('contact.enquiry_notification_failed', {
        enquiryId: enquiry.id,
        reference,
      });
    }

    return { reference, salesEmail: this.email.salesEmail };
  }

  private async markNotified(id: string): Promise<void> {
    try {
      await this.repository.markNotified(id);
    } catch (error) {
      // Bookkeeping only. The enquiry was stored and the notification was
      // accepted; failing the request now would be misleading.
      this.logger.error({ id, err: error }, 'Could not record enquiry notification');
    }
  }
}

/**
 * A reference for the honeypot path.
 *
 * There is no row to derive one from, and returning nothing would tell a bot
 * its submission was treated differently.
 */
function decoyReference(): string {
  return Math.random().toString(36).slice(2, 10).toUpperCase().padEnd(8, '0');
}
