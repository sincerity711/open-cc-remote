export interface IasOidcConfig {
  issuer_url: string;
  client_id: string;
  client_secret: string;
  redirect_uri: string;
  allowed_subjects: string[];
}

export interface HubConfig {
  port: number;
  db_path: string;
  ias?: IasOidcConfig;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): HubConfig {
  const port = Number(env.HUB_PORT ?? 7745);
  const db_path = env.HUB_DB_PATH ?? "./hub.sqlite";

  const issuer_url = env.HUB_IAS_ISSUER;
  const client_id = env.HUB_IAS_CLIENT_ID;
  const client_secret = env.HUB_IAS_CLIENT_SECRET;
  const redirect_uri = env.HUB_IAS_REDIRECT_URI;
  const allowed = env.HUB_IAS_ALLOWED_SUBJECTS;

  if (issuer_url && client_id && client_secret && redirect_uri && allowed) {
    return {
      port,
      db_path,
      ias: {
        issuer_url,
        client_id,
        client_secret,
        redirect_uri,
        allowed_subjects: allowed.split(",").map((s) => s.trim()).filter(Boolean),
      },
    };
  }
  return { port, db_path };
}
