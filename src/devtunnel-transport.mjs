import https from "node:https";
import tls from "node:tls";

const TOKEN_ENV_PATTERN = /^CODEY_[A-Z0-9_]{1,100}$/;
const TUNNEL_ID_PATTERN = /^[a-z0-9][a-z0-9-]{1,58}[a-z0-9]$/;
const CLUSTER_ID_PATTERN = /^[a-z][a-z0-9]{1,15}$/;

function unavailable() {
  // SDK errors can contain authorization headers or relay URLs with credentials.
  const error = new Error("Authenticated Workspace tunnel is unavailable; check the host and connect-token expiry");
  error.code = "ERR_CODEY_DEV_TUNNEL";
  return error;
}

export function normalizeDevTunnel(raw, { upstream, tlsServerName, fingerprint }) {
  if (raw === undefined) return undefined;
  if (!raw || typeof raw !== "object" || Array.isArray(raw) ||
      Object.keys(raw).some(key => !["tunnelId", "clusterId", "port", "connectTokenEnv"].includes(key)) ||
      !TUNNEL_ID_PATTERN.test(raw.tunnelId ?? "") ||
      !CLUSTER_ID_PATTERN.test(raw.clusterId ?? "") ||
      !TOKEN_ENV_PATTERN.test(raw.connectTokenEnv ?? "") ||
      !Number.isInteger(raw.port) || raw.port < 1 || raw.port > 65535 ||
      upstream.protocol !== "https:" ||
      !["localhost", "127.0.0.1", "[::1]"].includes(upstream.hostname) ||
      Number(upstream.port || 443) !== raw.port || !tlsServerName || !fingerprint) {
    throw new Error("Dev Tunnel Workspace requires a fixed tunnel/port, a secret environment reference, and pinned loopback HTTPS");
  }
  return Object.freeze({
    tunnelId: raw.tunnelId, clusterId: raw.clusterId,
    port: raw.port, connectTokenEnv: raw.connectTokenEnv,
  });
}

export function readDevTunnelConnectToken(config, environment = process.env, now = Date.now()) {
  try {
    const token = environment[config.connectTokenEnv];
    if (typeof token !== "string" || token.length > 8192 || !/^[\w-]+\.[\w-]+\.[\w-]+$/.test(token)) {
      throw unavailable();
    }
    // These claims only reject mistakes early. The Dev Tunnels service validates
    // the signature and authorization; this is not a local authentication bypass.
    const claims = JSON.parse(Buffer.from(token.split(".")[1], "base64url"));
    if (claims.clusterId !== config.clusterId || claims.tunnelId !== config.tunnelId ||
        claims.scp !== "connect" || !Number.isFinite(claims.exp) || claims.exp * 1000 <= now + 5000) {
      throw unavailable();
    }
    return token;
  } catch {
    throw unavailable();
  }
}

let sdkPromise;
function loadSdk() {
  sdkPromise ??= Promise.all([
    import("@microsoft/dev-tunnels-management"),
    import("@microsoft/dev-tunnels-connections"),
    import("@microsoft/dev-tunnels-ssh"),
  ]).then(([management, connections, ssh]) => ({
    TunnelManagementHttpClient: management.TunnelManagementHttpClient,
    ManagementApiVersions: management.ManagementApiVersions,
    TunnelRelayTunnelClient: connections.TunnelRelayTunnelClient,
    CancellationTokenSource: ssh.CancellationTokenSource,
  }));
  return sdkPromise;
}

class TunnelHttpsAgent extends https.Agent {
  constructor(transport) {
    // Relay streams can report the host's idle close only on their next write.
    // Reuse the relay client, not HTTP TLS sockets; upgraded WebSockets stay open.
    super({ keepAlive: false, maxSockets: 32, maxCachedSessions: 0 });
    this.transport = transport;
  }

  createConnection(_options, callback) {
    // Never fall back to ACA's own loopback listener or the tunnel's web endpoint.
    this.transport.openTlsSocket().then(
      socket => callback(null, socket),
      () => callback(unavailable()),
    );
  }
}

export class DevTunnelTransport {
  #config;
  #tlsOptions;
  #getToken;
  #sdkFactory;
  #timeoutMs;
  #management;
  #client;
  #connecting;
  #closed = false;
  #sockets = new Set();
  #cancellations = new Set();

  constructor(config, tlsOptions, {
    getToken = () => readDevTunnelConnectToken(config),
    sdkFactory = loadSdk,
    timeoutMs = 15000,
  } = {}) {
    if (!tlsOptions.ca || !tlsOptions.servername || tlsOptions.rejectUnauthorized !== true) {
      throw new Error("Dev Tunnel transport requires verified node TLS");
    }
    this.#config = config;
    this.#tlsOptions = { ...tlsOptions, rejectUnauthorized: true, minVersion: "TLSv1.2" };
    this.#getToken = getToken;
    this.#sdkFactory = sdkFactory;
    this.#timeoutMs = timeoutMs;
    this.agent = new TunnelHttpsAgent(this);
  }

  async #metadata(cancellation) {
    const token = this.#getToken();
    const tunnel = await this.#management.getTunnel({
      tunnelId: this.#config.tunnelId, clusterId: this.#config.clusterId,
    }, { accessToken: token, includePorts: true }, cancellation);
    if (!tunnel?.endpoints?.length ||
        !tunnel.ports?.some(port => port.portNumber === this.#config.port && port.protocol === "https")) {
      throw unavailable();
    }
    tunnel.accessTokens = { connect: token };
    return tunnel;
  }

  async #ready() {
    if (this.#closed) throw unavailable();
    if (this.#client?.connectionStatus === "connected") return this.#client;
    if (this.#connecting) return this.#connecting;
    this.#connecting = this.#connect();
    try {
      return await this.#connecting;
    } finally {
      this.#connecting = undefined;
    }
  }

  async #connect() {
    const sdk = await this.#sdkFactory();
    if (this.#closed) throw unavailable();
    if (this.#client) await this.#client.dispose();
    this.#management ??= new sdk.TunnelManagementHttpClient(
      { name: "CodeyWorkspace", version: "1.0" },
      sdk.ManagementApiVersions.Version20230927preview,
    );
    this.#management.enableEventsReporting = false;
    const client = new sdk.TunnelRelayTunnelClient(this.#management);
    this.#client = client;
    client.acceptLocalConnectionsForForwardedPorts = false;
    client.portForwarding(event => {
      if (event.portNumber !== this.#config.port) event.cancel = true;
    });
    client.refreshingTunnelAccessToken(event => {
      event.tunnelAccessToken = event.tunnelAccessScope === "connect"
        ? Promise.resolve().then(() => this.#getToken()) : Promise.resolve(null);
    });
    client.refreshingTunnel(event => {
      event.tunnelPromise = event.tunnelAccessScope === "connect"
        ? this.#metadata(event.cancellation) : Promise.resolve(null);
    });
    const cancellation = new sdk.CancellationTokenSource();
    this.#cancellations.add(cancellation);
    let timer;
    try {
      await Promise.race([
        (async () => {
          const tunnel = await this.#metadata(cancellation.token);
          await client.connect(tunnel, {
            enableRetry: false, enableReconnect: false, keepAliveIntervalInSeconds: 15,
          }, cancellation.token);
          await client.waitForForwardedPort(this.#config.port, cancellation.token);
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => { cancellation.cancel(); reject(unavailable()); }, this.#timeoutMs);
        }),
      ]);
      if (this.#closed) throw unavailable();
      return client;
    } catch {
      cancellation.cancel();
      void client.dispose().catch(() => {});
      if (this.#client === client) this.#client = undefined;
      throw unavailable();
    } finally {
      clearTimeout(timer);
      this.#cancellations.delete(cancellation);
      cancellation.dispose();
    }
  }

  async openTlsSocket() {
    let socket;
    let stream;
    let cancellation;
    let timer;
    let cancelled = false;
    try {
      return await Promise.race([
        (async () => {
          const sdk = await this.#sdkFactory();
          const client = await this.#ready();
          if (cancelled || this.#closed) throw unavailable();
          cancellation = new sdk.CancellationTokenSource();
          this.#cancellations.add(cancellation);
          stream = await client.connectToForwardedPort(this.#config.port, cancellation.token);
          if (cancelled || this.#closed) { stream.destroy(); throw unavailable(); }
          socket = tls.connect({ ...this.#tlsOptions, socket: stream });
          this.#sockets.add(socket);
          socket.once("close", () => this.#sockets.delete(socket));
          await new Promise((resolve, reject) => {
            socket.once("error", reject);
            socket.once("secureConnect", () => socket.authorized ? resolve() : reject(unavailable()));
          });
          if (cancelled || this.#closed) { socket.destroy(); throw unavailable(); }
          return socket;
        })(),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(unavailable()), this.#timeoutMs);
        }),
      ]);
    } catch {
      cancelled = true;
      cancellation?.cancel();
      socket?.destroy();
      stream?.destroy();
      throw unavailable();
    } finally {
      clearTimeout(timer);
      if (cancellation) {
        this.#cancellations.delete(cancellation);
        cancellation.dispose();
      }
    }
  }

  async dispose() {
    this.#closed = true;
    for (const cancellation of this.#cancellations) cancellation.cancel();
    for (const socket of this.#sockets) socket.destroy();
    this.agent.destroy();
    await Promise.allSettled([
      this.#client?.dispose(), this.#management?.dispose(),
    ]);
  }
}
