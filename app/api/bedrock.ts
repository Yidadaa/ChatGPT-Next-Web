import { NextRequest, NextResponse } from "next/server";
import { auth } from "./auth";
import { sign, decrypt } from "../utils/aws";
import { getServerSideConfig } from "../config/server";
import { ModelProvider } from "../constant";
import { prettyObject } from "../utils/format";

const ALLOWED_PATH = new Set(["chat", "models"]);

function parseEventData(chunk: Uint8Array): any {
  const decoder = new TextDecoder();
  const text = decoder.decode(chunk);
  try {
    const parsed = JSON.parse(text);
    // AWS Bedrock wraps the response in a 'body' field
    if (typeof parsed.body === "string") {
      try {
        const bodyJson = JSON.parse(parsed.body);
        return bodyJson;
      } catch (e) {
        return { output: parsed.body };
      }
    }
    return parsed.body || parsed;
  } catch (e) {
    // console.error("Error parsing event data:", e);
    try {
      // Handle base64 encoded responses
      const base64Match = text.match(/:"([A-Za-z0-9+/=]+)"/);
      if (base64Match) {
        const decoded = Buffer.from(base64Match[1], "base64").toString("utf-8");
        try {
          return JSON.parse(decoded);
        } catch (e) {
          return { output: decoded };
        }
      }

      // Handle event-type responses
      const eventMatch = text.match(/:event-type[^\{]+({.*})/);
      if (eventMatch) {
        try {
          return JSON.parse(eventMatch[1]);
        } catch (e) {
          return { output: eventMatch[1] };
        }
      }

      // Handle plain text responses
      if (text.trim()) {
        // Clean up any malformed JSON characters
        const cleanText = text.replace(/[\x00-\x1F\x7F-\x9F]/g, "");
        return { output: cleanText };
      }
    } catch (innerError) {
      console.error("Error in fallback parsing:", innerError);
    }
  }
  return null;
}

async function* transformBedrockStream(
  stream: ReadableStream,
  modelId: string,
) {
  const reader = stream.getReader();
  let buffer = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) {
        if (buffer) {
          yield `data: ${JSON.stringify({
            delta: { text: buffer },
          })}\n\n`;
        }
        break;
      }

      const parsed = parseEventData(value);
      if (!parsed) continue;

      // Handle Titan models
      if (modelId.startsWith("amazon.titan")) {
        const text = parsed.outputText || "";
        if (text) {
          yield `data: ${JSON.stringify({
            delta: { text },
          })}\n\n`;
        }
      }
      // Handle LLaMA models
      else if (modelId.startsWith("us.meta.llama")) {
        let text = "";
        if (parsed.outputs?.[0]?.text) {
          text = parsed.outputs[0].text;
        } else if (parsed.generation) {
          text = parsed.generation;
        } else if (parsed.output) {
          text = parsed.output;
        } else if (typeof parsed === "string") {
          text = parsed;
        }

        if (text) {
          yield `data: ${JSON.stringify({
            delta: { text },
          })}\n\n`;
        }
      }
      // Handle Mistral models
      else if (modelId.startsWith("mistral.mistral")) {
        let text = "";
        if (parsed.outputs?.[0]?.text) {
          text = parsed.outputs[0].text;
        } else if (parsed.output) {
          text = parsed.output;
        } else if (parsed.completion) {
          text = parsed.completion;
        } else if (typeof parsed === "string") {
          text = parsed;
        }

        if (text) {
          yield `data: ${JSON.stringify({
            delta: { text },
          })}\n\n`;
        }
      }
      // Handle Claude models
      else if (modelId.startsWith("anthropic.claude")) {
        if (parsed.type === "content_block_delta") {
          if (parsed.delta?.type === "text_delta") {
            yield `data: ${JSON.stringify({
              delta: { text: parsed.delta.text },
            })}\n\n`;
          } else if (parsed.delta?.type === "input_json_delta") {
            yield `data: ${JSON.stringify(parsed)}\n\n`;
          }
        } else if (
          parsed.type === "message_delta" &&
          parsed.delta?.stop_reason
        ) {
          yield `data: ${JSON.stringify({
            delta: { stop_reason: parsed.delta.stop_reason },
          })}\n\n`;
        } else if (
          parsed.type === "content_block_start" &&
          parsed.content_block?.type === "tool_use"
        ) {
          yield `data: ${JSON.stringify(parsed)}\n\n`;
        } else if (parsed.type === "content_block_stop") {
          yield `data: ${JSON.stringify(parsed)}\n\n`;
        }
      }
    }
  } finally {
    reader.releaseLock();
  }
}

function validateRequest(body: any, modelId: string): void {
  if (!modelId) throw new Error("Model ID is required");

  // Handle nested body structure
  const bodyContent = body.body || body;

  if (modelId.startsWith("anthropic.claude")) {
    if (
      !body.anthropic_version ||
      body.anthropic_version !== "bedrock-2023-05-31"
    ) {
      throw new Error("anthropic_version must be 'bedrock-2023-05-31'");
    }
    if (typeof body.max_tokens !== "number" || body.max_tokens < 0) {
      throw new Error("max_tokens must be a positive number");
    }
    if (modelId.startsWith("anthropic.claude-3")) {
      if (!Array.isArray(body.messages))
        throw new Error("messages array is required for Claude 3");
    } else if (typeof body.prompt !== "string") {
      throw new Error("prompt is required for Claude 2 and earlier");
    }
  } else if (modelId.startsWith("us.meta.llama")) {
    if (!bodyContent.prompt || typeof bodyContent.prompt !== "string") {
      throw new Error("prompt string is required for LLaMA models");
    }
    if (
      !bodyContent.max_gen_len ||
      typeof bodyContent.max_gen_len !== "number"
    ) {
      throw new Error("max_gen_len must be a positive number for LLaMA models");
    }
  } else if (modelId.startsWith("mistral.mistral")) {
    if (!bodyContent.prompt) {
      throw new Error("prompt is required for Mistral models");
    }
  } else if (modelId.startsWith("amazon.titan")) {
    if (!bodyContent.inputText) throw new Error("Titan requires inputText");
  }
}

async function requestBedrock(req: NextRequest) {
  const controller = new AbortController();

  // Get AWS credentials from server config first
  const config = getServerSideConfig();
  let awsRegion = config.awsRegion;
  let awsAccessKey = config.awsAccessKey;
  let awsSecretKey = config.awsSecretKey;

  // If server-side credentials are not available, parse from Authorization header
  if (!awsRegion || !awsAccessKey || !awsSecretKey) {
    const authHeader = req.headers.get("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      throw new Error("Missing or invalid Authorization header");
    }

    const [_, credentials] = authHeader.split("Bearer ");
    const [encryptedRegion, encryptedAccessKey, encryptedSecretKey] =
      credentials.split(":");

    if (!encryptedRegion || !encryptedAccessKey || !encryptedSecretKey) {
      throw new Error("Invalid Authorization header format");
    }

    // Decrypt the credentials
    awsRegion = decrypt(encryptedRegion);
    awsAccessKey = decrypt(encryptedAccessKey);
    awsSecretKey = decrypt(encryptedSecretKey);

    if (!awsRegion || !awsAccessKey || !awsSecretKey) {
      throw new Error("Failed to decrypt AWS credentials");
    }
  }

  let modelId = req.headers.get("ModelID");
  let shouldStream = req.headers.get("ShouldStream");
  if (!awsRegion || !awsAccessKey || !awsSecretKey || !modelId) {
    throw new Error("Missing required AWS credentials or model ID");
  }

  // Construct the base endpoint
  const baseEndpoint = `https://bedrock-runtime.${awsRegion}.amazonaws.com`;

  // Set up timeout
  const timeoutId = setTimeout(() => controller.abort(), 10 * 60 * 1000);

  try {
    // Determine the endpoint and request body based on model type
    let endpoint;

    const bodyText = await req.clone().text();
    if (!bodyText) {
      throw new Error("Request body is empty");
    }

    const bodyJson = JSON.parse(bodyText);

    // Debug log the request body
    console.log("Original request body:", JSON.stringify(bodyJson, null, 2));

    validateRequest(bodyJson, modelId);

    // For all models, use standard endpoints
    if (shouldStream === "false") {
      endpoint = `${baseEndpoint}/model/${modelId}/invoke`;
    } else {
      endpoint = `${baseEndpoint}/model/${modelId}/invoke-with-response-stream`;
    }

    // Set additional headers based on model type
    const additionalHeaders: Record<string, string> = {};
    if (
      modelId.startsWith("us.meta.llama") ||
      modelId.startsWith("mistral.mistral")
    ) {
      additionalHeaders["content-type"] = "application/json";
      additionalHeaders["accept"] = "application/json";
    }

    // For Mistral models, unwrap the body object
    const finalRequestBody =
      modelId.startsWith("mistral.mistral") && bodyJson.body
        ? bodyJson.body
        : bodyJson;

    // Set content type and accept headers for specific models
    const headers = await sign({
      method: "POST",
      url: endpoint,
      region: awsRegion,
      accessKeyId: awsAccessKey,
      secretAccessKey: awsSecretKey,
      body: JSON.stringify(finalRequestBody),
      service: "bedrock",
      isStreaming: shouldStream !== "false",
      additionalHeaders,
    });

    // Debug log the final request body
    // console.log("Final request endpoint:", endpoint);
    // console.log(headers);
    // console.log("Final request body:", JSON.stringify(finalRequestBody, null, 2));

    const res = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(finalRequestBody),
      redirect: "manual",
      // @ts-ignore
      duplex: "half",
      signal: controller.signal,
    });

    if (!res.ok) {
      const error = await res.text();
      console.error("AWS Bedrock error response:", error);
      try {
        const errorJson = JSON.parse(error);
        throw new Error(errorJson.message || error);
      } catch {
        throw new Error(error || "Failed to get response from Bedrock");
      }
    }

    if (!res.body) {
      throw new Error("Empty response from Bedrock");
    }

    // Handle non-streaming response
    if (shouldStream === "false") {
      const responseText = await res.text();
      console.error("AWS Bedrock shouldStream === false:", responseText);
      const parsed = parseEventData(new TextEncoder().encode(responseText));
      return NextResponse.json(parsed);
    }

    // Handle streaming response
    const transformedStream = transformBedrockStream(res.body, modelId);
    const stream = new ReadableStream({
      async start(controller) {
        try {
          for await (const chunk of transformedStream) {
            controller.enqueue(new TextEncoder().encode(chunk));
          }
          controller.close();
        } catch (err) {
          console.error("Stream error:", err);
          controller.error(err);
        }
      },
    });

    return new Response(stream, {
      headers: {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
        "X-Accel-Buffering": "no",
      },
    });
  } catch (e) {
    console.error("Request error:", e);
    throw e;
  } finally {
    clearTimeout(timeoutId);
  }
}

export async function handle(
  req: NextRequest,
  { params }: { params: { path: string[] } },
) {
  if (req.method === "OPTIONS") {
    return NextResponse.json({ body: "OK" }, { status: 200 });
  }

  const subpath = params.path.join("/");
  if (!ALLOWED_PATH.has(subpath)) {
    return NextResponse.json(
      { error: true, msg: "you are not allowed to request " + subpath },
      { status: 403 },
    );
  }
  const authResult = auth(req, ModelProvider.Bedrock);
  if (authResult.error) {
    return NextResponse.json(authResult, {
      status: 401,
    });
  }
  try {
    return await requestBedrock(req);
  } catch (e) {
    console.error("Handler error:", e);
    return NextResponse.json(prettyObject(e));
  }
}