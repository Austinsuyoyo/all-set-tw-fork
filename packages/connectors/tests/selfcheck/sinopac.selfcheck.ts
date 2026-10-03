import assert from "node:assert/strict";
import {
  fetchSinopacDeposits,
  parseSinopacDepositAccounts,
  parseSinopacDepositTransactions,
} from "../../src/sinopac-deposits";
import {
  sinopacDepositAccounts,
  sinopacDepositTransactions,
  sinopacDepositNoTransactions,
} from "../fixtures/sinopac-deposits";

const now = new Date("2026-10-03T04:00:00Z");
const accounts = parseSinopacDepositAccounts(sinopacDepositAccounts, now);
const transactions = parseSinopacDepositTransactions(
  sinopacDepositTransactions,
  "0000000012345",
  "TWD",
);
assert.deepEqual(
  accounts.bankBalanceSnapshots.map((s) => s.balance),
  [12000, 0],
);
assert.deepEqual(
  transactions.map((t) => t.amount),
  [-1000, 600],
);
assert.equal(transactions[0].accountId, accounts.bankAccounts[0].sourceId);
assert.equal(transactions[0].authorizedAt, "2026-10-02T19:06:00+08:00");
assert.equal(transactions[1].authorizedAt, "2026-10-01");
assert.equal(
  transactions[0].sourceId,
  parseSinopacDepositTransactions(
    sinopacDepositTransactions,
    "0000000012345",
    "TWD",
  )[0].sourceId,
);
assert.ok(!JSON.stringify({ accounts, transactions }).includes("00000000"));
const result = await fetchSinopacDeposits(
  async (path, _label, body) =>
    path.includes("ws_bankbal")
      ? sinopacDepositAccounts
      : body.get("Curr") === "TWD"
        ? sinopacDepositTransactions
        : sinopacDepositNoTransactions,
  now,
);
assert.equal(result.bankAccounts.length, 2);
assert.equal(result.bankTransactions.length, 2);
console.log("Sinopac deposit self-check passed");
