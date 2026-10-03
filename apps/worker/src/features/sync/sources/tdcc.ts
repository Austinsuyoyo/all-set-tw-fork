import type { Env } from "../../../platform/env";
import { type SyncTrigger, upsertConnectorSettings } from "../../../db";
import {
  type SyncOutcome,
  SYNC_SCOPE_ALL,
  TDCC_SCOPE_INVESTMENTS,
  TDCC_SCOPE_BANK,
  TDCC_SCOPE_TRADES,
  type SyncScope,
} from "../types";
import {
  emptySyncNewRecordCounts,
  type SyncWriteRecord,
  persistStagedSyncWrite,
} from "../persistence";
import type { SyncNewRecordCounts } from "@taiwan-fin-hub/shared";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../config";
import { decryptJson, encryptJson } from "../../../platform/crypto";
import { configEncryptionKey } from "../../../platform/config";
import {
  parseTdccConfig,
  tdccConnector,
  syncTdccTradeHistory,
  TdccOtpExpiredError,
} from "../../../connectors/protocols/tdcc";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
  investmentPositionRecord,
  netWorthHistoryRecord,
  investmentTransactionRecord,
} from "../record-mapper";
import { splitConnectorCursorState } from "../connector-state";
import {
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../repository";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../net-worth/service";
import { NeedsUserActionError, isUserActionError } from "../errors";

export type TdccSyncOverrides = {
  otp?: string;
  otpChannel?: "email" | "sms";
};

export async function syncTdcc(
  env: Env,
  trigger: SyncTrigger,
  overrides: TdccSyncOverrides,
  scopes: string[],
): Promise<SyncOutcome> {
  const selected = new Set(
    scopes.includes(SYNC_SCOPE_ALL)
      ? [TDCC_SCOPE_INVESTMENTS, TDCC_SCOPE_BANK, TDCC_SCOPE_TRADES]
      : scopes,
  );
  const scope = tdccOutcomeScope(selected);
  let records = 0;
  const newRecords = emptySyncNewRecordCounts();
  let cursorUpdated = false;

  if (selected.has(TDCC_SCOPE_INVESTMENTS) || selected.has(TDCC_SCOPE_BANK)) {
    const result = await syncTdccPositionsAndBank(env, trigger, overrides, {
      writeInvestments: selected.has(TDCC_SCOPE_INVESTMENTS),
      writeBank: selected.has(TDCC_SCOPE_BANK),
      scope,
    });
    records += result.records;
    mergeSyncNewRecordCounts(newRecords, result.newRecords);
    cursorUpdated = cursorUpdated || result.cursorUpdated;
  }

  if (selected.has(TDCC_SCOPE_TRADES)) {
    const result = await syncTdccTrades(env, trigger, overrides, scope);
    records += result.records;
    mergeSyncNewRecordCounts(newRecords, result.newRecords);
    cursorUpdated = cursorUpdated || result.cursorUpdated;
  }

  return {
    success: true,
    connectorId: "tdcc",
    scope,
    records,
    newRecords,
    cursorUpdated,
  };
}

async function syncTdccPositionsAndBank(
  env: Env,
  trigger: SyncTrigger,
  overrides: TdccSyncOverrides,
  options: {
    writeInvestments: boolean;
    writeBank: boolean;
    scope: SyncScope;
  },
): Promise<{
  records: number;
  newRecords: SyncNewRecordCounts;
  cursorUpdated: boolean;
}> {
  const connectorId = "tdcc";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const config = await decryptJson<unknown>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const mergedConfig = { ...(config as Record<string, unknown>), ...overrides };
  const parsedConfig = parseTdccConfig({
    ...mergedConfig,
    requestOtp: trigger === "manual",
  });
  requireTdccCredentials(parsedConfig);
  const syncScope = options.scope;
  console.log(
    `[sync] ${connectorId}/${syncScope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<ReturnType<typeof tdccConnector.sync>>;
  try {
    result = await tdccConnector.sync(
      parsedConfig,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    await handleTdccSyncError(
      env,
      settings.id,
      connectorId,
      mergedConfig,
      syncScope,
      trigger,
      error,
    );
    throw error;
  }

  console.log(
    `[sync] ${connectorId}/${syncScope}: fetched ${result.records.length} investment records`,
  );
  const now = new Date().toISOString();

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const netWorthHistory = result.netWorthHistory ?? [];
  console.log(
    `[sync] ${connectorId}/${syncScope}: bank accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length} history=${netWorthHistory.length}`,
  );
  const records: SyncWriteRecord[] = [
    ...(options.writeBank
      ? bankAccounts.map((account) =>
          bankAccountRecord(connectorId, account, now),
        )
      : []),
    ...(options.writeBank
      ? bankBalanceSnapshots.map((snapshot) =>
          bankBalanceSnapshotRecord(connectorId, snapshot, now),
        )
      : []),
    ...(options.writeBank
      ? bankTransactions.map((transaction) =>
          bankTransactionRecord(connectorId, transaction, now),
        )
      : []),
    ...(options.writeInvestments
      ? result.records.map((position) =>
          investmentPositionRecord(connectorId, position, now),
        )
      : []),
    ...netWorthHistory.map((point) =>
      netWorthHistoryRecord(connectorId, point, now),
    ),
  ];
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    const {
      otp: _otp,
      otpChannel: _otpChannel,
      requestOtp: _requestOtp,
      ...reusableConfig
    } = parsedConfig;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...reusableConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, parsedConfig),
        persistedCursor,
        now,
      ),
    );
  }

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements:
      options.writeBank && bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : [],
    finalizeStatements,
  });

  if (options.writeBank && bankBalanceSnapshots.length > 0) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }

  return {
    records:
      (options.writeInvestments ? result.records.length : 0) +
      (options.writeBank
        ? bankAccounts.length +
          bankBalanceSnapshots.length +
          bankTransactions.length
        : 0),
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

async function syncTdccTrades(
  env: Env,
  trigger: SyncTrigger,
  overrides: TdccSyncOverrides,
  scope: SyncScope,
): Promise<{
  records: number;
  newRecords: SyncNewRecordCounts;
  cursorUpdated: boolean;
}> {
  const connectorId = "tdcc";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const config = await decryptJson<unknown>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const mergedConfig = { ...(config as Record<string, unknown>), ...overrides };
  const parsedConfig = parseTdccConfig({
    ...mergedConfig,
    requestOtp: trigger === "manual",
  });
  requireTdccCredentials(parsedConfig);
  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<ReturnType<typeof syncTdccTradeHistory>>;
  try {
    result = await syncTdccTradeHistory(
      parsedConfig,
      settings.sync_cursor ?? undefined,
    );
  } catch (error) {
    await handleTdccSyncError(
      env,
      settings.id,
      connectorId,
      mergedConfig,
      scope,
      trigger,
      error,
    );
    throw error;
  }

  const now = new Date().toISOString();
  const investmentTransactions = result.investmentTransactions ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: fetched ${investmentTransactions.length} investment transactions`,
  );
  const records = investmentTransactions.map((transaction) =>
    investmentTransactionRecord(connectorId, transaction, now),
  );
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    const {
      otp: _otp,
      otpChannel: _otpChannel,
      requestOtp: _requestOtp,
      ...reusableConfig
    } = parsedConfig;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...reusableConfig,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, parsedConfig),
        persistedCursor,
        now,
      ),
    );
  }

  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    finalizeStatements,
  });

  return {
    records: investmentTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}

function mergeSyncNewRecordCounts(
  target: SyncNewRecordCounts,
  source: SyncNewRecordCounts,
) {
  target.invoices += source.invoices;
  target.bankTransactions += source.bankTransactions;
  target.investmentTransactions += source.investmentTransactions;
}

function tdccOutcomeScope(scopes: Set<string>): SyncScope {
  const allScopes = [
    TDCC_SCOPE_INVESTMENTS,
    TDCC_SCOPE_BANK,
    TDCC_SCOPE_TRADES,
  ];
  if (allScopes.every((scope) => scopes.has(scope))) return SYNC_SCOPE_ALL;
  return (allScopes.filter((scope) => scopes.has(scope)).join("+") ||
    SYNC_SCOPE_ALL) as SyncScope;
}

function requireTdccCredentials(config: {
  userId?: string;
  password?: string;
}) {
  if (!config.userId || !config.password) {
    throw new NeedsUserActionError(
      "請重新輸入身分證字號與集保 App 密碼，再開始連線。",
    );
  }
}

async function handleTdccSyncError(
  env: Env,
  settingsId: string,
  connectorId: "tdcc",
  mergedConfig: Record<string, unknown>,
  scope: SyncScope,
  trigger: SyncTrigger,
  error: unknown,
): Promise<never> {
  if (error instanceof TdccOtpExpiredError) {
    const { otp, ...configWithoutOtp } = mergedConfig;
    await upsertConnectorSettings(env.DB, {
      id: settingsId,
      connectorId,
      encryptedConfig: await encryptJson(
        configWithoutOtp,
        configEncryptionKey(env),
      ),
      publicConfig: null,
      now: new Date().toISOString(),
    });
    console.log(
      `[sync] ${connectorId}/${scope}: cleared expired otp from config`,
    );
  }

  if (trigger === "scheduled" && isUserActionError(error)) {
    throw new NeedsUserActionError(
      error instanceof Error ? error.message : "Sync requires user action.",
    );
  }

  throw error;
}
