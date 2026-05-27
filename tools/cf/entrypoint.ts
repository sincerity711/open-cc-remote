// CF wrapper: translate platform-injected env (VCAP_SERVICES / VCAP_APPLICATION /
// PORT) into the HUB_* vars the hub already understands, then start the hub.
// The hub package never imports this file — keeps CF specifics out of the core.

const env = process.env;

function parseJson<T>(raw: string | undefined): T | undefined {
  if (!raw) return undefined;
  try { return JSON.parse(raw) as T; } catch { return undefined; }
}

interface IdentityCreds {
  url?: string;
  clientid?: string;
  clientsecret?: string;
}
interface VcapServices {
  identity?: Array<{ credentials?: IdentityCreds }>;
}
interface VcapApplication {
  application_uris?: string[];
}

const services = parseJson<VcapServices>(env.VCAP_SERVICES) ?? {};
const application = parseJson<VcapApplication>(env.VCAP_APPLICATION) ?? {};

const identity = services.identity?.[0]?.credentials;
if (identity) {
  if (identity.url) env.HUB_IAS_ISSUER ||= identity.url;
  if (identity.clientid) env.HUB_IAS_CLIENT_ID ||= identity.clientid;
  if (identity.clientsecret) env.HUB_IAS_CLIENT_SECRET ||= identity.clientsecret;
  const route = application.application_uris?.[0];
  if (route) env.HUB_IAS_REDIRECT_URI ||= `https://${route}/auth/callback`;
}

if (env.PORT) env.HUB_PORT ||= env.PORT;

// CF container disk is ephemeral; /tmp is always writable.
env.HUB_DB_PATH ||= "/tmp/hub.sqlite";

await import("../../packages/hub/src/index.ts");
