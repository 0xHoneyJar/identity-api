import { CredentialKey } from "./CredentialKey.js";
export type CredentialStanding="ACTIVE"|"REVOKED"|"TRANSFER_PENDING"|"COLLISION_REVIEW";
export class CredentialLink {
  private standing: CredentialStanding="ACTIVE";
  constructor(readonly id:string,readonly canonicalUserId:string,readonly key:CredentialKey,readonly linkedAt:Date){}
  isOwnedBy(userId:string){ return this.canonicalUserId===userId; }
  revoke(){ this.standing="REVOKED"; }
  getStanding(){ return this.standing; }
}
