// Only connection bindings belong in this key. Labels and renewed token values
// must not tear down otherwise healthy relay connections and Workspace sockets.
export function gatewayConnectionKey(node, fallbackCa) {
  const tunnel = node.devTunnel;
  return JSON.stringify([
    node.upstream.href, node.tlsServerName, node.ca ?? fallbackCa, node.fingerprint,
    tunnel ? [tunnel.tunnelId, tunnel.clusterId, tunnel.port, tunnel.connectTokenEnv] : null,
    typeof node.getTunnelToken === "function",
  ]);
}

export class GatewayTransportCache {
  constructor(createTransport, fallbackCa) {
    this.createTransport = createTransport;
    this.fallbackCa = fallbackCa;
    this.entries = new Map();
    this.nodes = null;
    this.retiring = new Set();
    this.closed = false;
  }

  reconcile(nodes) {
    const next = new Map(Array.from(nodes, node =>
      [node.id, { node, key: gatewayConnectionKey(node, this.fallbackCa) }]));
    this.nodes = next;
    for (const [id, entry] of this.entries) {
      const current = next.get(id);
      if (!current?.node.devTunnel || current.key !== entry.key) this.remove(id);
      else entry.node = current.node;
    }
  }

  get(node) {
    const key = gatewayConnectionKey(node, this.fallbackCa);
    const current = this.nodes?.get(node.id);
    // An HTTP/health request may have captured its node before an async ACL
    // read. Never let that old snapshot repopulate an invalidated TLS pin.
    if (this.closed || !node.devTunnel || (this.nodes && current?.key !== key)) {
      throw new Error("Node connection changed; retry with the current registry");
    }
    const latest = current?.node ?? node;
    let entry = this.entries.get(node.id);
    if (entry?.key !== key) {
      this.remove(node.id);
      entry = { key, node: latest };
      entry.transport = this.createTransport({
        ...latest,
        ...(latest.getTunnelToken ? { getTunnelToken: () => entry.node.getTunnelToken() } : {}),
      });
      this.entries.set(node.id, entry);
    } else {
      entry.node = latest;
    }
    return entry.transport;
  }

  remove(id) {
    const entry = this.entries.get(id);
    if (!entry) return;
    this.entries.delete(id);
    // Native disposal immediately closes sockets before its first await.
    // Cleanup errors must neither revive this entry nor expose SDK credentials.
    let result;
    try { result = entry.transport.dispose(); } catch { return; }
    const pending = Promise.resolve(result).catch(() => {});
    this.retiring.add(pending);
    void pending.then(() => this.retiring.delete(pending));
  }

  async close() {
    this.closed = true;
    this.reconcile([]);
    await Promise.all([...this.retiring]);
  }
}
