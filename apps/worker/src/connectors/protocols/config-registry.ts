import type { ConnectorId } from "@taiwan-fin-hub/shared";
import type { z } from "zod";
import { invoiceConfigSchema } from "./einvoice";
import { tdccConfigSchema } from "./tdcc";
import { esunConfigSchema } from "./esun";
import { cathaybkConfigSchema } from "./cathaybk";
import { sinopacConfigSchema } from "./sinopac";
import { taishinConfigSchema } from "./taishin";
import { ctbcConfigSchema } from "./ctbc";
import { skbankConfigSchema } from "./skbank";
import { obankConfigSchema } from "./obank";
import { nextbankConfigSchema } from "./nextbank";
import { firstbankConfigSchema } from "./firstbank";
import { hncbConfigSchema } from "./hncb";
import { rakutenConfigSchema } from "./rakuten";
import { kgibankConfigSchema } from "./kgibank";
import { megabankConfigSchema } from "./megabank";

export const connectorConfigSchemas = {
  einvoice: invoiceConfigSchema,
  tdcc: tdccConfigSchema,
  esun: esunConfigSchema,
  cathaybk: cathaybkConfigSchema,
  sinopac: sinopacConfigSchema,
  taishin: taishinConfigSchema,
  ctbc: ctbcConfigSchema,
  skbank: skbankConfigSchema,
  obank: obankConfigSchema,
  nextbank: nextbankConfigSchema,
  firstbank: firstbankConfigSchema,
  hncb: hncbConfigSchema,
  rakuten: rakutenConfigSchema,
  kgibank: kgibankConfigSchema,
  megabank: megabankConfigSchema,
} satisfies Record<ConnectorId, z.ZodTypeAny>;

export function parseConnectorConfig(
  connectorId: ConnectorId,
  config: unknown,
) {
  return connectorConfigSchemas[connectorId].parse(config);
}
