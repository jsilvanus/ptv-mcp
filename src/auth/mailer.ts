/**
 * No SMTP/email provider is wired up yet (out of scope for Phase 3 — see
 * EXECUTION_LOG.md). This interface exists so the verification/reset flows
 * are fully built and tested against it now; swapping in a real provider
 * later (e.g. an SES/Postmark-backed Mailer) is a new implementation, not
 * a change to the auth service that calls it.
 */
export interface Mailer {
  sendVerificationEmail(to: string, rawToken: string): Promise<void>;
  sendPasswordResetEmail(to: string, rawToken: string): Promise<void>;
}

/** Logs the link instead of sending it — fine for local dev, wrong for anything else. */
export class LoggingMailer implements Mailer {
  constructor(private readonly log: (message: string) => void = console.log) {}

  async sendVerificationEmail(to: string, rawToken: string): Promise<void> {
    this.log(`[mailer] verification email to ${to}: token=${rawToken}`);
  }

  async sendPasswordResetEmail(to: string, rawToken: string): Promise<void> {
    this.log(`[mailer] password reset email to ${to}: token=${rawToken}`);
  }
}
