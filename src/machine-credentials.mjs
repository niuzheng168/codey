import {
  createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual,
} from "node:crypto";
import { requestError } from "./signed-store.mjs";

const TOKEN = /^[A-Za-z0-9_-]{43}$/;
const SUBJECT = /^m-[a-f0-9]{24}$/;
const USERNAME = /^[a-z][a-z0-9_-]{0,31}$/;
const FIELDS = Object.freeze([
  "clientSigningKey",
  "workspaceSsoKey",
  "tunnelUpdateKey",
  "updaterCredential",
  "workspaceSubject",
  "workspaceUsername",
]);
const NODE_FIELDS = Object.freeze(FIELDS.filter((name) => name !== "updaterCredential"));

function key(master, nodeId) {
  return createHmac("sha256", master)
    .update(`codey-machine-client-credentials-v1:${nodeId}`)
    .digest();
}

function canonical(value, fields = NODE_FIELDS) {
  return JSON.stringify(Object.fromEntries(fields.map((name) => [name, value[name]])));
}

function decodedKey(value) {
  if (!TOKEN.test(value ?? "")) throw requestError("注册文件中的节点凭据无效");
  const bytes = Buffer.from(value, "base64url");
  if (bytes.length !== 32 || bytes.toString("base64url") !== value) {
    throw requestError("注册文件中的节点凭据无效");
  }
  return bytes;
}

function distinctKeys(value, names) {
  return new Set(names.map((name) => decodedKey(value[name]).toString("hex"))).size === names.length;
}

function storedCredentials(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== NODE_FIELDS.length ||
      Object.keys(input).some((name) => !NODE_FIELDS.includes(name)) ||
      !distinctKeys(input, ["clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey"]) ||
      !SUBJECT.test(input.workspaceSubject ?? "") ||
      !USERNAME.test(input.workspaceUsername ?? "")) {
    throw requestError("注册文件中的节点凭据无效");
  }
  return Object.freeze(Object.fromEntries(NODE_FIELDS.map((name) => [name, input[name]])));
}

export function machineCredentials(input) {
  if (!input || typeof input !== "object" || Array.isArray(input) ||
      Object.keys(input).length !== FIELDS.length ||
      Object.keys(input).some((name) => !FIELDS.includes(name)) ||
      !distinctKeys(input, [
        "clientSigningKey", "workspaceSsoKey", "tunnelUpdateKey", "updaterCredential",
      ]) ||
      !SUBJECT.test(input.workspaceSubject ?? "") ||
      !USERNAME.test(input.workspaceUsername ?? "")) {
    throw requestError("注册文件中的节点凭据无效");
  }
  return Object.freeze(Object.fromEntries(FIELDS.map((name) => [name, input[name]])));
}

export function sealMachineCredentials(master, nodeId, input) {
  const value = machineCredentials(input);
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(master, nodeId), iv);
  cipher.setAAD(Buffer.from(`codey-machine:${nodeId}`));
  const encrypted = Buffer.concat([
    cipher.update(canonical(value, NODE_FIELDS), "utf8"), cipher.final(),
  ]);
  return ["v1", iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
}

export function openMachineCredentials(master, nodeId, sealed) {
  try {
    const [version, ivText, tagText, valueText, ...extra] = String(sealed).split(".");
    const iv = Buffer.from(ivText, "base64url");
    const tag = Buffer.from(tagText, "base64url");
    const encrypted = Buffer.from(valueText, "base64url");
    if (version !== "v1" || extra.length || iv.length !== 12 || tag.length !== 16 ||
        encrypted.length < 32 || encrypted.length > 4096) throw new Error("Invalid sealed credentials");
    const decipher = createDecipheriv("aes-256-gcm", key(master, nodeId), iv);
    decipher.setAAD(Buffer.from(`codey-machine:${nodeId}`));
    decipher.setAuthTag(tag);
    return storedCredentials(JSON.parse(Buffer.concat([
      decipher.update(encrypted), decipher.final(),
    ]).toString("utf8")));
  } catch {
    throw new Error("Invalid sealed machine credentials");
  }
}

export function sameMachineCredentials(left, right) {
  const a = Buffer.from(canonical(storedCredentials(left)));
  const b = Buffer.from(canonical(machineCredentials(right), NODE_FIELDS));
  return a.length === b.length && timingSafeEqual(a, b);
}
