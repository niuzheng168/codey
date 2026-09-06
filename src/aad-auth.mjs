import { createPublicKey, verify } from "node:crypto";

function b64url(value) {
  return Buffer.from(value.replace(/-/g, "+").replace(/_/g, "/"), "base64");
}

function cookies(req) {
  return Object.fromEntries(
    String(req.headers.cookie ?? "")
      .split(";")
      .map((item) => item.trim().split(/=(.*)/s))
      .filter(([key]) => key),
  );
}

export class AadAuthenticator {
  constructor({ tenantId, clientId, allowedPrincipalIds = [], fetchImpl = fetch }) {
    this.tenantId = tenantId.toLowerCase();
    this.clientId = clientId.toLowerCase();
    this.allowed = new Set(allowedPrincipalIds.map((value) => value.toLowerCase()));
    this.fetchImpl = fetchImpl;
    this.keys = null;
    this.keysExpiresAt = 0;
  }

  async principal(req) {
    const token = cookies(req).codey_aad;
    if (!token) return null;
    try {
      const claims = await this.#validate(token);
      const id = String(claims.oid ?? claims.sub ?? "").toLowerCase();
      if (!id || (this.allowed.size && !this.allowed.has(id))) return null;
      return { id, name: claims.preferred_username ?? claims.name ?? id };
    } catch {
      return null;
    }
  }

  startPage(redirectUri) {
    return `<!doctype html><meta charset="utf-8"><title>Codey sign in</title>
<script>
(async()=>{const b=a=>btoa(String.fromCharCode(...new Uint8Array(a))).replace(/\\+/g,'-').replace(/\\//g,'_').replace(/=+$/,'');
const v=b(crypto.getRandomValues(new Uint8Array(48))),s=b(crypto.getRandomValues(new Uint8Array(24)));
sessionStorage.setItem('codey_verifier',v);sessionStorage.setItem('codey_state',s);
const c=b(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(v)));
const q=new URLSearchParams({client_id:'${this.clientId}',response_type:'code',redirect_uri:'${redirectUri}',response_mode:'query',scope:'openid profile email',code_challenge:c,code_challenge_method:'S256',state:s});
location.replace('https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize?'+q)})()
</script>`;
  }

  callbackPage(redirectUri) {
    return `<!doctype html><meta charset="utf-8"><title>Completing Codey sign in</title>
<p>Completing Microsoft Entra sign-in…</p><script>
(async()=>{const q=new URLSearchParams(location.search),state=sessionStorage.getItem('codey_state'),verifier=sessionStorage.getItem('codey_verifier');
if(!q.get('code')||q.get('state')!==state||!verifier)throw new Error('Invalid sign-in response');
const body=new URLSearchParams({client_id:'${this.clientId}',grant_type:'authorization_code',code:q.get('code'),redirect_uri:'${redirectUri}',code_verifier:verifier,scope:'openid profile email'});
const token=await fetch('https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token',{method:'POST',headers:{'content-type':'application/x-www-form-urlencoded'},body});
const value=await token.json();if(!token.ok||!value.id_token)throw new Error(value.error_description||'Token exchange failed');
const saved=await fetch('/portal-auth/session',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({idToken:value.id_token})});
if(!saved.ok)throw new Error((await saved.json()).error||'Codey access denied');sessionStorage.clear();location.replace('/')})().catch(e=>{document.body.textContent='Sign-in failed: '+e.message})
</script>`;
  }

  async createSession(idToken) {
    const claims = await this.#validate(String(idToken ?? ""));
    const id = String(claims.oid ?? claims.sub ?? "").toLowerCase();
    if (!id || (this.allowed.size && !this.allowed.has(id))) {
      const error = new Error("This Microsoft Entra user is not allowed to access Codey");
      error.status = 403;
      throw error;
    }
    return {
      principal: { id, name: claims.preferred_username ?? claims.name ?? id },
      cookie: `codey_aad=${idToken}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=3600`,
    };
  }

  async #validate(token) {
    const parts = token.split(".");
    if (parts.length !== 3) throw new Error("Invalid token");
    const header = JSON.parse(b64url(parts[0]));
    const claims = JSON.parse(b64url(parts[1]));
    if (
      String(claims.aud ?? "").toLowerCase() !== this.clientId ||
      String(claims.tid ?? "").toLowerCase() !== this.tenantId ||
      Number(claims.exp ?? 0) <= Date.now() / 1000
    ) {
      throw new Error("Invalid token claims");
    }
    const keys = await this.#keys();
    const jwk = keys.find((item) => item.kid === header.kid);
    if (!jwk) throw new Error("Unknown signing key");
    const valid = verify(
      "RSA-SHA256",
      Buffer.from(`${parts[0]}.${parts[1]}`),
      createPublicKey({ key: jwk, format: "jwk" }),
      b64url(parts[2]),
    );
    if (!valid) throw new Error("Invalid token signature");
    return claims;
  }

  async #keys() {
    if (this.keys && this.keysExpiresAt > Date.now()) return this.keys;
    const response = await this.fetchImpl(
      `https://login.microsoftonline.com/${this.tenantId}/discovery/v2.0/keys`,
    );
    if (!response.ok) throw new Error("Unable to load Entra signing keys");
    const value = await response.json();
    this.keys = value.keys ?? [];
    this.keysExpiresAt = Date.now() + 60 * 60 * 1000;
    return this.keys;
  }
}
