import { SignJWT, importJWK, type JWK } from "jose";
import { randomBytes } from "node:crypto";

export async function signDpop(privateJwk: JWK, htm: string, htu: string): Promise<string> {
  const privateKey = await importJWK(privateJwk, "EdDSA");
  return await new SignJWT({ htm, htu })
    .setProtectedHeader({ alg: "EdDSA" })
    .setIssuedAt()
    .setJti(randomBytes(8).toString("base64url"))
    .sign(privateKey);
}
