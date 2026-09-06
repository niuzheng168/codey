// Opt-in, synthetic-text-only verification. Never reads a user's chat history,
// changes .env, deploys anything, or prints credentials/provider error bodies.
import { parseArgs } from "node:util";
import { VoiceRewriteService, resolveVoiceRewriteConfig } from "../src/voice-rewrite-service.mjs";

const { values } = parseArgs({ options: {
  "env-file": { type: "string", default: ".env" },
  deployment: { type: "string" },
  run: { type: "boolean", default: false },
  "show-output": { type: "boolean", default: false },
} });
process.loadEnvFile(values["env-file"]);
if (values.deployment) process.env.VOICE_REWRITE_DEPLOYMENT = values.deployment;
const config = resolveVoiceRewriteConfig(process.env);
if (!config.configured) {
  console.error("Configure a valid Foundry resource/key and an explicit VOICE_REWRITE_DEPLOYMENT.");
  process.exitCode = 1;
} else if (!values.run) {
  console.log(JSON.stringify({ configured: true, deployment: config.deployment, calls: 0, note: "Add --run to send four synthetic rewrite requests." }));
} else {
  const cases = [
    {
      id: "negative-scope",
      input: { transcript: "呃，检查一下 west us two 的语音，先不要改配置，也不要重启。",
        history: [{ role: "user", content: "目标节点是 westus2。" }] },
      valid: (text) => text.includes("westus2") && /(?:不要|不|勿|禁止)[^。]{0,12}重启/.test(text) &&
        /(?:不要|不|勿|禁止)[^。]{0,12}(?:改|修改|更改)配置/.test(text),
    },
    {
      id: "current-model-over-history",
      input: { transcript: "还是用 GPT-5.6，只给设计，不要实现。",
        history: [{ role: "assistant", content: "建议使用 GPT-6，并立即实施。" }] },
      valid: (text) => text.includes("GPT-5.6") && !text.includes("GPT-6") && /(?:不要|不|勿|禁止)[^。]{0,8}实现/.test(text),
    },
    {
      id: "ambiguous-node",
      input: { transcript: "那个节点先别重启。",
        history: [{ role: "user", content: "A100 和 westus2 都有 CloudCLI。" }] },
      valid: (text, result) => text.includes("那个节点") && !/A100|westus2/.test(text) && result.ambiguities.includes("那个节点"),
    },
    {
      id: "self-correction",
      input: { transcript: "先重启，不对，先不要重启，只检查 8443 端口。", history: [] },
      valid: (text) => /(?:不要|不|勿|禁止)[^。]{0,8}重启/.test(text) && text.includes("8443") && text.includes("检查"),
    },
  ];
  const service = new VoiceRewriteService(config);
  const results = [];
  for (const sample of cases) {
    try {
      const result = await service.rewrite(sample.input, { nodeId: "synthetic-probe" });
      results.push({
        id: sample.id, passed: sample.valid(result.text, result), durationMs: result.durationMs,
        ...(values["show-output"] ? { text: result.text, ambiguities: result.ambiguities } : {}),
      });
    } catch (error) {
      results.push({ id: sample.id, passed: false, code: error.code || "PROBE_FAILED" });
    }
  }
  console.log(JSON.stringify({ deployment: config.deployment, syntheticOnly: true, results }, null, 2));
  if (results.some((result) => !result.passed)) process.exitCode = 1;
}
