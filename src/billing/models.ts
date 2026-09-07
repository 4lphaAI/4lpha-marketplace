import { getAddress, type Address } from "viem";

export const OG_MANIFEST_VERSION = "0g-chat-v1-2026-08-26";
export const OG_CHAT_TEMPLATE_ID = "0g.chat.v1";
export const OG_ROUTER_ORIGIN = "https://router-api.0g.ai";
export const OG_CHAT_PATH = "/v1/chat/completions";
export const OG_HISTORY_PATH = "/v1/account/usage/history";
export const OG_MAX_BODY_BYTES = 32 * 1024;
export const OG_TEMPLATE_TOKEN_ALLOWANCE = 4_096n;
export const OG_STREAM_TIMEOUT_MS = 60_000;
export const OG_MAX_STREAM_BYTES = 8 * 1024 * 1024;
export const OG_MAX_SSE_ITEM_BYTES = 256 * 1024;
export const OG_MAX_SSE_EVENTS = 65_536;
export const OG_MAX_SSE_BUFFER_BYTES = 512 * 1024;

export type OgChatModel = Readonly<{
  canonicalModelId: string;
  rawModelId: string;
  serviceType: "chatbot";
  contextLength: bigint;
  maxCompletionTokens: bigint;
  promptNeuronPerToken: bigint;
  inputReserveNeuronPerToken: bigint;
  completionNeuronPerToken: bigint;
  providerAddress: Address;
  reviewedProviderIdentity: string | null;
}>;

type Row = readonly [string, string, string, string, string, string];

const rows: readonly Row[] = [
  ["0gm-1.0-35b-a3b", "262144", "32768", "501000000000", "501000000000", "3010000000000"],
  ["0gm-1.0-35b-a3b-sia", "32768", "8192", "3350000000000", "3350000000000", "20150000000000"],
  ["claude-fable-5", "1000000", "131072", "56390000000000", "112780000000000", "281990000000000"],
  ["claude-opus-4-8", "1000000", "131072", "31330000000000", "62660000000000", "156660000000000"],
  ["claude-opus-5", "1000000", "128000", "31330000000000", "62660000000000", "156660000000000"],
  ["claude-sonnet-5", "1000000", "131072", "11900000000000", "23800000000000", "59530000000000"],
  ["deepseek-v4-flash", "1000000", "393216", "858000000000", "858000000000", "1710000000000"],
  ["deepseek-v4-pro", "1000000", "393216", "9090000000000", "9090000000000", "18190000000000"],
  ["glm-5", "202752", "32768", "4690000000000", "4690000000000", "15030000000000"],
  ["glm-5.1", "206848", "131072", "11360000000000", "11360000000000", "35700000000000"],
  ["glm-5.2", "1048576", "32768", "5650000000000", "5650000000000", "18840000000000"],
  ["glm-5.3", "1000000", "131072", "8780000000000", "8780000000000", "27620000000000"],
  ["gpt-5.5", "1000000", "128000", "31330000000000", "62660000000000", "187990000000000"],
  ["gpt-5.6-luna", "1000000", "128000", "1250000000000", "2500000000000", "7510000000000"],
  ["gpt-5.6-sol", "1000000", "128000", "31330000000000", "62660000000000", "187990000000000"],
  ["gpt-5.6-terra", "1000000", "128000", "12530000000000", "25060000000000", "75190000000000"],
  ["hy3", "262144", "32768", "828000000000", "828000000000", "3310000000000"],
  ["kimi-k2.7-code", "262144", "16384", "7730000000000", "7730000000000", "32550000000000"],
  ["kimi-k3", "1048576", "131072", "18790000000000", "18790000000000", "93990000000000"],
  ["minimax-m3", "1000000", "131072", "1690000000000", "1690000000000", "6770000000000"],
  ["qwen3-vl-30b", "262144", "32768", "224000000000", "224000000000", "2240000000000"],
  ["qwen3.6-plus", "1000000", "65536", "4080000000000", "4080000000000", "24490000000000"],
  ["qwen3.7-max", "1000000", "65536", "5160000000000", "5160000000000", "15490000000000"],
  ["qwen3.7-plus", "1000000", "65536", "3250000000000", "3250000000000", "13020000000000"],
  ["qwen3.8-max", "1000000", "131072", "10330000000000", "10330000000000", "31000000000000"],
];

const providers: Readonly<Record<string, Address>> = Object.freeze({
  "0gm-1.0-35b-a3b": getAddress("0x4870CbC4D07d6Ac2EE5aA865588e5985FE77a4E9"),
  "0gm-1.0-35b-a3b-sia": getAddress("0xf56fAaf9989aDafDDf26fa5Ffdd03a9A27b38fAE"),
  "claude-fable-5": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "claude-opus-4-8": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "claude-opus-5": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "claude-sonnet-5": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "deepseek-v4-flash": getAddress("0x61C0007197E7D4d6A842d6768E8035728877B9F6"),
  "deepseek-v4-pro": getAddress("0xB01EBd79c3fd63ff52fD47C3935119601EEe2FdB"),
  "glm-5": getAddress("0xd9966e13a6026Fcca4b13E7ff95c94DE268C471C"),
  "glm-5.1": getAddress("0xDB7B465300B0acf454867683c5481055f698b2e8"),
  "glm-5.2": getAddress("0x7DCFe6AEa70350C2090041524c9B4A9262DCe87D"),
  "glm-5.3": getAddress("0xe4d9768112BFe24112e2E0433FE1F4F452fcB6eb"),
  "gpt-5.5": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "gpt-5.6-luna": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "gpt-5.6-sol": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "gpt-5.6-terra": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "hy3": getAddress("0xe4d9768112BFe24112e2E0433FE1F4F452fcB6eb"),
  "kimi-k2.7-code": getAddress("0xF203A388e9E70F09ece38046a6D40a89cf896309"),
  "kimi-k3": getAddress("0x1F444c8A8D0b8e99A50e9f165806d28B01916E04"),
  "minimax-m3": getAddress("0xa6581CfDc65278cC539e94d864012ce4B35c5D56"),
  "qwen3-vl-30b": getAddress("0x4415ef5CBb415347bb18493af7cE01f225Fc0868"),
  "qwen3.6-plus": getAddress("0x992e6396157Dc4f22E74F2231235D7DE62696db5"),
  "qwen3.7-max": getAddress("0xF203A388e9E70F09ece38046a6D40a89cf896309"),
  "qwen3.7-plus": getAddress("0x1B3AAef3ae5050EEE04ea38cD4B087472BD85EB0"),
  "qwen3.8-max": getAddress("0xB01EBd79c3fd63ff52fD47C3935119601EEe2FdB"),
});

export const OG_CHAT_MODELS: ReadonlyMap<string, OgChatModel> = new Map(
  rows.map(([id, context, completion, prompt, inputReserve, output]) => {
    const providerAddress = providers[id];
    if (providerAddress === undefined) throw new Error(`Missing provider for ${id}.`);
    return [id, Object.freeze({
      canonicalModelId: id,
      rawModelId: id,
      serviceType: "chatbot" as const,
      contextLength: BigInt(context),
      maxCompletionTokens: BigInt(completion),
      promptNeuronPerToken: BigInt(prompt),
      inputReserveNeuronPerToken: BigInt(inputReserve),
      completionNeuronPerToken: BigInt(output),
      providerAddress,
      reviewedProviderIdentity: null,
    })];
  }),
);

export type OgMessage = Readonly<{
  role: "system" | "user" | "assistant";
  content: string;
}>;

export type CanonicalOgChatRequest = Readonly<{
  model: string;
  messages: readonly OgMessage[];
  max_tokens: number;
  stream: true;
}>;

export function getOgChatModel(modelId: string): OgChatModel {
  const model = OG_CHAT_MODELS.get(modelId);
  if (model === undefined) throw new Error("MODEL_NOT_ALLOWED");
  return model;
}

export function canonicalOgChatBody(
  modelId: string,
  maxTokens: number,
  messages: readonly OgMessage[],
): Readonly<{ body: string; bytes: bigint; model: OgChatModel; reserveNeuron: bigint }> {
  const model = getOgChatModel(modelId);
  if (!Number.isInteger(maxTokens) || maxTokens < 1 || BigInt(maxTokens) > model.maxCompletionTokens) {
    throw new Error("MODEL_NOT_ALLOWED");
  }
  if (messages.length < 1 || messages.length > 16) throw new Error("messages must contain 1..16 entries.");
  const cleanMessages: OgMessage[] = [];
  for (const message of messages) {
    if (message.role !== "system" && message.role !== "user" && message.role !== "assistant") {
      throw new Error("Only system, user, and assistant text messages are supported.");
    }
    if (typeof message.content !== "string" || message.content.length < 1 || message.content.length > 4_000) {
      throw new Error("Each message content must contain 1..4000 characters.");
    }
    cleanMessages.push({ role: message.role, content: message.content });
  }
  const request: CanonicalOgChatRequest = {
    model: model.canonicalModelId,
    messages: cleanMessages,
    max_tokens: maxTokens,
    stream: true,
  };
  const body = JSON.stringify(request);
  const bytes = BigInt(Buffer.byteLength(body, "utf8"));
  if (bytes > BigInt(OG_MAX_BODY_BYTES)) throw new Error("Chat body exceeds 32 KiB.");
  if (bytes + OG_TEMPLATE_TOKEN_ALLOWANCE > model.contextLength - BigInt(maxTokens)) {
    throw new Error("Chat body cannot fit the reviewed context window.");
  }
  const reserveNeuron =
    model.contextLength * model.inputReserveNeuronPerToken +
    BigInt(maxTokens) * model.completionNeuronPerToken;
  return { body, bytes, model, reserveNeuron };
}

export type LiveOgModelFacts = Readonly<{
  canonicalModelId: string;
  serviceType: string;
  contextLength: bigint;
  maxCompletionTokens: bigint;
  inputReserveNeuronPerToken: bigint;
  completionNeuronPerToken: bigint;
  providerAddress: Address;
  teeAcknowledged: boolean;
  explicitlyHealthy?: boolean;
}>;

export function assertLiveOgModelMatches(reviewed: OgChatModel, live: LiveOgModelFacts): void {
  if (
    live.canonicalModelId !== reviewed.canonicalModelId ||
    live.serviceType !== "chatbot" ||
    live.contextLength < reviewed.contextLength ||
    live.maxCompletionTokens < reviewed.maxCompletionTokens ||
    live.inputReserveNeuronPerToken > reviewed.inputReserveNeuronPerToken ||
    live.completionNeuronPerToken > reviewed.completionNeuronPerToken ||
    live.providerAddress.toLowerCase() !== reviewed.providerAddress.toLowerCase() ||
    !live.teeAcknowledged ||
    live.explicitlyHealthy === false
  ) {
    throw new Error("MODEL_MANIFEST_DRIFT");
  }
}
