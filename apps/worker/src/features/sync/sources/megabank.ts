import type { Env } from "../../../platform/env";
import { canonicalSyncLockRowId } from "../lock";
import {
  acquireSyncJobLock,
  releaseSyncJobLock,
  type SyncTrigger,
} from "../../../db";
import { SYNC_SCOPE_ALL, type SyncOutcome } from "../types";
import { SyncAlreadyRunningError, NeedsUserActionError } from "../errors";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../config";
import { decryptJson, encryptJson } from "../../../platform/crypto";
import { configEncryptionKey } from "../../../platform/config";
import { parseMegabankConfig } from "../../../connectors/protocols/megabank";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../connector-state";
import {
  prepareMegabankCaptcha,
  createMegabankConnector,
  MegabankVerificationRequiredError,
  MegabankOtpRequiredError,
  MegabankOtpInvalidError,
  MegabankProtocolError,
} from "../../../connectors/protocols/megabank-mobile-api";
import {
  updateConnectorEncryptedConfigIfCurrent,
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../repository";
import { obankStoredConfigAfterSync } from "./obank";
import { recognizeNumericCaptcha } from "../../ocr/service";
import { type SyncWriteRecord, persistStagedSyncWrite } from "../persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
  creditCardBillRecord,
} from "../record-mapper";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../net-worth/service";

export type MegabankSyncOverrides = {
  captcha?: string;
  otp?: string;
};

export async function prepareMegabankCaptchaSession(env: Env) {
  const connectorId = "megabank";
  const runId = crypto.randomUUID();
  const lockRowId = canonicalSyncLockRowId(connectorId);
  const locked = await acquireSyncJobLock(env.DB, {
    lockRowId,
    scope: SYNC_SCOPE_ALL,
    trigger: "manual",
    runId,
    leaseMs: 3 * 60 * 1000,
  });
  if (!locked) throw new SyncAlreadyRunningError(connectorId);

  try {
    const settings = await requireConnectorSettings(env.DB, connectorId);
    const stored = await decryptJson<Record<string, unknown>>(
      settings.encrypted_config,
      configEncryptionKey(env),
    );
    const config = parseMegabankConfig({
      ...stored,
      ...parsePublicConnectorConfig(connectorId, settings.public_config),
    });
    const prepared = await prepareMegabankCaptcha(config);
    const saved = await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      settings.encrypted_config,
      await encryptJson(
        {
          ...stored,
          // 首次取得驗證碼時固定虛擬裝置，之後登入都沿用，簡訊驗證才可能只需一次。
          ...prepared.device,
          pendingSession: prepared.pendingSession,
          pendingSessionExpiresAt: prepared.pendingSessionExpiresAt,
        },
        configEncryptionKey(env),
      ),
    );
    if (!saved) {
      throw new NeedsUserActionError(
        "兆豐銀行設定在驗證期間已變更，請重新取得驗證碼。",
      );
    }
    return {
      captchaImage: prepared.captchaImage,
      expiresAt: prepared.pendingSessionExpiresAt,
      captchaLength: 5,
      captchaKind: "numeric" as const,
    };
  } finally {
    await releaseSyncJobLock(env.DB, lockRowId, runId);
  }
}

function megabankStoredConfigAfterSync(stored: Record<string, unknown>) {
  const cleaned = obankStoredConfigAfterSync(stored);
  delete cleaned.otp;
  return cleaned;
}

export async function syncMegabank(
  env: Env,
  trigger: SyncTrigger,
  overrides: MegabankSyncOverrides = {},
): Promise<SyncOutcome> {
  const connectorId = "megabank";
  const scope = SYNC_SCOPE_ALL;
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseMegabankConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
    ...overrides,
  });
  let result: Awaited<
    ReturnType<ReturnType<typeof createMegabankConnector>["sync"]>
  >;
  try {
    const connector = createMegabankConnector(
      globalThis.fetch.bind(globalThis),
      overrides.captcha || overrides.otp
        ? undefined
        : async (imageBytes, contentType) => {
            try {
              return (
                await recognizeNumericCaptcha(
                  env.AI,
                  imageBytes,
                  contentType,
                  5,
                )
              ).number;
            } catch {
              throw new MegabankVerificationRequiredError(
                "兆豐銀行驗證碼無法自動辨識，請改用人工輸入。",
              );
            }
          },
      // 只有使用者在場的手動同步才請銀行寄簡訊驗證碼，排程不觸發。
      { allowOtpRequest: trigger === "manual" },
    );
    result = await connector.sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    const awaitingOtp =
      error instanceof MegabankOtpRequiredError ||
      error instanceof MegabankOtpInvalidError;
    const cleaned = megabankStoredConfigAfterSync(stored);
    await updateConnectorEncryptedConfigIfCurrent(
      env.DB,
      connectorId,
      settings.encrypted_config,
      await encryptJson(
        awaitingOtp
          ? {
              ...cleaned,
              ...error.device,
              pendingSession: error.pendingSession,
              pendingSessionExpiresAt: error.pendingSessionExpiresAt,
            }
          : cleaned,
        configEncryptionKey(env),
      ),
    );
    if (awaitingOtp) throw error;
    if (error instanceof MegabankVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    if (error instanceof MegabankProtocolError) throw error;
    throw error;
  }

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const creditCardBills = result.creditCardBills ?? [];
  const now = new Date().toISOString();
  const records: SyncWriteRecord[] = [
    ...bankAccounts.map((account) =>
      bankAccountRecord(connectorId, account, now),
    ),
    ...bankBalanceSnapshots.map((snapshot) =>
      bankBalanceSnapshotRecord(connectorId, snapshot, now),
    ),
    ...bankTransactions.map((transaction) =>
      bankTransactionRecord(connectorId, transaction, now),
    ),
    ...creditCardBills.map((bill) =>
      creditCardBillRecord(connectorId, bill, now),
    ),
  ];
  const cleanedConfig = parseMegabankConfig(
    megabankStoredConfigAfterSync(config),
  );
  if (
    (await requireConnectorSettings(env.DB, connectorId)).encrypted_config !==
    settings.encrypted_config
  ) {
    throw new NeedsUserActionError(
      "兆豐銀行設定在同步期間已變更，請重新同步。",
    );
  }
  const settingsGuard = {
    connectorId,
    encryptedConfig: settings.encrypted_config,
  } as const;
  let persistedCursor: string | undefined;
  let persistedEncryptedConfig: string | undefined;
  const finalizeStatements: D1PreparedStatement[] = [];
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    persistedEncryptedConfig = await encryptConnectorConfig(
      env,
      connectorId,
      cleanedConfig,
    );
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        persistedEncryptedConfig,
        serializePublicConfig(connectorId, cleanedConfig),
        persistedCursor,
        now,
        settings.encrypted_config,
      ),
    );
  }
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    settingsGuard,
    afterPromoteStatements:
      bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB, settingsGuard)]
        : [],
    finalizeStatements,
  });
  if (
    persistedEncryptedConfig &&
    (await requireConnectorSettings(env.DB, connectorId)).encrypted_config !==
      persistedEncryptedConfig
  ) {
    throw new NeedsUserActionError(
      "兆豐銀行設定在同步期間已變更，請重新同步。",
    );
  }
  if (
    bankBalanceSnapshots.some((snapshot) =>
      bankAccounts.some(
        (account) =>
          account.sourceId === snapshot.accountId &&
          account.accountType !== "credit",
      ),
    )
  ) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }
  return {
    success: true,
    connectorId,
    scope,
    records: records.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}
