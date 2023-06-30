import { NextRequest } from "next/server";
import { getServerSideConfig } from "../config/server";
import md5 from "spark-md5";
import { ACCESS_CODE_PREFIX } from "../constant";

function getIP(req: NextRequest) {
  let ip = req.ip ?? req.headers["x-real-ip"];
  const forwardedFor = req.headers["x-forwarded-for"];

  if (!ip && forwardedFor) {
    [ip] = forwardedFor.split(",") ?? [""];
  }

  return ip;
}

function parseApiKey(bearToken: string) {
  const token = bearToken.trim();
  const isOpenAiKey = !token.startsWith("Bearer ");

  return {
    accessCode: isOpenAiKey ? "" : token.slice(ACCESS_CODE_PREFIX.length),
    apiKey: isOpenAiKey ? token : "",
  };
}

export function auth(req: NextRequest) {
  const authToken = req.headers.get("Authorization") || "";

  // check if it is an OpenAI API key or a user token
  const { accessCode, apiKey: token } = parseApiKey(authToken);

  const hashedCode = md5.hash(accessCode || "").trim();

  const serverConfig = getServerSideConfig();
  console.log("[Auth] allowed hashed codes:", [...serverConfig.codes]);
  console.log("[Auth] got access code:", accessCode);
  console.log("[Auth] hashed access code:", hashedCode);
  console.log("[User IP]:", getIP(req));
  console.log("[Time]:", new Date().toLocaleString());

  if (serverConfig.needCode && !serverConfig.codes.has(hashedCode) && !token) {
    return {
      error: true,
      msg: accessCode ? "wrong access code" : "empty access code",
    };
  }

  // if the user does not provide an API key, inject the system API key
  if (!token) {
    const { apiKey } = serverConfig;
    if (apiKey) {
      console.log("[Auth] use system API key");
      req.headers.set("Authorization", `Bearer ${apiKey}`);
    } else {
      console.log("[Auth] admin did not provide an API key");
    }
  } else {
    console.log("[Auth] use user API key");
  }

  return {
    error: false,
  };
}
