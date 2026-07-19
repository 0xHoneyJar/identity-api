export type CredentialProvider = "discord" | "telegram" | "wallet" | "passkey" | "email" | "custom";

export class CredentialKey {
  private constructor(readonly provider: CredentialProvider, readonly issuer: string, readonly subject: string) {}
  static create(input: {provider: CredentialProvider; issuer: string; subject: string}): CredentialKey {
    const issuer=input.issuer.trim(); const subject=input.subject.trim();
    if(!issuer) throw new Error("CREDENTIAL_ISSUER_REQUIRED");
    if(!subject) throw new Error("CREDENTIAL_SUBJECT_REQUIRED");
    return new CredentialKey(input.provider,issuer,subject);
  }
  toStorageKey(): string { return `${this.provider}|${this.issuer}|${this.subject}`; }
}
