import type {CredentialKey} from "../domain/CredentialKey.js";
import type {CredentialLink} from "../domain/CredentialLink.js";
import type {LinkIntent} from "../domain/LinkIntent.js";
export type VerifiedCredentialEvidence={provider:string;issuer:string;subject:string;proofType:string;proofVersion:string;verifiedAt:Date;claims:Record<string,unknown>;sourceReference?:string};
export interface CredentialProofVerifier<T=unknown>{verify(input:T):Promise<VerifiedCredentialEvidence>}
export interface CredentialLinkRepository{findByKey(key:CredentialKey):Promise<CredentialLink|null>;save(link:CredentialLink):Promise<void>}
export interface LinkIntentRepository{findByIdForUpdate(id:string):Promise<LinkIntent|null>;save(intent:LinkIntent):Promise<void>}
export interface UnitOfWork{transaction<T>(operation:()=>Promise<T>):Promise<T>}
export interface Clock{now():Date}
export interface AuditSink{append(event:{type:string;canonicalUserId?:string;credentialStorageKey?:string;occurredAt:Date;details:Record<string,unknown>}):Promise<void>}
