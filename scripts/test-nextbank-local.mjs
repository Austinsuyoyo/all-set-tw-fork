import { createServer } from "node:http";
import { randomBytes } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { fileURLToPath, pathToFileURL } from "node:url";
import path from "node:path";
import ts from "typescript";

// Standalone development probe. Only generated code is saved; never credentials,
// bank responses, CAPTCHA answers, session tokens or account numbers.
const root = fileURLToPath(new URL("../", import.meta.url));
const compiled = path.join(root, "node_modules/.cache/nextbank-probe");
await mkdir(compiled, { recursive: true });
for (const name of ["sync-window", "nextbank-api", "nextbank"]) {
  const source = (
    await readFile(
      path.join(root, `packages/connectors/src/${name}.ts`),
      "utf8",
    )
  )
    .replaceAll('"./sync-window"', '"./sync-window.mjs"')
    .replaceAll('"./nextbank-api"', '"./nextbank-api.mjs"');
  await writeFile(
    path.join(compiled, `${name}.mjs`),
    ts.transpileModule(source, {
      compilerOptions: {
        target: ts.ScriptTarget.ES2022,
        module: ts.ModuleKind.ESNext,
      },
    }).outputText,
  );
}
const { NextbankApiClient, NextbankApiError, collectNextbankDepositPayloads } =
  await import(pathToFileURL(path.join(compiled, "nextbank-api.mjs")));
const { parseNextbankDeposits } = await import(
  pathToFileURL(path.join(compiled, "nextbank.mjs"))
);
let stage = "準備";
let bankCode;
const stages = {
  Captcha: "取得驗證碼",
  CaptchaLogin: "銀行登入",
  AllInOne: "主帳戶查詢",
  PocketInfo: "口袋清單查詢",
  CurrentDepositDetail: "主帳戶交易查詢",
  GetPocketTxDetail: "口袋交易查詢",
  GetTermDepositDetail: "定存口袋查詢",
  Logout: "登出",
};
const client = new NextbankApiClient({
  fetcher: async (url, init) => {
    const action = new URL(String(url)).pathname.split("/").at(-1);
    stage = stages[action] ?? "銀行查詢";
    bankCode = undefined;
    const response = await fetch(url, init);
    let data;
    try {
      data = await response.clone().json();
    } catch {
      /* Record only the format, never the raw body. */
    }
    const code = data?.error?.errorCode;
    if (
      typeof code === "string" &&
      /^[A-Z_][A-Z_0-9]{2,79}$/.test(code) &&
      !/^[A-Z][12]\d{8}$/.test(code)
    )
      bankCode = code;
    console.log(
      "NEXTBANK_STEP " +
        JSON.stringify({
          action,
          httpStatus: response.status,
          success: typeof data?.success === "boolean" ? data.success : null,
          responseShape: shape(data),
        }),
    );
    return response;
  },
});
const csrf = randomBytes(32).toString("hex");
let busy = false;
let origin;

function shape(value, depth = 0) {
  if (value === null) return "null";
  if (depth > 7) return "nested";
  if (Array.isArray(value))
    return {
      type: "array",
      count: value.length,
      items: value.slice(0, 3).map((item) => shape(item, depth + 1)),
    };
  if (typeof value === "object")
    return Object.fromEntries(
      Object.entries(value)
        .slice(0, 80)
        .map(([key, child]) => [
          /^[a-z][A-Za-z]{0,60}$/.test(key) ? key : "[redacted-key]",
          shape(child, depth + 1),
        ]),
    );
  return typeof value;
}

const page = `<!doctype html><html lang="zh-Hant"><meta charset="utf-8"><meta name="viewport" content="width=device-width"><title>將來銀行本機測試</title>
<style>body{font:17px system-ui;max-width:620px;margin:40px auto;padding:20px;background:#f4f7fa;color:#172b42}form{display:grid;gap:14px}input,button{font:inherit;padding:12px}label{display:grid;gap:5px}button{cursor:pointer}pre{white-space:pre-wrap;overflow-wrap:anywhere}img{max-width:300px}</style>
<h1>將來銀行本機測試</h1><p>資料只在這台電腦記憶體中處理。登入後查詢主帳戶、最近三個月交易及口袋，完成後登出。這次尚不包含投資部位。</p>
<p>請先結束將來銀行 App 的登入，避免工作階段衝突。銀行要求其他驗證時會停止，不會重試密碼。</p>
<form id="form"><label>身分證字號<input name="identity" autocomplete="off" required></label><label>使用者代號<input name="userId" autocomplete="off" required></label><label>密碼<input name="password" type="password" autocomplete="off" required></label>
<button type="button" id="captcha">取得圖形驗證碼</button><img id="image" alt="取得後顯示驗證碼" hidden><label>圖形驗證碼<input name="captchaResult" autocomplete="off" required></label><button id="submit">登入並測試唯讀查詢</button></form><pre id="status" role="status"></pre>
<script nonce="${csrf}">
const form=document.querySelector('#form'),status=document.querySelector('#status');
async function post(route,body){const response=await fetch(route,{method:'POST',headers:{'Content-Type':'application/json','X-Probe-Token':'${csrf}'},body:JSON.stringify(body)});const data=await response.json();if(!response.ok)throw Error(data.error);return data;}
document.querySelector('#captcha').onclick=async()=>{try{const data=await post('/captcha',{});const image=document.querySelector('#image');image.src='data:image/png;base64,'+data.imageBase64;image.hidden=false;status.textContent='請輸入圖形驗證碼，有效時間兩分鐘。';}catch(e){status.textContent=e.message;}};
form.onsubmit=async(event)=>{event.preventDefault();const body=Object.fromEntries(new FormData(form));form.querySelectorAll('input,button').forEach(el=>el.disabled=true);form.elements.password.value='';status.textContent='正在登入並查詢，請勿重複提交…';try{const data=await post('/run',body);status.textContent='查詢成功。主帳戶查詢期間：'+data.months+' 個月；口袋數：'+data.pockets+'。\\n'+data.logout+'\\n正規化成功；交易共 '+data.review.transactionCount+' 筆。請核對下列餘額及全部交易（負數為支出，正數為收入）（僅顯示於本機、不寫入資料庫）。\\n'+data.review.accounts.map(a=>a.name+'：'+a.balance+' '+a.currency).join('\\n')+'\\n'+data.review.transactions.map(t=>t.date+' ['+t.accountName+'] '+(t.amount<0?'支出':t.amount>0?'收入':'零金額')+' '+t.amount+' '+(t.description||'')).join('\\n');}catch(e){status.textContent=e.message;}finally{body.password='';form.querySelectorAll('input,button').forEach(el=>el.disabled=false);form.elements.captchaResult.value='';document.querySelector('#image').hidden=true;}};
</script></html>`;

function respond(res, code, data) {
  res.writeHead(code, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store",
    "X-Content-Type-Options": "nosniff",
  });
  res.end(JSON.stringify(data));
}
const server = createServer(async (req, res) => {
  if (req.headers.host !== new URL(origin).host)
    return respond(res, 403, { error: "來源不符" });
  if (req.method === "GET" && req.url === "/") {
    res.writeHead(200, {
      "Content-Type": "text/html; charset=utf-8",
      "Cache-Control": "no-store",
      "Referrer-Policy": "no-referrer",
      "Content-Security-Policy": `default-src 'none'; script-src 'nonce-${csrf}'; style-src 'unsafe-inline'; img-src data:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`,
    });
    return res.end(page);
  }
  if (
    req.method !== "POST" ||
    req.headers.origin !== origin ||
    req.headers["x-probe-token"] !== csrf ||
    req.headers["content-type"] !== "application/json"
  )
    return respond(res, 403, { error: "來源不符" });
  if (!["/captcha", "/run"].includes(req.url))
    return respond(res, 404, { error: "找不到操作" });
  if (busy) return respond(res, 409, { error: "查詢進行中，請稍候" });
  busy = true;
  let accessToken;
  try {
    let body = "";
    for await (const chunk of req) {
      body += chunk.toString();
      if (body.length > 8192) throw new Error("body");
    }
    const input = JSON.parse(body);
    body = "";
    if (req.url === "/captcha") {
      const challenge = await client.prepareCaptcha();
      return respond(res, 200, { imageBase64: challenge.imageBase64 });
    }
    if (
      !["identity", "userId", "password", "captchaResult"].every(
        (key) => typeof input[key] === "string",
      )
    )
      throw new Error("input");
    try {
      ({ accessToken } = await client.login(input));
    } finally {
      input.password = "";
    }
    const data = await collectNextbankDepositPayloads(client, accessToken);
    stage = "存款資料正規化與口袋總額核對";
    bankCode = undefined;
    const normalized = parseNextbankDeposits(data);
    // This review is sent only to the requesting localhost page, never logged
    // or written to disk. Do not return raw identifiers or complete responses.
    const review = {
      accounts: normalized.bankAccounts.map((account) => ({
        name: account.accountName,
        type: account.accountType,
        balance: normalized.bankBalanceSnapshots.find(
          (snapshot) => snapshot.accountId === account.sourceId,
        )?.balance,
        currency: account.currency,
      })),
      transactionCount: normalized.bankTransactions.length,
      transactions: [...normalized.bankTransactions]
        .sort((a, b) =>
          String(b.authorizedAt ?? b.postedDate).localeCompare(
            String(a.authorizedAt ?? a.postedDate),
          ),
        )
        .map((transaction) => ({
          date: transaction.authorizedAt ?? transaction.postedDate,
          accountName:
            normalized.bankAccounts.find(
              (account) => account.sourceId === transaction.accountId,
            )?.accountName ?? "未知帳戶",
          amount: transaction.amount,
          description: transaction.description,
        })),
    };
    // Types and list lengths only. Never print customer data or exception bodies.
    console.log("NEXTBANK_RESPONSE_SHAPE " + JSON.stringify(shape(data)));
    let logout = "已登出銀行工作階段。";
    try {
      await client.logout(accessToken);
    } catch {
      logout = "查詢完成，但銀行登出未確認；請在銀行 App 確認工作階段。";
    }
    accessToken = undefined;
    respond(res, 200, {
      months: data.mainTransactions.length,
      pockets: data.pockets.length,
      review,
      logout,
    });
  } catch (error) {
    const kind = error instanceof NextbankApiError ? error.kind : "local_error";
    console.log("NEXTBANK_PROBE_RESULT " + JSON.stringify({ stage, kind }));
    respond(res, 400, {
      error:
        "測試未完成【" +
        stage +
        "】：" +
        kind +
        (bankCode ? "（銀行代碼：" + bankCode + "）" : "") +
        "。如需重試，請重新取得驗證碼。",
    });
  } finally {
    if (accessToken) {
      try {
        await client.logout(accessToken);
      } catch {
        console.log("NEXTBANK_LOGOUT_UNCONFIRMED");
      }
    }
    busy = false;
  }
});
server.requestTimeout = 60_000;
const port = Number(process.env.NEXTBANK_PROBE_PORT ?? 0);
if (!Number.isInteger(port) || port < 0 || port > 65535)
  throw new Error("Invalid probe port");
server.listen(port, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Nextbank local probe: ${origin}`);
});
