import type { Env } from "../../../platform/env";
import type { SyncTrigger } from "../../../db";
import type { SyncOutcome } from "../types";
import {
  requireConnectorSettings,
  encryptConnectorConfig,
  serializePublicConfig,
} from "../config";
import { decryptJson } from "../../../platform/crypto";
import { configEncryptionKey } from "../../../platform/config";
import { parseCtbcConfig } from "../../../connectors/protocols/ctbc";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../connector-state";
import {
  createCtbcConnector,
  CtbcVerificationRequiredError,
} from "../../../connectors/protocols/ctbc-mobile-api";
import { createCtbcFetch } from "../../../connectors/ctbc";
import { NeedsUserActionError } from "../errors";
import { type SyncWriteRecord, persistStagedSyncWrite } from "../persistence";
import {
  bankAccountRecord,
  bankBalanceSnapshotRecord,
  bankTransactionRecord,
  creditCardBillRecord,
} from "../record-mapper";
import {
  connectorStateStatement,
  linkCanonicalBankAccountsStatement,
} from "../repository";
import { prepareCtbcAuthorizationWrite } from "../ctbc-authorizations";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../net-worth/service";

export async function syncCtbc(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "ctbc";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseCtbcConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );

  let result: Awaited<
    ReturnType<ReturnType<typeof createCtbcConnector>["sync"]>
  >;
  try {
    const fetcher = createCtbcFetch(env);
    const connector = fetcher
      ? createCtbcConnector(fetcher)
      : createCtbcConnector();
    result = await connector.sync(config, settings.sync_cursor ?? undefined);
  } catch (error) {
    if (error instanceof CtbcVerificationRequiredError) {
      throw new NeedsUserActionError(error.message);
    }
    throw error;
  }

  const bankAccounts = result.bankAccounts ?? [];
  const bankBalanceSnapshots = result.bankBalanceSnapshots ?? [];
  const bankTransactions = result.bankTransactions ?? [];
  const creditCardBills = result.creditCardBills ?? [];
  console.log(
    `[sync] ${connectorId}/${scope}: accounts=${bankAccounts.length} snapshots=${bankBalanceSnapshots.length} transactions=${bankTransactions.length} bills=${creditCardBills.length}`,
  );

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

  let persistedCursor: string | undefined;
  const finalizeStatements: D1PreparedStatement[] = [];
  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, config),
        serializePublicConfig(connectorId, config),
        persistedCursor,
        now,
      ),
    );
  }

  const authorizationWrite = await prepareCtbcAuthorizationWrite(
    env.DB,
    records,
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records: authorizationWrite.records,
    afterPromoteStatements: [
      ...authorizationWrite.afterPromoteStatements,
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : []),
    ],
    finalizeStatements,
  });

  if (bankBalanceSnapshots.length > 0) {
    await rebuildBankDepositHistory(env.DB, [dateFromIso(now)]);
  }

  return {
    success: true,
    connectorId,
    scope,
    records:
      bankAccounts.length +
      bankBalanceSnapshots.length +
      bankTransactions.length +
      creditCardBills.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}
