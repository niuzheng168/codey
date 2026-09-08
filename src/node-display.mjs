// "local" in the browser data API means the device running the browser, not
// a Windows Workspace that historically reused that stable enrollment ID.
export function browserDataNode(node) {
  if (node.id !== "local") return node;
  let hostname;
  try { hostname = new URL(node.endpoint).hostname; } catch { return node; }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(hostname)) return node;
  return { ...node, name: "浏览器本机", region: "当前打开浏览器的设备 · 不是远程 Windows 节点" };
}
