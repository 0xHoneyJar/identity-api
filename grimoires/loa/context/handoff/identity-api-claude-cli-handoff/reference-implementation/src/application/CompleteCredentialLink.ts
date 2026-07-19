import {CredentialKey,CredentialProvider} from "../domain/CredentialKey.js";
import {CredentialLink} from "../domain/CredentialLink.js";
import type {CredentialLinkRepository,LinkIntentRepository,CredentialProofVerifier,UnitOfWork,Clock,AuditSink} from "../ports/index.js";
export type Result={status:"LINKED"|"ALREADY_LINKED";credentialLinkId:string}|{status:"COLLISION";credentialLinkId:string;existingCanonicalUserId:string};
export class CompleteCredentialLink<T> {
  constructor(private verifier:CredentialProofVerifier<T>,private intents:LinkIntentRepository,private links:CredentialLinkRepository,private uow:UnitOfWork,private clock:Clock,private audit:AuditSink,private newId:()=>string){}
  async execute(input:{linkIntentId:string;canonicalUserId:string;initiatingSessionId:string;proof:T}):Promise<Result>{
    const evidence=await this.verifier.verify(input.proof);
    const key=CredentialKey.create({provider:evidence.provider as CredentialProvider,issuer:evidence.issuer,subject:evidence.subject});
    return this.uow.transaction(async()=>{
      const intent=await this.intents.findByIdForUpdate(input.linkIntentId); if(!intent) throw new Error("LINK_INTENT_NOT_FOUND");
      intent.consume({canonicalUserId:input.canonicalUserId,initiatingSessionId:input.initiatingSessionId,now:this.clock.now()});
      const existing=await this.links.findByKey(key);
      if(existing){
        await this.intents.save(intent);
        if(existing.isOwnedBy(input.canonicalUserId)) return {status:"ALREADY_LINKED",credentialLinkId:existing.id};
        await this.audit.append({type:"credential.link.collision",canonicalUserId:input.canonicalUserId,credentialStorageKey:key.toStorageKey(),occurredAt:this.clock.now(),details:{existingCanonicalUserId:existing.canonicalUserId}});
        return {status:"COLLISION",credentialLinkId:existing.id,existingCanonicalUserId:existing.canonicalUserId};
      }
      const created=new CredentialLink(this.newId(),input.canonicalUserId,key,this.clock.now());
      await this.links.save(created); await this.intents.save(intent);
      await this.audit.append({type:"credential.link.created",canonicalUserId:input.canonicalUserId,credentialStorageKey:key.toStorageKey(),occurredAt:this.clock.now(),details:{proofType:evidence.proofType}});
      return {status:"LINKED",credentialLinkId:created.id};
    });
  }
}
