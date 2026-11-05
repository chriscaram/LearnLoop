import { randomBytes } from 'node:crypto';
import { SendEmailCommand } from '@aws-sdk/client-ses';
import { getSesClient } from '@learnloop/shared/aws';
import { getConfig } from '@learnloop/shared/config';
import { logEvent } from '@learnloop/shared/logger';

export const EMAIL_TEMPLATES = Object.freeze({
  welcome: ({ name }) => ({
    subject: 'Welcome to LearnLoop',
    text: `Hi ${name},\n\nYour LearnLoop account is ready. Sign in to browse the catalog and start a course.\n\nThe LearnLoop team`,
  }),
  payment_receipt: ({ name, amount, periodEnd }) => ({
    subject: 'Your LearnLoop receipt',
    text: `Hi ${name},\n\nWe received your payment of ${amount} USD for the LearnLoop monthly plan. Your subscription runs until ${periodEnd}.\n\nThe LearnLoop team`,
  }),
  staff_message: ({ name, title, body, staffName }) => ({
    subject: title,
    text: `Hi ${name},\n\n${body}\n\n${staffName}, LearnLoop`,
  }),
});

export function renderEmail(template, data) {
  const render = EMAIL_TEMPLATES[template];
  if (!render) throw new TypeError(`unknown email template: ${template}`);
  return render(data);
}

/**
 * Sends a transactional email through SES. Never throws for delivery
 * problems: returns { ok: false, errorType } and logs a failed email_sent.
 */
export async function sendEmail({ to, template, data }) {
  const { subject, text } = renderEmail(template, data);
  const config = getConfig();
  const emailId = `eml_${randomBytes(6).toString('hex')}`;
  try {
    const out = await getSesClient().send(new SendEmailCommand({
      Source: config.sesSender,
      Destination: { ToAddresses: [config.emailRecipientOverride || to] },
      Message: { Subject: { Data: subject, Charset: 'UTF-8' }, Body: { Text: { Data: text, Charset: 'UTF-8' } } },
    }));
    logEvent({ event: 'email_sent', entityType: 'email', entityId: emailId, actorType: 'system' });
    return { ok: true, messageId: out.MessageId };
  } catch (error) {
    const errorType = error?.name ?? 'Error';
    logEvent({ event: 'email_sent', entityType: 'email', entityId: emailId, outcome: 'failed', errorType, actorType: 'system' });
    return { ok: false, errorType };
  }
}
