import assert from "node:assert/strict";
import test from "node:test";
import { xiaomiCookieHeader, type BrowserCookie } from "../lib/mimo-browser.ts";

const cookie = (
  name: string,
  value: string,
  domain = ".platform.xiaomimimo.com",
): BrowserCookie => ({
  name,
  value,
  domain,
  path: "/",
  expires: -1,
});

test("MiMo browser import uses only required and known cookies", () => {
  const header = xiaomiCookieHeader([
    cookie("userId", "123", ".xiaomimimo.com"),
    cookie("api-platform_serviceToken", "token"),
    cookie("api-platform_ph", "ph"),
    cookie("unrelated", "secret"),
  ]);
  assert.equal(header, "api-platform_serviceToken=token; userId=123; api-platform_ph=ph");
});

test("MiMo browser import rejects incomplete, expired, or unrelated-domain sessions", () => {
  assert.equal(xiaomiCookieHeader([cookie("api-platform_serviceToken", "token")]), undefined);
  assert.equal(
    xiaomiCookieHeader([
      cookie("api-platform_serviceToken", "token", ".other.com"),
      cookie("userId", "123", ".xiaomimimo.com"),
    ]),
    undefined,
  );
  assert.equal(
    xiaomiCookieHeader(
      [
        { ...cookie("api-platform_serviceToken", "token"), expires: 1 },
        cookie("userId", "123", ".xiaomimimo.com"),
      ],
      2,
    ),
    undefined,
  );
});
