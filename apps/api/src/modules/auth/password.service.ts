import { Injectable } from '@nestjs/common';
import * as argon2 from 'argon2';
import { AppConfig } from '../../common/config/config.module';

/**
 * Password hashing with argon2id.
 *
 * argon2id is the OWASP-recommended default: it combines argon2i's resistance
 * to side-channel attacks with argon2d's resistance to GPU cracking. Cost
 * parameters come from configuration so they can be raised as hardware improves
 * without a code change.
 */
@Injectable()
export class PasswordService {
  /**
   * A real argon2id hash of a value nobody knows, used to spend the same CPU
   * time when the email does not exist as when it does. Without this, login is
   * measurably faster for unknown emails and becomes a user-enumeration oracle.
   */
  private dummyHash: string | undefined;

  constructor(private readonly config: AppConfig) {}

  private get options(): argon2.HashOptions & { raw?: false } {
    return {
      type: argon2.argon2id,
      memoryCost: this.config.get('ARGON2_MEMORY_COST'),
      timeCost: this.config.get('ARGON2_TIME_COST'),
      parallelism: this.config.get('ARGON2_PARALLELISM'),
    };
  }

  async hash(plain: string): Promise<string> {
    return argon2.hash(plain, this.options);
  }

  async verify(hash: string, plain: string): Promise<boolean> {
    try {
      return await argon2.verify(hash, plain);
    } catch {
      // A malformed hash in the database must read as "wrong password",
      // not as a 500 that tells the caller something unusual happened.
      return false;
    }
  }

  /** Burns equivalent CPU time so an unknown email is timing-indistinguishable. */
  async verifyDummy(plain: string): Promise<false> {
    this.dummyHash ??= await argon2.hash(
      'idea001-nonexistent-account-placeholder',
      this.options,
    );
    await this.verify(this.dummyHash, plain);
    return false;
  }
}
