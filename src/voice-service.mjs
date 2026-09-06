/** Shared with the authenticated voice gateway; PCM limits bound duration and cost. */
export const MAX_VOICE_SECONDS = 120;
export const MAX_VOICE_BYTES = MAX_VOICE_SECONDS * 16000 * 2 + 65536;
export const VOICE_LANGUAGES = Object.freeze(["auto", "zh-CN", "en-US"]);

/** Safe client-facing errors; never attach provider bodies, keys or endpoint URLs. */
export class VoiceError extends Error {
  constructor(status, code, message) {
    super(message);
    Object.assign(this, { status, code });
  }
}

function speechEndpoint(value) {
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.username || url.password || url.hash ||
        !/^[a-z0-9-]+\.(?:cognitiveservices\.azure\.com|services\.ai\.azure\.com|api\.cognitive\.microsoft\.com)$/i.test(url.hostname) ||
        (url.port && url.port !== "443") ||
        !["/", "/speechtotext/transcriptions:transcribe"].includes(url.pathname) ||
        [...url.searchParams.keys()].some((key) => key !== "api-version") ||
        url.searchParams.getAll("api-version").length > 1) return null;
    url.pathname = "/speechtotext/transcriptions:transcribe";
    const version = url.searchParams.get("api-version") || "2025-10-15";
    if (!/^\d{4}-\d{2}-\d{2}(?:-preview)?$/.test(version)) return null;
    url.searchParams.set("api-version", version);
    return url.href;
  } catch { return null; }
}

function foundrySpeechEndpoint(value) {
  try {
    const url = new URL(value);
    const match = /^([a-z0-9-]+)\.services\.ai\.azure\.com$/i.exec(url.hostname);
    if (!match || url.protocol !== "https:" || url.username || url.password || url.port ||
        url.search || url.hash || !/^\/(?:api\/projects\/[a-z0-9_.-]+\/?)?$/i.test(url.pathname)) return null;
    return speechEndpoint(`https://${match[1]}.cognitiveservices.azure.com/`);
  } catch { return null; }
}

/** Portal startup and service tests use this server-only config; nothing secret is returned to browsers. */
export function resolveVoiceServiceConfig(environment = process.env) {
  const azureEndpoint = environment.AZURE_SPEECH_ENDPOINT
    ? speechEndpoint(environment.AZURE_SPEECH_ENDPOINT)
    : foundrySpeechEndpoint(environment.FOUNDRY_ENDPOINT);
  const azureKey = environment.AZURE_SPEECH_KEY || environment.AZURE_SPEECH_API_KEY || environment.FOUNDRY_API_KEY || "";
  // MAI is Speech enhanced transcription, NOT Azure OpenAI audio/transcriptions.
  // Require its own explicitly configured, MAI-capable Speech resource.
  const maiEndpoint = speechEndpoint(environment.MAI_TRANSCRIBE_SPEECH_ENDPOINT || environment.MAI_TRANSCRIBE_ENDPOINT);
  const maiKey = environment.MAI_TRANSCRIBE_KEY || environment.MAI_TRANSCRIBE_API_KEY ||
    (maiEndpoint && azureEndpoint && new URL(maiEndpoint).origin === new URL(azureEndpoint).origin ? azureKey : "");
  const maiModel = environment.MAI_TRANSCRIBE_MODEL || "MAI-Transcribe-2";
  const modelAllowed = ["MAI-Transcribe-1", "MAI-Transcribe-1.5", "MAI-Transcribe-2"].includes(maiModel);
  return {
    providers: [
      { id: "azure-speech", label: "Azure Speech", endpoint: azureEndpoint, key: azureKey, configured: Boolean(azureEndpoint && azureKey.length >= 16) },
      { id: "mai-transcribe", label: `MAI Transcribe${maiModel === "MAI-Transcribe-2" ? " 2" : ""}`, endpoint: maiEndpoint, key: maiKey, model: maiModel, configured: Boolean(maiEndpoint && maiKey.length >= 16 && modelAllowed) },
    ],
  };
}

/** Used by the voice service and tests to reject compressed/polyglot/oversized audio before billing. */
export function validateVoiceWave(audio) {
  const invalid = () => { throw new VoiceError(400, "VOICE_AUDIO_INVALID", "Expected mono 16 kHz, 16-bit PCM WAV audio."); };
  if (!Buffer.isBuffer(audio) || audio.length < 44 || audio.length > MAX_VOICE_BYTES) invalid();
  if (audio.toString("ascii", 0, 4) !== "RIFF" || audio.toString("ascii", 8, 12) !== "WAVE" ||
      audio.readUInt32LE(4) !== audio.length - 8) invalid();
  let format = false;
  let dataBytes = 0;
  let offset = 12;
  while (offset + 8 <= audio.length) {
    const id = audio.toString("ascii", offset, offset + 4);
    const size = audio.readUInt32LE(offset + 4);
    const start = offset + 8;
    const end = start + size;
    if (end > audio.length) invalid();
    if (id === "fmt ") {
      if (format || size < 16 || audio.readUInt16LE(start) !== 1 ||
          audio.readUInt16LE(start + 2) !== 1 || audio.readUInt32LE(start + 4) !== 16000 ||
          audio.readUInt32LE(start + 8) !== 32000 || audio.readUInt16LE(start + 12) !== 2 ||
          audio.readUInt16LE(start + 14) !== 16) invalid();
      format = true;
    } else if (id === "data") {
      if (dataBytes || !size || size % 2) invalid();
      dataBytes = size;
    }
    offset = end + (size % 2);
  }
  if (!format || !dataBytes || offset !== audio.length) invalid();
  const durationMs = dataBytes / 32;
  if (durationMs < 250 || durationMs > MAX_VOICE_SECONDS * 1000) {
    throw new VoiceError(400, "VOICE_DURATION_INVALID", "Recording must be between 0.25 and 120 seconds.");
  }
  return { durationMs };
}

async function boundedJson(response, signal) {
  const reader = response.body?.getReader();
  if (!reader) throw new VoiceError(502, "VOICE_RESPONSE_INVALID", "Voice service returned no result.");
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 512 * 1024) throw new VoiceError(502, "VOICE_RESPONSE_INVALID", "Voice service returned an invalid result.");
      chunks.push(value);
    }
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally { reader.releaseLock(); }
}

/** Portal-owned transcription adapter; VM CloudCLI servers never receive these provider credentials. */
export class VoiceService {
  constructor(config, { fetchImpl = fetch, timeoutMs = 60000 } = {}) {
    this.providers = new Map(config.providers.map((provider) => [provider.id, provider]));
    this.fetchImpl = fetchImpl;
    this.timeoutMs = timeoutMs;
  }

  publicConfig(userId) {
    const providers = [...this.providers.values()].map(({ id, label, configured }) => ({ id, label, configured }));
    return {
      userId, providers, languages: VOICE_LANGUAGES, maxDurationSeconds: MAX_VOICE_SECONDS,
      defaultProvider: providers.find((provider) => provider.configured)?.id || "azure-speech",
    };
  }

  configured(provider) { return this.providers.get(provider)?.configured === true; }

  async transcribe({ provider: id, language, audio, signal: callerSignal }) {
    const provider = this.providers.get(id);
    if (!provider?.configured) throw new VoiceError(503, "VOICE_NOT_CONFIGURED", "This voice service is not configured.");
    if (!VOICE_LANGUAGES.includes(language)) throw new VoiceError(400, "VOICE_LANGUAGE_INVALID", "Unsupported language.");
    const { durationMs } = validateVoiceWave(audio);
    const timeout = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([timeout, ...(callerSignal ? [callerSignal] : [])]);
    const definition = {};
    if (language !== "auto") definition.locales = [id === "mai-transcribe" ? language.split("-")[0] : language];
    if (id === "mai-transcribe") {
      definition.enhancedMode = { enabled: true, model: provider.model };
      if (provider.model === "MAI-Transcribe-2") definition.enhancedMode.modelOptions = { transcribeStyle: "verbatim" };
    } else definition.profanityFilterMode = "None";
    const form = new FormData();
    form.append("audio", new Blob([audio], { type: "audio/wav" }), "recording.wav");
    form.append("definition", JSON.stringify(definition));
    try {
      signal.throwIfAborted();
      const response = await this.fetchImpl(provider.endpoint, {
        method: "POST", redirect: "manual", signal,
        headers: { "Ocp-Apim-Subscription-Key": provider.key },
        body: form,
      });
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        throw new VoiceError(response.status === 429 ? 503 : 502, "VOICE_PROVIDER_REJECTED", "Voice service rejected the request. Ask the administrator to check its resource, region and credentials.");
      }
      const data = await boundedJson(response, signal);
      signal.throwIfAborted();
      if (!Array.isArray(data.combinedPhrases) ||
          data.combinedPhrases.some((phrase) => typeof phrase?.text !== "string")) {
        throw new VoiceError(502, "VOICE_RESPONSE_INVALID", "Voice service returned an invalid result.");
      }
      const text = data.combinedPhrases.map((phrase) => phrase.text).join(" ").trim();
      if (text.length > 32000) throw new VoiceError(502, "VOICE_RESPONSE_INVALID", "Voice service returned an invalid result.");
      return { text, provider: id, durationMs };
    } catch (error) {
      if (callerSignal?.aborted) throw callerSignal.reason || new VoiceError(499, "VOICE_CANCELLED", "Transcription cancelled.");
      if (timeout.aborted) throw new VoiceError(504, "VOICE_TIMEOUT", "Transcription timed out.");
      if (error instanceof VoiceError) throw error;
      throw new VoiceError(502, "VOICE_UNAVAILABLE", "Voice service is temporarily unavailable.");
    }
  }
}
