import { describe, expect, it, vi } from "vitest";
import {
  createSinopacConnector,
  SINOPAC_SESSION_PROTOCOL,
  SinopacVerificationRequiredError,
} from "../../../src/sources/sinopac/connector";
import { parseSinopacConfig } from "../../../src/sources/sinopac/protocol";

describe("永豐 connector 安全錯誤處理", () => {
  it("HTTP 200 登入頁不進入帳戶 parser，也不記錄 response、session 或憑證", async () => {
    const info = vi.spyOn(console, "info").mockImplementation(() => {});
    const warning = vi.spyOn(console, "warn").mockImplementation(() => {});
    const responseBody =
      "<html><body>m_login PRIVATE_HTML_SENTINEL 777777777</body></html>";
    const fetchImpl = vi.fn(
      async () =>
        new Response(responseBody, {
          status: 200,
          headers: { "content-type": "text/html; charset=utf-8" },
        }),
    );
    const config = parseSinopacConfig({
      userId: "PRIVATE_USER_ID_SENTINEL",
      account: "PRIVATE_ACCOUNT_SENTINEL",
      password: "PRIVATE_PASSWORD_SENTINEL",
      sessionCookies: JSON.stringify([
        {
          name: "SESSION",
          value: "PRIVATE_COOKIE_SENTINEL",
          domain: "m.sinopac.com",
          expires: -1,
        },
      ]),
      protocol: SINOPAC_SESSION_PROTOCOL,
    });

    try {
      const connector = createSinopacConnector(undefined, fetchImpl);
      await expect(connector.sync(config)).rejects.toBeInstanceOf(
        SinopacVerificationRequiredError,
      );
      expect(info).not.toHaveBeenCalled();
      expect(warning).not.toHaveBeenCalled();
      expect(fetchImpl).toHaveBeenCalledTimes(1);
    } finally {
      info.mockRestore();
      warning.mockRestore();
    }
  });
});
