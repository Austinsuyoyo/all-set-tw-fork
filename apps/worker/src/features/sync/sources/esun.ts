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
import { parseEsunConfig } from "../../../connectors/protocols/esun";
import {
  parsePublicConnectorConfig,
  splitConnectorCursorState,
} from "../connector-state";
import { createEsunConnector } from "../../../connectors/esun";
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
  reconcileEsunLifecycleShadowStatements,
  reconcileEsunSingleCardSummaryAccountStatements,
} from "../repository";
import { prepareEsunAuthorizationWrite } from "../esun-authorizations";
import {
  rebuildBankDepositHistory,
  dateFromIso,
} from "../../net-worth/service";

export async function syncEsun(
  env: Env,
  trigger: SyncTrigger,
): Promise<SyncOutcome> {
  const connectorId = "esun";
  const scope = "all";
  const settings = await requireConnectorSettings(env.DB, connectorId);
  const stored = await decryptJson<Record<string, unknown>>(
    settings.encrypted_config,
    configEncryptionKey(env),
  );
  const config = parseEsunConfig({
    ...stored,
    ...parsePublicConnectorConfig(connectorId, settings.public_config),
  });

  console.log(
    `[sync] ${connectorId}/${scope}: starting trigger=${trigger} (cursor=${settings.sync_cursor ? "set" : "none"})`,
  );
  const result = await createEsunConnector(env.BROWSER).sync(
    config,
    settings.sync_cursor ?? undefined,
  );

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
  const finalizeStatements: D1PreparedStatement[] = [];
  let persistedCursor: string | undefined;

  if (result.cursor) {
    const cursorState = splitConnectorCursorState(connectorId, result.cursor);
    persistedCursor = cursorState.safeCursor;
    finalizeStatements.push(
      connectorStateStatement(
        env.DB,
        connectorId,
        await encryptConnectorConfig(env, connectorId, {
          ...config,
          ...cursorState.secretState,
        }),
        serializePublicConfig(connectorId, config),
        persistedCursor,
        now,
      ),
    );
  }

  const authorizationStatements = await prepareEsunAuthorizationWrite(
    env.DB,
    records,
  );
  const newRecords = await persistStagedSyncWrite(env.DB, {
    records,
    afterPromoteStatements: [
      ...(bankAccounts.length > 0
        ? [linkCanonicalBankAccountsStatement(env.DB)]
        : []),
      ...reconcileEsunLifecycleShadowStatements(env.DB),
      ...reconcileEsunSingleCardSummaryAccountStatements(env.DB),
      ...authorizationStatements,
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
      bankTransactions.length,
    newRecords,
    cursorUpdated: Boolean(
      persistedCursor && persistedCursor !== settings.sync_cursor,
    ),
  };
}
