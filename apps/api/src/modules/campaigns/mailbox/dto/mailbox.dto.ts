import { Transform } from 'class-transformer';
import {
  IsBoolean,
  IsEmail,
  IsIn,
  IsInt,
  IsOptional,
  IsString,
  Max,
  MaxLength,
  Min,
  Matches,
  MinLength,
} from 'class-validator';

const trim = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim() : value;
const lower = ({ value }: { value: unknown }): unknown =>
  typeof value === 'string' ? value.trim().toLowerCase() : value;

export const MAIL_SECURITY = ['SSL_TLS', 'STARTTLS'] as const;

/**
 * The account as a mail client describes it: address, description, IMAP and
 * SMTP host/port/secure connection type, and the password. The username is the
 * address unless the provider says otherwise.
 *
 * `password` is optional on an update (the stored one is kept) and required on
 * the first save — the service enforces that. It is never returned.
 */
export class SaveMailboxDto {
  @IsEmail({}, { message: 'must be an email address' })
  @MaxLength(320)
  @Transform(lower)
  emailAddress!: string;

  @IsOptional()
  @IsString()
  @MaxLength(200)
  @Transform(trim)
  description?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(320)
  @Transform(trim)
  username?: string;

  @IsOptional()
  @IsString()
  @MinLength(1)
  @MaxLength(500)
  password?: string;

  @IsString()
  @MaxLength(253)
  @Transform(lower)
  imapHost!: string;

  @IsInt()
  @IsIn([993, 143], { message: 'must be 993 (SSL/TLS) or 143 (STARTTLS)' })
  imapPort!: number;

  @IsIn(MAIL_SECURITY, { message: 'must be SSL_TLS or STARTTLS' })
  imapSecurity!: (typeof MAIL_SECURITY)[number];

  @IsString()
  @MaxLength(253)
  @Transform(lower)
  smtpHost!: string;

  @IsInt()
  @IsIn([465, 587], { message: 'must be 465 (SSL/TLS) or 587 (STARTTLS)' })
  smtpPort!: number;

  @IsIn(MAIL_SECURITY, { message: 'must be SSL_TLS or STARTTLS' })
  smtpSecurity!: (typeof MAIL_SECURITY)[number];
}

/**
 * How campaign mail is sent. Secrets are optional on update (the stored ones
 * are kept) and never returned.
 */
export class SaveProviderDto {
  @IsIn(['SMTP', 'RESEND'], { message: 'must be SMTP or RESEND' })
  provider!: 'SMTP' | 'RESEND';

  @IsOptional()
  @IsEmail({}, { message: 'must be an email address' })
  @MaxLength(320)
  @Transform(lower)
  fromAddress?: string;

  @IsOptional()
  @IsString()
  @Matches(/^re_[A-Za-z0-9_-]{8,200}$/, { message: 'must be a Resend API key (re_…)' })
  apiKey?: string;

  @IsOptional()
  @IsString()
  @Matches(/^whsec_[A-Za-z0-9+/=]{16,200}$/, {
    message: 'must be a Resend webhook signing secret (whsec_…)',
  })
  webhookSecret?: string;
}

export class MailboxSendingDto {
  @IsOptional()
  @IsBoolean()
  enabled?: boolean;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(1000)
  hourlyLimit?: number;

  @IsOptional()
  @IsInt()
  @Min(1)
  @Max(10000)
  dailyLimit?: number;
}
