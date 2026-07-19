export type ProviderContext={provider:string;issuer:string;toolkitId:string;tenantId:string;clientId:string;redirectUri:string};
export class LinkIntent {
  private status:"PENDING"|"CONSUMED"|"EXPIRED"|"CANCELLED"="PENDING";
  constructor(readonly id:string,readonly canonicalUserId:string,readonly initiatingSessionId:string,readonly providerContext:ProviderContext,readonly expiresAt:Date){}
  consume(input:{canonicalUserId:string;initiatingSessionId:string;now:Date}){
    if(this.status!=="PENDING") throw new Error("LINK_INTENT_NOT_PENDING");
    if(input.now>=this.expiresAt){this.status="EXPIRED";throw new Error("LINK_INTENT_EXPIRED");}
    if(input.canonicalUserId!==this.canonicalUserId) throw new Error("LINK_INTENT_USER_MISMATCH");
    if(input.initiatingSessionId!==this.initiatingSessionId) throw new Error("LINK_INTENT_SESSION_MISMATCH");
    this.status="CONSUMED";
  }
}
