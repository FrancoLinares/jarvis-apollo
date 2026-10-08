import type { MemorySqlExecutor } from '@/memory/store';
import { extractBillingItems } from '@/billing/extract';
import { fetchBillingMails } from '@/billing/mail';
import { planBillingAlerts, resolveBillingSkipList, type BillingAlert } from '@/billing/plan';

// 11:00 y 21:00 UTC = 8:00 y 18:00 en Buenos Aires.
export const BILLING_CHECK_CRON = '0 11,21 * * *';
export const BILLING_FIRST_LOOKBACK_DAYS = 45;
export const BILLING_LOOKBACK_DAYS = 7;

export const BILLING_SEEN_TABLE_STATEMENT =
  'CREATE TABLE IF NOT EXISTS billing_mail_seen (id TEXT PRIMARY KEY, processed_at INTEGER NOT NULL, subject TEXT, items_json TEXT)';

export function readBillingCredentials(): { user: string; password: string } | undefined {
  const env = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env ?? {};
  const user = env.GMAIL_USER?.trim();
  const password = env.GMAIL_APP_PASSWORD?.replace(/\s+/g, '');
  return user && password ? { user, password } : undefined;
}

export async function runBillingCheck(input: {
  readonly sqlExecutor: MemorySqlExecutor;
  readonly openRouterApiKey: string;
  readonly modelId: string;
  readonly nowMilliseconds: number;
  readonly alreadyScheduledMessageList: readonly string[];
  readonly schedule: (alert: BillingAlert) => Promise<void>;
  readonly dryRun?: boolean;
}): Promise<{ mails: number; alerts: readonly BillingAlert[] }> {
  const credentials = readBillingCredentials();
  if (credentials === undefined) {
    return { mails: 0, alerts: [] };
  }
  input.sqlExecutor.execute(BILLING_SEEN_TABLE_STATEMENT);
  const seenIdSet = new Set(
    input.sqlExecutor.execute<{ id: string }>('SELECT id FROM billing_mail_seen').map((row) => row.id),
  );
  const lookbackDays = seenIdSet.size === 0 ? BILLING_FIRST_LOOKBACK_DAYS : BILLING_LOOKBACK_DAYS;
  const mailList = await fetchBillingMails({
    ...credentials,
    sinceMilliseconds: input.nowMilliseconds - lookbackDays * 24 * 60 * 60 * 1000,
    alreadyProcessedIdSet: seenIdSet,
  });
  const scheduledMessageList = [...input.alreadyScheduledMessageList];
  const allAlertList: BillingAlert[] = [];
  for (const mail of mailList) {
    const itemList = await extractBillingItems({
      mail,
      openRouterApiKey: input.openRouterApiKey,
      modelId: input.modelId,
    });
    const alertList = planBillingAlerts({
      itemList,
      mailReceivedAtMilliseconds: mail.receivedAtMilliseconds,
      nowMilliseconds: input.nowMilliseconds,
      skipConceptList: resolveBillingSkipList(),
      alreadyScheduledMessageList: scheduledMessageList,
    });
    for (const alert of alertList) {
      scheduledMessageList.push(alert.message);
      allAlertList.push(alert);
      if (!input.dryRun) {
        await input.schedule(alert);
      }
    }
    if (!input.dryRun) {
      input.sqlExecutor.execute(
        'INSERT OR IGNORE INTO billing_mail_seen (id, processed_at, subject, items_json) VALUES (?, ?, ?, ?)',
        mail.id,
        input.nowMilliseconds,
        mail.subject,
        JSON.stringify(itemList),
      );
    }
  }
  return { mails: mailList.length, alerts: allAlertList };
}
